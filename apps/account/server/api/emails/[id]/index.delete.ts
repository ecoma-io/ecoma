/**
 * `DELETE /api/emails/:id` — thu hồi một địa chỉ email của chính caller.
 *
 * ## Hợp đồng v1
 *
 * - `id` sai hình dạng (không phải uuid) → `400` trước khi chạm DB.
 * - `id` không thuộc caller → `404` (không xác nhận tồn tại).
 * - Hàng đã `revoked` → idempotent, vẫn `204` (DELETE thu hồi là no-op hợp lệ).
 * - Thu hồi sẽ làm caller hết **mọi** địa chỉ verified → `400` với lý do
 *   `last_verified_email` (FR-002: account phải giữ ít nhất một địa chỉ
 *   verified làm kênh liên hệ). Đây là lỗi nghiệp vụ có chủ đích: caller đã
 *   đăng nhập, 400 không phải oracle dò địa chỉ.
 * - Thành công → `204` không body + audit `data_email_revoked`.
 *
 * Ràng buộc "≥1 verified còn lại" kiểm **nguyên tử trong transaction** của
 * `revokeEmailGuarded` (`FOR UPDATE` mọi hàng verified của sub trước khi đếm) —
 * hai DELETE song song trên hai địa chỉ verified khác nhau không thể cùng vượt
 * guard và hạ caller xuống 0 verified. Nếu caller còn một địa chỉ verified khác
 * thì địa chỉ được xoá được phép là verified — nhiều verified cùng tồn tại,
 * caller chọn cái thu hồi.
 */

import { createError, defineEventHandler, getRouterParam, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  revokeEmailGuarded,
} from '../../../lib/data-domain';
import { accountHyperdrive } from '../../../utils/bindings';
import { writeLog } from '../../../utils/logger';
import { withRequestPool } from '../../../utils/db';

/** Hình dạng id — uuid; sai hình dạng là 400 trước khi chạm DB. */
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

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'email_revoke.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const outcome = await withRequestPool(hyperdrive, async (pool) => {
      // Guard FR-002 nằm trong transaction của `revokeEmailGuarded` (khoá
      // `FOR UPDATE` mọi hàng verified của sub trước khi đếm) — hai DELETE
      // song song trên hai địa chỉ verified khác nhau tuần tự hoá, không có
      // đường nào hạ caller xuống 0 verified.
      const revoked = await revokeEmailGuarded(pool, { userSub: authed.session.sub, id });
      if (revoked === 'missing') {
        return 'not_found' as const;
      }
      if (revoked === 'already_revoked') {
        // Idempotent: thu hồi lại hàng đã thu hồi không lỗi, không audit thứ hai.
        return 'already_revoked' as const;
      }
      if (revoked === 'last_verified') {
        writeLog({
          event: 'email_revoke.rejected',
          status: 400,
          sub: authed.session.sub,
          reason: 'last_verified_email',
        });
        return 'last_verified' as const;
      }

      const audited = await appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: DATA_EVENT_TYPES.emailRevoked,
        metadata: { field_count: 1 },
      });
      if (!audited) {
        writeLog({ event: 'email_revoke.audit_failed', status: 204, sub: authed.session.sub });
      }
      writeLog({ event: 'email_revoke.done', status: 204, sub: authed.session.sub });
      return 'revoked' as const;
    });

    switch (outcome) {
      case 'not_found':
        throw createError({ statusCode: 404, statusMessage: 'Not Found' });
      case 'last_verified':
        throw createError({ statusCode: 400, statusMessage: 'last_verified_email' });
      default:
        event.node.res.statusCode = 204;
        return null;
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'email_revoke.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
