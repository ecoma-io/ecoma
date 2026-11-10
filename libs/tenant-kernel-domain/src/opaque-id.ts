/**
 * Định danh opaque dùng chung của kernel tenant: một chuỗi không mang ngữ nghĩa
 * bên trong, người gọi chịu trách nhiệm verify trước khi đưa vào kernel.
 *
 * Kernel **không** ép kiểu branded: mỗi bounded context tự mang kiểu branded
 * của riêng mình, kernel chỉ làm việc trên chuỗi opaque.
 */

/** Độ dài tối đa của một định danh opaque, chặn payload bất thường từ input. */
export const MAX_OPAQUE_ID_LENGTH = 200;

/**
 * Kiểm tra định danh opaque: chuỗi, bằng chính chuỗi trim của mình (không bị
 * đệm khoảng trắng hai đầu), dài từ 1 đến MAX_OPAQUE_ID_LENGTH ký tự. Không ném.
 */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}
