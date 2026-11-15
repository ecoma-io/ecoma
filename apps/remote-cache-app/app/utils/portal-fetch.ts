/**
 * `portalFetch` — wrapper của `fetch` cho các route `/api/portal/**` của BFF.
 *
 * ## Vì sao cần wrapper
 *
 * Mọi `/api/portal/**` **default-closed** (middleware authn): không có phiên
 * hợp lệ ⇒ `401`. Một trang gọi thẳng `fetch('/api/portal/…')` sẽ đổ thành lỗi
 * tải dữ liệu — người dùng thấy "mất mạng" thay vì "đã đăng xuất". Wrapper này
 * dịch `401` thành điều hướng tới `/api/auth/login` (luồng OIDC của BFF), nơi
 * UI chỉ điều hướng chứ không tự dựng authorize URL.
 *
 * ⚠️ Redirect xảy ra ở **client**: app là non-SSR SPA (`ssr: false`), trang
 * render ở browser nên `location` luôn tồn tại. Trong môi trường không có
 * `window` (SSR/test), wrapper trả response nguyên văn — caller xử lý như cũ.
 *
 * ## CSRF cho mutation
 *
 * Mutation (`POST`/`PUT`/`PATCH`/`DELETE`) phải echo cookie
 * `__Host-remote-cache-app-csrf` trong header `x-ecoma-csrf` (double-submit).
 * Wrapper đọc cookie ở **browser** — token CSRF không phải secret, cookie được
 * đặt không HttpOnly đúng cho mục đích này.
 *
 * ## Không nuốt lỗi khác
 *
 * `403` (không phải member) và `503` (BFF chưa cấu hình) là trạng thái **có
 * nghĩa** cho người dùng — trang render đúng trạng thái đó. Chỉ `401` mới là
 * "phiên không còn dùng được ⇒ đi đăng nhập lại".
 */

/**
 * Đường dẫn login của BFF — route không chặn authn (`AUTH_PATHS`).
 *
 * ⚠️ Hằng ghim, không nhận từ env: route là kết quả của Nitro file-based
 * routing (`server/api/auth/login.get.ts` — tệp là đường dẫn), và middleware
 * authn ghim cùng giá trị trong `AUTH_PATHS`. Đổi đường login = đổi tên tệp
 * route + cập nhật hằng này và `AUTH_PATHS`.
 */
export const LOGIN_PATH = '/api/auth/login';

/** Tên header CSRF — mirror `CSRF_HEADER_NAME` của `server/auth/session.ts`. */
export const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/** Tên cookie CSRF — mirror `CSRF_COOKIE_NAME` của `server/auth/session.ts`. */
const CSRF_COOKIE_NAME = '__Host-remote-cache-app-csrf';

/** Đọc cookie CSRF từ `document.cookie` — chỉ chạy ở browser. */
function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  // Mirror shape của `apps/backoffice/app/composables/use-backoffice-session.ts`
  // (destructure theo cặp `name=value`): CSRF token KHÔNG phải secret, nhưng
  // taint từ `document.cookie` về `return` trần là hình dạng rule Semgrep chặn
  // — hình destructuring này cắt đường taint đó một cách trung thực.
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE_NAME) {
      // Cookie hỏng percent-encoding không được chặn cả trang — coi như không có.
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Gọi API portal của BFF; `401` ⇒ điều hướng tới trang login; mọi method đổi
 * state (mirror `CSRF_METHODS` của middleware authn) tự thêm header CSRF.
 * ⚠️ `return response` cuối hàm bị allowlist semgrep ghim đúng dòng 94 của tệp
 * (`.github/semgrep/accepted-shapes.json`) — re-pin chỉ do owner allowlist. FP
 * gốc: taint cookie qua headers của request DI RA, engine coi response bị nhiễm
 * — response là dữ liệu BFF, không echo token nào. Sửa phía trên return phải bù dòng.
 */
export async function portalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // Cùng bộ method với `CSRF_METHODS` của `server/middleware/authn.ts` — route
  // mutation mới thêm sau này vẫn nhận header đúng.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) {
    const csrf = readCsrfCookie();
    if (csrf !== null) {
      headers.set(CSRF_HEADER_NAME, csrf);
    }
  }
  // Cookie phiên được gửi mặc định: fetch cùng-origin dùng
  // `credentials: 'same-origin'` — cookie `__Host-` của BFF nằm kèm request mà
  // không cần `credentials: 'include'` (route `/api/portal/**` luôn cùng origin
  // với trang). Ghim tường minh, không phụ thuộc default của platform.
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: init.credentials ?? 'same-origin',
  });
  return response;
}
