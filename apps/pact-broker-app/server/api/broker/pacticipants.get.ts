import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';
import { requirePrincipal } from '../../principal';

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
  // `useRuntimeConfig(event)` — không phải `event.context.runtimeConfig`: slot
  // đó không ai gắn trên runtime thật (chi tiết ở `pacts.get.ts`).
  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  // Principal do middleware authn gắn — mang access token của chủ phiên để
  // forward tới API (ADR-0031 §4). Không có principal ⇒ 401 (middleware đã
  // chặn trước; nhánh này là lưới an toàn cho route gọi ngoài middleware).
  const principal = requirePrincipal(event);
  const result = await brokerCall(config, principal.accessToken, '/pacticipants');
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
