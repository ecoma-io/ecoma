/**
 * `brokerFetch` — wrapper của `fetch` cho các route `/api/broker/**` của BFF.
 *
 * ## Vì sao cần wrapper
 *
 * Từ #206 (ADR-0031 §2), mọi `/api/broker/**` **default-closed**: không có phiên
 * hợp lệ ⇒ `401`. Một trang gọi thẳng `fetch('/api/broker/…')` sẽ đổ thành
 * lỗi tải dữ liệu — người dùng thấy "mất mạng" thay vì "đã đăng xuất". Wrapper
 * này dịch `401` thành điều hướng tới `/api/auth/login` (luồng OIDC của BFF),
 * nơi UI chỉ điều hướng chứ không tự dựng authorize URL (ADR-0031 §2).
 *
 * ⚠️ Redirect xảy ra ở **client**: app là non-SSR SPA (`ssr: false`), trang
 * render ở browser nên `location` luôn tồn tại. Trong môi trường không có
 * `window` (SSR/test), wrapper trả response nguyên văn — caller xử lý như cũ.
 *
 * ## Không nuốt lỗi khác
 *
 * `403` (không đủ quyền) và `503` (BFF chưa cấu hình) là trạng thái **có
 * nghĩa** cho người dùng — trang render "không đủ quyền"/"chưa cấu hình".
 * Chỉ `401` mới là "phiên không còn dùng được ⇒ đi đăng nhập lại".
 */

/** Đường dẫn login của BFF — route không chặn authn (`AUTH_PATHS`). */
export const LOGIN_PATH = '/api/auth/login';

/**
 * Gọi API của BFF; `401` ⇒ điều hướng tới trang login.
 *
 * @param path Path của BFF, ví dụ `/api/broker/pacts`.
 * @param init Init tuỳ chọn cho `fetch`.
 * @returns Response của BFF (kể cả `401` khi không có `window`).
 */
export async function brokerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, init);
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.assign(LOGIN_PATH);
  }
  return response;
}
