import { ref, type Ref } from 'vue';

/**
 * Bốn trạng thái của một trang dữ liệu, mô hình hoá trong **kiểu** chứ không
 * phải bằng cờ rời rạc.
 *
 * `loading` và `error` không mang `value`; `ready` thì bắt buộc có. Nhờ vậy
 * không tồn tại trạng thái vô nghĩa kiểu `loading && error`, và không có cách
 * nào quên xử lý nhánh lỗi — exhaustive switch buộc phải nhìn hết bốn nhánh.
 *
 * `empty` tách riêng khỏi `ready` vì "không có dữ liệu" và "có dữ liệu" cần hai
 * câu chữ khác nhau; gộp chúng là cách phổ biến nhất để một trang trông như đang
 * tải mãi.
 */
export type AsyncState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly value: T };

/**
 * `AsyncState` **không** có nhánh `empty`.
 *
 * Dành cho trang mà dữ liệu là **một** object: profile, preference, trạng thái
 * TOTP, số mã khôi phục còn lại. Những trang đó không có "không có gì để hiển
 * thị" — chúng có hoặc "TOTP đang tắt" hay "TOTP đang bật", và cả hai đều là dữ
 * liệu. Giữ `empty` trong kiểu ở đó là một nhánh template không bao giờ tới mà
 * vẫn phải viết `v-else-if`, và mọi lần sửa sau đó lại phải thêm một kiểm tra nữa
 * cho nhánh chết đó.
 *
 * Thao tác ghi vẫn qua `Result` nên nhánh lỗi không mất: bỏ `empty` là bỏ trạng
 * thái **hiển thị**, không phải đường báo lỗi.
 */
export type NonEmptyAsyncState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly value: T };

/**
 * Nạp dữ liệu vào một `AsyncState`.
 *
 * `isEmpty` do caller quyết định: chỉ caller biết thế nào là rỗng (danh sách
 * không phần tử, hay một object mà mọi trường đều rỗng). Mặc định coi `undefined`,
 * `null` và mảng rỗng là rỗng — `undefined` là cách một adapter báo "không có
 * context nào cho handle này" (`getConsentContext`), và nếu nó rơi vào nhánh
 * `ready` thì template render ra một card trắng trơn: `ready` mang `value:
 * undefined` trong khi chính khối chú thích của kiểu này cam kết `ready` **bắt
 * buộc** có `value`. Caller vẫn truyền `isEmpty` tường minh để thu hẹp thêm.
 *
 * `load` truyền vào chứ không tự gọi adapter, nên test được cả nhánh lỗi lẫn nhánh
 * rỗng mà không cần dựng cả app.
 *
 * ⚠️ `onMounted(run)` là **bắt buộc**, không phải tiện lợi. Không có nó thì
 * `state` đứng yên ở `loading` mãi mãi: nó là `ref` thuần nên lần render đầu (trên
 * SSR) đã đọc nó và không có gì thay đổi sau đó, dẫn tới hydration mismatch và một
 * trang treo vĩnh viễn ở chữ "Đang tải…". Mounted hook chỉ chạy ở client, nên dữ liệu
 * vẫn nằm ngoài đường render của server — server render skeleton, client điền vào.
 */
export function useAsyncState<T>(
  load: () => Promise<T>,
  isEmpty: (value: T) => false,
): {
  readonly state: Ref<NonEmptyAsyncState<T>>;
  readonly reload: () => Promise<void>;
};
export function useAsyncState<T>(
  load: () => Promise<T>,
  isEmpty?: (value: T) => boolean,
): {
  readonly state: Ref<AsyncState<T>>;
  readonly reload: () => Promise<void>;
};
export function useAsyncState<T>(
  load: () => Promise<T>,
  isEmpty: (value: T) => boolean = (value) =>
    value === undefined ||
    value === null ||
    (Array.isArray(value) && (value as readonly unknown[]).length === 0),
): {
  readonly state: Ref<AsyncState<T>>;
  readonly reload: () => Promise<void>;
} {
  const state = ref<AsyncState<T>>({ kind: 'loading' }) as Ref<AsyncState<T>>;

  async function run(): Promise<void> {
    state.value = { kind: 'loading' };
    try {
      const value = await load();
      state.value = isEmpty(value) ? { kind: 'empty' } : { kind: 'ready', value };
    } catch (error) {
      // `String(error)` để không bao giờ render `[object Object]`; lỗi gốc vẫn
      // còn trong console của devtools.
      state.value = {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  onMounted(run);

  return { state, reload: run };
}
