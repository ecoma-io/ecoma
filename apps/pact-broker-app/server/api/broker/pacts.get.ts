import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';

/**
 * `GET /api/broker/pacts` — quan hệ consumer/provider đang có pact, cho trang
 * Pacts.
 *
 * Dùng `/matrix` của API: đó là đường liệt kê quan hệ consumer/provider/version
 * mà API công bố, đủ cho bảng dashboard render. Không route nào của BFF dựng
 * lại logic liệt kê của API.
 */
export default defineEventHandler(async (event) => {
  const config = pactBrokerBffConfig(event.context.runtimeConfig);
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }
  const result = await brokerCall(config, '/matrix');
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
