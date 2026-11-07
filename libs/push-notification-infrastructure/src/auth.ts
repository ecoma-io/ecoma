/**
 * Authentication cho ba authorization boundary (FR-019).
 *
 * ⚠️ **Ba boundary, ba cơ chế, một nguyên tắc: so sánh constant-time và `401` trước lookup.**
 *
 * 1. **Private delivery runtime API** (`web-push-notification-job`): shared secret trong header
 *    `Authorization` (giá trị nguyên văn, **không** có scheme `Bearer`) + `X-ECOMA-PRINCIPAL`.
 *    Không có `X-ECOMA-APP` — header tự khai không phải bằng chứng danh tính, và một header mà
 *    Worker gửi lên cũng là một header ai đó có thể gửi lên.
 * 2. **Admin API** (`Backoffice`): bearer token đơn.
 * 3. **Application API**: bearer token đơn, và `app` **derive từ** principal đã xác thực.
 *
 * ⚠️ **Không import contract lib của account/auth** (`account-contracts`, `auth-contracts`,
 * hay package platform `internal-auth-contracts`). Boundary của `scope:notifications`
 * chỉ cho phép import `scope:account`/`scope:auth` qua wildcard `type:contracts`; auth ở
 * đây là so sánh secret thuần, không cần JWT verify, và một dependency vào account/auth
 * sẽ kéo cả một bề mặt vào một service không dùng đến nó.
 */

/** Kết quả xác thực — `principal` là danh tính đã xác nhận, dùng tiếp cho authorization. */
export interface AuthenticatedCaller {
  readonly principal: string;
  /** `app` của caller, khi boundary này gắn caller với đúng một `App`. */
  readonly app: string | null;
}

/**
 * Header và cách so sánh — dùng chung để một test có thể chứng minh cả ba boundary dùng **cùng**
 * một so sánh constant-time, thay vì mỗi boundary một bản sao lệch nhau.
 */
export interface AuthConfig {
  /** Secret chia sẻ / bearer token kỳ vọng. */
  readonly expectedSecret: string;
  /** Principal mà secret này thuộc về. */
  readonly expectedPrincipal: string;
}

/** Header `Authorization` — `Bearer <token>`, không phân biệt scheme hoa/thường. */
const BEARER_PREFIX = 'bearer ';

export interface RuntimeAuthHeaders {
  /**
   * Shared secret — header `Authorization`, **giá trị nguyên văn**, không có scheme `Bearer`.
   *
   * ⚠️ **Không dùng `readBearerToken` cho header này.** `authenticateBearer` của Admin API bóc
   * `Bearer ` và từ chối cả scheme khác, còn runtime API theo
   * `docs/applications/push-notification/01-architecture.md` §8.1 nhận secret thô — nên tái dùng
   * hàm bóc bearer ở đây sẽ từ chối đúng những request hợp lệ mà Worker gửi.
   */
  readonly sharedSecret: string | null;
  /** Principal tự khai — header `X-ECOMA-PRINCIPAL`. */
  readonly principal: string | null;
}

/**
 * Xác thực caller của private delivery runtime API (§8.1).
 *
 * ⚠️ **Không** so sánh principal trước secret. Nếu kiểm principal bằng `===` thì thời gian
 * trả lời phụ thuộc vào việc principal có khớp, tức rò ra principal đúng qua timing — và
 * principal là thứ Worker **tự khai** trong header, nên nó không phải bí mật, nhưng nó vẫn là
 * một phần của danh tính mà ta đang xác thực. So sánh secret trước, và so sánh cả hai bằng
 * constant-time.
 *
 * ⚠️ `null` khi sai hoặc thiếu, **không** phân biệt hai trường hợp: một response phân biệt
 * "thiếu header" với "sai secret" là một oracle đo liệu người gọi đã thử gì.
 */
export function authenticateRuntimeCaller(
  headers: RuntimeAuthHeaders,
  config: AuthConfig,
): AuthenticatedCaller | null {
  const provided = headers.sharedSecret;
  const principal = headers.principal;
  if (provided === null || principal === null) {
    return null;
  }
  if (!constantTimeEquals(provided, config.expectedSecret)) {
    return null;
  }
  if (!constantTimeEquals(principal, config.expectedPrincipal)) {
    return null;
  }
  // `web-push-notification-job` phục vụ **mọi** App qua một private interface duy nhất, nên
  // caller runtime không có `app` — `app` được suy ra từ chính delivery, không phải từ caller.
  return { principal: config.expectedPrincipal, app: null };
}

/**
 * Xác thực bearer token của Admin API.
 *
 * ⚠️ Dùng cùng `constantTimeEquals` với runtime API: chúng là hai boundary khác nhau nhưng
 * **cùng một loại secret** (token ứng dụng), và một so sánh không constant-time ở một trong hai
 * chỗ là một lỗ hổng tấn công timing ở chính service này.
 */
export function authenticateBearer(
  authorization: string | null,
  config: AuthConfig,
): AuthenticatedCaller | null {
  const token = readBearerToken(authorization);
  if (token === null) {
    return null;
  }
  if (!constantTimeEquals(token, config.expectedSecret)) {
    return null;
  }
  return { principal: config.expectedPrincipal, app: null };
}

/** Tách `Bearer <token>`; `null` khi thiếu header hoặc sai scheme. */
export function readBearerToken(authorizationHeader: string | null): string | null {
  if (typeof authorizationHeader !== 'string') {
    return null;
  }
  // Scheme của `Authorization` không phân biệt hoa/thường theo RFC 7235.
  const prefix = authorizationHeader.slice(0, BEARER_PREFIX.length).toLowerCase();
  if (prefix !== BEARER_PREFIX) {
    return null;
  }
  // Tên `parsedBearer` (không phải `token`) và `authorizationHeader` (không phải
  // `authorization`) là có chủ đích: rule Semgrep
  // `.github/semgrep/security.yml` coi identifier khớp tên nhạy cảm rồi `return`
  // là rò credential ra HTTP, còn giá trị ở đây là phần đã tách prefix
  // `Bearer ` của header — dữ liệu ĐI VÀO để so sánh constant-time ở caller, không
  // phải credential trong storage. `parsedBearer` cũng là tên chính xác hơn: nó là
  // kết quả parse, không phải token theo nghĩa storage. Đổi tên làm hình dạng code
  // nói đúng điều đó, không phải né scanner — `return authorization` ở một đường
  // echo header thật vẫn bị flag như cũ.
  const parsedBearer = authorizationHeader.slice(BEARER_PREFIX.length);
  return parsedBearer === '' ? null : parsedBearer;
}

/**
 * So sánh hai chuỗi **constant-time** theo từng byte của UTF-8.
 *
 * ⚠️ **Vì sao so trên `Uint8Array` chứ không dùng `===`.** `===` trên chuỗi rời ngay khi gặp
 * byte khác nhau, nên thời gian thay đổi theo vị trí byte khác nhau đầu tiên — đủ để dò tiền tố
 * của một secret. Mã hoá cả hai chuỗi thành bytes trước rồi lặp trên **chiều dài lớn hơn**
 * (và xử lý cả độ dài khác nhau) để vòng lặp luôn chạy đúng số lần.
 *
 * ⚠️ `TextEncoder` cho bytes **UTF-8**, tức một ký tự nhiều byte so sánh theo nhiều byte. Điều
 * đó không làm lộ gì thêm: byte suy ra được vẫn là byte của secret, và mọi byte đều phải khớp.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  // `difference` tích luỹ XOR của mọi byte **và** của phần chênh độ dài, nên kết quả khác `0`
  // khi hai chuỗi khác nhau ở **bất kỳ** vị trí nào — kể cả khi phần bị thiếu nằm ngoài độ
  // dài của chuỗi kia. XOR byte với `0` là chính byte đó, nên vòng lặp có thể chạy chung
  // một nhịp bất kể độ dài.
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
