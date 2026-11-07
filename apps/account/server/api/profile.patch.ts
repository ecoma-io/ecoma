/**
 * `PATCH /api/profile` — ghi hồ sơ của chính caller (upsert hàng 1:1).
 *
 * ## Hợp đồng
 *
 * Body JSON `{ displayName?, avatarUrl? }`:
 * - Trường **không gửi** giữ nguyên giá trị hiện có (partial update cùng tinh
 *   thần FR-008e); gửi `null` thì xoá giá trị đó (avatar gỡ được, display_name
 *   quay về "chưa nhập").
 * - `displayName` phải là chuỗi 1–200 ký tự sau trim — chuỗi rỗng là **400**
 *   (đúng CHECK của DB: NULL = chưa nhập, rỗng là dạng sai; không có đường nào
 *   ghi rỗng để sau này đọc ra hai ngữ nghĩa).
 * - `avatarUrl` phải là `null` hoặc URL `https://` — CHECK của DB chỉ pin scheme
 *   (comment 0008), validation phần còn lại là của app; v1 nhận mọi HTTPS URL
 *   đúng hình dạng, allowlist host là quyết định sản phẩm sau này.
 * - Sai hình dạng → `400`; thành công → `200` với hàng sau ghi.
 *
 * ## 401/403/CSRF
 *
 * Mutation — `requireAuthedSession` kiểm CSRF double-submit trước: CSRF sai là
 * `403`, không session là `401` (hợp đồng của helper). Subject luôn từ session
 * row (SR-009).
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../lib/bff-session';
import {
  AVATAR_URL_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  selectProfile,
  upsertProfile,
} from '../lib/data-domain';
import { accountHyperdrive } from '../utils/bindings';
import { writeLog } from '../utils/logger';
import { withRequestPool } from '../utils/db';

/** Kết quả validate PATCH profile. */
interface ProfilePatch {
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
}

/**
 * HTTPS URL đúng hình dạng — scheme pin của DB (CHECK `^https://`) được lặp lại
 * ở đây để request sai bị `400` **trước** khi chạm DB; DB vẫn là lớp hai.
 * `URL` parse chặn chuỗi có khoảng trắng/điều khiển; `.href` của object kết quả
 * là dạng chuẩn hoá được ghi xuống (không lưu chuỗi thô chưa parse).
 */
function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.href.length <= AVATAR_URL_MAX_LENGTH;
  } catch {
    return false;
  }
}

function isProfilePatch(value: unknown): ProfilePatch | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const patch: { displayName?: string | null; avatarUrl?: string | null } = {};

  const displayName = (value as { displayName?: unknown }).displayName;
  if (displayName !== undefined) {
    if (displayName !== null) {
      if (typeof displayName !== 'string') {
        return false;
      }
      const trimmed = displayName.trim();
      if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
        return false;
      }
      patch.displayName = trimmed;
    } else {
      patch.displayName = null;
    }
  }

  const avatarUrl = (value as { avatarUrl?: unknown }).avatarUrl;
  if (avatarUrl !== undefined) {
    if (avatarUrl !== null) {
      if (typeof avatarUrl !== 'string' || !isHttpsUrl(avatarUrl)) {
        return false;
      }
      patch.avatarUrl = avatarUrl;
    } else {
      patch.avatarUrl = null;
    }
  }

  return patch;
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isProfilePatch).catch(() => null);
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'profile_update.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    return await withRequestPool(hyperdrive, async (pool) => {
      const existing = await selectProfile(pool, authed.session.sub);
      await upsertProfile(pool, {
        userSub: authed.session.sub,
        displayName:
          body.displayName === undefined ? (existing?.display_name ?? null) : body.displayName,
        avatarUrl: body.avatarUrl === undefined ? (existing?.avatar_url ?? null) : body.avatarUrl,
      });
      // Audit sau khi state change thành công — một PATCH thất bại không tạo
      // event `success` giả. Lỗi audit không hỏng request (NFR-004), chỉ log.
      const audited = await appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: DATA_EVENT_TYPES.profileUpdated,
        metadata: { field_count: body.displayName === undefined ? 1 : 2 },
      });
      if (!audited) {
        writeLog({ event: 'profile_update.audit_failed', status: 200, sub: authed.session.sub });
      }
      writeLog({ event: 'profile_update.done', status: 200, sub: authed.session.sub });

      const row = await selectProfile(pool, authed.session.sub);
      return {
        profile: {
          displayName: row?.display_name ?? '',
          avatarUrl: row?.avatar_url ?? null,
        },
      };
    });
  } catch {
    writeLog({ event: 'profile_update.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
