/**
 * Unit test của `GET /api/auth/callback` — hội tụ ở đúng invariant mà PR
 * wire-internal-origin (issue #356) đổi: **nơi POST `/token` được dựng từ đâu**.
 *
 * ## Vì sao mock dừng ở ba biên mà không xa hơn
 *
 * - **Pool `pg`** (06 §9: spec colocated không boot database thật) — `DELETE`
 *   của `consumeLoginFlow` trả một hàng verifier thật để luồng đi tiếp; mọi thứ
 *   sau là code thật (hash, PKCE, fetch, cookie).
 * - **`globalThis.fetch`** — chính là đối tượng bị assert: URL của POST
 *   `/token` phải đến từ origin nội bộ khi cấu hình, và từ issuer khi không.
 *   Mock trả response token tối thiểu (chỉ `access_token`).
 * - **`verifyAccessToken`** — verify thật cần JWKS server (lib `verify.spec.ts`
 *   đã phủ đường thật ở đó); ở đây nhánh này chỉ là chốt chặn giữa exchange và
 *   INSERT phiên, mock trả `verified` là đủ để luồng đi hết đường 302.
 *
 * Nhờ vậy assertion là **URL fetch bị bắt**, không phải shape token — shape
 * token là hợp đồng của `auth`, không phải của route này.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import callbackHandler from './callback.get';

const db = vi.hoisted(() => ({
  nodeUrl: null as string | null,
  deletedRows: [] as { rows: { code_verifier: string }[] }[],
  inserts: [] as { text: string }[],
}));

const fetchCapture = vi.hoisted(() => ({
  calls: [] as { url: string; method: string }[],
  tokenBody: { access_token: 'at-test-value' } as Record<string, unknown>,
}));

// ⚠️ KHÔNG mock `../../db` nữa: `poolBinding` dùng chung giờ là code thật của
// app — hai nhánh của nó gọi vào `backofficeHyperdrive`/`backofficeNodeDatabaseUrl`
// của barrel mock ở dưới (`hyperdrive → null`, `nodeUrl` do test điều khiển),
// nên đường nguồn DB của route được test qua cấu hình thật của nó.

vi.mock('@ecoma-io/backoffice-infrastructure', async (importOriginal) => {
  // Giữ nguyên các hàm thuần (cookie, deadline...) — mock chỉ thay các biên
  // network/DB của barrel.
  const actual = await importOriginal<typeof import('@ecoma-io/backoffice-infrastructure')>();
  return {
    ...actual,
    backofficeHyperdrive: () => null,
    backofficeNodeDatabaseUrl: () => db.nodeUrl,
    withBackofficePool: async <T>(
      _binding: unknown,
      callback: (pool: unknown) => Promise<T>,
    ): Promise<T> =>
      callback({
        query: async (text: string) => {
          if (text.startsWith('DELETE')) {
            return { rows: db.deletedRows, rowCount: db.deletedRows.length };
          }
          db.inserts.push({ text });
          return { rows: [], rowCount: 1 };
        },
      }),
    accountClientConfig: () => null,
    verifyAccessToken: async () => ({
      outcome: 'verified' as const,
      sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  };
});

const ISSUER = 'https://auth.test.ecoma.io:32768';
const INTERNAL_ORIGIN = 'http://ecoma-w0123456789ab-auth:4203';
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const CONFIG = {
  backofficeAuthIssuer: ISSUER,
  backofficeAuthAudience: 'https://api.test.ecoma.io:32768/backoffice',
  backofficeAuthClientId: 'ecoma-backoffice-local',
};

function handler(): WebHandler {
  const app = createApp();
  const router = createRouter();
  router.get('/api/auth/callback', callbackHandler);
  app.use(router.handler);
  return toWebHandler(app);
}

function callbackRequest(): Request {
  return new Request(
    'https://office.test.ecoma.io:32768/api/auth/callback?code=the-code&state=the-state',
    {
      headers: {
        host: 'office.test.ecoma.io:32768',
        cookie: '__Host-backoffice-login=flow-cookie-value',
      },
    },
  );
}

beforeEach(() => {
  db.nodeUrl = 'postgres://runtime@origin/db-backoffice';
  db.deletedRows = [{ code_verifier: CODE_VERIFIER }];
  db.inserts = [];
  fetchCapture.calls = [];
  vi.stubGlobal('useRuntimeConfig', () => CONFIG);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCapture.calls.push({
        url: input instanceof URL ? input.toString() : String(input),
        method: init?.method ?? 'GET',
      });
      return new Response(JSON.stringify(fetchCapture.tokenBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/auth/callback — token exchange fetch origin', () => {
  it('POSTs the token exchange to the internal origin when it is configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ...CONFIG,
      backofficeAuthInternalOrigin: INTERNAL_ORIGIN,
    }));

    const response = await handler()(callbackRequest());

    // Luồng phải đi trọn đường 302 — harness không chết trước bước exchange.
    expect(response.status).toBe(302);
    const exchange = fetchCapture.calls.find((call) => call.url.endsWith('/token'));
    expect(exchange).toBeDefined();
    expect(exchange?.method).toBe('POST');
    // Origin nội bộ quyết định nơi fetch; issuer chỉ là danh tính `iss`.
    expect(new URL(exchange?.url as string).origin).toBe(INTERNAL_ORIGIN);
    expect(new URL(exchange?.url as string).pathname).toBe('/token');
  });

  it('POSTs the token exchange to the issuer when no internal origin is configured', async () => {
    // Production path: không biến ⇒ URL từ issuer, hành vi giữ nguyên.
    const response = await handler()(callbackRequest());

    expect(response.status).toBe(302);
    const exchange = fetchCapture.calls.find((call) => call.url.endsWith('/token'));
    expect(exchange).toBeDefined();
    expect(new URL(exchange?.url as string).origin).toBe(ISSUER);
    expect(new URL(exchange?.url as string).pathname).toBe('/token');
  });

  it('still issues the session and flow-clearing cookies on the redirect after a completed exchange', async () => {
    // Chứng minh harness đi qua ĐỦ đường thật: phiên được INSERT và cookie
    // `__Host-backoffice-session` + flow-clear nằm trên response — nếu mock
    // nào ăn quá nhiều thì test này đỏ trước khi URL assertion có ý nghĩa.
    vi.stubGlobal('useRuntimeConfig', () => ({
      ...CONFIG,
      backofficeAuthInternalOrigin: INTERNAL_ORIGIN,
    }));

    const response = await handler()(callbackRequest());

    expect(
      db.inserts.some((insert) => insert.text.includes('INSERT INTO backoffice.bff_sessions')),
    ).toBe(true);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-backoffice-session=');
    expect(setCookie).toContain('__Host-backoffice-login=; Max-Age=0');
  });
});
