import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';

/**
 * `GET /api/broker/pacticipants` — danh sách pacticipant của tenant, cho trang
 * Overview/Pacts.
 *
 * Mọi route `/api/broker/**` cùng một hình dạng: đọc cấu hình → thiếu thì 503
 * fail-closed → forward kèm machine token server-side. Trạng thái của API được
 * truyền nguyên văn; lỗi transport (`errorCode`) biến thành 502 — lỗi của BFF,
 * không phải của dashboard hay của API.
 */
export default defineEventHandler(async (event) => {
  const config = pactBrokerBffConfig(event.context.runtimeConfig);
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }
  const result = await brokerCall(config, '/pacticipants');
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
