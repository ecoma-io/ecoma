/**
 * Gia hạn access token của phiên từ refresh token — `POST {issuer}/token`
 * với `grant_type=refresh_token` (RFC 6749 §6, public client: `client_id`
 * trong body). ADR-0031 §2 mục 3 (#258): `auth` **rotate** refresh token ở
 * mỗi lần dùng, nên một lần gia hạn thành công phải persist **cả hai** token
 * mới vào `bff_sessions` — bỏ sót refresh token mới là phá phiên ngay sau lần
 * gia hạn đầu (refresh token cũ đã bị tiêu thụ, reuse của nó ⇒ auth thu hồi
 * cả grant family).
 *
 * ## Mốc hết hạn của access token — không cần cột
 *
 * Refresh chạy **on-demand khi verify access token của phiên trả `invalid`**
 * (hết hạn hay sai — cùng hợp đồng một-lần-thử của #244): mốc "token đã hết
 * hạn" chính là kiểm `exp` offline của `verifyAccessToken`, không cần cột
 * `access_token_expires_at` hay migration nào.
 *
 * ## Phân loại kết quả — hợp đồng 401/503 của caller (middleware authn)
 *
 * - `renewed` — thành công; `sub` + access token mới (đã verify) cho caller
 *   gắn principal. Token ở giá trị trả về chỉ sống trong bộ nhớ của request,
 *   không bao giờ vào log/response/cookie (SR-007).
 * - `invalid_grant` — `auth` trả `error=invalid_grant` (reuse detected, grant
 *   family đã chết) ⇒ caller **huỷ phiên server-side** và ép đăng nhập lại;
 *   không retry.
 * - `unavailable` — fetch ném (mất mạng, timeout 10s) hay JWKS không verify
 *   được ⇒ caller trả **503**: "không gia hạn được lúc này" khác "token sai"
 *   — không bao giờ âm thầm coi là phiên hợp lệ.
 * - `failed` — mọi nhánh fail-closed còn lại (non-2xx khác, thiếu token trong
 *   response, token mới không verify được, DB lỗi) ⇒ caller trả 401 như phiên
 *   chết, không loop.
 *
 * ## Single-flight theo phiên (#258)
 *
 * `renewSessionTokensOnce` dedupe theo `idHash` bằng một `Promise` ở module
 * scope: các request đồng thời của cùng phiên dùng chung **một** lời gọi
 * refresh — không đua nhau tiêu thụ refresh token (đua là đúng kịch bản reuse
 * ⇒ family chết). State chỉ là promise in-flight, tự xoá khi xong — không
 * phải node-local application state (invariant 12): worker chết mất map chỉ
 * mất dedupe, không mất dữ liệu.
 *
 * ⚠️ Token không vào log (SR-007) — refresh token đi trong **body** của POST.
 */

import type { Pool } from 'pg';

import type { PactBrokerAppAuthConfigView } from './config';
import { verifyAccessToken } from './verify';

/** Kết quả gia hạn — caller phân loại 401/503 theo outcome, không đoán. */
export type RefreshOutcome =
  | { readonly outcome: 'renewed'; readonly sub: string; readonly accessToken: string }
  | { readonly outcome: 'invalid_grant' }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'failed' };

/**
 * Timeout của fetch refresh grant — `auth` không trả lời trong 10s là "không
 * gia hạn được lúc này"; request treo không được block người dùng vô hạn.
 */
const REFRESH_FETCH_TIMEOUT_MS = 10_000;

/** Hình dạng tối thiểu của response `/token` mà đường refresh dùng. */
interface RefreshTokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly error?: unknown;
}

/** `JSON.parse` không ném — body không phải JSON hợp lệ là `null`. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Gia hạn token của phiên theo hash: gọi `/token` với refresh token đã lưu,
 * verify access token mới, rồi ghi **cả hai** token mới vào hàng phiên (chỉ
 * khi hàng vẫn chưa revoke). Không ném — mọi nhánh là một `RefreshOutcome`.
 * Caller không log giá trị token nào (SR-007).
 */
export async function renewSessionTokens(
  pool: Pool,
  idHash: string,
  config: PactBrokerAppAuthConfigView,
  refreshToken: string,
): Promise<RefreshOutcome> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  let response: Response;
  try {
    // Origin fetch nội bộ khi cấu hình (local) — container Node không resolve
    // được hostname issuer (cùng luật `callback.get.ts`); path `/token` không đổi.
    response = await fetch(new URL('/token', config.internalOrigin ?? config.issuer).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch {
    // Node runtime ném TypeError ở đây; workerd trả Response giả (bắt ở dưới).
    return { outcome: 'unavailable' };
  }
  const raw = await response.text().catch(() => null);
  if (!response.ok) {
    // workerd (production Workers lẫn test harness) KHÔNG ném khi transport
    // hỏng (connection reset/refused/DNS) — nó tổng hợp một Response giả
    // `500` với body `TypeError: fetch failed`. Đây là lỗi hạ tầng, không
    // phải lời phán về grant ⇒ `unavailable` (503), cùng nhánh với exception.
    if (response.status === 500 && raw !== null && raw.startsWith('TypeError: ')) {
      return { outcome: 'unavailable' };
    }
    // RFC 6749 §5.2: lỗi grant là JSON `error` — `invalid_grant` là reuse
    // detected ⇒ caller huỷ phiên; lỗi khác chỉ là "grant không nhận được".
    const parsed = raw === null ? null : (safeJsonParse(raw) as RefreshTokenResponse | null);
    if (parsed?.error === 'invalid_grant') {
      return { outcome: 'invalid_grant' };
    }
    return { outcome: 'failed' };
  }
  const parsed = raw === null ? null : (safeJsonParse(raw) as RefreshTokenResponse | null);

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
    return { outcome: 'failed' };
  }

  // Không lưu token chưa verify (cùng hợp đồng callback).
  const verified = await verifyAccessToken(newAccess, config);
  if (verified.outcome === 'unavailable') {
    return { outcome: 'unavailable' };
  }
  if (verified.outcome !== 'verified') {
    return { outcome: 'failed' };
  }

  try {
    // `rowCount === 0` (phiên bị revoke giữa lúc load và UPDATE — logout song
    // song, reuse-detection) là thất bại: không gắn principal cho phiên đã chết.
    const result = await pool.query(
      `UPDATE pact_broker_app.bff_sessions
          SET access_token = $2, refresh_token = $3
        WHERE id_hash = $1 AND revoked_at IS NULL`,
      [idHash, newAccess, newRefresh],
    );
    if (result.rowCount === 0) {
      return { outcome: 'failed' };
    }
  } catch {
    // DB lỗi ⇒ không persist được ⇒ fail-closed về `failed` (401), không ném
    // ra ngoài — một cú lỗi DB không được biến thành 503 cho một request chỉ
    // cần re-login.
    return { outcome: 'failed' };
  }
  return { outcome: 'renewed', sub: verified.sub, accessToken: newAccess };
}

/** Promise refresh in-flight theo `idHash` — xoá khi promise kết thúc. */
const inflightByHash = new Map<string, Promise<RefreshOutcome>>();

/**
 * `renewSessionTokens` với single-flight theo phiên (#258): các request đồng
 * thời của cùng phiên chờ chung một promise — đúng một lời gọi `/token`.
 */
export function renewSessionTokensOnce(
  pool: Pool,
  idHash: string,
  config: PactBrokerAppAuthConfigView,
  refreshToken: string,
): Promise<RefreshOutcome> {
  const inflight = inflightByHash.get(idHash);
  if (inflight !== undefined) {
    return inflight;
  }
  const pending = renewSessionTokens(pool, idHash, config, refreshToken).finally(() => {
    inflightByHash.delete(idHash);
  });
  inflightByHash.set(idHash, pending);
  return pending;
}

/** Xoá state single-flight — chỉ test dùng, production không có caller nào. */
export function resetInflightRefreshForTests(): void {
  inflightByHash.clear();
}
