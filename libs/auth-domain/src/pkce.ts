import { OAuthProtocolError } from './errors';

/**
 * PKCE S256 — bắt buộc với MỌI client (FR-010). `plain` bị từ chối.
 *
 * Lý do phải chặn `plain` chứ không phải "khuyến nghị": RFC 7636 chỉ định
 * `plain` dành cho client không thể làm S256, và nó tương đương việc chống
 * chặn authorization code trở thành không có gì — attacker chặn được code thì
 * dùng luôn được verifier. Với một authorization server web, đó là mất tác
 * dụng của PKCE (T-03).
 */

/** Thuật toán PKCE duy nhất được chấp nhận. */
export const SUPPORTED_CODE_CHALLENGE_METHOD = 'S256' as const;

/** Độ dài `code_verifier` hợp lệ theo RFC 7636 §4.1: 43..128 ký tự. */
export const MIN_CODE_VERIFIER_LENGTH = 43;
export const MAX_CODE_VERIFIER_LENGTH = 128;

/**
 * RFC 7636 §4.1: `code_verifier` là chuỗi 43..128 ký tự gồm
 * `[A-Za-z0-9-._~]`.
 */
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]+$/u;

/**
 * RFC 7636 §4.2: `code_challenge` là BASE64URL(SHA256(ASCII(code_verifier)))
 * — luôn đúng 43 ký tự base64url KHÔNG padding.
 */
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Kiểm tra `code_verifier` từ phía client.
 *
 * Gọi ở `/token`, SAU khi tra code. Sai định dạng → `invalid_request`;
 * sai giá trị → `invalid_grant`. Phân biệt này có chủ ý: định dạng sai là lỗi
 * của request, còn giá trị sai là bằng chứng code đã bị chiếm hoặc bị lạm
 * dụng.
 */
export function assertValidCodeVerifier(codeVerifier: string): void {
  if (
    codeVerifier.length < MIN_CODE_VERIFIER_LENGTH ||
    codeVerifier.length > MAX_CODE_VERIFIER_LENGTH ||
    !CODE_VERIFIER_RE.test(codeVerifier)
  ) {
    throw OAuthProtocolError.directInvalidRequest('code_verifier khong dung dinh dang RFC 7636');
  }
}

/** Tính `code_challenge` từ `code_verifier` — phía server khi cần kiểm chứng lại. */
export async function computeS256Challenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier) as unknown as BufferSource,
  );

  let binary = '';
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Kết quả kiểm tra `code_challenge` ở `/authorize`. */
export interface ParsedCodeChallenge {
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Kiểm tra tham số PKCE ở `/authorize`.
 *
 * ⚠️ `code_challenge` thiếu HOẶC `code_challenge_method` thiếu đều bị từ chối
 * — không có trường hợp nào coi là "mặc định S256". Mặc định ngầm là đường để
 * downgrade: client cũ không gửi method, server mặc định cho nó qua.
 */
export function parseCodeChallenge(params: {
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  /**
   * Liệu lỗi ở đây được phép redirect tới `redirect_uri` không.
   *
   * ⚠️ Chỉ `true` KHI và CHỈ KHI `redirect_uri` đã được xác minh khớp bản đăng
   * ký. `parseAuthorizationRequest` truyền `false` vì tại thời điểm đó chưa có
   * bước xác minh nào cả. Mặc định là `false` để một lời gọi quên truyền cờ
   * vẫn fail-safe thay vì trở thành open redirect.
   */
  redirectable?: boolean;
}): ParsedCodeChallenge {
  const { codeChallenge, codeChallengeMethod } = params;
  const fail = (detail: string): OAuthProtocolError =>
    params.redirectable === true
      ? OAuthProtocolError.invalidRequest(detail)
      : OAuthProtocolError.directInvalidRequest(detail);

  if (codeChallengeMethod === undefined) {
    throw fail('thieu code_challenge_method');
  }
  if (codeChallengeMethod !== SUPPORTED_CODE_CHALLENGE_METHOD) {
    throw fail(`code_challenge_method phai la ${SUPPORTED_CODE_CHALLENGE_METHOD}`);
  }
  if (codeChallenge === undefined) {
    throw fail('thieu code_challenge');
  }
  if (!CODE_CHALLENGE_RE.test(codeChallenge)) {
    throw fail('code_challenge khong dung dinh dang S256');
  }

  return { codeChallenge, codeChallengeMethod: SUPPORTED_CODE_CHALLENGE_METHOD };
}

/**
 * So khớp `code_verifier` với `code_challenge` đã lưu trong transaction.
 *
 * So KHÔNG hằng thời gian ở đây: `code_challenge` không phải bí mật — nó nằm
 * trong URL `/authorize` và đã bị lộ qua `Referer`/log từ lâu. Tính đúng
 * base64url 43 ký tự từ SHA-256 rồi so bằng `===` là an toàn; so hằng thời
 * gian trên giá trị công khai chỉ tốn thêm mà không thêm bảo mật.
 */
export async function verifyCodeChallenge(params: {
  codeVerifier: string;
  expectedChallenge: string;
}): Promise<boolean> {
  const actual = await computeS256Challenge(params.codeVerifier);
  return actual === params.expectedChallenge;
}
