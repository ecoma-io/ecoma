/**
 * Unit test của `renewSessionTokens`/`renewSessionTokensOnce`
 * (`server/auth/refresh.ts`) — hợp đồng gia hạn access token từ refresh token
 * (#258, ADR-0031 §2 mục 3).
 *
 * Mock dừng ở ba biên (06-testing.md §9: spec colocated không boot database
 * thật, không fetch thật, không JWKS server thật): `globalThis.fetch`, pool
 * `pg` và `verifyAccessToken`. Assertions ghim:
 *
 * 1. URL của POST `/token` dựng từ `internalOrigin` khi có, từ `issuer` khi
 *    không (cùng luật fetch-origin với callback/logout);
 * 2. Body mang `grant_type=refresh_token` + `client_id` (RFC 6749 §6);
 * 3. Thành công ⇒ UPDATE **cả hai** cột token (rotation của auth — persist
 *    thiếu refresh token mới là phá phiên sau lần gia hạn đầu) và giá trị trả
 *    về là `renewed` + sub + access token mới (chỉ bộ nhớ request, SR-007);
 * 4. Phân loại: `invalid_grant` (reuse ⇒ caller huỷ phiên), `unavailable`
 *    (network/timeout/JWKS ⇒ 503), `failed` (mọi nhánh còn lại ⇒ 401);
 * 5. Single-flight (#258): N request đồng thời cùng `idHash` ⇒ đúng MỘT lời
 *    gọi fetch `/token`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  renewSessionTokens,
  renewSessionTokensOnce,
  resetInflightRefreshForTests,
} from './refresh';

const verifyOutcome = vi.hoisted(() => ({
  // Kiểu nở đủ ba outcome của union `TokenVerifyResult` — test mutate giữa
  // các nhánh; trường `sub`/`exp` không có nghĩa ở nhánh khác.
  result: {
    outcome: 'verified' as 'verified' | 'invalid' | 'unavailable',
    sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    exp: 0,
  },
}));

vi.mock('./verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify')>();
  return {
    ...actual,
    verifyAccessToken: async () => verifyOutcome.result,
  };
});

const ISSUER = 'https://auth.test.ecoma.io:32768';
const INTERNAL_ORIGIN = 'http://ecoma-w0123456789ab-auth:4203';
const ID_HASH = 'a'.repeat(64);
const OLD_REFRESH = 'old-refresh-token';
const NEW_ACCESS = 'new-access-token';
const NEW_REFRESH = 'new-refresh-token';

const CONFIG = {
  issuer: ISSUER,
  audience: 'https://api.test.ecoma.io:32768/pact-broker',
  clientId: 'ecoma-pact-broker-app-local',
  internalOrigin: null as string | null,
};

const VERIFIED_RESULT = () => ({
  outcome: 'verified' as const,
  sub: verifyOutcome.result.sub,
  exp: 0,
});

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * Response kế tiếp fetch mock trả — xếp hàng trước mỗi lần gọi renew. Module
 * scope có chủ đích: vitest chạy file này SERIAL (một file = một worker, không
 * `concurrent`), nên mutate-before-renew của test trước không rỉ vào test sau —
 * `beforeEach` reset đủ để không phụ thuộc thứ tự khai báo test.
 */
let nextResponse: { status: number; payload: Record<string, unknown> | null } = {
  status: 200,
  payload: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH },
};
let fetchCalls: FetchCall[] = [];

/**
 * Pool mock thuần — `queries` ghi lại mọi lệnh để assert; `updateRowCount`
 * điều khiển rowCount của UPDATE (mặc định 1 = khớp 1 hàng).
 */
function createPoolMock(): {
  queries: { text: string; values: readonly unknown[] }[];
  handle: { updateRowCount: number; throwOnQuery: boolean };
  pool: Pool;
} {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const handle = { updateRowCount: 1, throwOnQuery: false };
  const pool = {
    query: async (text: string, values?: readonly unknown[]) => {
      if (handle.throwOnQuery) {
        throw new Error('db connection lost');
      }
      queries.push({ text, values: values ?? [] });
      return { rows: [], rowCount: handle.updateRowCount };
    },
  } as unknown as Pool;
  return { queries, handle, pool };
}

beforeEach(() => {
  resetInflightRefreshForTests();
  fetchCalls = [];
  verifyOutcome.result = VERIFIED_RESULT();
  nextResponse = { status: 200, payload: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(
        nextResponse.payload === null ? 'not-json' : JSON.stringify(nextResponse.payload),
        { status: nextResponse.status, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renewSessionTokens — fetch origin and request shape', () => {
  it('POSTs the refresh grant to the internal origin when configured', async () => {
    const db = createPoolMock();
    const result = await renewSessionTokens(
      db.pool,
      ID_HASH,
      { ...CONFIG, internalOrigin: INTERNAL_ORIGIN },
      OLD_REFRESH,
    );

    expect(result).toEqual({
      outcome: 'renewed',
      sub: verifyOutcome.result.sub,
      accessToken: NEW_ACCESS,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(`${INTERNAL_ORIGIN}/token`);
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    const body = String(fetchCalls[0]?.init?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain(`client_id=${CONFIG.clientId}`);
    expect(body).toContain(`refresh_token=${OLD_REFRESH}`);
  });

  it('POSTs to the issuer origin when no internal origin is configured', async () => {
    const db = createPoolMock();
    await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(fetchCalls[0]?.url).toBe(`${ISSUER}/token`);
  });
});

describe('renewSessionTokens — success persists both rotated tokens', () => {
  it('UPDATEs both token columns with the new values and returns the verified sub', async () => {
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toEqual({
      outcome: 'renewed',
      sub: verifyOutcome.result.sub,
      accessToken: NEW_ACCESS,
    });
    expect(db.queries).toHaveLength(1);
    const update = db.queries[0];
    expect(update?.text).toContain('SET access_token = $2, refresh_token = $3');
    expect(update?.text).toContain('revoked_at IS NULL');
    expect(update?.values).toEqual([ID_HASH, NEW_ACCESS, NEW_REFRESH]);
  });

  it('persists before verification and returns failed when the new access token is invalid', async () => {
    // Persist chạy trước verify (security review #258): token `invalid` vẫn
    // nằm trong DB nhưng outcome là `failed` (401) — request kế verify lại từ
    // token đã lưu, không replay grant cũ.
    verifyOutcome.result = { outcome: 'invalid' as const };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toEqual({ outcome: 'failed' });
    expect(db.queries).toHaveLength(1);
  });
});

describe('renewSessionTokens — outcome classification', () => {
  it('returns invalid_grant when auth reports reuse detection (RFC 6749 §5.2)', async () => {
    nextResponse = { status: 400, payload: { error: 'invalid_grant' } };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    // Caller của outcome này huỷ phiên server-side — không persist gì.
    expect(result).toEqual({ outcome: 'invalid_grant' });
    expect(db.queries).toHaveLength(0);
  });

  it('returns unavailable when the token endpoint is unreachable (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    // Caller của outcome này trả 503 — không âm thầm coi là phiên hợp lệ.
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(db.queries).toHaveLength(0);
  });

  it('returns unavailable for the synthetic 500 workerd emits on transport failure', async () => {
    // workerd KHÔNG ném khi transport hỏng (reset/refused/DNS) — nó tổng hợp
    // `Response(500, "TypeError: fetch failed", statusText rỗng)`. Đây là lỗi
    // hạ tầng ⇒ cùng nhánh 503 với exception, không được rơi vào `failed` (401).
    nextResponse = { status: 500, payload: { error: 'TypeError: fetch failed' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('TypeError: fetch failed', {
            status: 500,
            statusText: '',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
          }),
      ),
    );
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toEqual({ outcome: 'unavailable' });
    expect(db.queries).toHaveLength(0);
  });

  it('persists both rotated tokens and returns unavailable when JWKS cannot verify the new token', async () => {
    // Persist TRƯỚC verify (security review #258): auth đã rotate refresh token
    // cũ — JWKS degrade phải vẫn lưu cả hai token mới, không thì request kế
    // replay grant đã tiêu thụ ⇒ invalid_grant ⇒ forced logout.
    verifyOutcome.result = { outcome: 'unavailable' as const };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toEqual({ outcome: 'unavailable' });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.values).toEqual([ID_HASH, NEW_ACCESS, NEW_REFRESH]);
  });

  it('returns failed on a non-2xx response that is not invalid_grant', async () => {
    nextResponse = { status: 500, payload: { error: 'server_error' } };
    const db = createPoolMock();

    expect(await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH)).toEqual({
      outcome: 'failed',
    });
  });

  it('returns failed when the response body is not JSON', async () => {
    nextResponse = { status: 200, payload: null };
    const db = createPoolMock();

    expect(await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH)).toEqual({
      outcome: 'failed',
    });
  });

  it('returns failed when the rotated refresh token is missing from the response', async () => {
    // Rotation của auth: response thiếu refresh_token là contract hỏng —
    // không persist nửa vời (access mới + refresh cũ đã tiêu thụ).
    nextResponse = { status: 200, payload: { access_token: NEW_ACCESS } };
    const db = createPoolMock();

    expect(await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH)).toEqual({
      outcome: 'failed',
    });
    expect(db.queries).toHaveLength(0);
  });

  it('returns failed when the UPDATE matches zero rows (session revoked concurrently)', async () => {
    const db = createPoolMock();
    db.handle.updateRowCount = 0;

    expect(await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH)).toEqual({
      outcome: 'failed',
    });
    expect(db.queries).toHaveLength(1);
  });

  it('returns failed when the UPDATE throws (database unreachable)', async () => {
    const db = createPoolMock();
    db.handle.throwOnQuery = true;

    expect(await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH)).toEqual({
      outcome: 'failed',
    });
  });
});

describe('renewSessionTokensOnce — single-flight per session (#258)', () => {
  it('collapses concurrent calls for the same session into one token request', async () => {
    const db = createPoolMock();
    // Defer resolve của fetch để mọi lời gọi bắt trước khi promise đầu xong —
    // new Response là sync nên cần một gate thật: fetch mock chờ một tick.
    let releaseFetch: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            fetchCalls.push({ url: String(input), init });
            releaseFetch = () =>
              resolve(
                new Response(JSON.stringify(nextResponse.payload), {
                  status: nextResponse.status,
                  headers: { 'content-type': 'application/json' },
                }),
              );
          }),
      ),
    );

    const first = renewSessionTokensOnce(db.pool, ID_HASH, CONFIG, OLD_REFRESH);
    const second = renewSessionTokensOnce(db.pool, ID_HASH, CONFIG, OLD_REFRESH);
    const third = renewSessionTokensOnce(db.pool, ID_HASH, CONFIG, OLD_REFRESH);
    releaseFetch?.();
    const outcomes = await Promise.all([first, second, third]);

    expect(fetchCalls).toHaveLength(1);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        outcome: 'renewed',
        sub: verifyOutcome.result.sub,
        accessToken: NEW_ACCESS,
      });
    }
  });

  it('issues a fresh token request after the previous one settles', async () => {
    const db = createPoolMock();

    await renewSessionTokensOnce(db.pool, ID_HASH, CONFIG, OLD_REFRESH);
    await renewSessionTokensOnce(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    // In-flight map đã xoá sau promise đầu: hai lần gọi tuần tự là hai grant —
    // dedupe chỉ áp cho request ĐỒNG THỜI, không cache kết quả.
    expect(fetchCalls).toHaveLength(2);
  });

  it('does not share the in-flight promise between different sessions', async () => {
    const db = createPoolMock();

    await Promise.all([
      renewSessionTokensOnce(db.pool, 'b'.repeat(64), CONFIG, OLD_REFRESH),
      renewSessionTokensOnce(db.pool, 'c'.repeat(64), CONFIG, OLD_REFRESH),
    ]);

    expect(fetchCalls).toHaveLength(2);
  });
});
