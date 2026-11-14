/**
 * Helper test dùng chung của `server/api/broker/**` — đóng vai middleware authn
 * cho h3 app dựng thủ công (review #254: tránh nhân bản mocking principal ở
 * mỗi spec file, lệch một chỗ là hai spec lệch nhau).
 *
 * ⚠️ Chỉ dành cho spec colocated: suite `tests/integrations/**` chạy runtime
 * thật qua middleware authn thật, không dùng helper này.
 */

import { defineEventHandler, type EventHandlerRequest, type EventHandlerResponse } from 'h3';

import { PRINCIPAL_CONTEXT_KEY } from '../../principal';

/** Access token của chủ phiên trong test — BFF forward nó xuống API (ADR-0031 §4). */
export const USER_TOKEN = 'user-access-token-value';

/**
 * Middleware gắn principal vào `event.context` — h3 chạy tiếp khi handler trả
 * undefined, đúng hình runtime thật (middleware authn gắn rồi route đọc).
 */
export function principalForTests(): import('h3').EventHandler<
  EventHandlerRequest,
  EventHandlerResponse
> {
  return defineEventHandler((event) => {
    event.context[PRINCIPAL_CONTEXT_KEY] = { actorSub: 'sub-user', accessToken: USER_TOKEN };
  });
}
