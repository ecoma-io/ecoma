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
 * ⚠️ Nạp **client-only** (`server: false`): adapter thật dùng `fetch` thô với
 * URL tương đối, và trên runtime server (workerd/Node) lệnh gọi đó không thể
 * chạy — không mang được cookie của request vào một fetch mới và URL tương đối
 * không parse được ngoài browser. Trước Issue #123, lệnh đọc này "thành công"
 * ở SSR vì nó rơi vào mock — đúng đường rò mock mà #123 xoá. Hệ quả được chấp
 * nhận: lần render đầu dùng `DEFAULT_ACCOUNT_LOCALE` + UTC, preference thật áp
 * sau hydrate (hiện tượng đổi một lần, chấp nhận thay vì rò mock hoặc fetch
 * giả thành công). Payload `useAsyncData` vẫn serialize, nên chỉ nạp một lần.
 *
 * Lỗi nạp **không** được làm sập shell: `useAsyncData` giữ lỗi trong `error`
 * của nó và hai state (`stored`, `preferences`) đứng yên ở `undefined` — app
 * rơi về cookie rồi `DEFAULT_ACCOUNT_LOCALE`, đúng như hành vi khi chưa đăng
 * nhập. Khi BFF thật có mặt, `getPreferences()` cho người chưa đăng nhập sẽ
 * trả lỗi hoặc rỗng; khi đó adapter — không phải shell này — là nơi diễn giải.
 */
export function useAccountShellPreferences(): void {
  const adapter = useAccountAdapter();
  const { load } = useAccountPreferences();

  useAsyncData(
    'account-shell-preferences',
    async () => {
      // Hai lời gọi này cùng đọc `adapter.getPreferences()`. Bản mock chỉ là dữ
      // liệu trong bộ nhớ nên chi phí không đáng kể; với BFF thật, việc gộp một
      // fetch thành hai là việc của tầng adapter/hợp đồng — xem handoff của PR.
      await Promise.all([useStoredAccountLocale(adapter), load()]);
    },
    { server: false },
  );
}
