/**
 * `GET /api/onboarding-status` — trạng thái onboarding của phiên hiện tại
 * (issue #325, giai đoạn 1).
 *
 * Trả `{ needsDisplayName: boolean }` theo `sub` của phiên: `true` khi người
 * dùng chưa đặt displayName ở `account`. UI đọc route này sau login để quyết
 * định có hiển thị màn onboarding hay đi thẳng vào app.
 *
 * ## Đây là gate → fail-closed
 *
 * Route nằm sau middleware authn (`server/middleware/authn.ts` phủ `/api/**`
 * trước mọi route — principal đã verify ở `event.context`). Khi account không
 * trả lời được (binding vắng, secret vắng, unreachable, HTTP lỗi, body sai
 * contract) route trả **503**, không trả `{ needsDisplayName: false }`:
 * "không hỏi được" không được đọc thành "không cần onboarding" — nếu vậy một
 * sự cố của account sẽ lặng lẽ bỏ qua màn onboarding cho người dùng mới.
 *
 * ## Vì sao `Cache-Control: no-store`
 *
 * Response là câu trả lời authority về trạng thái của phiên hiện tại — một
 * tầng cache giữ `{ needsDisplayName: true }` là giữ một người dùng trong màn
 * onboarding sau khi họ đã đặt tên.
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { needsDisplayName } from '@ecoma-io/backoffice-application';
import { accountClientConfig, fetchAccountProfiles } from '@ecoma-io/backoffice-infrastructure';

import { readWorkerEnv } from '../db';
import { writeLog } from '../log';
import { requirePrincipal } from '../principal';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  // Gate của riêng phiên này — principal từ middleware authn, không từ query.
  const principal = requirePrincipal(event);

  const config = accountClientConfig(readWorkerEnv(event));
  if (config === null) {
    writeLog({
      event: 'onboarding_status.failed',
      route: '/api/onboarding-status',
      method: 'GET',
      status: 503,
      sub: principal.actorSub,
      reason: 'account_client_unconfigured',
    });
    throw createError({ statusCode: 503, statusMessage: 'account unavailable' });
  }

  const result = await fetchAccountProfiles(config, [principal.actorSub]);
  if (!result.ok) {
    writeLog({
      event: 'onboarding_status.failed',
      route: '/api/onboarding-status',
      method: 'GET',
      status: 503,
      sub: principal.actorSub,
      reason: result.reason,
    });
    throw createError({ statusCode: 503, statusMessage: 'account unavailable' });
  }

  writeLog({
    event: 'onboarding_status.read',
    route: '/api/onboarding-status',
    method: 'GET',
    status: 200,
    sub: principal.actorSub,
  });

  return { needsDisplayName: needsDisplayName(result.profiles, principal.actorSub) };
});
