/**
 * `GET /api/notifications` — đọc ý định nhận thông báo của chính caller.
 *
 * ## Hợp đồng v1
 *
 * `200` với `{ notifications: NotificationPreferences }` — object UI
 * (`serviceEmail | productUpdates | marketing`). Map v1 (quyết định ghi trong
 * PR body): toàn bộ ba toggle UI đều map vào kênh DB `email` — bảng
 * `notification_preferences` là taxonomy **kênh** (`email | push`, CHECK của
 * 0008) trong khi UI là phân loại **nội dung**; `push` chưa có sản phẩm ghi
 * vào nó, và một toggle UI điều khiển đúng một hàng intent. Hàng không tồn tại
 * → giá trị mặc định hiển thị (`true` cho service email, `false` cho hai loại
 * còn lại) — cùng hợp đồng với mock; bảng trung tính với chính sách
 * opt-in/opt-out nên "chưa có hàng" không bị default hoá ở đường đọc DB, giá
 * trị hiển thị là của tầng UI.
 *
 * ⚠️ Subject duy nhất là `session.sub` (SR-009). Read-only — không audit.
 * `Cache-Control: no-store`.
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../lib/bff-session';
import {
  listNotificationPreferences,
  SERVICE_EMAIL_CHANNEL,
  type NotificationPreferenceRow,
} from '../lib/data-domain';
import { accountHyperdrive } from '../utils/bindings';
import { writeLog } from '../utils/logger';
import { withRequestPool } from '../utils/db';

/** Ba toggle nội dung của UI — hình dạng JSON của response, không import kiểu UI. */
interface NotificationPreferencesBody {
  readonly serviceEmail: boolean;
  readonly productUpdates: boolean;
  readonly marketing: boolean;
}

export interface NotificationsBody {
  readonly notifications: NotificationPreferencesBody;
}

/** Giá trị hiển thị khi chưa có hàng nào — cùng hợp đồng với mock adapter. */
const DISPLAY_DEFAULTS: NotificationPreferencesBody = {
  serviceEmail: true,
  productUpdates: false,
  marketing: false,
};

/** Tìm intent của kênh email trong danh sách hàng — chỉ kênh này có ý nghĩa UI v1. */
function emailIntent(rows: readonly NotificationPreferenceRow[]): boolean | undefined {
  return rows.find((row) => row.channel === SERVICE_EMAIL_CHANNEL)?.enabled;
}

export default defineEventHandler(async (event): Promise<NotificationsBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'notifications_read.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const rows = await withRequestPool(hyperdrive, (pool) =>
      listNotificationPreferences(pool, authed.session.sub),
    );
    const email = emailIntent(rows);
    return {
      notifications: {
        serviceEmail: email ?? DISPLAY_DEFAULTS.serviceEmail,
        productUpdates: DISPLAY_DEFAULTS.productUpdates,
        marketing: DISPLAY_DEFAULTS.marketing,
      },
    };
  } catch {
    writeLog({ event: 'notifications_read.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
