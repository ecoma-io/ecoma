/**
 * `PATCH /api/notifications` — ghi ý định nhận thông báo của chính caller.
 *
 * ## Hợp đồng v1 (quyết định ghi trong PR body)
 *
 * Body JSON `{ serviceEmail?, productUpdates?, marketing? }`. Hợp đồng v1:
 * BẤT KỲ field boolean nào được gửi ⇒ intent BẬT kênh `email` (tối thiểu một
 * field; gửi mọi field `false` mới là tắt). Đây KHÔNG phải partial update theo
 * nghĩa "trường không gửi giữ nguyên trạng thái nội dung": DB chỉ có một hàng
 * kênh, granularity nội dung không biểu diễn được — thấy rõ ở GET (hai toggle
 * nội dung luôn trả `false` mặc định). Ghi đè hàng kênh là hành vi có chủ đích;
 * tách granularity là quyết định sản phẩm cần cột mới, forward-fix.
 *
 * ## Map taxonomy (v1)
 *
 * UI là phân loại **nội dung**; DB (`notification_preferences`, 0008) là
 * taxonomy **kênh** (`email | push`). Map v1: cả ba toggle điều khiển cùng
 * **một hàng** — kênh `email`. PATCH hợp lệ cuối cùng là
 * `upsert(user_sub, 'email', enabled)` với `enabled` là OR của các toggle được
 * gửi (một request bật "News and offers" là một intent cho phép kênh email
 * nói chung — tách granularity nội dung là quyết định sản phẩm cần cột mới,
 * forward-fix). Request mọi toggle `false` tắt kênh — đúng nghĩa opt-out.
 *
 * ## Audit
 *
 * **Có** — state-changing op trên dữ liệu cá nhân: event
 * `data_notification_preferences_updated`, metadata chỉ mã cấu trúc. Read
 * (GET) không audit — cùng nguyên tắc mọi GET khác.
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  SERVICE_EMAIL_CHANNEL,
  upsertNotificationPreference,
} from '../lib/data-domain';
import { accountHyperdrive } from '../utils/bindings';
import { writeLog } from '../utils/logger';
import { withRequestPool } from '../utils/db';

/** Kết quả validate PATCH — chỉ có field được gửi, hoặc `false` khi sai hình dạng. */
interface NotificationPreferencesPatch {
  readonly serviceEmail?: boolean;
  readonly productUpdates?: boolean;
  readonly marketing?: boolean;
}

function parseNotificationPreferencesPatch(value: unknown): NotificationPreferencesPatch | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const patch: {
    serviceEmail?: boolean;
    productUpdates?: boolean;
    marketing?: boolean;
  } = {};

  const serviceEmail = (value as { serviceEmail?: unknown }).serviceEmail;
  if (serviceEmail !== undefined) {
    if (typeof serviceEmail !== 'boolean') {
      return false;
    }
    patch.serviceEmail = serviceEmail;
  }

  const productUpdates = (value as { productUpdates?: unknown }).productUpdates;
  if (productUpdates !== undefined) {
    if (typeof productUpdates !== 'boolean') {
      return false;
    }
    patch.productUpdates = productUpdates;
  }

  const marketing = (value as { marketing?: unknown }).marketing;
  if (marketing !== undefined) {
    if (typeof marketing !== 'boolean') {
      return false;
    }
    patch.marketing = marketing;
  }

  return patch;
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, parseNotificationPreferencesPatch).catch(() => null);
  if (body === null) {
    // Sai hình dạng — 400 chung, không nói trường nào sai (không oracle dò
    // allowlist; cùng một body chung chung với mọi route khác).
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'notifications_update.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    return await withRequestPool(hyperdrive, async (pool) => {
      // Map v1: OR của mọi toggle được gửi — một intent cho phép kênh email.
      // PATCH rỗng `{}` giữ nguyên giá trị hiện có (no-op có audit? KHÔNG —
      // no-op thật không tạo event `success` giả, return sớm trước khi ghi).
      // Hàng hiện có không cần đọc: upsert đè thẳng intent mới lên kênh email.
      const toggles = [body.serviceEmail, body.productUpdates, body.marketing].filter(
        (value): value is boolean => value !== undefined,
      );
      if (toggles.length === 0) {
        writeLog({
          event: 'notifications_update.noop',
          status: 200,
          sub: authed.session.sub,
        });
        return { ok: true };
      }
      const nextEmail = toggles.some((value) => value);

      await upsertNotificationPreference(pool, {
        userSub: authed.session.sub,
        channel: SERVICE_EMAIL_CHANNEL,
        enabled: nextEmail,
      });
      const audited = await appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: DATA_EVENT_TYPES.notificationPreferencesUpdated,
        metadata: { field_count: toggles.length },
      });
      if (!audited) {
        writeLog({
          event: 'notifications_update.audit_failed',
          status: 200,
          sub: authed.session.sub,
        });
      }
      writeLog({ event: 'notifications_update.done', status: 200, sub: authed.session.sub });

      return { ok: true, enabled: nextEmail };
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'notifications_update.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
