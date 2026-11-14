import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3';

import { brokerCall } from '../../../../utils/broker-client';
import { pactBrokerBffConfig } from '../../../../utils/broker-config';
import { requirePrincipal } from '../../../../principal';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `DELETE /api/broker/machine-tokens/:id` — thu hồi credential: hiệu lực tức
 * thời, request kế tiếp dùng secret cũ bị 401. Thao tác destructive — UI đòi
 * confirmation; quyền enforce ở API (ADR-0032 §1).
 */
export default defineEventHandler(async (event) => {
  const principal = requirePrincipal(event);

  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  const id = getRouterParam(event, 'id') ?? '';
  if (!UUID_RE.test(id)) {
    setResponseStatus(event, 404);
    return { error: 'Not Found' };
  }

  const result = await brokerCall(config, principal.accessToken, `/admin/machine-tokens/${id}`, {
    method: 'DELETE',
  });
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
