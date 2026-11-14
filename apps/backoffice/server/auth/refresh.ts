/**
 * Gia hạn access token của phiên từ refresh token — `POST {origin}/token`
 * với `grant_type=refresh_token` (RFC 6749 §6, public client: `client_id`
 * trong body). ADR-0012 §3: `auth` **rotate** refresh token ở mỗi lần dùng,
 * nên một lần gia hạn thành công phải persist **cả hai** token mới vào phiên
 * — bỏ qua refresh token mới là phá phiên ngay sau lần gia hạn đầu (refresh
 * token cũ đã bị tiêu thụ, reuse của nó ⇒ auth thu hồi cả family).
 *
 * ## Một lần thử, fail về 401
 *
 * Không background refresher, không distributed lock (quyết định M1 của
 * #244): gia hạn on-demand khi access token hết hạn, một lần thử mỗi request.
 * Hai request đua nhau trên cùng phiên thì một cái thắng, cái thua nhận
 * `invalid_grant` (thậm chí trigger reuse-detection thu hồi family) ⇒ 401
 * một lần rồi đăng nhập lại — chấp nhận, đổi lại không thêm state node-local.
 *
 * ## Không bao giờ lưu token chưa verify
 *
 * Cùng hợp đồng với callback: access token mới phải qua `verifyAccessToken`
 * trước khi UPDATE phiên. Thất bại ở bất kỳ bước nào (network, non-2xx,
 * thiếu token trong response, verify hỏng) ⇒ `null` — caller trả 401 như
 * phiên chết, không bao giờ loop.
 *
 * ⚠️ Token không vào log (SR-014) — refresh token đi trong **body** của POST.
 */

import type { Pool } from 'pg';

import { verifyAccessToken, type BackofficeAuthConfig } from '@ecoma-io/backoffice-infrastructure';

/** Hình dạng tối thiểu của response `/token` mà đường refresh dùng. */
interface RefreshTokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
}

/** Kết quả gia hạn thành công — sub của access token mới đã verify. */
export interface RenewedSession {
  readonly sub: string;
}

/**
 * Gia hạn token của phiên theo hash: gọi `/token` với refresh token đã lưu,
 * verify access token mới, rồi ghi **cả hai** token mới vào hàng phiên (chỉ
 * khi hàng vẫn chưa revoke). `null` cho mọi nhánh thất bại — caller phân loại
 * chung một lý do (401, đăng nhập lại). Kết quả chỉ mang `sub`: token mới đã
 * nằm trong phiên, không bao giờ rời DB qua giá trị trả về (SR-014).
 */
export async function renewSessionTokens(
  pool: Pool,
  idHash: string,
  config: BackofficeAuthConfig,
  refreshToken: string,
): Promise<RenewedSession | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  let parsed: RefreshTokenResponse | null;
  try {
    // Origin fetch nội bộ khi cấu hình (local) — container Node không resolve
    // được hostname issuer (cùng luật `callback.get.ts`); path `/token` không đổi.
    const response = await fetch(
      new URL('/token', config.internalOrigin ?? config.issuer).toString(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    );
    if (!response.ok) {
      return null;
    }
    parsed = (await response.json().catch(() => null)) as RefreshTokenResponse | null;
  } catch {
    return null;
  }

  // `offline_access` được xin ở login ⇒ response phải mang refresh token mới
  // (rotation). Thiếu nó là contract hỏng — không persist nửa vời.
  const newAccess =
    typeof parsed?.access_token === 'string' && parsed.access_token.length > 0
      ? parsed.access_token
      : null;
  const newRefresh =
    typeof parsed?.refresh_token === 'string' && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : null;
  if (newAccess === null || newRefresh === null) {
    return null;
  }

  // Không lưu token chưa verify (cùng hợp đồng callback) — verify hỏng ⇒ 401.
  const verified = await verifyAccessToken(newAccess, config);
  if (verified.outcome !== 'verified') {
    return null;
  }

  await pool.query(
    `UPDATE backoffice.bff_sessions
        SET access_token = $2, refresh_token = $3
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, newAccess, newRefresh],
  );
  return { sub: verified.sub };
}
