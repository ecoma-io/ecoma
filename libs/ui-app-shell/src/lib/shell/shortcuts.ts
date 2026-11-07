import { onMounted, onScopeDispose, ref, type Ref } from 'vue';

/**
 * Ký hiệu phím Meta của nền tảng đang chạy: `⌘` trên macOS, `Ctrl` ở nơi khác.
 *
 * Giá trị khởi tạo là `Ctrl` và chỉ được đọc lại **trong `onMounted`** — tức là
 * sau hydration. Nếu đọc `navigator` ngay khi render, HTML do SSR gửi (`Ctrl`)
 * sẽ khác HTML của lần render đầu ở client (`⌘` trên máy Mac) và Vue báo
 * hydration mismatch; ở đây chỉ có một lần cập nhật sau khi mount, và nó là một
 * thay đổi state bình thường.
 */
export function useAppShellMetaSymbol(): Ref<string> {
  const symbol = ref('Ctrl');

  onMounted(() => {
    const isMac = /Macintosh|Mac OS X/iu.test(navigator.userAgent);
    symbol.value = isMac ? '⌘' : 'Ctrl';
  });

  return symbol;
}

/**
 * Gắn phím tắt mở command palette (⌘/Ctrl + K) vào trạng thái `paletteOpen` của
 * shell.
 *
 * Một nguồn duy nhất cho trạng thái palette: nút trong sidebar và phím tắt cùng
 * ghi vào ref này, nên không thể lệch nhau. Phím tắt do shell gắn (một lần, ở
 * component gốc) chứ không phải ở nút — nút có thể bị ẩn khi sidebar thu gọn.
 */
export function useAppShellCommandPaletteShortcut(paletteOpen: Ref<boolean>): void {
  function onKeydown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown);
  });

  onScopeDispose(() => {
    window.removeEventListener('keydown', onKeydown);
  });
}
