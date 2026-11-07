/**
 * Cấu hình OIDC của `backoffice` — đọc từ `env` của Worker và `runtimeConfig`
 * private, kiểm hình dạng, trả `null` khi chưa cấu hình.
 *
 * ## Nguồn cấu hình
 *
 * Hai runtime dùng chung một module này:
 * - **Workers** (production/staging): biến nằm trong `env` của Worker —
 *   `BACKOFFICE_AUTH_ISSUER`, `BACKOFFICE_AUTH_AUDIENCE`,
 *   `BACKOFFICE_AUTH_CLIENT_ID` (Worker Secret) — đọc qua
 *   {@link readWorkerEnv} (`server/db.ts`), cùng đường với binding
 *   `DB_BACKOFFICE` mà `@ecoma-io/backoffice-infrastructure` đọc.
 * - **Node container local** (`node-server` preset): biến Nitro private
 *   `backofficeAuthIssuer` ← `NUXT_BACKOFFICE_AUTH_ISSUER` (vv.), khai ở
 *   `nuxt.config.ts`, không default.
 *
 * ## Origin fetch nội bộ (tuỳ chọn, local-only)
 *
 * `BACKOFFICE_AUTH_INTERNAL_ORIGIN` ← `backofficeAuthInternalOrigin` là
 * **tuỳ chọn**: khi có mặt, các fetch server-side tới `auth` (token exchange ở
 * callback, JWKS ở verify) dựng URL từ origin này thay vì từ `issuer`. Lý do
 * tồn tại: trên local, issuer PHẢI mang port động của Traefik (browser là bên
 * đi theo URL đó) nhưng container Node KHÔNG resolve được hostname issuer và
 * không đi ra host loopback được — đường network duy nhất là alias Docker của
 * WIC auth. Issuer vẫn là danh tính `iss`/authorize; chỉ fetch origin đổi.
 * Vắng mặt (production Workers) ⇒ mọi URL dựng từ issuer như cũ — hành vi
 * production giữ nguyên từng byte.
 *
 * ## Vì sao trả `null` thay vì throw
 *
 * "Chưa cấu hình" là trạng thái deployment hợp lệ (vd. preview chưa cấp
 * secret) — không phải lỗi runtime. Caller quyết định phản hồi: middleware
 * authn coi chưa cấu hình là **fail closed** (`503`, không phải cho qua),
 * đúng nguyên tắc `no_secret` của `apps/account`
 * (`server/middleware/internal-auth.ts`).
 */

import type { H3Event } from 'h3';

import { readWorkerEnv } from '../db';

/**
 * Tên biến `env` của Worker — **không** có giá trị mặc định nào trong code.
 *
 * ⚠️ Giá trị thật do deploy layer cấp (`wrangler secret`); code chỉ chứa tên,
 * không chứa giá trị (invariant 4 của `docs/architecture/01-architecture.md` §9).
 */
export const BACKOFFICE_AUTH_ISSUER_ENV = 'BACKOFFICE_AUTH_ISSUER';
export const BACKOFFICE_AUTH_AUDIENCE_ENV = 'BACKOFFICE_AUTH_AUDIENCE';
export const BACKOFFICE_AUTH_CLIENT_ID_ENV = 'BACKOFFICE_AUTH_CLIENT_ID';
export const BACKOFFICE_AUTH_INTERNAL_ORIGIN_ENV = 'BACKOFFICE_AUTH_INTERNAL_ORIGIN';

/**
 * Cấu hình OIDC đã qua kiểm hình dạng.
 *
 * ⚠️ `issuer` phải khớp **exact** claim `iss` của token (ADR-0012 §2) — vì vậy
 * nó được giữ nguyên vẹn, không normalize trailing slash: `auth` công bố
 * issuer của nó qua discovery, giá trị cấu hình phải là đúng chuỗi đó.
 */
export interface BackofficeAuthConfig {
  /** Issuer của `auth` — so exact với claim `iss` và làm base của mọi endpoint. */
  readonly issuer: string;
  /**
   * Audience của `backoffice` — so exact với claim `aud` của access token.
   *
   * ADR-0012 §5: audience riêng cho `backoffice`, giá trị do lane identity
   * cấp (#194); verifier đọc từ cấu hình riêng và chạy được với audience bất
   * kỳ — test tự ký token theo đúng contract thay vì phụ thuộc giá trị thật.
   */
  readonly audience: string;
  /**
   * `client_id` của `backoffice` tại `auth` — public client, seed thuộc lane
   * identity (#194). BFF dùng nó khi dựng authorize URL và đổi code → token.
   */
  readonly clientId: string;
  /**
   * Origin fetch server-side tới `auth` (không path cuối) — **tuỳ chọn**,
   * `null` khi không cấu hình. Có mặt ⇒ fetch JWKS/token từ origin này;
   * `null` ⇒ fetch từ `issuer` (hành vi production). Xem JSDoc của module.
   */
  readonly internalOrigin: string | null;
}

/** Hình dạng tối thiểu của `env` mà module này đọc — kiểm trước khi dùng. */
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
 * Đọc cấu hình OIDC của request; `null` khi thiếu bất kỳ biến bắt buộc nào.
 *
 * ⚠️ Cả ba biến bắt buộc cùng một điều kiện kích hoạt luồng login — thiếu một
 * biến là luồng không dựng được đúng contract (authorize URL sai, token sai
 * audience hay sai client), nên hàm trả `null` **chung** cho mọi dạng thiếu,
 * không lộ biến nào thiếu. Origin nội bộ là **tuỳ chọn**: vắng ⇒ `null` ở
 * trường đó, không ảnh hưởng điều kiện mở cổng.
 */
export function backofficeAuthConfig(event: H3Event): BackofficeAuthConfig | null {
  const issuer = readAuthEnv(event, BACKOFFICE_AUTH_ISSUER_ENV, 'backofficeAuthIssuer');
  const audience = readAuthEnv(event, BACKOFFICE_AUTH_AUDIENCE_ENV, 'backofficeAuthAudience');
  const clientId = readAuthEnv(event, BACKOFFICE_AUTH_CLIENT_ID_ENV, 'backofficeAuthClientId');
  if (issuer === null || audience === null || clientId === null) {
    return null;
  }
  const internalOrigin = readAuthEnv(
    event,
    BACKOFFICE_AUTH_INTERNAL_ORIGIN_ENV,
    'backofficeAuthInternalOrigin',
  );
  return { issuer, audience, clientId, internalOrigin };
}
