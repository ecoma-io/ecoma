/**
 * `GET /api/me` — danh tính hiển thị của phiên hiện tại (issue #325).
 *
 * Trả `{ sub, displayName }` — `sub` từ principal đã verify của middleware
 * authn, `displayName` từ cùng batch contract
 * `GET /internal/account/profiles` mà `/api/staff` và `/api/onboarding-status`
 * dùng, qua cùng cache 120s (`display-name-cache.ts` của
 * `@ecoma-io/backoffice-application`): sub của
 * một phiên chỉ là một entry trong batch, nên ba route chia nhau một cache và
 * một lần fetch phục vụ cả ba.
 *
 * ## Đây là dữ liệu hiển thị → controlled degrade
 *
 * Route **không** enforcement: `displayName` chỉ để hiển thị. Khi `account`
 * không trả lời được (binding vắng, secret vắng, unreachable, HTTP lỗi, body
 * sai contract), route trả `200` với `displayName: null` — đúng tinh thần
 * `staff.get` — kèm **một** dòng log `me.account_degraded` mang reason. `null`
 * là giá trị thật của contract ("chưa đặt tên"), không phải dữ liệu bịa; UI
 * đã có label i18n riêng cho trạng thái này (`onboarding.noDisplayName`).
 *
 * ## Vì sao `Cache-Control: no-store`
 *
 * Response gắn với phiên hiện tại; một tầng cache giữ `{sub, displayName}`
 * trả nhầm cho một phiên khác là rò danh tính giữa các phiên.
 */

import { defineEventHandler, setResponseHeader } from 'h3';

import { cachedDisplayName, storeDisplayNames } from '@ecoma-io/backoffice-application';
import { accountClientConfig, fetchAccountProfiles } from '@ecoma-io/backoffice-infrastructure';

import { readWorkerEnv } from '../db';
import { writeLog } from '../log';
import { requirePrincipal } from '../principal';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const principal = requirePrincipal(event);
  const { actorSub: sub } = principal;

  // Cache hit ⇒ không rời backoffice. Miss ⇒ một batch call cho đúng sub này.
  const nowMs = Date.now();
  let displayName = cachedDisplayName(sub, nowMs);
  if (displayName === undefined) {
    const config = accountClientConfig(readWorkerEnv(event));
    const result = config === null ? null : await fetchAccountProfiles(config, [sub]);

    if (result !== null && result.ok) {
      storeDisplayNames(result.profiles, nowMs);
      displayName = cachedDisplayName(sub, nowMs) ?? null;
    } else {
      // Controlled degrade: `displayName: null` + một dòng log riêng mang reason —
      // điều tra bắt đầu từ đây, không từ response null không dấu vết.
      const reason =
        config === null ? 'account_client_unconfigured' : (result as { reason: string }).reason;
      writeLog({
        event: 'me.account_degraded',
        route: '/api/me',
        method: 'GET',
        status: 200,
        sub,
        reason,
      });
      displayName = null;
    }
  }

  writeLog({
    event: 'me.read',
    route: '/api/me',
    method: 'GET',
    status: 200,
    sub,
  });

  return { sub, displayName };
});
