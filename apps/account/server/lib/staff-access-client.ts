/**
 * Client `account → staff-access` cho hợp đồng nội bộ `POST /authorization/verdict`
 * (ADR-0033 Quyết định 3) — mặt hỏi quyền của đường phát lời mời.
 *
 * ## Service Binding là transport, không phải authenticator
 *
 * Cùng lý luận với `auth-client.ts`: binding `STAFF_ACCESS_SERVICE` không mang
 * danh tính nào, nên mọi request đều ký envelope HMAC canonical
 * (`@ecoma-io/internal-auth-contracts`) với secret của **path** này. `sub` của
 * operator đi trong chuỗi ký (`actorSub`), nên `staff-access` phân giải staff
 * identity từ credential chứ không từ body — đúng ADR-0030 Quyết định 3.
 *
 * ## Vì sao hình dạng wire được validate lại ở đây
 *
 * Hình dạng canonical của endpoint sống ở
 * `apps/staff-access/src/authorization-verdict.ts` (provider). `apps/account`
 * chưa khai `@ecoma-io/staff-access-contracts` trong `package.json`, và thêm
 * nó đòi sửa `pnpm-lock.yaml` — ngoài scope lock của #227. Vì vậy đây là bản
 * mirror **chặt**: đúng hai khoá, verdict thuộc danh sách đóng, `actor_staff_id`
 * chuỗi khác rỗng. Khi `account` được phép phụ thuộc lib contracts của provider,
 * bản mirror này bị xoá và `validatePermissionVerdictResponse` được import.
 *
 * ## Fail-closed: chỉ 200 mới là verdict
 *
 * Mọi nhánh không phải `200` + body đúng hợp đồng đều trả `{ ok: false, reason }`
 * — kể cả `403` của middleware "actor không phải staff active". Lý do: một
 * verdict `denied` **phải** đi kèm hàng audit ở `staff_access.authorization_audit`
 * (ADR-0023 Quyết định 6); một `403` không có hàng đó, nên caller xử lý nó như
 * "không hỏi được verdict" (503), không như một phán quyết.
 */

import { createNonce, signRequest } from '@ecoma-io/internal-auth-contracts';

/** Tên binding Service Binding tới `staff-access` — code chỉ chứa tên (invariant 4). */
export const STAFF_ACCESS_SERVICE_BINDING_NAME = 'STAFF_ACCESS_SERVICE';

/** Path của endpoint verdict — ký trên chính path này. */
export const STAFF_ACCESS_VERDICT_PATH = '/authorization/verdict';

/** Timeout một lần gọi — cùng giá trị với `auth-client` và client của backoffice. */
export const STAFF_ACCESS_TIMEOUT_MS = 3_000;

/** Shape tối thiểu của Service Binding mà module này đọc từ `runtimeConfig`. */
export interface StaffAccessServiceBinding {
  fetch(input: Request, init?: RequestInit): Promise<Response>;
}

/** Mã lỗi ổn định của nhánh hạ tầng — đi vào log, không phải message cho người dùng. */
export type StaffAccessCallFailureReason =
  /** Chưa cấu hình binding — hạ tầng chưa provision (hoặc preset local chưa nối). */
  | 'binding_missing'
  /** Chưa cấu hình secret của path này — không thể ký, không có đường unsigned. */
  | 'secret_missing'
  /** `staff-access` trả 5xx — chính nó đang fail-close. */
  | 'staff_access_unavailable'
  /** `staff-access` trả 4xx — envelope hỏng (401) hoặc actor không phải staff (403). */
  | 'rejected'
  /** Network hoặc timeout — không tới được `staff-access`. */
  | 'unreachable'
  /** 200 nhưng body khác hợp đồng. */
  | 'invalid_response';

/** Kết quả một lần hỏi verdict — discriminated union, không ném. */
export type PermissionVerdictResult =
  | {
      readonly ok: true;
      readonly verdict: 'allowed';
      /** Staff identity do `staff-access` phân giải — không do phía này khai. */
      readonly actorStaffId: string;
    }
  | {
      readonly ok: true;
      readonly verdict: 'denied';
      readonly actorStaffId: string;
    }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/** Đọc binding `STAFF_ACCESS_SERVICE` ra khỏi `runtimeConfig` — `null` khi không có. */
export function staffAccessServiceBinding(
  runtimeConfig: unknown,
): StaffAccessServiceBinding | null {
  const env = (runtimeConfig as { cloudflare?: { env?: Record<string, unknown> } } | undefined)
    ?.cloudflare?.env;
  const binding = env?.[STAFF_ACCESS_SERVICE_BINDING_NAME];
  if (
    typeof binding !== 'object' ||
    binding === null ||
    typeof (binding as StaffAccessServiceBinding).fetch !== 'function'
  ) {
    return null;
  }
  return binding as StaffAccessServiceBinding;
}

/** Response 200 của endpoint verdict, sau khi validate. */
interface ValidatedVerdictResponse {
  readonly verdict: 'allowed' | 'denied';
  readonly actor_staff_id: string;
}

/**
 * Validate response 200 theo hình dạng canonical — đúng hai khoá, không thừa,
 * verdict thuộc danh sách đóng, `actor_staff_id` chuỗi khác rỗng.
 */
function validateVerdictResponse(value: unknown): ValidatedVerdictResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('verdict') || !keys.includes('actor_staff_id')) {
    return null;
  }
  if (record.verdict !== 'allowed' && record.verdict !== 'denied') {
    return null;
  }
  if (typeof record.actor_staff_id !== 'string' || record.actor_staff_id.length === 0) {
    return null;
  }
  return { verdict: record.verdict, actor_staff_id: record.actor_staff_id };
}

/**
 * Hỏi `staff-access` xem actor có permission không — cho **một** request,
 * không cache (ADR-0033 Quyết định 3).
 *
 * @param params.binding - Service Binding đã qua kiểm hình dạng.
 * @param params.signingKey - Secret của path này; chỉ dùng để ký, không trả ra ngoài.
 * @param params.actorSub - `sub` của operator, nằm trong chuỗi ký.
 * @param params.permission - Định danh `<domain>.<action>` cần hỏi.
 * @param params.correlationId - Định danh xuyên service; `staff-access` dùng nó cho
 *   hàng audit nên caller phải dùng lại đúng giá trị đó khi ghi dữ liệu của mình.
 * @param params.nowMs - Test seam cho timestamp envelope.
 */
export async function requestPermissionVerdict(params: {
  readonly binding: StaffAccessServiceBinding;
  readonly signingKey: string;
  readonly actorSub: string;
  readonly permission: string;
  readonly correlationId: string;
  readonly nowMs?: number;
}): Promise<PermissionVerdictResult> {
  const body = new TextEncoder().encode(
    JSON.stringify({ permission: params.permission, correlation_id: params.correlationId }),
  );
  const headers = await signRequest({
    method: 'POST',
    path: STAFF_ACCESS_VERDICT_PATH,
    body,
    secret: params.signingKey,
    timestamp: String(Math.floor((params.nowMs ?? Date.now()) / 1000)),
    nonce: createNonce(),
    actorSub: params.actorSub,
  });

  const requestHeaders = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(headers)) {
    requestHeaders.set(name, value);
  }

  let response: Response;
  try {
    response = await params.binding.fetch(
      new Request(`https://staff-access.internal${STAFF_ACCESS_VERDICT_PATH}`, {
        method: 'POST',
        headers: requestHeaders,
        body,
      }),
      { signal: AbortSignal.timeout(STAFF_ACCESS_TIMEOUT_MS) },
    );
  } catch {
    // Timeout (abort) và lỗi network cùng là `unreachable`.
    return { ok: false, reason: 'unreachable' };
  }

  if (response.status === 503) {
    return { ok: false, reason: 'staff_access_unavailable' };
  }
  if (response.status >= 400) {
    return { ok: false, reason: 'rejected' };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  const validated = validateVerdictResponse(parsed);
  if (validated === null) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, verdict: validated.verdict, actorStaffId: validated.actor_staff_id };
}
