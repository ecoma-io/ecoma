/**
 * Colocated spec của middleware authn — nhánh **refresh** (#258, ADR-0031 §2
 * mục 3): quyết định "khi nào refresh" và phân loại outcome ra 200/401/503,
 * chạy trên **h3 app thật** với middleware thật.
 *
 * Mock dừng ở hai biên (06-testing.md §9): pool `pg` và `verifyAccessToken`
 * (hợp đồng verify đã được `server/auth/verify.ts` + fake OIDC runtime suite
 * phủ ở `tests/integrations/`). `renewSessionTokens` chạy **thật** — hợp đồng
 * phân loại của nó đã được ghim ở `server/auth/refresh.spec.ts`.
 *
 * Assertions ghim cho từng outcome:
 * - `renewed` ⇒ 200, principal mang access token mới (route nhìn thấy token
 *   đã persist, không phải token cũ), CSRF vẫn enforce trước khi gắn.
 * - `invalid_grant` ⇒ 401 + `Set-Cookie` xoá phiên + hàng phiên bị revoke
 *   server-side (SR-007: cookie xoá, không re-auth vòng lặp).
 * - `unavailable` ⇒ 503 (khác "token sai" — không âm thầm hợp lệ).
 * - `failed` ⇒ 401, phiên KHÔNG bị revoke (caller tự login lại).
 * - Token hợp lệ ⇒ không lời gọi `/token` nào (on-demand, không scheduler).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import type { Pool } from 'pg';

import authnMiddleware from './authn';
import { resetInflightRefreshForTests } from '../auth/refresh';
import { hashSessionIdentifier } from '../auth/session';

const verifyOutcome = vi.hoisted(() => ({
  result: {
    outcome: 'verified' as 'verified' | 'invalid' | 'unavailable',
    sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    exp: 0,
  },
}));

/**
 * Mock verify **phân biệt theo token** (một hàm mock, hai lần gọi):
 * token cũ của phiên (`OLD_ACCESS`) đi theo `verifyOutcome.result` do test
 * mutate (hết hạn/không hết hạn); token MỚI do refresh trả (`NEW_ACCESS`) là
 * luôn verified — hợp đồng verify thật đã được ghim ở `server/auth/verify.ts`
 * và suite runtime. Không phân biệt thì refresh success test không dựng được:
 * outcome `invalid` của token cũ là thứ kích hoạt đường refresh.
 */
vi.mock('../auth/verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/verify')>();
  return {
    ...actual,
    verifyAccessToken: async (token: string) =>
      token === OLD_ACCESS
        ? verifyOutcome.result
        : { outcome: 'verified' as const, sub: verifyOutcome.result.sub, exp: 0 },
  };
});

/**
 * Pool mock thay `createPactBrokerAppPool` — middleware tạo pool qua hàm này;
 * mock tránh pool `pg` thật cố kết nối DNS giả. SQL được ghi vào
 * `executedQueries`; SELECT trả `sessionRow`.
 */
vi.mock('../auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/session')>();
  return {
    ...actual,
    createPactBrokerAppPool: (): Pool => createPoolMock(),
  };
});

const CONFIG = {
  issuer: 'https://auth.test.ecoma.io',
  audience: 'https://api.test.ecoma.io/pact-broker',
  clientId: 'ecoma-pact-broker-app-local',
  internalOrigin: null as string | null,
};

const SESSION_COOKIE = '__Host-pact-broker-session';
/**
 * Hash thật của cookie phiên trong probe — middleware chạy `hashSessionIdentifier`
 * thật (mock chỉ thay `createPactBrokerAppPool`), nên mọi SQL phải so với hash
 * này, không phải chuỗi cookie thô.
 */
const ID_HASH = await hashSessionIdentifier('opaque-session-id');
const OLD_ACCESS = 'expired-access-token';
const OLD_REFRESH = 'old-refresh-token';
const NEW_ACCESS = 'new-access-token';

/** Hàng phiên mà mock pool trả cho `loadSessionByHash` — mutate trong test. */
let sessionRow: Record<string, unknown> | null;

/** Ghi lại mọi lệnh SQL của pool mock — assert UPDATE revoke/rotate. */
let executedQueries: { text: string; values: readonly unknown[] }[];

function createPoolMock(): Pool {
  executedQueries = [];
  return {
    query: async (text: string, values?: readonly unknown[]) => {
      executedQueries.push({ text, values: values ?? [] });
      const first = String(text).trim().split(/\s+/u)[0]?.toUpperCase() ?? '';
      if (first === 'SELECT') {
        return { rows: sessionRow === null ? [] : [sessionRow], rowCount: 1 };
      }
      // UPDATE/INSERT: mặc định khớp 1 hàng.
      return { rows: [], rowCount: 1 };
    },
    end: async () => undefined,
  } as unknown as Pool;
}

function buildApp(env: Record<string, unknown>): (request: Request) => Promise<Response> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.cloudflare = { env };
    }),
  );
  app.use(authnMiddleware);
  const router = createRouter();
  router.get(
    '/api/broker/pacts',
    defineEventHandler((event) => {
      const principal = (event.context as Record<string, unknown>)['pactBrokerAppPrincipal'] as
        | { accessToken?: unknown }
        | undefined;
      return {
        ok: true,
        accessToken: typeof principal?.accessToken === 'string' ? principal.accessToken : null,
      };
    }),
  );
  app.use(router.handler);
  return toWebHandler(app);
}

function liveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id_hash: ID_HASH,
    account_sub: verifyOutcome.result.sub,
    access_token: OLD_ACCESS,
    refresh_token: OLD_REFRESH,
    created_at: new Date(now.getTime() - 60_000),
    expires_at: new Date(now.getTime() + 3_600_000),
    revoked_at: null,
    ...overrides,
  };
}

/**
 * Env Worker test — cấu hình OIDC + binding Hyperdrive (poolBinding đọc shape
 * `{ connectionString }`); connection string là giả, pool là mock.
 */
function envWithDb(): Record<string, unknown> {
  return {
    PACT_BROKER_AUTH_ISSUER: CONFIG.issuer,
    PACT_BROKER_AUTH_AUDIENCE: CONFIG.audience,
    PACT_BROKER_AUTH_CLIENT_ID: CONFIG.clientId,
    DB_PACT_BROKER_APP: { connectionString: 'postgres://mock.invalid/db' },
  };
}

async function probe(app: (request: Request) => Promise<Response>): Promise<{
  status: number;
  body: unknown;
  setCookie: string[];
}> {
  const response = await app(
    new Request('https://pact-broker-app.test/api/broker/pacts', {
      headers: { cookie: `${SESSION_COOKIE}=opaque-session-id` },
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    setCookie: response.headers.getSetCookie(),
  };
}

beforeEach(() => {
  resetInflightRefreshForTests();
  verifyOutcome.result = { outcome: 'verified', sub: verifyOutcome.result.sub, exp: 0 };
  sessionRow = liveRow();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: NEW_ACCESS, refresh_token: 'new-refresh' }), {
          status: 200,
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authn middleware refresh path (#258)', () => {
  it('renews an expired token, attaches the new one to the principal, and persists the rotation', async () => {
    verifyOutcome.result = { outcome: 'invalid', sub: verifyOutcome.result.sub, exp: 0 };
    const app = buildApp(envWithDb());

    const result = await probe(app);

    expect(result.status).toBe(200);
    // Route nhìn thấy token MỚI — forward token đã persist, không phải token cũ.
    expect(result.body).toEqual({ ok: true, accessToken: NEW_ACCESS });
    const update = executedQueries.find((query) => query.text.includes('SET access_token'));
    expect(update?.values).toEqual([ID_HASH, NEW_ACCESS, 'new-refresh']);
  });

  it('does not call the token endpoint when the access token is still valid', async () => {
    const app = buildApp(envWithDb());

    const result = await probe(app);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, accessToken: OLD_ACCESS });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it('answers 503 when the token endpoint is unreachable — never a silent valid session', async () => {
    verifyOutcome.result = { outcome: 'invalid', sub: verifyOutcome.result.sub, exp: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const app = buildApp(envWithDb());

    const result = await probe(app);

    expect(result.status).toBe(503);
    // Không nửa phiên: h3 trả payload lỗi của mình, không chạy route — không
    // token cũ nào được gắn principal hay persist.
    expect(result.body).toMatchObject({
      statusCode: 503,
      statusMessage: 'authorization unavailable',
    });
    expect(result.body).not.toHaveProperty('accessToken');
  });

  it('destroys the session server-side, clears the cookie, and answers 401 on invalid_grant (reuse)', async () => {
    verifyOutcome.result = { outcome: 'invalid', sub: verifyOutcome.result.sub, exp: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const app = buildApp(envWithDb());

    const result = await probe(app);

    expect(result.status).toBe(401);
    // Cookie phiên bị xoá — expiry quá khứ, kèm đúng thuộc tính `__Host-`.
    const cleared = result.setCookie.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    // Phiên bị revoke server-side — không re-auth vòng lặp với cùng phiên.
    const revoke = executedQueries.find((query) => query.text.includes('revoked_at = now()'));
    expect(revoke?.values).toEqual([ID_HASH]);
  });

  it('answers 401 without revoking the session when the refresh grant fails for other reasons', async () => {
    verifyOutcome.result = { outcome: 'invalid', sub: verifyOutcome.result.sub, exp: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })),
    );
    const app = buildApp(envWithDb());

    const result = await probe(app);

    expect(result.status).toBe(401);
    expect(result.setCookie).toEqual([]);
    expect(
      executedQueries.find((query) => query.text.includes('revoked_at = now()')),
    ).toBeUndefined();
  });

  it('answers 401 without touching the token endpoint when the session has no refresh token', async () => {
    verifyOutcome.result = { outcome: 'invalid', sub: verifyOutcome.result.sub, exp: 0 };
    sessionRow = liveRow({ refresh_token: null });
    const app = buildApp(envWithDb());

    const result = await probe(app);

    expect(result.status).toBe(401);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it('rejects a renewed token whose sub mismatches the session row (fail-closed defense)', async () => {
    verifyOutcome.result = { outcome: 'invalid', sub: verifyOutcome.result.sub, exp: 0 };
    sessionRow = liveRow({ account_sub: 'sub_otherowner' });
    const app = buildApp(envWithDb());

    const result = await probe(app);

    // 401, h3 trả payload lỗi của mình — sub khác hàng phiên không được dùng phiên cũ.
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ statusCode: 401, statusMessage: 'unauthorized' });
    expect(result.body).not.toHaveProperty('accessToken');
  });
});
