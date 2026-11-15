import type { AsyncState } from './use-async-state';

/**
 * Type guard cho các trang dùng `useAsyncState` với giá trị sentinel
 * `typeof UNAVAILABLE` (symbol) — thay cho phép so sánh qua ép kiểu
 * `as unknown as ...` lặp lại ở mỗi trang.
 *
 * Trang kiểm tra `state.value.kind === 'ready'` trước khi gọi, nên hàm chỉ cần
 * thu hẹp phần giá trị.
 */
export function isUnavailableValue(
  value: unknown,
  unavailable: symbol,
): value is typeof unavailable {
  return value === unavailable;
}

/**
 * Kiểm tra một `AsyncState` có phải `ready` mang sentinel unavailable không —
 * dùng trực tiếp trong `computed` của trang.
 */
export function isUnavailableState<T>(state: AsyncState<T>, unavailable: symbol): boolean {
  return state.kind === 'ready' && isUnavailableValue(state.value, unavailable);
}
