/**
 * `GET /api/preferences` — đọc preference của chính caller (FR-008d).
 *
 * ## Hợp đồng
 *
 * Session hợp lệ → `200` với `{ locale, timezone, colorMode }` — hàng đã tồn
 * tại. Chưa có hàng → `200` với `preferences: null`: trạng thái "chưa cấu hình"
 * là **trạng thái hợp lệ** được trả về phía UI, không phải lỗi. Route không tự
 * default hoá (FR-008a cấm fallback im lặng; default của FR-008c là việc của
 * đường ghi lúc tạo account — đường đó là của PR sau trong sequence #274).
 *
 * ⚠️ **Bỏ qua mọi `sub` từ query** (FR-008d, AC-020a): query string không được
 * đọc — kể cả để từ chối. `GET /api/preferences?sub=<user khác>` trả preference
 * của **chính caller**, và subject duy nhất là `session.sub` (SR-009).
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../lib/bff-session';
import { selectPreferences } from '../lib/data-domain';
import { accountHyperdrive } from '../utils/bindings';
import { writeLog } from '../utils/logger';
import { withRequestPool } from '../utils/db';

export interface PreferencesBody {
  readonly preferences: {
    readonly locale: string;
    readonly timezone: string;
    readonly colorMode: string;
  } | null;
}

export default defineEventHandler(async (event): Promise<PreferencesBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'preferences_read.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const row = await withRequestPool(hyperdrive, (pool) =>
      selectPreferences(pool, authed.session.sub),
    );
    if (row === null) {
      return { preferences: null };
    }
    return {
      preferences: {
        locale: row.locale,
        timezone: row.timezone,
        colorMode: row.color_mode,
      },
    };
  } catch {
    writeLog({ event: 'preferences_read.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
