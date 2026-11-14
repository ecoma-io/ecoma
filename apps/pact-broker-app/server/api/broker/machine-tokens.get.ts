import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';
import { requirePrincipal } from '../../principal';

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
  // Principal TRƯỚC config guard (review #254, nhất quán cả 5 route): request
  // chưa xác thực luôn nhận 401 bất kể broker có cấu hình hay không — không rò
  // trạng thái cấu hình cho caller vô danh (contract của `requirePrincipal`).
  const principal = requirePrincipal(event);

  // `useRuntimeConfig(event)` — không phải `event.context.runtimeConfig`: slot
  // đó không ai gắn trên runtime thật (chi tiết ở `pacts.get.ts`).
  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  const result = await brokerCall(config, principal.accessToken, '/admin/machine-tokens');
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
