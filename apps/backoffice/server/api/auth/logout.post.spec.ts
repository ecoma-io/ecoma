/**
 * Unit test của `POST /api/auth/logout` — hội tụ ở đúng invariant mà #243 đổi:
 * **nơi POST `/revocation` được dựng từ đâu**.
 *
 * Trên local lane, issuer mang port động của Traefik đúng cho browser nhưng
 * container Node không resolve được hostname đó — revocation dựng URL từ
 * issuer là chết im lặng (`revocation_failed` mỗi lần logout). Fix: fetch
 * origin là `internalOrigin ?? issuer`, cùng luật `callback.get.ts`.
 *
 * Mock dừng ở hai biên (06 §9): `globalThis.fetch` và barrel
 * `@ecoma-io/backoffice-infrastructure` (pool + session lookup) — mọi thứ sau
 * là code thật.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logoutHandler from './logout.post';

const SESSION_ROW = {
  id_hash: 'a'.repeat(64),
  account_sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  access_token: 'stale-access-token',
  refresh_token: 'stale-refresh-token' as string | null,
  auth_time: null,
  acr: null,
  created_at: new Date(),
  expires_at: new Date(Date.now() + 3_600_000),
  revoked_at: null,
};

const infra = vi.hoisted(() => ({
  loaded: null as unknown,
}));

vi.mock('@ecoma-io/backoffice-infrastructure', () => ({
  clearCsrfCookie: () => '__Host-backoffice-csrf=; Max-Age=0; Path=/',
  clearSessionCookie: () => '__Host-backoffice-session=; Max-Age=0; Path=/',
  CSRF_COOKIE_NAME: '__Host-backoffice-csrf',
  CSRF_HEADER_NAME: 'x-ecoma-csrf',
  csrfMatches: (cookie: string | undefined, header: string | undefined) =>
    cookie !== undefined && cookie === header,
  hashSessionIdentifier: async () => SESSION_ROW.id_hash,
  loadSessionByHash: async () => infra.loaded,
  revokeSessionByHash: async () => undefined,
  SESSION_COOKIE_NAME: '__Host-backoffice-session',
  // Giữ hình dạng thật của hai hàm nguồn DB: `poolBinding` là code thật của
  // app (không mock), nên hai hàm này đọc đúng runtimeConfig được stub.
  backofficeHyperdrive: () => null,
  backofficeNodeDatabaseUrl: (runtimeConfig: unknown) =>
    (runtimeConfig as { backofficeDatabaseUrl?: string } | null)?.backofficeDatabaseUrl ?? null,
  withBackofficePool: async <T>(_b: unknown, cb: (pool: unknown) => Promise<T>) => cb({}),
}));

const ISSUER = 'https://auth.test.ecoma.io:32768';
const INTERNAL_ORIGIN = 'http://ecoma-w0123456789ab-auth:4203';

const CONFIG = {
  backofficeAuthIssuer: ISSUER,
  backofficeAuthAudience: 'https://api.test.ecoma.io:32768/backoffice',
  backofficeAuthClientId: 'ecoma-backoffice-local',
  // Nguồn DB của `poolBinding` nhánh Node — giá trị không bao giờ được mở
  // connection thật: `withBackofficePool` đã mock.
  backofficeDatabaseUrl: 'postgres://runtime@origin/db-backoffice',
};

let fetchCalls: { url: string; init: RequestInit | undefined }[];

function handler(): WebHandler {
  const app = createApp();
  const router = createRouter();
  router.post('/api/auth/logout', logoutHandler);
  app.use(router.handler);
  return toWebHandler(app);
}

function logoutRequest(): Request {
  // Session cookie bắt buộc: không cookie là nhánh 204 idempotent sớm — không
  // chạm DB, không revoke (chính là bug im lặng của assertion đầu tiên).
  return new Request('https://office.test.ecoma.io:32768/api/auth/logout', {
    method: 'POST',
    headers: { cookie: '__Host-backoffice-session=session-cookie-value' },
  });
}

beforeEach(() => {
  infra.loaded = SESSION_ROW;
  fetchCalls = [];
  vi.stubGlobal('useRuntimeConfig', () => CONFIG);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/logout — revocation fetch origin (#243)', () => {
  it('POSTs revocation to the internal origin when it is configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ...CONFIG,
      backofficeAuthInternalOrigin: INTERNAL_ORIGIN,
    }));

    const response = await handler()(logoutRequest());

    expect(response.status).toBe(204);
    // Cả access lẫn refresh token đều được revoke, đúng origin nội bộ —
    // path `/revocation` không đổi (RFC 7009), chỉ origin đổi.
    const urls = fetchCalls.map((call) => call.url);
    expect(urls).toEqual([`${INTERNAL_ORIGIN}/revocation`, `${INTERNAL_ORIGIN}/revocation`]);
    const body = String(fetchCalls[0]?.init?.body);
    expect(body).toContain('token=stale-access-token');
    expect(body).toContain(`client_id=${CONFIG.backofficeAuthClientId}`);
  });

  it('POSTs revocation to the issuer origin when no internal origin is configured', async () => {
    const response = await handler()(logoutRequest());

    expect(response.status).toBe(204);
    expect(fetchCalls[0]?.url).toBe(`${ISSUER}/revocation`);
  });

  it('still answers 204 and skips revocation when the session is already revoked', async () => {
    infra.loaded = { ...SESSION_ROW, revoked_at: new Date() };

    const response = await handler()(logoutRequest());

    expect(response.status).toBe(204);
    expect(fetchCalls).toHaveLength(0);
  });
});
