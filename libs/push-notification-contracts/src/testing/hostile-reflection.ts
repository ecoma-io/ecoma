/**
 * Tiện ích **chỉ dùng cho test** — không nằm trong public API (`index.ts` không export).
 *
 * `Proxy` cho phép caller đặt trap cho `getPrototypeOf`/`ownKeys`/`getOwnPropertyDescriptor`
 * /`get` **ném exception**. Validator của thư viện là boundary cho dữ liệu không tin cậy, và
 * bất biến của boundary đó là: **mọi** giá trị đầu vào trả về một kết quả union phân biệt
 * (`{ ok: false, reason, detail }`), không bao giờ để exception chưa phân loại thoát ra.
 * Accessor ném lỗi là dạng đã được diệt trước (`readJsonDataProperty`); trap ném lỗi là
 * cùng loại vấn đề ở tầng phản chiếu, nên có helper này để khoá lại bằng test.
 *
 * Phạm vi: **validator** (parse body thô). Builder nhận input đã đóng kiểu do caller dựng —
 * một `Proxy` không phải giá trị hợp lệ của tham số có kiểu, nên không thuộc bất biến này.
 */

/** Trap nào sẽ ném khi bị chạm. */
export type ThrowingTrap = 'getPrototypeOf' | 'ownKeys' | 'descriptor' | 'get';

/**
 * Object chỉ ném ở **một** trap, các trap khác cư xử như object thường.
 *
 * `target` giữ **nguyên** kiểu của nó (mảng vẫn là mảng) — spread thành object thường sẽ làm
 * test mất đúng nhánh cần đo (`Array.isArray` đổi kết quả). `only` giới hạn phép ném vào
 * đúng `key` đó; bỏ trống nghĩa là ném cho mọi khoá. Nhờ vậy test phân biệt được bước nào
 * của validator bắt được lỗi (ví dụ trap `get` chỉ ném ở một khoá **được phép** thì vòng
 * kiểm field bị cấm phải đi qua bình thường).
 */
export function withThrowingTrap(
  trap: ThrowingTrap,
  target: object,
  only?: string,
): Record<string, unknown> {
  const hitsOnly = (key: PropertyKey): boolean => only === undefined || key === only;
  return new Proxy(target, {
    getPrototypeOf(): object | null {
      if (trap === 'getPrototypeOf') {
        throw new Error('hostile trap: getPrototypeOf');
      }
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(): ArrayLike<string | symbol> {
      if (trap === 'ownKeys') {
        throw new Error('hostile trap: ownKeys');
      }
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_target, key): PropertyDescriptor | undefined {
      if (trap === 'descriptor' && hitsOnly(key)) {
        throw new Error('hostile trap: getOwnPropertyDescriptor');
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(_target, key, receiver): unknown {
      if (trap === 'get' && hitsOnly(key)) {
        throw new Error('hostile trap: get');
      }
      return Reflect.get(target, key, receiver);
    },
  }) as Record<string, unknown>;
}
