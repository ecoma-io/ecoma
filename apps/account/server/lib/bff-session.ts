/**
 * Shared plumbing cho các BFF route vừa gọi `auth` vừa yêu cầu session người
 * dùng: `/api/auth/handoff`, `/api/consent/context`, `/api/consent/decide`.
 *
 * ## Vì sao tách khỏi từng route
 *
 * Cả ba route cùng lặp đúng một chuỗi bước: đọc cookie → CSRF double-submit →
 * load session sống → kiểm ACR. Copy ba lần là ba cơ hội để một route quên
 * kiểm CSRF mà không test nào đỏ (đúng lý do `server/middleware/internal-auth.ts`
 * chọn middleware thay vì check trong từng route). Route **vẫn** tự dựng các
 * response của mình — helper chỉ trả dữ liệu hoặc `null`, khôngThrow, không
 * render — nên hành vi lỗi vẫn thuộc về từng route, nhưng *điều kiện vào* thống
 * nhất một nơi.
 *
 * ## Luật tra session: hash-lookup trong khi đang xác thực
 *
 * loadSessionByHash đọc bằng `id_hash` — giá trị cookie KHÔNG BAO GIỜ chạm DB
 * (SR-001); `hashSessionIdentifier` là hàm đó. Session chết (revoked / hết hạn)
 * không có quyền kích hoạt back-channel của `auth`: mọi ba route fail-closed
 * như chưa đăng nhập (`401` như bên `session.get.ts`), không có fallback "coi
 * như chưa đăng nhập".
 */

import { createError, getCookie, getHeader, type H3Event } from 'h3';

import { ACR_URN_VALUES, type AcrUrn } from '@ecoma-io/auth-contracts';

import { accountHyperdrive } from '../utils/bindings';
import { withRequestPool } from '../utils/db';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfMatches,
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  SESSION_COOKIE_NAME,
  type AccountSessionRow,
} from './session';

/**
 * Session đã tải thành công và đạt chuẩn của các route này.
 *
 * ⚠️ Xoá các trường nhận dạng cơ bản: `id_hash` đi ngay vào đây (nó giàu
 * thông tin hơn session_ref — nó là hash của cookie đang sống), và route không
 * log bất kỳ dữ liệu nào từ session này ngoài `sub` (khác `id_hash`).
 */
export interface AuthedSession {
  /** Subject của người dùng — dùng cho payload push về auth. */
  readonly sub: string;
  /** `session_ref` của session — đi vào contract với auth. */
  readonly sessionRef: string;
  /** ACR cao nhất session đã vượt — bắt buộc thuộc allowlist. */
  readonly acr: AcrUrn;
  /** Thời điểm xác thực (epoch ms). */
  readonly authnAtMs: number;
}

/**
 * Chuỗi cookie của request nhắm vào các route có session; chỉ đọc qua h3,
 * không cache ở tầng nào.
 */
function currentCookie(event: H3Event, name: string): string | undefined {
  return getCookie(event, name);
}

/** Kết quả đọc phiên — không phân biệt làn nào ngoài `ok` và `null`. */
export type AuthedSessionResult = { readonly ok: true; readonly session: AuthedSession } | null;

/**
 * Đọc + kiểm CSRF + load session sống với ACR thuộc allowlist của
 * `ACR_URN_VALUES`.
 *
 * ⚠️ **Ra `null` cho mọi lý do bị từ chối — route chuyển thành `401`.** Không
 * bao giờ "skip CSRF để tiện dev": cùng lý do `middleware/internal-auth.ts`
 * từ chối "thiếu secret" thay vì cho qua. CSRF phân biệt chỉ distinguish
 * `403` (CSRF sai) và mọi nhánh khác với `401` — route chọn cách trả nhất quán.
 *
 * ⚠️ `acr null` (session anonymous) hoặc giá trị lạ trong DB: từ chối —
 * đảm bảo mọi route quay về cùng hành vi với một session "không đăng nhập".
 */
export async function requireAuthedSession(event: H3Event): Promise<AuthedSessionResult> {
  const sessionCookie = currentCookie(event, SESSION_COOKIE_NAME);
  const csrfCookie = currentCookie(event, CSRF_COOKIE_NAME);
  const csrfHeader = getHeader(event, CSRF_HEADER_NAME);

  if (sessionCookie === undefined) {
    return null;
  }
  // CSRF double-submit: chỉ kiểm khi có cả hai mảnh cookie — một trong hai
  // mảnh vắng nghĩa là session không được cấp qua đúng luồng verify, coi như
  // không đăng nhập.
  if (csrfCookie === undefined || !csrfMatches(csrfCookie, csrfHeader ?? '')) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    // Binding thiếu là lỗi hạ tầng, không phải là "chưa đăng nhập".
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const row: AccountSessionRow | null = await withRequestPool(hyperdrive, async (pool) => {
    const idHash = await hashSessionIdentifier(sessionCookie);
    return loadSessionByHash(pool, idHash);
  });

  if (row === null || !isSessionLive(row, Date.now())) {
    return null;
  }
  if (row.acr === null) {
    // Session anonymous — do verify cấp ACR, session này không nên tồn tại ở đây.
    return null;
  }
  if (!(ACR_URN_VALUES as readonly string[]).includes(row.acr)) {
    // ACR lạ trong DB: fail-closed, không phỏng đoán mức assurance đủ.
    return null;
  }

  return {
    ok: true,
    session: {
      sub: row.user_sub ?? '',
      sessionRef: row.session_ref,
      acr: row.acr as AcrUrn,
      authnAtMs: row.authn_at === null ? 0 : new Date(row.authn_at).getTime(),
    },
  };
}
