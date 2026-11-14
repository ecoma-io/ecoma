/**
 * Client control-plane của `remote-cache-app` — BFF gọi `remote-cache-api`
 * portal surface bằng envelope HMAC nội bộ `ecoma-internal-v2`
 * (`@ecoma-io/internal-auth-contracts`) mang actor `sub` ĐÃ VERIFY (ADR-0034).
 *
 * ## Biên xác thực — browser KHÔNG BAO GIỜ gọi control plane trực tiếp
 *
 * Mọi request của trình duyệt vào `/api/portal/**` đi qua middleware authn của
 * app này, rồi client dưới đây ký bằng `INTERNAL_AUTH_SECRET` (secret dùng
 * chung BFF ↔ control plane, deploy cấp qua env). Browser không có API key,
 * không có secret, không có đường network tới `remote-cache-api`.
 *
 * ## Nguồn cấu hình — hai runtime, một thứ tự ưu tiên
 *
 * - **Workers** (production/staging): `REMOTE_CACHE_API_BASE_URL` +
 *   `INTERNAL_AUTH_SECRET` (Worker Secret) đọc qua {@link readWorkerEnv}.
 * - **Node container local**: Nitro private `remoteCacheApiBaseUrl` ←
 *   `NITRO_REMOTE_CACHE_API_BASE_URL`, `internalAuthSecret` ←
 *   `NITRO_INTERNAL_AUTH_SECRET` (khai ở `nuxt.config.ts`, không default).
 *
 * ## Fail-closed
 *
 * Thiếu base URL hay secret ⇒ `null` — caller trả `503`; không có nhánh nào
 * coi "chưa cấu hình" là "cho phép". Lỗi network khi fetch ⇒ lỗi được bọc
 * `ControlPlaneUnavailableError` — caller trả `502` (control plane trả lời
 * không được là lỗi gateway, khác `503` là "app này chưa cấu hình").
 */

import type { H3Event } from 'h3';

import { signRequest } from '@ecoma-io/internal-auth-contracts';

import { readWorkerEnv } from './db';

/** Tên biến `env` của Worker — base URL của control plane. */
export const REMOTE_CACHE_API_BASE_URL_ENV = 'REMOTE_CACHE_API_BASE_URL';

/** Tên biến `env` của Worker — secret HMAC dùng chung với `remote-cache-api`. */
export const INTERNAL_AUTH_SECRET_ENV = 'INTERNAL_AUTH_SECRET';

/** Khoá runtimeConfig private tương ứng (`NITRO_REMOTE_CACHE_API_BASE_URL`). */
export const REMOTE_CACHE_API_BASE_URL_CONFIG_KEY = 'remoteCacheApiBaseUrl';

/** Khoá runtimeConfig private tương ứng (`NITRO_INTERNAL_AUTH_SECRET`). */
export const INTERNAL_AUTH_SECRET_CONFIG_KEY = 'internalAuthSecret';

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Đọc một biến từ `env` Worker, fallback runtimeConfig private của Nitro. */
function readConfigValue(event: H3Event, envKey: string, configKey: string): string | null {
  const env = readWorkerEnv(event);
  if (typeof env === 'object' && env !== null) {
    const fromEnv = readString((env as Record<string, unknown>)[envKey]);
    if (fromEnv !== null) {
      return fromEnv;
    }
  }
  // Nitro chặn `useRuntimeConfig` ngoài runtime thật; test dựng h3 thủ công
  // thì gọi nó là ném — bọc try để đường "không có runtimeConfig" trả `null`
  // như mọi nhánh chưa cấu hình khác. Kịch bản xấu nhất của catch-all này là
  // 503 fail-closed, không bao giờ là allow.
  try {
    const runtimeConfig = useRuntimeConfig(event) as Record<string, unknown>;
    return readString(runtimeConfig[configKey]);
  } catch {
    return null;
  }
}

/** Cấu hình control plane đã qua kiểm hình dạng; `null` khi thiếu biến nào. */
export interface RemoteCacheControlPlaneConfig {
  /** Base URL của `remote-cache-api` — absolute, không path. */
  readonly baseUrl: string;
  /** Secret HMAC dùng chung — KHÔNG BAO GIỜ vào log/response. */
  readonly secret: string;
}

/**
 * Đọc cấu hình control plane của request; `null` khi thiếu bất kỳ biến nào —
 * chung một `null`, không lộ biến nào thiếu.
 */
export function remoteCacheControlPlaneConfig(
  event: H3Event,
): RemoteCacheControlPlaneConfig | null {
  const baseUrl = readConfigValue(
    event,
    REMOTE_CACHE_API_BASE_URL_ENV,
    REMOTE_CACHE_API_BASE_URL_CONFIG_KEY,
  );
  const secret = readConfigValue(event, INTERNAL_AUTH_SECRET_ENV, INTERNAL_AUTH_SECRET_CONFIG_KEY);
  if (baseUrl === null || secret === null) {
    return null;
  }
  return { baseUrl, secret };
}

/** Lỗi fetch control plane không trả lời được — caller ánh xạ `502`. */
export class ControlPlaneUnavailableError extends Error {
  constructor(cause: unknown) {
    super('control plane is unreachable');
    this.name = 'ControlPlaneUnavailableError';
    this.cause = cause;
  }
}

/** Tham số một lần gọi control plane đã ký. */
export interface ControlPlaneCallInput {
  /** HTTP method. */
  readonly method: 'GET' | 'POST';
  /**
   * Path **kể cả query string** — đúng chuỗi được ký (`pathname + search` của
   * canonical string), ví dụ `/tenants/acme/projects?limit=50`.
   */
  readonly path: string;
  /** Thân request — **đúng byte** sẽ được gửi (không serialize lại). */
  readonly body?: Uint8Array | null;
  /** Actor `sub` đã verify của phiên — nằm trong canonical string (ADR-0034). */
  readonly actorSub: string;
}

/** Kết quả một lần gọi control plane — body đã decode ở mức JSON. */
export interface ControlPlaneCallResult {
  /** Status HTTP của control plane — pass-through. */
  readonly status: number;
  /** Body JSON đã parse; body rỗng/không phải JSON ⇒ `null`. */
  readonly json: unknown;
}

/**
 * Gọi control plane với envelope HMAC. Không ném trừ {@link
 * ControlPlaneUnavailableError} (network/abort) — mọi status HTTP của control
 * plane được trả nguyên vẹn cho caller quyết định.
 *
 * ⚠️ Secret không bao giờ đi vào URL, header khác, log hay response — chỉ
 * trong phép HMAC của `signRequest`.
 */
export async function callControlPlane(
  config: RemoteCacheControlPlaneConfig,
  input: ControlPlaneCallInput,
): Promise<ControlPlaneCallResult> {
  const headers: Record<string, string> = {
    ...((await signRequest({
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      secret: config.secret,
      actorSub: input.actorSub,
      timestamp: String(Math.floor(Date.now() / 1000)),
    })) as Record<string, string>),
  };
  if (input.body !== null && input.body !== undefined && input.body.length > 0) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body === null || input.body === undefined || input.body.length === 0
        ? {}
        : { body: input.body as BodyInit }),
    });
  } catch (error) {
    throw new ControlPlaneUnavailableError(error);
  }

  const rawBody = await response.text();
  let json: unknown = null;
  if (rawBody.length > 0) {
    try {
      json = JSON.parse(rawBody) as unknown;
    } catch {
      // Body không phải JSON (vd body rỗng hay text của 502 upstream) — giữ
      // `null`; caller quyết định theo status, không cần raw text.
      json = null;
    }
  }
  return { status: response.status, json };
}
