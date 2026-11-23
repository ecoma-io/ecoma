/**
 * Điểm seam duy nhất cho **full-page navigation** (rời SPA) của app.
 *
 * ⚠️ Vì sao không gọi `window.location.assign` trực tiếp tại call-site: jsdom gắn
 * `location` là [LegacyUnforgeable] — accessor non-configurable trên `window`, và
 * phương thức `assign` là own non-configurable trên instance. Ở pool mặc định
 * (mỗi file một context mới) `vi.stubGlobal('location', …)` vẫn hoạt động, nhưng ở
 * pool `vmThreads` (một context dùng chung) descriptor gốc không thể redefine nên
 * stub ném `TypeError: Cannot redefine property: location`. Đi qua hàm gián đoạn
 * này thì test mock được bằng `vi.mock` mà không đụng descriptor nào của jsdom.
 *
 * ⚠️ Tên hàm tránh `navigateTo`: Nuxt auto-import một built-in trùng tên, và một
 * export trùng tên trong `~/utils/**` bị Nuxt coi là override gây cảnh báo
 * NUXT_B6002. Hàm này khác ngữ nghĩa với built-in (full-page navigation rời SPA,
 * không phải router navigation nội bộ) nên không thay thế được built-in.
 *
 * Chỉ hai call-site trong app (shell + CTA của trang lỗi 401); điểm điều hướng
 * duy nhất của UI giữ nguyên bất biến "mọi full navigation đi qua đây".
 */
export function navigateFullPage(url: string): void {
  window.location.assign(url);
}
