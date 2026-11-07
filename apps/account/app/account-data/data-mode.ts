/**
 * Quyết định chế độ dữ liệu của `account`, thuần và không phụ thuộc runtime.
 *
 * Đây là **một nơi duy nhất** quyết định mock của data domain có được bật hay
 * không. Tách khỏi composable để unit test được toàn bộ matrix mà không cần
 * dựng Nuxt, và để mọi call-site dùng chung một luật thay vì tự suy luận môi
 * trường.
 *
 * ## Phạm vi của cờ — chỉ data domain
 *
 * Cờ **không** đụng tới các luồng auth: challenge/verify/handoff/consent đã là
 * đường BFF thật ở mọi mode, và không có nhánh nào ở đây mock chúng. Chỉ các
 * thao tác dữ liệu tài khoản (profile, emails, sessions, preferences...)
 * chịu tác động của mode.
 *
 * ## Luật fail-closed — `real` là đáy rơi xuống
 *
 * Giá trị cấu hình chỉ đến từ `runtimeConfig.public.accountDataMode`
 * (`NITRO_PUBLIC_ACCOUNT_DATA_MODE` ở deployment). Không có nhánh nào đọc query
 * param, cookie, header, localStorage hay hostname.
 *
 * `mock` chỉ được bật khi **cả hai** điều kiện cùng đúng:
 *
 * 1. Chuỗi cấu hình đúng bằng `'mock'` — `undefined`, `null`, chuỗi rỗng, sai
 *    chính tả (`'mok'`), sai hoa/thường (`'Mock'`), thừa khoảng trắng
 *    (`'mock '`), non-string (số, boolean, object) đều không.
 * 2. App đang chạy dưới `nuxt dev` (`import.meta.dev`). Một artifact đã build
 *    **không bao giờ** trả `mock`, kể cả khi biến môi trường nói vậy — ở đó
 *    biến sai là lỗi cấu hình, bị chặn ở `server/utils/data-mode-server.ts`
 *    (boot gate + `/ready` 503), không được nuốt ở đây.
 *
 * Không có giá trị nào khác ngoài `mock`/`real`: khác với backoffice
 * (`'unavailable'` khi chưa có đường dữ liệu thật), data domain của `account`
 * đã có BFF thật (`/api/profile`, `/api/emails`, ...), nên fail-closed nghĩa là
 * **rơi về `real`** — không có trạng thái "không có adapter" nào cần biểu diễn.
 */

/** Giá trị duy nhất của `runtimeConfig.public.accountDataMode` bật mock (chỉ dưới dev). */
export const ACCOUNT_DATA_MODE_MOCK = 'mock' as const;

/** Giá trị cấu hình tường minh nghĩa là chạy thật — khai ở lane Production/Staging. */
export const ACCOUNT_DATA_MODE_REAL = 'real' as const;

/**
 * Chế độ dữ liệu đã được phân giải, đầu vào của điểm chọn adapter.
 *
 * Vế `typeof ACCOUNT_DATA_MODE_MOCK` thay vì literal `'mock'`: đổi giá trị hằng
 * thì union đổi theo, nên resolver và composable không thể lệch khỏi hằng mà
 * vẫn typecheck. `'real'` dùng literal vì nó là **đáy fail-closed** chứ không
 * phải giá trị ai phải khai: một cấu hình thiếu/sai rơi về đây mà không cần
 * hằng nào trỏ tới.
 */
export type AccountDataMode = typeof ACCOUNT_DATA_MODE_MOCK | 'real';

/**
 * Phân giải giá trị thô của deployment configuration thành chế độ dữ liệu.
 *
 * @param raw Giá trị đọc từ `runtimeConfig.public.accountDataMode` (rỗng `''` là
 *            "chưa cấu hình" — cùng quy ước với các key khác của `runtimeConfig`).
 * @param isDev Cờ `nuxt dev` (`import.meta.dev`) — phải do call-site truyền để
 *              hàm thuần và test được; artifact truyền `false` bất kỳ nhánh nào.
 * @returns `ACCOUNT_DATA_MODE_MOCK` khi dev chưa được cấu hình (mặc định) hoặc
 *          dev được đặt đúng `'mock'`; mọi tổ hợp khác — gồm cả `mock` được đặt
 *          trong artifact — là `'real'`.
 */
export function resolveAccountDataMode(raw: unknown, isDev: boolean): AccountDataMode {
  // Chưa cấu hình: mặc định theo môi trường — mock chỉ tồn tại dưới dev cho UI
  // dev độc lập; artifact không bao giờ có default mock.
  if (raw === undefined || raw === '') {
    return isDev ? ACCOUNT_DATA_MODE_MOCK : 'real';
  }

  if (raw === ACCOUNT_DATA_MODE_MOCK && isDev) {
    return ACCOUNT_DATA_MODE_MOCK;
  }

  return 'real';
}
