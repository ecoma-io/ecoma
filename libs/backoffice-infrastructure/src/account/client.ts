/**
 * Client `backoffice → account` qua contract nội bộ `GET /internal/account/profiles`
 * (issue #325).
 *
 * ## Service Binding là transport, không phải authenticator
 *
 * Cùng lý luận với `apps/auth/src/account-client.ts`: binding `ACCOUNT_SERVICE`
 * **không** mang header hay `cf`, nên mọi request đều ký HMAC với
 * `AUTH_INTERNAL_SECRET`. Binding chỉ quyết định request đi tới đâu; authentication
 * nằm ở envelope.
 *
 * ## Hai failure mode có chủ đích
 *
 * Module này trả **discriminated result** thay vì ném — khác `AccountClient` của
 * `auth`, vốn fail-closed tuyệt đối. Lý do: hai consumer ở đây cần hai chế độ
 * lỗi khác nhau:
 *
 * - `GET /api/onboarding-status` là **gate** → caller cần phân biệt "đã hỏi được"
 *   với "không hỏi được" để trả `503` (fail-closed — không trả lời được thì không
 *   mở màn onboarding cũng như không cho qua).
 * - `GET /api/staff` là **display** → khi account không trả lời, sổ staff vẫn phải
 *   chạy với `displayName: null` (controlled degrade); ném ra sẽ biến sự cố của một
 *   service phụ thành sự cố của cả sổ staff.
 *
 * Caller quyết định chế độ, client không tự quyết — cùng ranh giới với
 * `read-route.ts`: khung gom phần giống nhau, route tự khai chính sách của mình.
 *
 * ## Vì sao hàm này nhận `env` thay vì `H3Event`
 *
 * Cùng quy ước với {@link backofficeHyperdrive}: lib infrastructure không
 * ràng buộc vào framework serving của một app (`H3Event` là kiểu của h3); cách
 * đọc `env` ra khỏi request là chi tiết composition, phía app làm qua
 * `readWorkerEnv` rồi truyền **giá trị thường** vào đây.
 */

import {
  createNonce,
  dedupeProfileSubs,
  signRequest,
  validateAccountProfilesResponse,
  type AccountProfileEntry,
} from '@ecoma-io/account-contracts';

/**
 * Tên binding Service Binding tới `account` — **không** chứa giá trị nào khác
 * (invariant 4: application code chỉ chứa tên binding).
 */
export const ACCOUNT_SERVICE_BINDING_NAME = 'ACCOUNT_SERVICE';

/**
 * Tên biến `env` của Worker giữ secret HMAC ký envelope nội bộ — same secret
 * mà `account` dùng để verify (`internalHmacSecret`). Giá trị do deploy layer
 * cấp (`wrangler secret`); code chỉ chứa tên.
 */
export const AUTH_INTERNAL_SECRET_ENV = 'AUTH_INTERNAL_SECRET';

/** Shape tối thiểu của Service Binding mà module này đọc từ `env` của Worker. */
export interface AccountServiceBinding {
  fetch: (input: Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Timeout cho một lần gọi account — cùng giá trị với `ACCOUNT_TIMEOUT_MS` của
 * `apps/auth`. Không có nó thì một account unreachable giữ request tới hết hạn
 * Worker; có nó thì lỗi là "không gọi được" và fail nhanh.
 */
const ACCOUNT_TIMEOUT_MS = 3_000;

/**
 * Mã lỗi ổn định của nhánh hạ tầng — đi vào log (`writeLog.reason`), không phải
 * message cho người dùng.
 */
export type AccountCallFailureReason =
  | 'binding_missing'
  | 'secret_missing'
  | 'unreachable'
  | 'http_error'
  | 'invalid_response';

/** Kết quả một lần gọi batch profiles — discriminated union, không ném. */
export type AccountProfilesCallResult =
  | { readonly ok: true; readonly profiles: readonly AccountProfileEntry[] }
  | { readonly ok: false; readonly reason: AccountCallFailureReason };

/**
 * Cấu hình đã qua kiểm hình dạng mà client cần cho mỗi lần gọi.
 *
 * ⚠️ Secret KHÔNG nằm trong object này — nó sống trong closure của
 * `signHeaders` và không bao giờ là property trả về cho caller. Secret chỉ có
 * một Consumer hợp lệ là `signRequest`; đưa nó vào config object vừa mở bề mặt
 * đọc vô ích, vừa dính rule `security-sensitive-value-in-http-response`
 * (`return { ..., secret }` là sink theo tên field). Caller opaque chỉ cần
 * binding + một hàm ký.
 */
interface AccountClientConfig {
  readonly binding: AccountServiceBinding;
  readonly signHeaders: (path: string) => Promise<Record<string, string>>;
}

/** `readString` — `null` khi không phải chuỗi khác rỗng. */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Đọc cấu hình client từ `env` của Worker.
 *
 * ⚠️ Phía app đọc `env` qua `readWorkerEnv` (`event.context.cloudflare.env`),
 * **không** qua `useRuntimeConfig(event).cloudflare` — preset `cloudflare-module`
 * của Nitro không populate khoá đó (đo ở `server/db.ts`), nên đường runtimeConfig
 * là một đường luôn trả `undefined` và fail-closed vô ích.
 *
 * @param env `env` của Worker — đọc ra khỏi request context bởi caller (vd
 *   `readWorkerEnv` phía app); giữ `unknown` để lib này không ràng buộc cách
 *   đọc.
 * @returns `null` khi thiếu binding hoặc secret — "chưa cấu hình" là trạng thái
 *   deployment hợp lệ, caller quyết định fail thế nào (không ném ở đây).
 */
export function accountClientConfig(env: unknown): AccountClientConfig | null {
  if (typeof env !== 'object' || env === null) {
    return null;
  }
  const record = env as Record<string, unknown>;
  const bindingValue = record[ACCOUNT_SERVICE_BINDING_NAME];
  const secret = readString(record[AUTH_INTERNAL_SECRET_ENV]);
  if (
    typeof bindingValue !== 'object' ||
    bindingValue === null ||
    typeof (bindingValue as AccountServiceBinding).fetch !== 'function' ||
    secret === null
  ) {
    return null;
  }
  // `const` giữ narrowing `string` vào closure — tham số `secret` ở trên là
  // biến có thể gán lại nên TS không mang narrowing vào `signer`.
  const hmacSecret: string = secret;
  const binding = bindingValue as AccountServiceBinding;
  /**
   * Ký một GET nội bộ — cùng canonical envelope với phía verify của `account`
   * (`signRequest` từ `@ecoma-io/account-contracts`).
   *
   * ⚠️ `path` phải là pathname + search nguyên vẹn: query string là một phần của
   * chuỗi ký. Headers trả về là một bản ghi phẳng (`InternalAuthHeaders`), đi thẳng
   * vào `RequestInit.headers` — không cần dựng `Headers` object.
   *
   * Ký ngay trong closure của config (không trả secret ra giá trị nào): secret đi
   * vào `signRequest` với đủ envelope đặc trưng (secret + timestamp) — sanitizer
   * của rule `security-sensitive-value-in-http-response` cắt taint tại lời gọi
   * này, nên object trả về cho caller chỉ mang binding và hàm ký, không mang khóa.
   */
  async function signer(path: string): Promise<Record<string, string>> {
    const headers = await signRequest({
      method: 'GET',
      path,
      body: new Uint8Array(),
      // `const` narrowing mang được vào closure (khác tham số let/function — TS
      // thu hẹp kiểu của const ở điểm khai báo và giữ nguyên trong closure).
      secret: hmacSecret,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
    });
    return { ...headers };
  }
  return {
    binding,
    signHeaders: signer,
  };
}
/**
 * Gọi `GET /internal/account/profiles?subs=...` và validate response.
 *
 * Mọi nhánh lỗi đều trả `{ ok: false, reason }` — không có nhánh nào ném, và
 * không có nhánh nào trả dữ liệu "mặc định" cho caller đọc nhầm thành câu trả
 * lời thật.
 *
 * ⚠️ Response validator là lưới an toàn bắt buộc: payload đã đi qua `JSON.parse`,
 * không còn ai giữ type, nên hợp đồng chỉ được tin sau khi qua
 * {@link validateAccountProfilesResponse}.
 *
 * @param subs Danh sách `sub` cần hỏi — được dedupe và giới hạn bởi trần contract
 *   trước khi ký (hàm thuần `dedupeProfileSubs` của contract lib).
 */
export async function fetchAccountProfiles(
  config: AccountClientConfig,
  subs: readonly string[],
): Promise<AccountProfilesCallResult> {
  const deduped = dedupeProfileSubs(subs);
  if (deduped.length === 0) {
    return { ok: true, profiles: [] };
  }

  const path = `/internal/account/profiles?subs=${deduped.map(encodeURIComponent).join(',')}`;
  let response: Response;
  try {
    response = await config.binding.fetch(new Request(`https://account.internal${path}`), {
      headers: await config.signHeaders(path),
      // Timeout qua `init.signal` — giới hạn duy nhất mà Service Binding có.
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (!response.ok) {
    return { ok: false, reason: 'http_error' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }

  const validation = validateAccountProfilesResponse(body);
  if (!validation.ok) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, profiles: validation.payload.profiles };
}
