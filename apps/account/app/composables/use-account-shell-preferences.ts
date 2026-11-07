import { useAsyncData } from '#app';
import { useAccountAdapter } from './use-account-adapter';
import { useAccountPreferences } from './use-account-preferences';
import { useStoredAccountLocale } from './use-account-locale';

/**
 * Nạp preference của tài khoản **một lần ở shell**, cho mọi trang.
 *
 * ⚠️ Không có điểm nối này thì hai thứ là code chết: `useStoredAccountLocale`
 * (không call-site trong `app/`) và `useAccountPreferences().load()` (chỉ có
 * `reload()` được `/preferences` gọi sau khi lưu). Hệ quả: preference đã lưu không
 * bao giờ thắng cookie lúc tải trang — quy tắc ưu tiên dán ngay trong
 * `useAccountLocale` không chạy — và `formatDateTime` trên `/sessions`,
 * `/applications`, `/security`, `/privacy` luôn rơi về `DEFAULT_ACCOUNT_LOCALE` +
 * `UTC` dù tài khoản đã lưu `Asia/Ho_Chi_Minh`.
 *
 * ⚠️ `useAsyncData` chứ không phải fire-and-forget: trong SSR nó **chặn render**
 * cho tới khi nạp xong, nên locale và timezone đã lưu có mặt ngay ở HTML đầu
 * tiên. Bỏ qua bước này thì server render tiếng Anh/UTC rồi client đổi sang
 * vi/ICT sau hydrate — đúng cảnh báo "chuỗi render hai lần khác nhau" trong
 * `useAccountFormat`. Payload cũng được serialize, nên client không nạp lại.
 *
 * ⚠️ Lỗi nạp **không** được làm sập shell: `useAsyncData` giữ lỗi trong `error`
 * của nó và hai state (`stored`, `preferences`) đứng yên ở `undefined` — app rơi
 * về cookie rồi `DEFAULT_ACCOUNT_LOCALE`, đúng như hành vi khi chưa đăng nhập.
 * Khi BFF thật có mặt, `getPreferences()` cho người chưa đăng nhập sẽ trả lỗi
 * hoặc rỗng; khi đó adapter — không phải shell này — là nơi diễn giải.
 */
export function useAccountShellPreferences(): void {
  const adapter = useAccountAdapter();
  const { load } = useAccountPreferences();

  useAsyncData('account-shell-preferences', async () => {
    // Hai lời gọi này cùng đọc `adapter.getPreferences()`. Bản mock chỉ là dữ
    // liệu trong bộ nhớ nên chi phí không đáng kể; với BFF thật, việc gộp một
    // fetch thành hai là việc của tầng adapter/hợp đồng — xem handoff của PR.
    await Promise.all([useStoredAccountLocale(adapter), load()]);
  });
}
