/**
 * Unit test của `GET /api/me` — response shape, đường cache và controlled
 * degrade, dùng h3 app thật với event context tự gắn (cùng kiểu với
 * `onboarding-status.get.spec.ts`).
 *
 * ⚠️ Mock dừng ở Service Binding (`fetch`) — handler, validator, cache và
 * degrade logic là code thật. `resetDisplayNameCacheForTests` chạy ở
 * `beforeEach` vì cache là state mức module dùng chung giữa các test.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountProfilesResponse } from '@ecoma-io/account-contracts';
import { resetDisplayNameCacheForTests, storeDisplayNames } from '@ecoma-io/backoffice-application';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import meRoute from './me.get';

const writeLog = vi.fn<(entry: Record<string, unknown>) => void>();
vi.mock('../log', () => ({ writeLog: (...args: unknown[]) => writeLog(...args) }));

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECRET = 'unit-test-internal-secret-0123456789abcdef';
const ENV = { AUTH_INTERNAL_SECRET: SECRET };

function fakeBinding(body: unknown, status = 200): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn<() => Promise<Response>>(
      async () => new Response(JSON.stringify(body), { status }),
    ),
  };
}

async function get(options: {
  readonly env?: Record<string, unknown>;
  readonly principal?: { readonly actorSub: string };
}): Promise<{ status: number; body: unknown }> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      if (options.env !== undefined) {
        event.context.cloudflare = { env: options.env };
      }
      if (options.principal !== undefined) {
        event.context[PRINCIPAL_CONTEXT_KEY] = options.principal;
      }
    }),
  );
  const router = createRouter();
  router.get('/api/me', meRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(new Request('http://localhost/api/me'));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('GET /api/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDisplayNameCacheForTests();
  });

  it('answers 401 when the request carries no principal', async () => {
    const binding = fakeBinding(accountProfilesResponse([{ sub: SUB, displayName: 'X' }]));
    const { status } = await get({ env: { ...ENV, ACCOUNT_SERVICE: binding } });
    expect(status).toBe(401);
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('returns the principal sub with the display name from account', async () => {
    const binding = fakeBinding(
      accountProfilesResponse([{ sub: SUB, displayName: 'Nguyễn Văn A' }]),
    );
    const { status, body } = await get({
      env: { ...ENV, ACCOUNT_SERVICE: binding },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ sub: SUB, displayName: 'Nguyễn Văn A' });
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it('serves a warm cache entry without calling account', async () => {
    storeDisplayNames([{ sub: SUB, displayName: 'Warm' }], Date.now());
    const binding = fakeBinding(accountProfilesResponse([{ sub: SUB, displayName: 'Fresh' }]));
    const { status, body } = await get({
      env: { ...ENV, ACCOUNT_SERVICE: binding },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ sub: SUB, displayName: 'Warm' });
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('degrades to displayName null with a log event when account is unreachable', async () => {
    const binding = {
      fetch: vi.fn<() => Promise<Response>>(async () => {
        throw new Error('network down');
      }),
    };
    const { status, body } = await get({
      env: { ...ENV, ACCOUNT_SERVICE: binding },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ sub: SUB, displayName: null });
    const degraded = writeLog.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.event === 'me.account_degraded');
    expect(degraded).toMatchObject({ reason: 'unreachable' });
  });

  it('degrades to displayName null with a log event when the client is unconfigured', async () => {
    const { status, body } = await get({ env: {}, principal: { actorSub: SUB } });
    expect(status).toBe(200);
    expect(body).toEqual({ sub: SUB, displayName: null });
    const degraded = writeLog.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.event === 'me.account_degraded');
    expect(degraded).toMatchObject({ reason: 'account_client_unconfigured' });
  });

  it('degrades to displayName null when account answers a contract-violating body', async () => {
    const binding = fakeBinding({ profiles: [{ sub: SUB, email: 'a@b.c', displayName: null }] });
    const { status, body } = await get({
      env: { ...ENV, ACCOUNT_SERVICE: binding },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ sub: SUB, displayName: null });
    const degraded = writeLog.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.event === 'me.account_degraded');
    expect(degraded).toMatchObject({ reason: 'invalid_response' });
  });
});
