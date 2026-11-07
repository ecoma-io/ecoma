/**
 * Biên HTTP của `push-notification`: đọc body, ánh xạ status, và **không** gì khác.
 *
 * ⚠️ **Vì sao file này tên `wire.ts` chứ không phải `http.ts`.** Tên module là không gian tên
 * toàn cục trong hệ import: `.oxlintrc.json` cấm import Node builtin theo **tên trần**
 * (`http`, `path`, `crypto`, …) cho mọi file dưới `apps/**` — một rule viết đúng để chặn
 * `import ... from 'http'`. Nhưng pattern đó khớp cả `./http`, nên một file tên `http.ts` ở
 * composition root khiến chính file của service bị báo vi phạm. Đặt tên là `wire` giữ ý nghĩa
 * (đây là lớp **wire**, không phải HTTP server) và né phải nới rule — `.oxlintrc.json` không
 * phải file của unit này.
 *
 * ⚠️ **Vì sao file này tồn tại thay vì để trong `main.ts`.** `main.ts` là composition root:
 * nó dựng adapter và nối route với use case. Đặt thêm "parse JSON, kiểm object rỗng, viết
 * response lỗi" vào đó làm cho nó dài hơn mức có thể đọc, và ba thứ đó lặp ở **mọi** route —
 * nên chúng phải là một chỗ. Một chỗ cũng là điều kiện để "route này có kiểm body rỗng
 * không" trở thành một câu hỏi có đáp án, thay vì một điều phải nhớ riêng cho từng route.
 *
 * ⚠️ **Không có business rule ở đây.** Đặc biệt: hàm ánh xạ `reason` → status là **cầu nối**
 * giữa vocabulary đóng của use case và HTTP, không phải nơi quyết định. Tập `reason` là hợp
 * đồng (với caller ở Application API, với delivery plane ở Admin API), nên một `reason` mới
 * mà chưa có status là một khoảng trống của contract — và `switch` có nhánh `default` để
 * `assertUnreachable` bắt nó thay vì trả `200` cho một rejection.
 */

import {
  CREATE_NOTIFICATION_REJECTION,
  INVENTORY_REJECTION,
  type CreateNotificationRejection,
  type InventoryRejection,
} from '@ecoma-io/push-notification-application';

/** Thân JSON cho mọi response của service. */
export function json(
  payload: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Thân lỗi — **không** nối giá trị đầu vào.
 *
 * ⚠️ `detail` là hằng hoặc thông điệp từ use case; các use case ở
 * `@ecoma-io/push-notification-application` đã cam kết không nối `endpoint` /
 * `Idempotency-Key` / payload vào `detail` (log injection bằng newline). Việc giữ bất biến
 * đó ở tầng dưới là lý do hàm này không cần sanitize thêm.
 */
export function problem(
  status: number,
  reason: string,
  detail: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return json({ error: reason, detail }, status, headers);
}

/** `plain object` — không array, không `null`, không primitive. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Kết quả đọc body: object JSON, hoặc `detail` để trả `400`. */
export type JsonObjectResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly detail: string };

/**
 * Đọc body thành JSON object.
 *
 * ⚠️ **Body rỗng → `{}`**, và đó là quyết định có chủ đích: một Worker caller thường `POST`
 * không body, và coi đó là `400` sẽ làm một interface hợp lệ trả lỗi. Endpoint nào contract
 * **yêu cầu** body rỗng dùng `readEmptyRequestBody` — hai hàm tách biệt để một request mang
 * dữ liệu thật mà thiếu body **không** bị âm thầm coi là `{}` (nếu không, client nhận `400`
 * từ validator với lý do không đúng nguyên nhân).
 */
export async function readJsonObject(request: Request): Promise<JsonObjectResult> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return { ok: true, value: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'Body không parse được thành JSON.' };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, detail: 'Body phải là object JSON.' };
  }
  return { ok: true, value: parsed };
}

/** Kết quả đọc body của endpoint contract yêu cầu **rỗng**. */
export type EmptyRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * Đọc body của endpoint **bắt buộc rỗng** (`claim` · `invalidate` — §8.1).
 *
 * ⚠️ Kiểm rỗng **thật**, không phải "cho qua": §8.1 nói rõ `claim` không nhận tham số điều
 * khiển state nào (`lease_duration`/`now`/`dispatch_generation`), vì nhận chúng biến lease
 * thành thứ caller điều khiển được và phá vỡ "predicate claim là nguồn duy nhất của
 * thắng/thua". `invalidate` tương tự: body mang "bằng chứng" là thứ control plane không thể
 * kiểm chứng và `MUST NOT` tin.
 */
export async function readEmptyRequestBody(request: Request): Promise<EmptyRequestResult> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return { ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'Body phải là object JSON rỗng.' };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, detail: 'Body phải là object JSON rỗng.' };
  }
  if (Object.keys(parsed).length > 0) {
    return { ok: false, detail: 'Body phải rỗng.' };
  }
  return { ok: true };
}

/**
 * `reason` của `createNotification` → HTTP status.
 *
 * ⚠️ `no_eligible_subscription` là `400`, **không** `404`: caller gửi một notification hợp
 * lệ, chỉ là không có ai nhận được. `404` ở đây sẽ bảo caller rằng endpoint không tồn tại.
 *
 * ⚠️ Tham số là `CreateNotificationRejection` — union do **application layer** định nghĩa
 * (`(typeof CREATE_NOTIFICATION_REJECTION)[keyof …]`), không phải union viết tay ở đây. Viết
 * lại union ở file này sẽ tạo hai nơi phải giữ đồng bộ mà không có gì buộc chúng đồng bộ.
 */
export function notificationRejectionStatus(reason: CreateNotificationRejection): number {
  switch (reason) {
    case CREATE_NOTIFICATION_REJECTION.AppMismatch:
      return 403;
    case CREATE_NOTIFICATION_REJECTION.IdempotencyKeyMissing:
    case CREATE_NOTIFICATION_REJECTION.IdempotencyKeyTooLong:
      return 400;
    case CREATE_NOTIFICATION_REJECTION.IdempotencyKeyConflict:
      return 409;
    case CREATE_NOTIFICATION_REJECTION.RateLimited:
      return 429;
    case CREATE_NOTIFICATION_REJECTION.StorageFailure:
      return 503;
    case CREATE_NOTIFICATION_REJECTION.InvalidPayload:
    case CREATE_NOTIFICATION_REJECTION.PayloadOverBudget:
    case CREATE_NOTIFICATION_REJECTION.FanoutLimitExceeded:
    case CREATE_NOTIFICATION_REJECTION.NoEligibleSubscription:
      return 400;
    default: {
      // ⚠️ **Guard lúc chạy, không phải assertion kiểu.** `const exhaustive: never = reason` là
      // cách kinh điển để kiểm tra exhaustiveness, và nó **không kiểm được ở target `build`**:
      // `nx build` phân tích app bằng **declaration đã build** của các lib
      // (`tsconfig.app.json` project reference → `dist/*.d.ts`), nơi
      // `CREATE_NOTIFICATION_REJECTION` là anonymous object type của các literal, nên `case`
      // so sánh được nhưng `reason` vẫn là union đầy đủ — `never` không bao giờ đạt được, và
      // assertion đó chỉ "đúng" ở target `typecheck` (chạy trên source). Một guard thật thì
      // đúng ở **cả** hai, và nó mạnh hơn: typecheck bắt được `reason` thiếu ở *source*,
      // guard bắt được cả một `reason` lọt vào từ JS hoặc từ một tài liệu cũ.
      throw new Error(`notificationRejectionStatus: reason chưa khai báo status: ${reason}`);
    }
  }
}

/**
 * `reason` của use case inventory (Device/Subscription) → HTTP status.
 *
 * ⚠️ Tách khỏi `notificationRejectionStatus` **cố ý**: ba tập này là ba hợp đồng với ba
 * consumer khác nhau, và một tập `reason` chung khiến mỗi client phải hiểu các nhánh không
 * thuộc contract của nó. Xem cùng lý do đó ở `adminRejectionStatus`.
 *
 * ⚠️ **Ba nhánh `409` không cùng nghĩa với `400`.** `endpoint_rejected`/`invalid_payload` là
 * lỗi của request — sửa request là được. `device_owned_by_another_user`,
 * `endpoint_owned_by_another_device`, `subscription_expired`, `no_provider_for_scope` và
 * `vapid_key_unavailable` là **xung đột trạng thái**: request đúng hình dạng nhưng thế giới
 * không ở trạng thái để phục vụ nó, và sửa request không giúp được. `409` nói cho client biết
 * đó là điều kiện, không phải cú pháp.
 */
export function inventoryRejectionStatus(reason: InventoryRejection): number {
  switch (reason) {
    case INVENTORY_REJECTION.AppMismatch:
      return 403;
    case INVENTORY_REJECTION.DeviceNotFound:
    case INVENTORY_REJECTION.SubscriptionNotFound:
      return 404;
    case INVENTORY_REJECTION.DeviceOwnedByAnotherUser:
    case INVENTORY_REJECTION.EndpointOwnedByAnotherDevice:
    case INVENTORY_REJECTION.SubscriptionExpired:
    case INVENTORY_REJECTION.NoProviderForScope:
    case INVENTORY_REJECTION.VapidKeyUnavailable:
      return 409;
    case INVENTORY_REJECTION.StorageFailure:
      return 503;
    case INVENTORY_REJECTION.InvalidPayload:
    case INVENTORY_REJECTION.EndpointRejected:
      return 400;
    default:
      return 400;
  }
}

/**
 * Đọc một field chuỗi bắt buộc từ body JSON.
 *
 * ⚠️ **Trả `null` cho chuỗi rỗng, không trả `''`** — vì `''` đi qua kiểm `typeof === 'string'`
 * và sẽ đi vào SQL thành một định danh rỗng, nơi CHECK của schema chặn bằng một lỗi không
 * phân loại (`devices_device_id_non_empty_check`). `null` để route trả `400` với lý do đúng.
 */
export function readRequiredString(
  body: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  return readNonEmptyString(body[key]);
}

/**
 * Chuỗi không rỗng, hoặc `null`.
 *
 * ⚠️ Dùng cho **path param** và cho field body đã biết là chuỗi. Một path param rỗng không
 * bao giờ xảy ra với Hono (route có placeholder thì luôn khớp một segment), nên `null` ở đây
 * là một guard kép chứ không phải nhánh thường dùng — và nó vẫn đáng có vì nó biến một `undefined`
 * của kiểu Hono thành một `400` có nghĩa thay vì một `undefined` đi vào SQL.
 */
export function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `reason` của use case Admin → HTTP status.
 *
 * ⚠️ Tách khỏi `notificationRejectionStatus` **cố ý**: hai tập này là hai hợp đồng với hai
 * consumer khác nhau, và gộp chúng khiến một admin phải hiểu vocabulary của Application API
 * (xem `admin-provider.ts` — cùng lý do đó tách `ADMIN_REJECTION` khỏi `REQUEST_REJECTION`).
 */
export function adminRejectionStatus(reason: string): number {
  switch (reason) {
    case 'provider_not_found':
    case 'subscription_not_found':
    case 'delivery_not_found':
      return 404;
    case 'app_mismatch':
      return 403;
    case 'state_mismatch':
    case 'open_outbox_intent':
    case 'provider_held':
    case 'recovery_precondition_failed':
      return 409;
    case 'storage_failure':
      return 503;
    default:
      return 400;
  }
}

/** Trần `limit` của các list endpoint quản trị — chặn một query quét cả bảng. */
export const ADMIN_LIST_LIMIT_MAX = 200;
export const ADMIN_LIST_LIMIT_DEFAULT = 50;

/**
 * Đọc `?limit=`; thiếu/sai → default; lớn → trần.
 *
 * ⚠️ Vì sao **validate** chứ không chỉ parse: `limit` là tham số do caller kiểm soát và đi
 * thẳng vào `LIMIT` của SQL. Một `limit = 1e9` không phải yêu cầu hợp lệ, và để nó tới đây là
 * một câu quét bảng do client quyết định kích thước.
 */
export function readLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null || !/^[0-9]+$/u.test(raw)) {
    return ADMIN_LIST_LIMIT_DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return ADMIN_LIST_LIMIT_DEFAULT;
  }
  return Math.min(parsed, ADMIN_LIST_LIMIT_MAX);
}
