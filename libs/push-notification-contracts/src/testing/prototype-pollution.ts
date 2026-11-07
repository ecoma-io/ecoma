/**
 * Tiện ích **chỉ dùng cho test** — không nằm trong public API (`index.ts` không export).
 *
 * Mô phỏng prototype pollution để chứng minh các validator định nghĩa "khoá có mặt" bằng
 * **own property** (`Object.hasOwn`), không phải bằng phép `in` (vốn đi lên cả prototype
 * chain). Đây là khác biệt thật: một `in` sẽ vừa cho object rỗng lọt qua kiểm closed schema
 * vừa kéo giá trị từ `Object.prototype` vào kết quả trả về.
 *
 * Dùng `Reflect.defineProperty`/`Reflect.deleteProperty` thay vì gán thẳng
 * `Object.prototype.x = ...`: cùng hiệu ứng, nhưng không phải sửa trực tiếp built-in.
 */

/** Chạy `fn` trong lúc các khoá `pollution` tồn tại trên `Object.prototype`, rồi khôi phục. */
export function withPrototypeKeys<T>(pollution: Readonly<Record<string, unknown>>, fn: () => T): T {
  const restore: (() => void)[] = [];
  try {
    for (const [key, value] of Object.entries(pollution)) {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
      Reflect.defineProperty(Object.prototype, key, {
        value,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      restore.push(() => {
        if (previous) {
          Reflect.defineProperty(Object.prototype, key, previous);
        } else {
          Reflect.deleteProperty(Object.prototype, key);
        }
      });
    }
    return fn();
  } finally {
    // Gỡ theo thứ tự ngược lại để trạng thái trước test được phục hồi đúng.
    for (let index = restore.length - 1; index >= 0; index -= 1) {
      restore[index]?.();
    }
  }
}
