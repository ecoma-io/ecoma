/**
 * `GET /api/applications` — danh sách ứng dụng đã kết nối của chính caller.
 *
 * ## Vai trò BFF (FR-011 — ownership)
 *
 * Grants nằm trong **db-auth** (`auth.oauth_grants` + `oauth_clients`); docs
 * chốt quản lý grant thuộc `auth`, và account KHÔNG BAO GIỜ đọc `db-auth`
 * trực tiếp. Route này là proxy: session để lấy `sub` (SR-009 — giá trị duy
 * nhất quyết định phạm vi dữ liệu), envelope HMAC qua binding `AUTH_SERVICE`
 * (`POST /internal/connected-applications`), trả về đúng danh sách mà auth
 * cấp. Không SQL nào chạm db-auth từ app này.
 *
 * ## Hợp đồng v1
 *
 * `200 { applications: [{ id, clientName, grantedAt, scopes }] }` —
 * `grantedAt` ISO 8601. Lỗi contract/transport → `502` với `{ ok: false }`:
 * UI hiển thị error state chung, không phân biệt lý do (auth chết và auth từ
 * chối cùng là "danh sách chưa lấy được" cho caller).
 *
 * Read-only — không audit phía account (auth không audit đọc; cùng nguyên tắc
 * mọi GET). `Cache-Control: no-store`.
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import type { ConnectedApplicationGrant } from '@ecoma-io/auth-contracts';

import { fetchConnectedApplications, authServiceBinding } from '../../lib/auth-client';
import { requireAuthedSession } from '../../lib/bff-session';
import { writeLog } from '../../utils/logger';

export interface ApplicationsBody {
  readonly applications: {
    readonly id: string;
    readonly clientName: string;
    readonly grantedAt: string;
    readonly scopes: readonly string[];
  }[];
}

export default defineEventHandler(async (event): Promise<ApplicationsBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const signingKey = typeof config.internalHmacSecret === 'string' ? config.internalHmacSecret : '';
  if (signingKey.length === 0) {
    writeLog({ event: 'applications_read.failed', status: 503, reason: 'config_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
  // `kid` của khoá đang ký — rỗng nghĩa là transition chưa bật `kid`; chỉ
  // forward khi nó là chuỗi không rỗng (cùng hình thức consent context).
  const signingKid =
    typeof config.internalHmacKid === 'string' && config.internalHmacKid.length > 0
      ? config.internalHmacKid
      : undefined;

  const result = await fetchConnectedApplications({
    binding: authServiceBinding(config),
    signingKey,
    signingKid,
    // SR-009: subject từ session, không từ bất kỳ nguồn client nào.
    request: { sub: authed.session.sub },
    nowMs: Date.now(),
  });

  if (!result.ok) {
    writeLog({ event: 'applications_read.failed', status: 502, reason: result.reason });
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway' });
  }

  writeLog({ event: 'applications_read.done', status: 200 });
  return {
    applications: result.value.applications.map((application: ConnectedApplicationGrant) => ({
      id: application.id,
      clientName: application.client_name,
      grantedAt: new Date(application.granted_at).toISOString(),
      scopes: application.scopes,
    })),
  };
});
