import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';

/**
 * `GET /api/broker/environments` — danh sách environment của tenant.
 */
export default defineEventHandler(async (event) => {
  // `useRuntimeConfig(event)` — không phải `event.context.runtimeConfig`: slot
  // đó không ai gắn trên runtime thật (chi tiết ở `pacts.get.ts`).
  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }
  const result = await brokerCall(config, '/environments');
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
