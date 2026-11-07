import { defineEventHandler, setResponseStatus } from 'h3';

import { pactBrokerBffConfig } from '../utils/broker-config';

/**
 * `GET /ready` — readiness, **có** kiểm phụ thuộc broker API cấu hình được.
 *
 * Phân biệt với `/health` (xem `health.get.ts`): readiness trả lời "Worker có
 * phục vụ request thật được không" — với dashboard, request thật cần cấu hình
 * broker (base URL + token). Thiếu cấu hình là trạng thái không sẵn sàng, không
 * phải trạng thái không khỏe: orchestrator ngừng traffic mới, người vận hành thấy
 * 503 với mã ổn định và sửa cấu hình deployment.
 *
 * ⚠️ Readiness **không** probe broker API bằng HTTP thật: nó chỉ kiểm cấu hình
 * có mặt và hợp lệ. Một lần gọi HTTP thật biến readiness thành serving-path
 * dependency của broker API — đúng thứ mà invariant "observability/khả năng
 * kiểm tra không được trở thành serving-path dependency" cấm; và readiness của
 * dashboard sẽ rung theo một service khác, phủ hết ý nghĩa phân tầng của hai
 * route.
 */
export default defineEventHandler((event) => {
  const configured = pactBrokerBffConfig(event.context.runtimeConfig) !== null;
  if (!configured) {
    setResponseStatus(event, 503);
    return { status: 'unavailable', code: 'broker_not_configured' };
  }
  return { status: 'ready' };
});
