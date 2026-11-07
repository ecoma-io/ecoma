import { OAuthProtocolError } from './errors';

/**
 * Exact redirect URI matching (FR-002, T-04).
 *
 * ⚠️ Đây là hàm so khớp duy nhất được phép dùng trong cả repo. Không có
 * `startsWith`, không có so sánh "bỏ qua query", không có dựng lại URL rồi
 * so `origin`.
 *
 * So khớp EXACT là toàn bộ ý nghĩa của đăng ký redirect URI. Chỉ cần một so
 * khớp lỏng, các đòn tấn công sau mở ra ngay:
 *
 * - Prefix: đăng ký `https://app.example/cb` → khớp được
 *   `https://app.example/cb-attacker.example/`. Prefix match trên *đường dẫn*
 *   không an toàn vì ranh giới nằm ở `/`, không phải ở ký tự kế tiếp.
 * - Bỏ qua query: đăng ký `https://app.example/cb` → khớp được
 *   `https://app.example/cb?next=https://evil.example`. Nếu app đó có tham số
 *   `next`, kẻ tấn công điều khiển được redirect tiếp.
 * - Bỏ qua fragment: `redirect_uri` truyền qua `Location` sẽ bị browser cắt
 *   fragment, nên so khớp có/không fragment tạo ra hai cách ghi cho cùng một
 *   đích.
 * - Chuẩn hoá percent-encoding hoặc chữ hoa/thường: `%2F` vs `/`, `%2e` vs
 *   `.` — mở đường để hai chuỗi khác nhau cùng trỏ tới một đích.
 */

/** Nơi khai báo một redirect URI được phép dùng kèm loopback (native client). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export type RedirectUriPolicy =
  | { kind: 'exact' }
  | { kind: 'loopback-port-variable'; allowedHosts: ReadonlySet<string> };

/**
 * So khớp `redirect_uri` được yêu cầu với URI đã đăng ký.
 *
 * Vòng lặp chỉ dành cho client native (RFC 8252 §7.3): cổng sinh ngẫu nhiên
 * nên chỉ được phép đổi CỔNG, KHÔNG được đổi host hay path. So khớp vẫn là
 * exact trên mọi thành phần còn lại.
 */
export function redirectUriMatches(
  requested: string,
  registered: string,
  policy: RedirectUriPolicy = { kind: 'exact' },
): boolean {
  if (policy.kind === 'loopback-port-variable') {
    return loopbackMatches(requested, registered, policy.allowedHosts);
  }
  return requested === registered;
}

function loopbackMatches(
  requested: string,
  registered: string,
  allowedHosts: ReadonlySet<string>,
): boolean {
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }

  // Scheme phải khớp tuyệt đối: không cho http tấn công https.
  if (req.protocol !== reg.protocol) {
    return false;
  }
  if (!allowedHosts.has(reg.hostname)) {
    return false;
  }
  // Không cho subdomain lách: hostname phải đúng từng ký tự.
  if (req.hostname !== reg.hostname) {
    return false;
  }
  // Path + query + fragment phải khớp exact. Chỉ CỔNG được đổi.
  return `${req.pathname}${req.search}${req.hash}` === `${reg.pathname}${reg.search}${reg.hash}`;
}

/**
 * Kiểm tra một `redirect_uri` có phải dạng hợp lệ về cú pháp không.
 *
 * ⚠️ Chỉ kiểm tra CÚ PHÁP. Đây KHÔNG phải kiểm tra client đã đăng ký URI đó
 * hay chưa — việc đó cần tra `client_redirect_uris`. Giữ hai việc tách bạch
 * vì chúng trả lỗi khác nhau: URI sai cú pháp là `invalid_request`, URI hợp
 * lệ về cú pháp nhưng không đăng ký là `invalid_request` sau khi client đã
 * xác thực — và cả hai đều phải KHÔNG redirect.
 */
export function assertWellFormedRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw OAuthProtocolError.directInvalidRequest('redirect_uri khong phai URL hop le');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw OAuthProtocolError.directInvalidRequest('redirect_uri phai dung http hoac https');
  }

  // Fragment KHÔNG được phép trong redirect URI đăng ký: browser cắt fragment
  // khi chuyển hướng, nên nó không bao giờ tới được server — một URI mang
  // fragment là URI mà không ai thực sự kiểm soát được phần cuối.
  if (url.hash !== '') {
    throw OAuthProtocolError.directInvalidRequest('redirect_uri khong duoc chua fragment');
  }

  // http chỉ hợp lệ cho loopback của client native (RFC 8252).
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw OAuthProtocolError.directInvalidRequest('redirect_uri http chi dung cho loopback');
  }
}
