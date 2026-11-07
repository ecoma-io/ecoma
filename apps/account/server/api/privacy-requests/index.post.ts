/**
 * `POST /api/privacy-requests` — tạo privacy request của chính caller (v1).
 *
 * ## Hợp đồng v1 (FR-013, FR-014)
 *
 * Body JSON `{ kind }` với `kind` thuộc allowlist đóng
 * (`export | correct | delete | restrict | object` — CR-001). Sai hình dạng/
 * giá trị → `400`.
 *
 * Thành công → `200 { ok: true, request: { kind, status: 'pending',
 * submittedAt, dueAt } }`. Deadline ghi MỘT lần lúc tạo theo `now()` của DB
 * (FR-014: không có đường kéo dài — không route nào UPDATE `deadline_at`).
 *
 * ## Idempotent + trần
 *
 * - Request mở cùng loại đã tồn tại (PK `subject_sub, kind` chặn) → `200`
 *   cùng hình dạng với hàng hiện có: UI đã có confirm dialog; nộp đôi là
 *   retry lành tính, một hàng `pending` trùng là dữ liệu rác.
 * - Trần 3 request/giờ theo sub (`durable state`, cùng triết lý trần pending
 *   email) → `429` — nhánh duy nhất không phải 200: trần là hành vi của caller
 *   cần thấy được, khác với các nhánh anti-enumeration của route email (nơi
 *   caller chưa đăng nhập). Im lặng 200 ở đây sẽ làm user tin request đã nhận
 *   trong khi chưa có hàng nào — trái FR-015 (trạng thái phải trung thực).
 *
 * ## Audit
 *
 * **Có** — event `data_privacy_requested`, metadata chỉ `field_count` (không
 * bao giờ chứa nội dung request — request v1 không có trường nội dung nào
 * ngoài `kind`, và `kind` nằm trong chính hàng DB).
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  insertPrivacyRequest,
  PRIVACY_DEADLINE_DAYS,
  PRIVACY_KIND_ALLOWLIST,
  PRIVACY_REQUEST_MAX_PER_WINDOW,
  PRIVACY_REQUEST_WINDOW_SECONDS,
  toPrivacyRequestView,
} from '../../lib/data-domain';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

function isPrivacyRequestBody(value: unknown): { kind: string } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !PRIVACY_KIND_ALLOWLIST.includes(kind)) {
    return false;
  }
  return { kind };
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isPrivacyRequestBody).catch(() => null);
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'privacy_create.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const outcome = await withRequestPool(hyperdrive, async (pool) => {
      const result = await insertPrivacyRequest(pool, {
        userSub: authed.session.sub,
        kind: body.kind,
        maxPerWindow: PRIVACY_REQUEST_MAX_PER_WINDOW,
        windowSeconds: PRIVACY_REQUEST_WINDOW_SECONDS,
        deadlineDays: PRIVACY_DEADLINE_DAYS,
      });

      if (result.kind === 'ceiling') {
        writeLog({
          event: 'privacy_create.rejected',
          status: 429,
          sub: authed.session.sub,
          reason: 'request_ceiling',
        });
        throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' });
      }

      // Nhánh `duplicate` là idempotent thành công — KHÔNG audit thứ hai (cùng
      // luật với `already_revoked` của email DELETE): event audit mô tả một sự
      // kiện tạo, không phải một lần bấm nút.
      if (result.kind === 'created') {
        const audited = await appendSecurityEvent(pool, {
          subjectSub: authed.session.sub,
          type: DATA_EVENT_TYPES.privacyRequested,
          metadata: { field_count: 1 },
        });
        if (!audited) {
          writeLog({ event: 'privacy_create.audit_failed', status: 200, sub: authed.session.sub });
        }
      }
      writeLog({ event: 'privacy_create.done', status: 200, sub: authed.session.sub });
      return result;
    });

    return { ok: true, request: toPrivacyRequestView(outcome.row) };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'privacy_create.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
