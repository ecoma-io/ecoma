/**
 * Setup của test `apps/account`.
 *
 * ⚠️ Import `nuxt-runtime-bridge` ở **đây**, không phải trong `harness.ts`: vitest nạp
 * setup file trước mọi test file, nên global của Nuxt đã có mặt trước khi module app
 * đầu tiên được import. Gộp vào `harness.ts` thì nó chỉ chạy khi spec đã nạp xong —
 * quá muộn cho các composable gọi `useState()` ở phạm vi module.
 *
 * Phần còn lại là reset state giữa các test. `useState` của bridge **không** tự
 * xoá: composable gọi nó ở phạm vi module, nên store phải sống lâu hơn một lần mount.
 * Đây là chỗ duy nhất được phép xoá, và nó xoá cả cookie lẫn `head` — một test để lại
 * `account-locale` không được làm test sau đọc nhầm.
 */
import { beforeEach } from 'vitest';

import { resetAccountGlobals } from './nuxt-runtime-bridge';

/**
 * Polyfill `showModal`/`close` cho `<dialog>` — jsdom 30 chưa implement hai method
 * này (chỉ có property `open`). `AccountConfirmDialog` gọi chúng trong `watch(open)`,
 * nên không có polyfill thì mở dialog ném `TypeError` và test không đi tới được
 * assertion. Polyfill chỉ set property `open`: ngữ nghĩa modal (focus trap, Escape)
 * là việc của browser thật, không phải việc test cần tái hiện.
 */
function dialogShowModal(this: HTMLDialogElement): void {
  this.open = true;
}

function dialogClose(this: HTMLDialogElement): void {
  this.open = false;
}

if (typeof globalThis.HTMLDialogElement !== 'undefined') {
  const proto = globalThis.HTMLDialogElement.prototype as HTMLDialogElement;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = dialogShowModal;
  }
  if (typeof proto.close !== 'function') {
    proto.close = dialogClose;
  }
}

beforeEach(resetAccountGlobals);

export { accountStores, i18n } from './nuxt-runtime-bridge';
