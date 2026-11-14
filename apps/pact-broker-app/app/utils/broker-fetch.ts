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

/**
 * Đường dẫn login của BFF — route không chặn authn (`AUTH_PATHS`).
 *
 * ⚠️ Hằng ghim, không nhận từ env (review #254): route là kết quả của Nitro
 * file-based routing (`server/api/auth/login.get.ts` — tệp là đường dẫn), và
 * middleware authn ghim cùng giá trị trong `AUTH_PATHS`. Ghi đè qua env chỉ
 * tạo nguồn thứ hai lệch được khỏi cả hai chỗ đó mà không đổi được route thật.
 * Đổi đường login = đổi tên tệp route + cập nhật hằng này và `AUTH_PATHS`.
 */
export const LOGIN_PATH = '/api/auth/login';

/**
 * Gọi API của BFF; `401` ⇒ điều hướng tới trang login.
 *
 * @param path Path của BFF, ví dụ `/api/broker/pacts`.
 * @param init Init tuỳ chọn cho `fetch`.
 * @returns Response của BFF (kể cả `401` khi không có `window`).
 */
export async function brokerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // Cookie phiên được gửi mặc định: fetch cùng-origin dùng
  // `credentials: 'same-origin'` — cookie `__Host-` của BFF nằm kèm request mà
  // không cần `credentials: 'include'` (review #254: bao giờ gọi chéo-origin
  // mới phải bật tường minh; route `/api/broker/**` luôn cùng origin với trang).
  const response = await fetch(path, init);
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.assign(LOGIN_PATH);
  }
  return response;
}
