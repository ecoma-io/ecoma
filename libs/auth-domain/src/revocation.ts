/**
 * Mức thu hồi token.
 *
 * ⚠️ Đây là phần dễ nói quá nhất của toàn bộ thiết kế. Vì access token là JWT
 * tự chứa và resource server verify OFFLINE, `auth` KHÔNG có mặt khi token
 * được dùng. Vì vậy:
 *
 * - `auth` có thể CHẶN token MỚI ngay lập tức (kiểm tra tại thời điểm phát
 *   hành, fail-closed — FR-017).
 * - `auth` KHÔNG THỂ rút lại token ĐÃ CẤP. Token đó còn hợp lệ tới khi hết
 *   hạn. Độ trễ = TTL access token. Gọi đó là "thu hồi tức thời" là sai.
 *
 * `token` đặc biệt là câu trả lời duy nhất trung thực cho `/token`:
 */
export type RevocationScope =
  /** Thu hồi một access token cụ thể. */
  | { kind: 'access_token'; accessTokenId: string }
  /** Thu hồi toàn bộ family của một refresh token — dùng khi phát hiện reuse. */
  | { kind: 'refresh_family'; familyId: string }
  /** Thu hồi mọi thứ đã cấp cho một subject — dùng khi khoá ký bị compromise. */
  | { kind: 'subject'; sub: string };

/**
 * Kết quả kiểm tra thu hồi tại thời điểm phát hành.
 *
 * ⚠️ `unknown` KHÔNG phải "chưa bị thu hồi". Vì control plane là
 * `token_revocations` và nó phải trả lời được, nên `unknown` và `unavailable`
 * đều dẫn tới fail-closed (FR-017): không cấp token.
 */
export type RevocationCheckResult = 'not_revoked' | 'revoked' | 'unknown' | 'unavailable';

export function isIssuable(result: RevocationCheckResult): boolean {
  return result === 'not_revoked';
}

/**
 * Bảo đảm chỉ thu hồi được tuyên bố ở điểm kiểm soát phát hành.
 *
 * ⚠️ KHÔNG có "fail closed" nào cho resource server verify offline — không có
 * endpoint `/introspect` trong scope này, và thêm vào chỉ tạo ra ảo giác an toàn.
 * Tài liệu và log KHÔNG được gắn nhãn "fail closed" cho bất kỳ đường offline
 * nào (FR-017c).
 */
export const FAIL_CLOSED_ONLY_AT_ISSUANCE = true;

/**
 * TTL tối đa cho cache kết quả kiểm thu hồi: KHÔNG được dài hơn TTL access
 * token (FR-017b). Cache dài hơn TTL token là tuyên bố thu hồi sớm hơn hệ
 * thống có thể đả bảo.
 */
export function assertRevocationCacheTtl(
  cacheTtlSeconds: number,
  accessTokenTtlSeconds: number,
): void {
  if (cacheTtlSeconds > accessTokenTtlSeconds) {
    throw new Error(
      `TTL cache thu hoi (${cacheTtlSeconds}s) khong duoc dai hon TTL access token (${accessTokenTtlSeconds}s)`,
    );
  }
}
