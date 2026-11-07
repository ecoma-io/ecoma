<script setup lang="ts">
/**
 * Dialog xác nhận cho hành động phá huỷ — gỡ email, thu hồi session, gỡ ứng
 * dụng, nộp privacy request.
 *
 * Dùng `<dialog>` gốc của HTML (`showModal()`) thay vì tự dựng overlay: nó cho
 * sẵn `Escape` để đóng, focus trap, và `::backdrop`. Tự dựng bằng `div` nghĩa là
 * tự viết lại ba thứ đó, và thường làm sai ít nhất một.
 *
 * ⚠️ **Vì sao không dùng `<noscript>` hay fallback thủ công:** `showModal()` chỉ
 * chạy client-side. Trong JSX/template Vue không có fallback no-JS ở đây, nhưng
 * điều quan trọng là: **nút xác nhận chính** chỉ tồn tại sau khi JS chạy, nên
 * server render ra một `<dialog>` đã đóng. Người dùng không có JS nhìn thấy
 * trang với nút "Xoá" bấm không được — đó là hành vi an toàn (không hành động
 * phá huỷ nào chạy khi không có bảo vệ), và được ghi lại ở đây để không ai đọc
 * nó là sự cố.
 *
 * ⚠️ `aria-modal`/`aria-labelledby` không khai tay vì `showModal()` đã đặt ngữ
 * nghĩa modal vào accessibility tree; khai lại chỉ là markup thừa.
 */
/**
 * ⚠️ Chín prop này là lý do `vue/max-props` bị tắt ở đây: đóng gói chúng vào
 * một object (`{ labels: {…}, handlers: {…} }`) là tự viết lại `vue/require-typed-ref`
 * và làm call-site dài hơn ở sáu trang, để đổi lấy một con số rule.
 */
const {
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  /** `dialog` mở hay không — hai chiều, để caller đóng được sau khi xác nhận. */
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** Nhãn của nút phá huỷ khi hành động không phục hồi được. */
  readonly danger?: boolean;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}>();

const dialog = ref<HTMLDialogElement | undefined>(undefined);

watch(
  () => open,
  async (isOpen) => {
    const element = dialog.value;
    if (!element) {
      return;
    }
    // `showModal()` ném `InvalidStateError` nếu dialog đã mở; `close()` ném nếu
    // đã đóng. So trạng thái thay vì bắt lỗi để không nuốt lỗi thật của lần gọi
    // đầu tiên.
    if (isOpen && !element.open) {
      await element.showModal();
    } else if (!isOpen && element.open) {
      element.close();
    }
  },
  { immediate: true },
);
</script>

<template>
  <dialog
    ref="dialog"
    class="m-auto w-full max-w-md rounded-card border border-line bg-surface-raised p-0 text-foam backdrop:bg-canvas-deep/40"
    aria-labelledby="account-dialog-title"
    aria-describedby="account-dialog-description"
    data-testid="account-dialog"
    @cancel="onCancel"
  >
    <div class="px-5 py-4">
      <h2 id="account-dialog-title" class="text-base font-semibold">{{ title }}</h2>
      <p id="account-dialog-description" class="mt-2 text-sm text-muted">{{ description }}</p>
    </div>
    <div class="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
      <button
        type="button"
        class="account-button-secondary"
        data-testid="account-dialog-cancel"
        @click="onCancel"
      >
        {{ cancelLabel }}
      </button>
      <button
        type="button"
        :class="danger ? 'account-button-danger' : 'account-button-primary'"
        :disabled="confirmDisabled"
        data-testid="account-dialog-confirm"
        @click="onConfirm"
      >
        {{ confirmLabel }}
      </button>
    </div>
  </dialog>
</template>
