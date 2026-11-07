/**
 * `POST /api/consent/context` — proxy consent context từ `auth`.
 *
 * ## Vai trò
 *
 * Browser của `/consent?handle=Y` không ký envelope, không biết Service
 * Binding, không gọi auth được: đây là **lớp BFF** của hợp đồng
 * `POST /internal/consent/context` (§5.1.7 hàng 6, hướng `account → auth`).
 * Route đọc handle từ body, session để lấy `account_session_ref` (giá trị từ
 * DB, không lấy từ browser), ký envelope và trả đúng context mà auth cấp.
 *
 * ## Session + CSRF bắt buộc
 *
 * Context là op read-only ở phía auth nhưng vẫn là POST kèm session, và response
 * này tiết lộ (tên app, danh sách quyền) cho frame cookies của victim nếu không
 * có CSRF — double-submit như logout.
 *
 * ## Không map scope ở UI
 *
 * `scope[]` thô từ auth được map ở **server** vào cặp label/description của UI
 * (`ConsentContext.permissions`) — bên sở hữu ngữ nghĩa scope là BFF+auth, UI
 * chỉ hiển thị. Scope lạ (không trong map) hiện nguyên mã làm label và mô tả
 * chung chung: không đặt tên cho nó là "an toàn".
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import type { ConsentContextRequest } from '@ecoma-io/auth-contracts';

import { fetchConsentContext, authServiceBinding } from '../../lib/auth-client';
import { requireAuthedSession } from '../../lib/bff-session';
import { writeLog } from '../../utils/logger';

/** Body hợp lệ: handle opaque. */
function isContextBody(value: unknown): { handle: string } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const handle = (value as { handle?: unknown }).handle;
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 1_000) {
    return false;
  }
  return { handle };
}

/** Response cho browser — hình dạng của UI `ConsentContext` + `ok`. */
export interface ConsentContextResponse {
  readonly ok: boolean;
  readonly reason?: string;
  readonly clientName?: string;
  readonly permissions?: readonly { readonly label: string; readonly description: string }[];
  readonly highRisk?: boolean;
}

/**
 * Diễn giải scope thô thành văn hiển thị — quyết định của **server**, không
 * phải của UI.
 *
 * ⚠️ Bảng scope là allowlist mở (không phải whitelist đóng): một scope không có
 * trong bảng không bị bỏ — nó hiện đúng mã gốc với mô tả chung chung, để người
 * dùng luôn thấy đủ những gì app xin, kể cả scope mà BFF chưa học tên.
 */
const SCOPE_LABELS: Readonly<Record<string, { label: string; description: string }>> = {
  'profile:read': { label: 'Read your profile', description: 'Display name and avatar.' },
  'email:read': {
    label: 'Read your email addresses',
    description: 'Including verification state.',
  },
  'activity:read': {
    label: 'Read your activity',
    description: 'Recent documents you have opened.',
  },
};

export function mapScopes(scope: readonly string[]): {
  label: string;
  description: string;
}[] {
  return scope.map((code) => {
    const known = SCOPE_LABELS[code];
    if (known !== undefined) {
      return known;
    }
    return { label: code, description: 'Access to your account data.' };
  });
}

export default defineEventHandler(async (event): Promise<ConsentContextResponse> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isContextBody).catch(() => null);
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    writeLog({ event: 'consent_context.rejected', status: 401, reason: 'no_session' });
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const signingKey = typeof config.internalHmacSecret === 'string' ? config.internalHmacSecret : '';
  if (signingKey.length === 0) {
    writeLog({ event: 'consent_context.failed', status: 503, reason: 'config_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
  // `kid` của khoá đang ký — rỗng nghĩa là transition chưa bật `kid`; chỉ forward
  // khi nó là chuỗi không rỗng.
  const signingKid =
    typeof config.internalHmacKid === 'string' && config.internalHmacKid.length > 0
      ? config.internalHmacKid
      : undefined;

  const request: ConsentContextRequest = {
    handle: body.handle,
    account_session_ref: authed.session.sessionRef,
  };

  const result = await fetchConsentContext({
    binding: authServiceBinding(config),
    signingKey,
    signingKid,
    request,
    nowMs: Date.now(),
  });

  if (!result.ok) {
    writeLog({ event: 'consent_context.failed', status: 502, reason: result.reason });
    return { ok: false, reason: result.reason };
  }

  writeLog({ event: 'consent_context.done', status: 200 });
  return {
    ok: true,
    clientName: result.value.client_name,
    permissions: mapScopes(result.value.scope),
    // `elevated` và `high` cùng thành cờ "cẩn thận" cho UI — mức phân biệt
    // chi tiết là việc của auth, UI chỉ render hai nhánh.
    highRisk: result.value.risk_level !== 'low',
  };
});
