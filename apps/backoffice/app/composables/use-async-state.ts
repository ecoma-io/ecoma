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
 * cần hiển thị cố định. Những trang đó không có "không có gì để hiển thị" — họ
 * có dữ liệu hoặc một trạng thái hợp lệ. Giữ `empty` trong kiểu ở đó chỉ làm
 * template phải xử lý nhánh chết. Tách riêng cho trường hợp danh sách thuần tuý.
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
 * context nào cho handle này", và nếu nó rơi vào nhánh
 * `ready` thì template render ra một card trắng trơn: `ready` mang `value:
 * undefined` trong khi chính khối chú thích của kiểu này cam kết `ready` **bắt
 * buộc** có `value`. Caller vẫn truyền `isEmpty` tường minh để thu hẹp thêm.
 *
 * `load` truyền vào chứ không tự gọi adapter, nên test được cả nhánh lỗi lẫn nhánh
 * rỗng mà không cần dựng cả app.
 *
 * ⚠️ **Chỉ request mới nhất được ghi vào `state`.** `reload` là hàm công khai và
 * `onMounted` gọi nó, nên hai request có thể cùng bay (ví dụ bấm "thử lại" đúng lúc
 * một lần nạp khác đang chờ). Không có luật này thì một request **cũ** hoàn tất muộn
 * sẽ ghi đè kết quả mới hơn, hoặc tệ hơn: dựng lại một `error` đã lỗi thời sau khi
 * request mới đã thành công — tức là UI hiện lỗi cho một lần nạp đã được thay thế.
 * Request bị thay thế **không** ghi gì, kể cả trạng thái lỗi.
 *
 * ⚠️ `onMounted(run)` là **bắt buộc**, không phải tiện lợi. Không có nó thì
 * `state` đứng yên ở `loading` mãi mãi: `state` là `ref` thuần và không có gì ghi vào
 * nó sau lần render đầu, nên trang treo vĩnh viễn ở chữ "Đang tải…" — không có lần nạp
 * nào chạy để đưa nó sang trạng thái khác. Mounted hook chỉ chạy ở client, nên dữ liệu
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

  // Số thứ tự của request mới nhất. Chỉ request mang đúng số này được ghi vào
  // `state`; mọi request bị thay thế kết thúc im lặng — xem ghi chú "Chỉ request mới
  // nhất được ghi vào `state`" ở JSDoc của hàm này.
  let latest = 0;

  async function run(): Promise<void> {
    const request = (latest += 1);
    state.value = { kind: 'loading' };
    try {
      const value = await load();
      if (request !== latest) {
        return;
      }
      state.value = isEmpty(value) ? { kind: 'empty' } : { kind: 'ready', value };
    } catch (error) {
      if (request !== latest) {
        return;
      }
      // `AsyncState.error` mang **chuỗi**, không mang `unknown`: một lần reject bằng
      // giá trị không phải `Error` (adapter của bên thứ ba) vẫn phải render được, nên
      // nhánh đó chuyển qua `String(error)`, kể cả khi kết quả là "[object Object]".
      state.value = {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  onMounted(run);

  return { state, reload: run };
}
