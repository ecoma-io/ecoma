/**
 * Kiến trúc dùng chung cho domain library Push Notification Service.
 *
 * Source of truth:
 * - `docs/applications/push-notification/01-architecture.md` §4.2 (Transport = web | app);
 *   §5.1 (identity theo `subscription_id`, `device_id` bắt buộc);
 *   §5.6 (kiến trúc delivery/lease/generation).
 * - `docs/applications/push-notification/02-requirements.md` FR-001–FR-002 (Transport/Provider
 *   là hai khái niệm khác nhau; web-push là ProviderType, không phải Transport).
 *
 * Quyết định domain suy ra:
 * - `Transport` được khai báo lại tại đây thay vì import từ
 *   `@ecoma-io/push-notification-contracts`: hai lib nằm ở hai phía của ranh giới
 *   boundary (`type:contracts` và `type:domain`), neither import theo hướng nào —
 *   contracts là wire schema, domain là business invariant (theo mô hình mà
 *   `account-domain` / các contract lib của identity đã thiết lập). Hai lớp cùng mirror
 *   canonical docs.
 * - Thời gian trong domain luôn là epoch millis kiểu `number`, do caller truyền vào.
 *   Domain không đọc đồng hồ (không `Date.now()`), không parse RFC 3339 (việc
 *   serialization thuộc contracts/application).
 */

/**
 * Kết quả thành công của một operation domain: giữ giá trị trả về trực tiếp trên
 * result thay vì throw — business rejection là trường hợp dự kiến, không phải lỗi.
 */
export type DomainOk<Value extends object> = { readonly ok: true } & Value;

/**
 * Kết quả bị từ chối với reason đóng (string literal union do từng operation định nghĩa)
 * và detail hằng — domain không bao giờ interpolate dữ liệu đầu vào vào detail
 * để tránh rò rỉ payload/credential qua error message.
 */
export type DomainRejection<Reason extends string> = {
  readonly ok: false;
  readonly reason: Reason;
  readonly detail: string;
};

/**
 * Transport của Push Subscription — kênh gửi tin (web = Web Push qua browser,
 * app = push tới native app).
 *
 * KHÁC `ProviderType`: web-push là provider type (giao thức), không phải transport.
 * Không bao giờ gán `'web-push'` vào giá trị `Transport`.
 */
export const TRANSPORT = {
  Web: 'web',
  App: 'app',
} as const;

export type Transport = (typeof TRANSPORT)[keyof typeof TRANSPORT];

/**
 * Vocabulary `Transport` ở dạng mảng — **suy ra** từ `TRANSPORT` thay vì viết tay.
 *
 * Một mảng viết tay là nguồn thứ hai có thể lệch khỏi object: thêm một transport vào
 * `TRANSPORT` mà quên cập nhật mảng thì type vẫn xanh, nhưng transport mới bị
 * `isTransport` loại như giá trị ngoài vocabulary và subscription thuộc nó biến mất
 * không có lỗi nào — đúng loại hỏng âm thầm mà vocabulary đóng sinh ra để chặn.
 * Suy ra từ chính `TRANSPORT` giữ hai nguồn là một.
 */
export const TRANSPORT_VALUES: readonly Transport[] = Object.values(TRANSPORT);

/**
 * Runtime guard cho `Transport` — chặn giá trị ngoài vocabulary (kể cả provider
 * type) ở boundary khi domain nhận dữ liệu từ caller bên ngoài.
 */
export function isTransport(value: unknown): value is Transport {
  return typeof value === 'string' && TRANSPORT_VALUES.some((transport) => transport === value);
}

/**
 * Chuỗi không rỗng (sau trim) — guard cơ sở cho identity fields
 * (`subscription_id`, `device_id`, `provider_id`, `app`).
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Số nguyên an toàn dương — đơn vị dùng cho epoch millis và `dispatch_generation`.
 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Số nguyên an toàn không âm — dùng cho counter bắt đầu từ 0 (attempts,
 * dispatch_generation có thể 0 khi trạng thái chưa từng claim).
 */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Số nguyên an toàn đủ lớn để làm **epoch millis** — `expires_at`, `lease_expires_at`,
 * `available_at`, `now`.
 *
 * Vì sao không dùng `isFiniteNumber` cho các mốc thời gian: `isFiniteNumber` chỉ chặn
 * `NaN`/`Infinity`, nên một `expires_at` nằm ngoài miền số nguyên an toàn vẫn lọt qua và
 * mọi phép so sánh `<=` với nó đều cho kết quả *đúng về mặt kỹ thuật* nhưng vô nghĩa — đó
 * là điều kiện cổng `expired`/backoff mà §5.6 dựa vào. `Number.isSafeInteger` chặn cả
 * hai vế: số không nguyên và số vượt `2^53-1`, nên một mốc thời gian hỏng **không** thể lọt
 * vào quyết định nghiệp vụ dưới dạng một so sánh cho kết quả ngược ý.
 *
 * Miền âm vẫn được chấp nhận: domain không đọc đồng hồ nên không có "hiện tại" để so,
 * và một mốc âm chỉ khác một mốc dương ở phép so sánh — từ chối nó ở đây sẽ biến thành
 * một quy tắc định nghĩa thời gian mà canonical docs không quy định.
 */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Số thực hữu hạn — chấp nhận cả 0 và số âm cho `now` khi test, vì domain chỉ
 * cần so sánh, không tự sinh thời gian.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
