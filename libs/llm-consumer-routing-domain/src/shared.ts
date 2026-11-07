/**
 * Kiến trúc dùng chung cho domain library `llm-consumer-routing`.
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào —
 * domain không đọc đồng hồ (`Date.now()`), không parse RFC 3339, không sinh
 * số ngẫu nhiên. Mọi hàm là thuần: không sửa input, không giữ state, và trả
 * `DomainOk`/`DomainRejection` thay vì ném exception cho dữ liệu đầu vào hỏng.
 *
 * Runtime string (error message, detail) viết bằng tiếng Anh theo language
 * policy của repo (mỗi domain error message English, không chứa secret).
 */

export type DomainOk<Value extends object> = { readonly ok: true } & Value;

export type DomainRejection<Reason extends string> = {
  readonly ok: false;
  readonly reason: Reason;
  readonly detail: string;
};

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
