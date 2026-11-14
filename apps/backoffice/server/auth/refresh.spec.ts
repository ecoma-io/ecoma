/**
 * Unit test của `renewSessionTokens` (`server/auth/refresh.ts`) — hợp đồng
 * gia hạn access token từ refresh token (#244).
 *
 * Mock dừng ở ba biên (06 §9: spec colocated không boot database thật, không
 * fetch thật, không JWKS server thật): `globalThis.fetch`, pool `pg` và
 * `verifyAccessToken` (đường verify thật đã được lib `verify.spec.ts` phủ).
 * Assertions ghim:
 *
 * 1. URL của POST `/token` dựng từ `internalOrigin` khi có, từ `issuer` khi
 *    không (#243 — cùng luật fetch-origin với callback/logout);
 * 2. Body mang `grant_type=refresh_token` + `client_id` (RFC 6749 §6, public
 *    client);
 * 3. Thành công ⇒ UPDATE **cả hai** cột token (rotation của auth — persist
 *    thiếu refresh token mới là phá phiên sau lần gia hạn đầu);
 * 4. Mọi nhánh thất bại (network, non-2xx, thiếu token, verify hỏng, DB lỗi,
 *    UPDATE khớp 0 hàng) ⇒ `null` và **không** báo thành công — fail-closed
 *    về 401, không loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { renewSessionTokens } from './refresh';

const verifyOutcome = vi.hoisted(() => ({
  // Kiểu nở đủ hai outcome của union `TokenVerifyResult` — test mutate giữa
  // các nhánh; các trường `sub`/`exp` không có nghĩa ở nhánh `invalid`.
  result: {
    outcome: 'verified' as 'verified' | 'invalid' | 'unavailable',
    sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    exp: 0,
  },
}));

vi.mock('@ecoma-io/backoffice-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/backoffice-infrastructure')>();
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
  audience: 'https://api.test.ecoma.io:32768/backoffice',
  clientId: 'ecoma-backoffice-local',
  internalOrigin: null as string | null,
};

const VERIFIED_RESULT = () => ({
  outcome: 'verified' as const,
  sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  exp: 0,
});

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly status: number;
  readonly payload: Record<string, unknown> | null;
}

/** Response kế tiếp fetch mock trả — xếp hàng trước mỗi lần gọi renew. */
let nextResponse: { status: number; payload: Record<string, unknown> | null };
let fetchCalls: FetchCall[];

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
  // Trả `handle` (object gốc, không spread) — mutate `db.handle.updateRowCount`
  // phải nhìn thấy được trong closure của `pool.query`.
  return { queries, handle, pool };
}

beforeEach(() => {
  fetchCalls = [];
  verifyOutcome.result = VERIFIED_RESULT();
  nextResponse = { status: 200, payload: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init, ...nextResponse });
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

    expect(result).not.toBeNull();
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call?.url).toBe(`${INTERNAL_ORIGIN}/token`);
    expect(call?.init?.method).toBe('POST');
    const body = String(call?.init?.body);
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

    expect(result).toEqual({ sub: verifyOutcome.result.sub });
    expect(db.queries).toHaveLength(1);
    const update = db.queries[0];
    expect(update?.text).toContain('SET access_token = $2, refresh_token = $3');
    expect(update?.text).toContain('revoked_at IS NULL');
    expect(update?.values).toEqual([ID_HASH, NEW_ACCESS, NEW_REFRESH]);
  });

  it('does not persist when the new access token fails verification', async () => {
    verifyOutcome.result = { outcome: 'invalid' as const };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(0);
  });
});

describe('renewSessionTokens — failure returns null without writing', () => {
  it('returns null when the token endpoint is unreachable (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(0);
  });

  it('returns null on a non-2xx response (revoked refresh token)', async () => {
    nextResponse = { status: 400, payload: { error: 'invalid_grant' } };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(0);
  });

  it('returns null when the response body is not JSON', async () => {
    nextResponse = { status: 200, payload: null };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(0);
  });

  it('returns null when the rotated refresh token is missing from the response', async () => {
    // Rotation của auth: response thiếu refresh_token là contract hỏng —
    // không persist nửa vời (access mới + refresh cũ đã tiêu thụ).
    nextResponse = { status: 200, payload: { access_token: NEW_ACCESS } };
    const db = createPoolMock();

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(0);
  });

  it('returns null when the UPDATE matches zero rows (session revoked concurrently)', async () => {
    const db = createPoolMock();
    db.handle.updateRowCount = 0;

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
    expect(db.queries).toHaveLength(1);
  });

  it('returns null when the UPDATE throws (database unreachable)', async () => {
    const db = createPoolMock();
    db.handle.throwOnQuery = true;

    const result = await renewSessionTokens(db.pool, ID_HASH, CONFIG, OLD_REFRESH);

    expect(result).toBeNull();
  });
});
