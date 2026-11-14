import { ref, type Ref } from 'vue';

/**
 * Bốn trạng thái của một trang dữ liệu, mô hình hoá trong **kiểu** chứ không
 * phải bằng cờ rời rạc.
 *
 * Deliberate duplication của
 * `apps/pact-broker-app/app/composables/use-async-state.ts` (module boundary
 * cấm import chéo giữa app, `docs/architecture/05-code-architecture.md` §7).
 *
 * `loading` và `error` không mang `value`; `ready` thì bắt buộc có. `empty`
 * tách riêng khỏi `ready` vì "không có dữ liệu" và "có dữ liệu" cần hai câu
 * chữ khác nhau.
 *
 * ⚠️ **Chỉ request mới nhất được ghi vào `state`.** `reload` là hàm công khai
 * và `onMounted` gọi nó, nên hai request có thể cùng bay. Request bị thay thế
 * không ghi gì, kể cả trạng thái lỗi.
 *
 * ⚠️ `onMounted(run)` là bắt buộc: `state` là `ref` thuần, không có lần nạp
 * nào chạy thì trang treo vĩnh viễn ở trạng thái tải. Mounted hook chỉ chạy ở
 * client — đúng cho app non-SSR này.
 */
export type AsyncState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly value: T };

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

  // Số thứ tự của request mới nhất — xem ghi chú ở JSDoc của kiểu.
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
      state.value = {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  onMounted(run);

  return { state, reload: run };
}
