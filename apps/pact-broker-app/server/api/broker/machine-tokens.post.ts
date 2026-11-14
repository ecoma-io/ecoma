import { defineEventHandler, readValidatedBody, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';
import { requirePrincipal } from '../../principal';

/**
 * Body hợp lệ của tạo credential (ADR-0032 §1a/§1e, §2): purpose bắt buộc
 * (`developer` | `ci`), name 1–255, scopes ⊆ enum của API. Scope ≤ authority
 * của creator được enforce ở API side — BFF chỉ mirror để UI disable control
 * trước khi gọi; không tin validation này làm security boundary.
 */
export interface CreateTokenBody {
  readonly name: string;
  readonly scopes: string[];
  readonly purpose: 'developer' | 'ci';
}

function isCreateTokenBody(value: unknown): CreateTokenBody | false {
  if (typeof value !== 'object' || value === null) return false;
  const { name, scopes, purpose } = value as Record<string, unknown>;
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) return false;
  if (purpose !== 'developer' && purpose !== 'ci') return false;
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 3) return false;
  if (!scopes.every((s) => s === 'read' || s === 'write' || s === 'admin')) return false;
  // Trùng scope là dữ liệu rác cho API — lọc ở đây, giữ thứ tự client chọn.
  return { name, scopes: [...new Set(scopes)], purpose };
}

/**
 * `POST /api/broker/machine-tokens` — tạo machine credential theo danh tính
 * user (ADR-0031 §4: BFF forward access token của chủ phiên; ADR-0032 §1:
 * quyền tạo do API enforce theo ma trận role). Response chứa plaintext ĐÚNG
 * MỘT LẦN (show-once) — không đường đọc lại; body đi qua nguyên văn.
 */
export default defineEventHandler(async (event) => {
  const principal = requirePrincipal(event);

  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  const body = (await readValidatedBody(event, isCreateTokenBody).catch(
    () => null,
  )) as CreateTokenBody | null;
  if (body === null) {
    setResponseStatus(event, 400);
    return { error: 'Bad Request' };
  }

  const result = await brokerCall(config, principal.accessToken, '/admin/machine-tokens', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
