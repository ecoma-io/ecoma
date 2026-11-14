/**
 * Cấu hình OIDC của `pact-broker-app` — đọc từ `env` của Worker và
 * `runtimeConfig` private, kiểm hình dạng, trả `null` khi chưa cấu hình.
 * Cùng đường `apps/backoffice/server/auth/config.ts` (deliberate duplication).
 *
 * ## Nguồn cấu hình
 *
 * Hai runtime dùng chung một module này:
 * - **Workers** (production/staging): biến nằm trong `env` của Worker —
 *   `PACT_BROKER_AUTH_ISSUER`, `PACT_BROKER_AUTH_AUDIENCE`,
 *   `PACT_BROKER_AUTH_CLIENT_ID` (Worker Secret) — đọc qua
 *   {@link readWorkerEnv} (`server/db.ts`).
 * - **Node container local** (`node-server` preset): biến Nitro private
 *   `pactBrokerAuthIssuer` ← `NITRO_PACT_BROKER_AUTH_ISSUER` (vv.), khai ở
 *   `nuxt.config.ts`, không default.
 *
 * ## Origin fetch nội bộ (tuỳ chọn, local-only)
 *
 * `PACT_BROKER_AUTH_INTERNAL_ORIGIN` ← `pactBrokerAuthInternalOrigin`: khi có
 * mặt, các fetch server-side tới `auth` (token exchange ở callback, JWKS ở
 * verify) dựng URL từ origin này thay vì từ `issuer` — container Node local
 * không resolve được hostname issuer công khai. `iss` vẫn so exact với issuer;
 * chỉ nơi fetch đổi. Vắng mặt (production) ⇒ hành vi giữ nguyên từng byte.
 *
 * ## Vì sao trả `null` thay vì throw
 *
 * "Chưa cấu hình" là trạng thái deployment hợp lệ — caller quyết định phản
 * hồi; middleware authn coi chưa cấu hình là **fail closed** (`503`).
 */

import type { H3Event } from 'h3';

import { readWorkerEnv } from '../db';

/**
 * Tên biến `env` của Worker — **không** có giá trị mặc định nào trong code
 * (invariant 4: giá trị do deploy layer cấp).
 */
export const PACT_BROKER_AUTH_ISSUER_ENV = 'PACT_BROKER_AUTH_ISSUER';
export const PACT_BROKER_AUTH_AUDIENCE_ENV = 'PACT_BROKER_AUTH_AUDIENCE';
export const PACT_BROKER_AUTH_CLIENT_ID_ENV = 'PACT_BROKER_AUTH_CLIENT_ID';
export const PACT_BROKER_AUTH_INTERNAL_ORIGIN_ENV = 'PACT_BROKER_AUTH_INTERNAL_ORIGIN';

/**
 * Cấu hình OIDC đã qua kiểm hình dạng.
 *
 * ⚠️ `issuer` giữ nguyên vẹn, không normalize trailing slash: so exact với
 * claim `iss` — giá trị cấu hình phải là đúng chuỗi discovery công bố.
 */
export interface PactBrokerAppAuthConfigView {
  /** Issuer của `auth` — so exact với claim `iss` và làm base của mọi endpoint. */
  readonly issuer: string;
  /** Audience của `pact-broker` — so exact với claim `aud` của access token. */
  readonly audience: string;
  /** `client_id` của `pact-broker-app` tại `auth` — public client. */
  readonly clientId: string;
  /** Origin fetch server-side (tuỳ chọn, local-only) — `null` khi không cấu hình. */
  readonly internalOrigin: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Đọc một biến từ `env` Worker, fallback runtimeConfig private của Nitro. */
function readAuthEnv(event: H3Event, envKey: string, configKey: string): string | null {
  const env = readWorkerEnv(event);
  if (typeof env === 'object' && env !== null) {
    const fromEnv = readString((env as Record<string, unknown>)[envKey]);
    if (fromEnv !== null) {
      return fromEnv;
    }
  }
  // Nitro chặn `useRuntimeConfig` ngoài runtime thật; test dựng h3 app trực
  // tiếp thì gọi nó là ném — bọc try để đường "không có runtimeConfig" trả
  // `null` như mọi nhánh chưa cấu hình khác.
  try {
    const runtimeConfig = useRuntimeConfig(event) as Record<string, unknown>;
    return readString(runtimeConfig[configKey]);
  } catch {
    return null;
  }
}

/**
 * Đọc cấu hình OIDC của request; `null` khi thiếu bất kỳ biến bắt buộc nào —
 * chung một `null`, không lộ biến nào thiếu. Origin nội bộ là tuỳ chọn.
 */
export function pactBrokerAuthConfig(event: H3Event): PactBrokerAppAuthConfigView | null {
  const issuer = readAuthEnv(event, PACT_BROKER_AUTH_ISSUER_ENV, 'pactBrokerAuthIssuer');
  const audience = readAuthEnv(event, PACT_BROKER_AUTH_AUDIENCE_ENV, 'pactBrokerAuthAudience');
  const clientId = readAuthEnv(event, PACT_BROKER_AUTH_CLIENT_ID_ENV, 'pactBrokerAuthClientId');
  if (issuer === null || audience === null || clientId === null) {
    return null;
  }
  const internalOrigin = readAuthEnv(
    event,
    PACT_BROKER_AUTH_INTERNAL_ORIGIN_ENV,
    'pactBrokerAuthInternalOrigin',
  );
  return { issuer, audience, clientId, internalOrigin };
}
