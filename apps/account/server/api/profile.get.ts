/**
 * `GET /api/profile` — đọc hồ sơ của chính caller.
 *
 * ## Hợp đồng
 *
 * Session hợp lệ → `200` với `{ profile: { displayName, avatarUrl } | null }`.
 * `profile: null` nghĩa là "chưa nhập lần nào" — hàng 1:1 chưa tồn tại; đây là
 * **trạng thái hợp lệ** (khác `404` của route theo id, nơi 404 nói về một record
 * được hỏi). `{ displayName, avatarUrl }` với chuỗi rỗng không bao giờ xuất hiện:
 * CHECK của DB chặn rỗng, và PATCH validate trước khi ghi.
 *
 * ⚠️ **Subject từ session, không từ client** (SR-009): route không đọc `sub` từ
 * query/header nào — giá trị duy nhất quyết định hàng được đọc là `session.sub`.
 *
 * ## Cache
 *
 * `Cache-Control: no-store` — hồ sơ là personal data, mọi response là lần đọc
 * authority (cùng nguyên tắc FR-011e với contract status).
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../lib/bff-session';
import { selectProfile } from '../lib/data-domain';
import { accountHyperdrive } from '../utils/bindings';
import { writeLog } from '../utils/logger';
import { withRequestPool } from '../utils/db';

export interface ProfileBody {
  readonly profile: {
    readonly displayName: string;
    readonly avatarUrl: string | null;
  } | null;
}

export default defineEventHandler(async (event): Promise<ProfileBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'profile_read.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const row = await withRequestPool(hyperdrive, (pool) =>
      selectProfile(pool, authed.session.sub),
    );
    if (row === null) {
      return { profile: null };
    }
    return {
      profile: {
        displayName: row.display_name ?? '',
        avatarUrl: row.avatar_url,
      },
    };
  } catch {
    writeLog({ event: 'profile_read.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
