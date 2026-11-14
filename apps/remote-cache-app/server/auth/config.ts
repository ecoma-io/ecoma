/**
 * Cấu hình OIDC của `remote-cache-app` — deliberate duplication của
 * `apps/pact-broker-app/server/auth/config.ts` (module boundary cấm import
 * chéo, 05-code-architecture.md §7).
 *
 * ## Nguồn cấu hình
 *
 * Hai runtime dùng chung một module này:
 * - **Workers** (production/staging): biến nằm trong `env` của Worker —
 *   `REMOTE_CACHE_AUTH_ISSUER`, `REMOTE_CACHE_AUTH_AUDIENCE`,
 *   `REMOTE_CACHE_AUTH_CLIENT_ID` (Worker Secret) — đọc qua
 *   {@link readWorkerEnv} (`server/db.ts`).
 * - **Node container local** (`node-server` preset): biến Nitro private
 *   `remoteCacheAuthIssuer` ← `NITRO_REMOTE_CACHE_AUTH_ISSUER` (vv.), khai ở
 *   `nuxt.config.ts`, không default.
 *
 * ## Origin fetch nội bộ (tuỳ chọn, local-only)
 *
 * `REMOTE_CACHE_AUTH_INTERNAL_ORIGIN` ← `remoteCacheAuthInternalOrigin`: khi có
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
export const REMOTE_CACHE_AUTH_ISSUER_ENV = 'REMOTE_CACHE_AUTH_ISSUER';
export const REMOTE_CACHE_AUTH_AUDIENCE_ENV = 'REMOTE_CACHE_AUTH_AUDIENCE';
export const REMOTE_CACHE_AUTH_CLIENT_ID_ENV = 'REMOTE_CACHE_AUTH_CLIENT_ID';
export const REMOTE_CACHE_AUTH_INTERNAL_ORIGIN_ENV = 'REMOTE_CACHE_AUTH_INTERNAL_ORIGIN';

/**
 * Cấu hình OIDC đã qua kiểm hình dạng.
 *
 * ⚠️ `issuer` giữ nguyên vẹn, không normalize trailing slash: so exact với
 * claim `iss` — giá trị cấu hình phải là đúng chuỗi discovery công bố.
 */
export interface RemoteCacheAppAuthConfigView {
  /** Issuer của `auth` — so exact với claim `iss` và làm base của mọi endpoint. */
  readonly issuer: string;
  /** Audience của control plane — so exact với claim `aud` của access token. */
  readonly audience: string;
  /** `client_id` của `remote-cache-app` tại `auth` — public client. */
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
  // `null` như mọi nhánh chưa cấu hình khác. Kịch bản xấu nhất của catch-all
  // này là 503 fail-closed, không bao giờ là allow.
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
export function remoteCacheAuthConfig(event: H3Event): RemoteCacheAppAuthConfigView | null {
  const issuer = readAuthEnv(event, REMOTE_CACHE_AUTH_ISSUER_ENV, 'remoteCacheAuthIssuer');
  const audience = readAuthEnv(event, REMOTE_CACHE_AUTH_AUDIENCE_ENV, 'remoteCacheAuthAudience');
  const clientId = readAuthEnv(event, REMOTE_CACHE_AUTH_CLIENT_ID_ENV, 'remoteCacheAuthClientId');
  if (issuer === null || audience === null || clientId === null) {
    return null;
  }
  const internalOrigin = readAuthEnv(
    event,
    REMOTE_CACHE_AUTH_INTERNAL_ORIGIN_ENV,
    'remoteCacheAuthInternalOrigin',
  );
  return { issuer, audience, clientId, internalOrigin };
}
