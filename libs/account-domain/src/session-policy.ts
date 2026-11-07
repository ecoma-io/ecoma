/**
 * Policy thuần cho tuổi session và tuổi bằng chứng xác thực.
 *
 * FR-004b: hành động nhạy cảm cần bằng chứng **đủ mới**, không suy ra từ tuổi session.
 * Vì vậy policy tách hai khái niệm:
 *
 * - **Tuổi session** (`expires_at`) — hết hạn thì session chết, không còn dùng được.
 * - **Tuổi bằng chứng** (`authn_at`) — session còn sống không đồng nghĩa bằng chứng
 *   còn mới; hành động nhạy cảm đòi `authn_at` **đủ gần** thời điểm hiện tại.
 *
 * ⚠️ **Mọi tham số thời gian đều do caller truyền vào** (`now`, `maxAgeSeconds`), và
 * module này không đọc đồng hồ, không I/O. Lý do: (a) tầng domain không được phụ
 * thuộc runtime; (b) **ngưỡng staleness tối đa chưa chốt** (`01-architecture.md` §10),
 * nên thời điểm kích hoạt quyết định giá trị — hằng số hardcode ở đây sẽ biến một
 * quyết định còn mở thành quyết định đã chốt trong code.
 *
 * Assurance được kiểm bằng **ACR membership** (`./acr`), không còn thang bậc:
 * `requiresReauthentication` nhận tập ACR của session và ACR yêu cầu.
 */

import { acrSatisfies, type Acr } from './acr';

/** Trạng thái session tối thiểu mà policy cần để quyết định tuổi. */
export interface SessionExpiry {
  /** Thời điểm hết hạn (epoch ms). */
  readonly expiresAt: number;
  /** Thời điểm thu hồi (epoch ms) — `null` khi session chưa bị thu hồi. */
  readonly revokedAt?: number | null;
}

/**
 * Session đã hết hạn chưa.
 *
 * So sánh là `now >= expiresAt`: tại đúng mốc hết hạn thì session đã chết, không
 * phải "còn đúng một mili giây".
 */
export function isExpired(session: SessionExpiry, now: number): boolean {
  return now >= session.expiresAt;
}

/** Session đã bị thu hồi hay chưa — thu hồi có hiệu lực ngay lập tức. */
export function isRevoked(session: SessionExpiry, now: number): boolean {
  return session.revokedAt !== null && session.revokedAt !== undefined && now >= session.revokedAt;
}

/**
 * Bằng chứng xác thực còn đủ mới hay không (FR-004b).
 *
 * @param authnAt Thời điểm xác thực (epoch ms).
 * @param now Thời điểm hiện tại (epoch ms).
 * @param maxAgeSeconds Ngưỡng tuổi tối đa, tính bằng giây. **Caller cung cấp** —
 *   ngưỡng chưa chốt, xem ghi chú đầu module.
 *
 * @returns `false` nếu `authn_at` nằm trong tương lai: bằng chứng tương lai là dữ
 *   liệu hỏng, không phải bằng chứng "rất mới".
 */
export function isFresh(authnAt: number, now: number, maxAgeSeconds: number): boolean {
  if (authnAt > now) {
    return false;
  }
  const maxAgeMs = maxAgeSeconds * 1000;
  if (maxAgeMs < 0) {
    return false;
  }
  return now - authnAt <= maxAgeMs;
}

/** Yêu cầu xác thực lại tối thiểu cho một hành động nhạy cảm. */
export interface ReauthenticationRule {
  /** ACR mà hành động đòi hỏi — session phải chứa chính xác URN này. */
  readonly requiredAcr: Acr;
  /** Ngưỡng tuổi bằng chứng tối đa, giây. Caller cung cấp. */
  readonly maxAgeSeconds: number;
}

/**
 * Hành động nhạy cảm có cần xác thực lại không (FR-004b, SR-005).
 *
 * Quyết định dựa trên **cả hai** điều kiện, không chỉ một:
 *
 * - Tập ACR của session không chứa ACR yêu cầu → cần xác thực lại, dù `authn_at`
 *   vừa mới (ví dụ đòi `phishing-resistant` cho thao tác nhạy cảm khi session chỉ
 *   có `email-otp`).
 * - `authn_at` quá cũ → cần xác thực lại, dù ACR đủ (ví dụ passkey từ 3 tháng
 *   trước không đủ cho thao tác nhạy cảm).
 *
 * @param sessionAcrs Tập ACR hiện tại của session (tính từ bằng chứng đã vượt qua).
 * @param authnAt Thời điểm xác thực (epoch ms).
 * @param now Thời điểm hiện tại (epoch ms).
 * @param rule Ngưỡng của hành động đang xét.
 */
export function requiresReauthentication(
  sessionAcrs: Iterable<Acr>,
  authnAt: number,
  now: number,
  rule: ReauthenticationRule,
): boolean {
  if (!acrSatisfies(sessionAcrs, rule.requiredAcr)) {
    return true;
  }
  return !isFresh(authnAt, now, rule.maxAgeSeconds);
}
