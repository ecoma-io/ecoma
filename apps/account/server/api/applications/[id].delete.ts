/**
 * `DELETE /api/applications/:id` — thu hồi quyền của một ứng dụng đã kết nối.
 *
 * ## Vai trò BFF (FR-011 — ownership)
 *
 * `id` là `oauth_grants.id` của **auth**; việc thu hồi (CAS grant + control
 * plane `token_revocations` + audit) là MỘT sự kiện db-auth do auth thực hiện
 * qua `POST /internal/connected-applications/revoke`. Account proxy envelope
 * đã ký rồi ghi audit **riêng của mình** (`data_application_revoked` trên
 * `security_events` của db-account) sau khi auth xác nhận thành công — audit
 * account không bao giờ đứng trước state của auth.
 *
 * ## Hợp đồng v1
 *
 * - `id` sai hình dạng uuid → `400` trước khi chạm network.
 * - `id` không thuộc caller / đã revoked → auth trả 404 → `404` (không xác
 *   nhận tồn tại; idempotent thu hồi lại giống email DELETE — trạng thái cuối
 *   client muốn đã đạt, nhưng KHÔNG audit lần hai).
 * - auth 503 → `502` (auth fail-closed là trạng thái của auth; khác 503 của
 *   chính account khi binding thiếu).
 * - Thành công → `204` không body + audit `data_application_revoked`
 *   (metadata `field_count` — KHÔNG chứa `client_id` hay grant id: định danh
 *   grant là dữ liệu của auth, audit account chỉ cần đếm được sự kiện).
 */

import { createError, defineEventHandler, getRouterParam, setResponseHeader } from 'h3';

import { revokeConnectedApplication, authServiceBinding } from '../../lib/auth-client';
import { requireAuthedSession } from '../../lib/bff-session';
import { appendSecurityEvent, DATA_EVENT_TYPES } from '../../lib/data-domain';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

/** Hình dạng id — uuid (`oauth_grants.id`); sai hình dạng là 400 trước network. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const id = getRouterParam(event, 'id');
  if (typeof id !== 'string' || !UUID_SHAPE.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const signingKey = typeof config.internalHmacSecret === 'string' ? config.internalHmacSecret : '';
  const hyperdrive = accountHyperdrive(config);
  if (signingKey.length === 0 || !hyperdrive) {
    writeLog({
      event: 'application_revoke.failed',
      status: 503,
      reason: 'config_or_binding_missing',
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
  const signingKid =
    typeof config.internalHmacKid === 'string' && config.internalHmacKid.length > 0
      ? config.internalHmacKid
      : undefined;

  const result = await revokeConnectedApplication({
    binding: authServiceBinding(config),
    signingKey,
    signingKid,
    request: { sub: authed.session.sub, grant_id: id },
    nowMs: Date.now(),
  });

  if (!result.ok) {
    if (result.reason === 'rejected' && result.detail === '404') {
      // Không thuộc caller / đã revoked — idempotent 404, không audit.
      writeLog({ event: 'application_revoke.not_found', status: 404, sub: authed.session.sub });
      throw createError({ statusCode: 404, statusMessage: 'Not Found' });
    }
    writeLog({ event: 'application_revoke.failed', status: 502, reason: result.reason });
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway' });
  }

  // Audit sau khi auth xác nhận — event `success` chỉ khi state đã đổi thật.
  const audited = await withRequestPool(hyperdrive, (pool) =>
    appendSecurityEvent(pool, {
      subjectSub: authed.session.sub,
      type: DATA_EVENT_TYPES.applicationRevoked,
      metadata: { field_count: 1 },
    }),
  );
  if (!audited) {
    writeLog({ event: 'application_revoke.audit_failed', status: 204, sub: authed.session.sub });
  }
  writeLog({ event: 'application_revoke.done', status: 204, sub: authed.session.sub });
  event.node.res.statusCode = 204;
  return null;
});
