import { defineEventHandler, readValidatedBody, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';

/**
 * Body hợp lệ: ba tham số truy vấn của `can-i-deploy`, giới hạn độ dài theo rule
 * name/version/environment của API. Type guard viết tay theo quy ước chung của
 * các server route Nuxt trong repo (xem `apps/account`), không dùng thư viện
 * validate riêng — ranh giới đủ nhỏ để tự viết, và mọi chuỗi forwarded đều bị
 * bọc `encodeURIComponent` ở client.
 */
function isCanIDeployBody(
  value: unknown,
): { pacticipant: string; version: string; to?: string } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { pacticipant, version, to } = value as Record<string, unknown>;
  if (typeof pacticipant !== 'string' || pacticipant.length < 1 || pacticipant.length > 255) {
    return false;
  }
  if (typeof version !== 'string' || version.length < 1 || version.length > 255) {
    return false;
  }
  if (to === undefined) {
    return { pacticipant, version };
  }
  if (typeof to !== 'string' || to.length < 1 || to.length > 100) {
    return false;
  }
  return { pacticipant, version, to };
}

/**
 * `POST /api/broker/can-i-deploy` — kiểm deployability, trả tri-state
 * `deployable: boolean | null` của API nguyên văn.
 *
 * POST (không GET) vì đây là **truy vấn có tham số nhạy cảm** mà dashboard gửi
 * dạng form; dùng POST cho phép validate body bằng type guard và không để tham
 * số nằm trong URL (log access của mọi tầng giữa ghi được URL).
 *
 * Query được validate trước khi forward — dashboard không phải proxy mù: chỉ
 * ba tham số có nghĩa được truyền tiếp, mọi thứ khác bị bỏ.
 */
export default defineEventHandler(async (event) => {
  const config = pactBrokerBffConfig(event.context.runtimeConfig);
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  const query = await readValidatedBody(event, isCanIDeployBody).catch(() => null);
  if (query === null) {
    setResponseStatus(event, 400);
    return { error: 'Bad Request' };
  }

  const params = new URLSearchParams({ pacticipant: query.pacticipant, version: query.version });
  if (query.to !== undefined) {
    params.set('to', query.to);
  }

  const result = await brokerCall(config, `/can-i-deploy?${params.toString()}`);
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
