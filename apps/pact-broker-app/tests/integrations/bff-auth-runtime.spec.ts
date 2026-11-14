/**
 * Hợp đồng authn/authz của **BFF `pact-broker-app`** trên runtime thật
 * (workerd app + workerd API + PostgreSQL container + fake OIDC local) —
 * phần app-owned của DoD #206 (ADR-0031 §2/§3, ADR-0032).
 *
 * Suite này chỉ đo mặt app: middleware authn, CSRF double-submit, callback
 * single-use, logout. Ma trận role/tenant của API (cross-tenant 404, tenant
 * suspended ⇒ 401, forged header) là của API và được ghim ở
 * `apps/pact-broker-api/tests/integrations/user-auth.spec.ts` — nhân bản nó ở
 * đây chỉ tạo bản sao có thể lệch.
 *
 * ⚠️ Assertion "không machine token nào trong traffic/cookie" là bất biến
 * ADR-0031 §5: token seed của Pact CLI/CI tồn tại trong stack (đường machine
 * hợp lệ), nên mọi response/cookie của BFF được so với chính giá trị đó.
 */

import { createHash, randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startBrokerStack, type BrokerSession, type BrokerStack } from './broker-stack';

const SESSION_COOKIE = '__Host-pact-broker-session';
const CSRF_COOKIE = '__Host-pact-broker-csrf';
const CSRF_HEADER = 'x-ecoma-csrf';

let stack: BrokerStack;

beforeAll(async () => {
  stack = await startBrokerStack();
}, 300_000);

afterAll(async () => {
  await stack?.close();
}, 120_000);

/** Cookie header chỉ có session (không CSRF) — dựng ca "thiếu mảnh thứ hai". */
function sessionCookieOnly(session: BrokerSession): string {
  return session.cookieHeader
    .split('; ')
    .filter((pair) => !pair.startsWith(`${CSRF_COOKIE}=`))
    .join('; ');
}

/** Giá trị session identifier (cookie value) — thứ middleware hash để tra DB. */
function sessionIdentifier(session: BrokerSession): string {
  const pair = session.cookieHeader
    .split('; ')
    .find((candidate) => candidate.startsWith(`${SESSION_COOKIE}=`));
  if (pair === undefined) {
    throw new Error('session cookie is missing from the broker session header');
  }
  return pair.slice(SESSION_COOKIE.length + 1);
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Chạy một câu SQL trên DB phiên bằng role runtime của app (chỉ dùng để dựng state). */
async function withAppDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: stack.appDatabaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface BffResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly headers: Headers;
}

async function callBff(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    csrf?: string;
    body?: string;
    redirect?: 'manual';
  } = {},
): Promise<BffResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.csrf !== undefined) headers[CSRF_HEADER] = init.csrf;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${stack.appUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: init.redirect ?? 'follow',
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
    headers: response.headers,
  };
}

describe('pact-broker-app BFF authentication contract (#206)', () => {
  it('answers every /api/broker/* route with 401 when no session cookie is present', async () => {
    const routes: { path: string; method?: string; body?: string }[] = [
      { path: '/api/broker/pacts' },
      { path: '/api/broker/pacticipants' },
      { path: '/api/broker/environments' },
      { path: '/api/broker/machine-tokens' },
      { path: '/api/broker/definitely-not-a-route' },
      { path: '/api/broker/can-i-deploy', method: 'POST', body: '{}' },
    ];

    for (const route of routes) {
      const response = await callBff(route.path, {
        method: route.method,
        body: route.body,
      });

      expect(response.status, `${route.method ?? 'GET'} ${route.path}`).toBe(401);
      expect(response.contentType).toContain('application/json');
      // SR-007: nhánh từ chối không bao giờ mang token/credential.
      expect(response.body).not.toContain(stack.machineToken);
      expect(response.body).not.toContain('Bearer');
    }
  });

  it('serves the reads with a real session, without ever emitting a machine token', async () => {
    const session = await stack.loginSession();

    // Callback chỉ set cookie phiên/CSRF; không mảnh nào được giống token máy
    // và session identifier là opaque (không phải JWT ba segment).
    for (const cookie of session.setCookies) {
      expect(cookie).not.toContain(stack.machineToken);
    }
    expect(sessionIdentifier(session)).not.toContain('.');

    const pacts = await callBff('/api/broker/pacts', { cookie: session.cookieHeader });
    expect(pacts.status).toBe(200);
    expect(pacts.body).not.toContain(stack.machineToken);

    const sessionProbe = await callBff('/api/auth/session', { cookie: session.cookieHeader });
    expect(sessionProbe.status).toBe(200);
    expect(JSON.parse(sessionProbe.body)).toEqual({ authenticated: true });
    expect(sessionProbe.headers.get('cache-control')).toBe('no-store');
  });

  it('answers an idle-expired session with 401 (re-authentication required)', async () => {
    // Dựng hàng phiên đã hết hạn trực tiếp trong DB: `expires_at` do app trượt
    // ở mỗi request, nên chỉ có đường ghi một hàng quá khứ mới đo được nhánh
    // "phiên chết" mà không chờ 12 giờ.
    const identifier = randomBytes(32).toString('base64url');
    const accessToken = await stack.fakeAuth.signAccessToken('pact-broker-app-it-owner', 600);
    await withAppDb(async (client) => {
      await client.query(
        `INSERT INTO pact_broker_app.bff_sessions
           (id_hash, account_sub, access_token, refresh_token, created_at, expires_at)
         VALUES ($1, $2, $3, NULL, now() - interval '2 hours', now() - interval '1 hour')`,
        [hashIdentifier(identifier), 'pact-broker-app-it-owner', accessToken],
      );
    });

    const response = await callBff('/api/broker/pacts', {
      cookie: `${SESSION_COOKIE}=${identifier}`,
    });

    expect(response.status).toBe(401);
    expect(response.body).not.toContain(accessToken);
  });

  it('answers a revoked session with 401 and reports authenticated:false', async () => {
    const session = await stack.loginSession();
    await withAppDb(async (client) => {
      await client.query(
        `UPDATE pact_broker_app.bff_sessions
            SET revoked_at = now()
          WHERE id_hash = $1`,
        [hashIdentifier(sessionIdentifier(session))],
      );
    });

    const response = await callBff('/api/broker/pacts', { cookie: session.cookieHeader });
    expect(response.status).toBe(401);

    const probe = await callBff('/api/auth/session', { cookie: session.cookieHeader });
    expect(JSON.parse(probe.body)).toEqual({ authenticated: false });
  });

  it('rejects a mutation without the CSRF header (401) and with a mismatched one (403)', async () => {
    const session = await stack.loginSession();
    const body = JSON.stringify({ pacticipant: 'svc-consumer', version: '1.0.0' });

    // Thiếu mảnh header ⇒ không chứng minh được cùng client ⇒ 401.
    const missingHeader = await callBff('/api/broker/can-i-deploy', {
      method: 'POST',
      cookie: session.cookieHeader,
      body,
    });
    expect(missingHeader.status).toBe(401);

    // Chỉ có session, không có CSRF cookie lẫn header ⇒ 401.
    const missingBoth = await callBff('/api/broker/can-i-deploy', {
      method: 'POST',
      cookie: sessionCookieOnly(session),
      body,
    });
    expect(missingBoth.status).toBe(401);

    // Đủ hai mảnh nhưng lệch nhau ⇒ 403 (nỗ lực giả mạo).
    const mismatch = await callBff('/api/broker/can-i-deploy', {
      method: 'POST',
      cookie: session.cookieHeader,
      csrf: `${session.csrfToken}-tampered`,
      body,
    });
    expect(mismatch.status).toBe(403);

    // Đủ và khớp ⇒ request đi qua BFF tới API (tri-state `deployable`).
    const accepted = await callBff('/api/broker/can-i-deploy', {
      method: 'POST',
      cookie: session.cookieHeader,
      csrf: session.csrfToken,
      body,
    });
    expect(accepted.status).toBe(200);
    // API trả HAL `{ summary: { deployable }, … }` — tri-state fail-closed.
    const payload = JSON.parse(accepted.body) as { summary?: { deployable?: unknown } };
    expect(
      payload.summary?.deployable === null || typeof payload.summary?.deployable === 'boolean',
    ).toBe(true);
  });

  it('rejects a replayed callback (the login flow is single-use)', async () => {
    // Lấy flow cookie + state thật từ login route, rồi gọi callback HAI lần với
    // cùng một flow: lần đầu consume hàng (DELETE), lần hai rowCount 0 ⇒ 401.
    const login = await fetch(`${stack.appUrl}/api/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const location = login.headers.get('location') ?? '';
    const state = new URL(location).searchParams.get('state') ?? '';
    const flowCookie = login.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Host-pact-broker-login='))
      ?.split(';')[0];
    expect(flowCookie).toBeDefined();
    expect(state).not.toBe('');

    const callbackUrl = `${stack.appUrl}/api/auth/callback?code=it-auth-code&state=${encodeURIComponent(state)}`;
    const first = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: flowCookie ?? '' },
    });
    expect(first.status).toBe(302);

    const replay = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: flowCookie ?? '' },
    });
    expect(replay.status).toBe(401);
    // Và không phiên nào được cấp lại từ flow đã dùng.
    expect(
      replay.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
  });

  it('answers an authenticated request to an unknown /api/broker path with 404', async () => {
    const session = await stack.loginSession();

    const response = await callBff('/api/broker/definitely-not-a-route', {
      cookie: session.cookieHeader,
    });

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });

  it('kills the session on logout (204) and a fresh login afterwards works', async () => {
    const session = await stack.loginSession();

    const logout = await callBff('/api/auth/logout', {
      method: 'POST',
      cookie: session.cookieHeader,
      csrf: session.csrfToken,
    });
    expect(logout.status).toBe(204);

    const afterLogout = await callBff('/api/broker/pacts', { cookie: session.cookieHeader });
    expect(afterLogout.status).toBe(401);

    const fresh = await stack.loginSession();
    const afterFreshLogin = await callBff('/api/broker/pacts', { cookie: fresh.cookieHeader });
    expect(afterFreshLogin.status).toBe(200);
  });

  it('refuses to reach the API with a user token through the admin-only route (403)', async () => {
    // ADR-0032: M1 user path chỉ đọc — `/admin/machine-tokens` là mực admin,
    // đường user nhận 403 (không phải lỗi hệ thống) và BFF truyền nguyên văn.
    const session = await stack.loginSession();

    const response = await callBff('/api/broker/machine-tokens', { cookie: session.cookieHeader });

    expect(response.status).toBe(403);
    expect(response.body).not.toContain(stack.machineToken);
  });
});
