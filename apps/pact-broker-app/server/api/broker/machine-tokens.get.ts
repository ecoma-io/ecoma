import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';

/**
 * `GET /api/broker/machine-tokens` — metadata token của tenant (không bao giờ
 * có token bản rõ: API chỉ trả metadata cho list, và response đi qua BFF
 * nguyên văn).
 *
 * Route này cần token BFF có scope `admin`; với token scope thấp hơn, API trả
 * 403 — truyền nguyên văn để UI hiển thị đúng "không đủ quyền" thay vì biến
 * thành lỗi hệ thống.
 */
export default defineEventHandler(async (event) => {
  const config = pactBrokerBffConfig(event.context.runtimeConfig);
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }
  const result = await brokerCall(config, '/admin/machine-tokens');
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
