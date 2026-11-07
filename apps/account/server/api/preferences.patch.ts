/**
 * `PATCH /api/preferences` — partial update preference của chính caller.
 *
 * ## Hợp đồng (FR-008a/b/d/e)
 *
 * Body JSON `{ locale?, timezone?, colorMode? }`:
 * - Trường không gửi **giữ nguyên** (FR-008e) — không reset về default. PATCH
 *   chỉ `colorMode` không đổi locale/timezone (AC-007).
 * - `locale` ngoài allowlist `en | vi` → `400`, giá trị cũ giữ nguyên (FR-008a:
 *   reject, không fallback; AC-006).
 * - **Caller chưa có hàng preference và patch thiếu `locale`** → `400`
 *   `locale_required` (quyết định v1, ghi trong PR body): cột `locale` của 0008
 *   là NOT NULL không DB default theo chủ ý — default hoá im lặng là fallback
 *   đúng cái FR-008a cấm, nên lần cấu hình đầu phải nói rõ locale. GET trả
 *   `preferences: null` cho trạng thái "chưa cấu hình" — UI dựa vào đó hiện
 *   form chọn locale. Sau lần đầu, mọi PATCH thiếu `locale` giữ giá trị cũ.
 * - `timezone` sai theo IANA tz database (`Mars/Phobos`, chuỗi rỗng, text rác)
 *   → `400` (FR-008b). Validator dùng `Intl.DateTimeFormat` — xem JSDoc
 *   `isValidTimeZone` vì sao không dùng `supportedValuesOf`.
 * - `colorMode` ngoài `system | light | dark` → `400` (enum đóng §3.3).
 * - Body chứa `sub` của user khác: trường đó **không tồn tại** trong hợp đồng
 *   và bị bỏ qua im lặng — subject duy nhất là `session.sub` (FR-008d, SR-009).
 * - Body rỗng `{}` là hợp lệ khi hàng đã tồn tại (no-op); khi chưa có hàng thì
 *   rơi vào nhánh `locale_required` ở trên.
 *
 * Thành công → `200` với hàng sau ghi (các trường chưa từng đặt lấy DB default:
 * timezone `Asia/Ho_Chi_Minh`, color_mode `system` — §3.3).
 *
 * ## Audit
 *
 * **Có** — PATCH preferences là state-changing op trên dữ liệu cá nhân (quyết
 * định v1, ghi trong PR body): event `data_preferences_updated`, metadata chỉ
 * mã cấu trúc, không giá trị. Read (GET) không audit — cùng nguyên tắc với mọi
 * GET khác của app; internal contract (FR-008g) mới có luật audit-every-read,
 * và route đó không thuộc PR này.
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  parsePreferencesPatch,
  selectPreferences,
  updatePreferencesPartial,
} from '../lib/data-domain';
import { accountHyperdrive } from '../utils/bindings';
import { writeLog } from '../utils/logger';
import { withRequestPool } from '../utils/db';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, parsePreferencesPatch).catch(() => null);
  if (body === null) {
    // Sai hình dạng/giá trị — 400 cho mọi nhánh, không nói trường nào sai để
    // error surface không trở thành oracle dò giá trị allowlist (thấp nhưng
    // miễn phí: cùng một body chung chung).
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'preferences_update.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    return await withRequestPool(hyperdrive, async (pool) => {
      // Hàng chưa tồn tại + patch thiếu locale → 400 locale_required: không có
      // giá trị nào hợp lệ để điền locale (fallback im lặng bị FR-008a cấm).
      // Đọc trước trong cùng pool; race giữa hai PATCH đầu của cùng sub là
      // lành tính — cả hai đều mang locale hoặc một nhánh 400, không hỏng dữ
      // liệu (INSERT ON CONFLICT là nguyên tử).
      const existing = await selectPreferences(pool, authed.session.sub);
      if (existing === null && body.locale === undefined) {
        writeLog({
          event: 'preferences_update.rejected',
          status: 400,
          sub: authed.session.sub,
          reason: 'locale_required',
        });
        throw createError({ statusCode: 400, statusMessage: 'locale_required' });
      }

      await updatePreferencesPartial(pool, {
        userSub: authed.session.sub,
        // body.locale undefined chỉ xảy ra khi hàng đã có — dùng giá trị hiện
        // tại để giữ nguyên (COALESCE phía UPDATE không cần vì SQL giờ SET
        // trực tiếp $2; truyền existing.locale giữ đúng ngữ nghĩa "không gửi
        // = giữ nguyên" mà không đổi chữ ký lib).
        locale: body.locale ?? existing?.locale ?? '',
        timezone: body.timezone,
        colorMode: body.colorMode,
      });
      const audited = await appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: DATA_EVENT_TYPES.preferencesUpdated,
        metadata: { field_count: body.locale === undefined ? 1 : 2 },
      });
      if (!audited) {
        writeLog({
          event: 'preferences_update.audit_failed',
          status: 200,
          sub: authed.session.sub,
        });
      }
      writeLog({ event: 'preferences_update.done', status: 200, sub: authed.session.sub });

      const row = await selectPreferences(pool, authed.session.sub);
      // Không tới được với PATCH vừa ghi (row đã được INSERT), nhưng select
      // lại là cách trả hàng thực tế thay vì tái cấu trúc body — một hàng bị
      // mutate song song ngay sau ghi được phản ánh đúng.
      return {
        preferences:
          row === null
            ? null
            : {
                locale: row.locale,
                timezone: row.timezone,
                colorMode: row.color_mode,
              },
      };
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
    writeLog({ event: 'preferences_update.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
