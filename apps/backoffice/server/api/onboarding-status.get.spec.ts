/**
 * Unit test của `GET /api/onboarding-status` — classification fail-closed của
 * từng nhánh hạ tầng, dùng h3 app thật với event context tự gắn (cùng kiểu với
 * `read-route.spec.ts`): route đọc `event.context.cloudflare.env` (binding +
 * secret) và `event.context.backofficePrincipal` (principal của middleware
 * authn).
 *
 * ⚠️ Mock dừng ở Service Binding (`fetch`) — handler, validator và gate logic
 * là code thật.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountProfilesResponse } from '@ecoma-io/account-contracts';

import { PRINCIPAL_CONTEXT_KEY } from '../principal';
import onboardingStatusRoute from './onboarding-status.get';

const writeLog = vi.fn<(entry: Record<string, unknown>) => void>();
vi.mock('../log', () => ({ writeLog: (...args: unknown[]) => writeLog(...args) }));

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECRET = 'unit-test-internal-secret-0123456789abcdef';

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
  router.get('/api/onboarding-status', onboardingStatusRoute);
  app.use(router.handler);

  const response = await toWebHandler(app)(new Request('http://localhost/api/onboarding-status'));
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

describe('GET /api/onboarding-status — fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 401 when the request carries no principal', async () => {
    const binding = fakeBinding(accountProfilesResponse([{ sub: SUB, displayName: 'X' }]));
    const { status } = await get({
      env: { ACCOUNT_SERVICE: binding, AUTH_INTERNAL_SECRET: SECRET },
    });
    expect(status).toBe(401);
    // Gate không gọi account khi chưa có phiên — không request nào rời backoffice.
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('answers 503 when the account client is unconfigured', async () => {
    const { status } = await get({ env: {}, principal: { actorSub: SUB } });
    expect(status).toBe(503);
  });

  it('answers 503 when the account call fails (unreachable)', async () => {
    const binding = {
      fetch: vi.fn<() => Promise<Response>>(async () => {
        throw new Error('network down');
      }),
    };
    const { status } = await get({
      env: { ACCOUNT_SERVICE: binding, AUTH_INTERNAL_SECRET: SECRET },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(503);
  });

  it('answers 503 when account answers with a non-OK status', async () => {
    const binding = fakeBinding({ nope: true }, 503);
    const { status } = await get({
      env: { ACCOUNT_SERVICE: binding, AUTH_INTERNAL_SECRET: SECRET },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(503);
  });
});

describe('GET /api/onboarding-status — ok', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns needsDisplayName true when the sub has no display name', async () => {
    const binding = fakeBinding(accountProfilesResponse([{ sub: SUB, displayName: null }]));
    const { status, body } = await get({
      env: { ACCOUNT_SERVICE: binding, AUTH_INTERNAL_SECRET: SECRET },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ needsDisplayName: true });
  });

  it('returns needsDisplayName false when the sub has a display name', async () => {
    const binding = fakeBinding(accountProfilesResponse([{ sub: SUB, displayName: 'X' }]));
    const { status, body } = await get({
      env: { ACCOUNT_SERVICE: binding, AUTH_INTERNAL_SECRET: SECRET },
      principal: { actorSub: SUB },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ needsDisplayName: false });
  });
});
