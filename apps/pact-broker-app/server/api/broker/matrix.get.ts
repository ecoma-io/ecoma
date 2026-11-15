import { defineEventHandler, getQuery, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';
import { requirePrincipal } from '../../principal';

/**
 * `GET /api/broker/matrix` — ma trận kèm verdict tri-state cho trang Matrix,
 * forward nguyênván `GET /matrix` của API với các selector người dùng chọn.
 *
 * Trang Matrix (issue #208) gửi tối đa hai selector qua query:
 * `pacticipant`/`version` (bắt buộc ít nhất pacticipant — API trả 400 nếu
 * thiếu, nguyên văn) và `to` (environment/tag/branch, tuỳ chọn). BFF chỉ
 * forward ba tham số có nghĩa — dashboard không phải proxy mù (cùng luật
 * `can-i-deploy.post.ts`).
 */
const ALLOWED_PARAMS = ['pacticipant', 'version', 'to'] as const;

export default defineEventHandler(async (event) => {
  // Principal TRƯỚC config guard (nhất quán cả các route /api/broker/**).
  const principal = requirePrincipal(event);

  // `useRuntimeConfig(event)` — chi tiết ở `pacts.get.ts`.
  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  const incoming = getQuery(event);
  const params = new URLSearchParams();
  for (const key of ALLOWED_PARAMS) {
    const value = incoming[key];
    if (typeof value === 'string' && value !== '') {
      params.set(key, value);
    }
  }
  if (!params.has('pacticipant')) {
    setResponseStatus(event, 400);
    return { error: 'Bad Request', code: 'pacticipant_required' };
  }

  const result = await brokerCall(config, principal.accessToken, `/matrix?${params.toString()}`);
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
