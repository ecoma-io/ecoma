/**
 * Unit spec cho verifyPortalIdentity — bai 1 fail-closed cua portal auth,
 * khong cham DB that: claim nonce thay bang fake `db.unsafe` va TINH HMAC
 * THAT qua signRequest cua contract (cung primitive voi production).
 *
 * Ghim chuoi tu choi (src/portal-auth.ts):
 *   thieu secret -> 503; body vuot gioi han -> 413; envelope sai -> 401;
 *   envelope hop le nhung khong mang actor sub -> 401; loi DB o claim -> 503.
 * Mot envelope dung khong duoc qua hai lan (replay -> 401) ngay ca khi fake
 * claim bao "chua tung thay" lan dau va "da co tu truoc" lan sau.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_BODY_LIMIT_BYTES,
  signRequest,
  type InternalAuthHeaders,
} from '@ecoma-io/internal-auth-contracts';

import { loadRemoteCacheConfig } from './config';
import {
  readBodyBytes,
  verifyPortalIdentity,
  type PortalAuthFailure,
  type PortalIdentity,
} from './portal-auth';
import type { RemoteCacheClient } from '@ecoma-io/remote-cache-infrastructure';

const SECRET = 'unit-test-internal-secret';
const ACTOR_SUB = 'account-sub-for-unit';

/**
 * Thu hep ket qua verify ve that bai auth voi status mong doi — nem Error neu
 * do la identity hop le hay status khac. Tránh `expect` trong nhánh điều kiện
 * (vitest/no-conditional-expect) ma van giu narrow literal cho caller.
 */
function expectAuthFailure<TStatus extends PortalAuthFailure['status']>(
  result: PortalIdentity | PortalAuthFailure,
  status: TStatus,
): Extract<PortalAuthFailure, { status: TStatus }> {
  if ('actorSub' in result) {
    throw new Error(`expected auth failure ${status}, got an identity for ${result.actorSub}`);
  }
  if (result.status !== status) {
    throw new Error(`expected auth failure ${status}, got ${result.status}`);
  }
  // Hai guard tren da khoet status dung literal; conditional type generic
  // khong tu dong narrow, nen cast day du bang chung runtime o day.
  return result as Extract<PortalAuthFailure, { status: TStatus }>;
}

/** Fake client DB: dem so lan claim va cho dieu khien "nonce da co tu truoc". */
function fakeDb(
  options: { claimReturnsReplayed: boolean; throwOnClaim?: boolean } = {
    claimReturnsReplayed: false,
  },
): RemoteCacheClient & {
  readonly claimCalls: number;
  readonly claimParams: readonly unknown[];
} {
  const state: { claimCalls: number; claimParams: readonly unknown[] } = {
    claimCalls: 0,
    claimParams: [],
  };
  const client = {
    get claimCalls() {
      return state.claimCalls;
    },
    get claimParams() {
      return state.claimParams;
    },
    unsafe: async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('internal_nonces')) {
        state.claimCalls += 1;
        state.claimParams = params ?? [];
        if (options.throwOnClaim === true) {
          throw new Error('db down');
        }
        // claimNonce hop dong: RETURNING nonce — 0 hang = nonce da co tu truoc.
        return options.claimReturnsReplayed ? [] : [{ nonce: 'x' }];
      }
      return [];
    },
    begin: async () => {
      throw new Error('not used in unit');
    },
    end: async () => undefined,
  };
  // Cast: fake chi phai dap ung dung subset ma verifyPortalIdentity cham —
  // generic `unsafe<T>` cua interface khong the duoc mot ham non-generic
  // dap ung ma khong cast.
  return client as unknown as RemoteCacheClient & {
    readonly claimCalls: number;
    readonly claimParams: readonly unknown[];
  };
}

function configWithSecret(): ReturnType<typeof loadRemoteCacheConfig> {
  return loadRemoteCacheConfig({
    DB_REMOTE_CACHE: { connectionString: 'postgres://h/d' },
    INTERNAL_AUTH_SECRET: SECRET,
  });
}

async function signedHeaders(options: {
  method: string;
  path: string;
  body: Uint8Array | null;
  actorSub?: string;
  timestamp: string;
}): Promise<InternalAuthHeaders> {
  return signRequest({
    method: options.method,
    path: options.path,
    body: options.body,
    actorSub: options.actorSub,
    secret: SECRET,
    timestamp: options.timestamp,
  });
}

function requestFrom(headers: Record<string, string>, method = 'POST'): Request {
  return new Request('http://localhost/tenants/ecoma/projects', { method, headers });
}

describe('verifyPortalIdentity (unit)', () => {
  it('fails closed with 503 when the portal secret has not been provisioned', async () => {
    const unconfigured = loadRemoteCacheConfig({
      DB_REMOTE_CACHE: { connectionString: 'postgres://h/d' },
    });
    const db = fakeDb();
    const result = await verifyPortalIdentity({
      request: requestFrom({}),
      body: new Uint8Array(),
      config: unconfigured,
      db,
      now: '1000000000',
    });
    const failure = expectAuthFailure(result, 503);
    expect(failure.status).toBe(503);
    expect(db.claimCalls).toBe(0);
  });

  it('rejects a request without any envelope headers with 401 and the HMAC challenge', async () => {
    const db = fakeDb();
    const result = await verifyPortalIdentity({
      request: requestFrom({}),
      body: new Uint8Array(),
      config: configWithSecret(),
      db,
      now: '1000000000',
    });
    const challenge = expectAuthFailure(result, 401);
    expect(challenge.headers['WWW-Authenticate']).toBe('HMAC realm="ecoma-internal"');
    // Chu ky chua chung minh: khong duoc ghi gi vao kho nonce.
    expect(db.claimCalls).toBe(0);
  });

  it('rejects a wrong-signature envelope with 401 before touching the nonce store', async () => {
    const db = fakeDb();
    const now = '1000000000';
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body: null,
      actorSub: ACTOR_SUB,
      timestamp: now,
    });
    // Nguoi goi khong giu dung secret: doi body sau khi ky.
    const tamperedBody = new TextEncoder().encode('{"name":"evil"}');
    const result = await verifyPortalIdentity({
      request: requestFrom({ ...headers, 'content-type': 'application/json' }),
      body: tamperedBody,
      config: configWithSecret(),
      db,
      now,
    });
    expect(!('actorSub' in result) && result.status).toBe(401);
    expect(db.claimCalls).toBe(0);
  });

  it('rejects a valid envelope that carries no actor sub with 401', async () => {
    const db = fakeDb();
    const now = '1000000000';
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body: null,
      timestamp: now,
    });
    const result = await verifyPortalIdentity({
      request: requestFrom(headers),
      body: new Uint8Array(),
      config: configWithSecret(),
      db,
      now,
    });
    expect(!('actorSub' in result) && result.status).toBe(401);
    // Chu ky hop le nen nonce DA duoc chiem truoc khi mat actor bi tu choi.
    expect(db.claimCalls).toBe(1);
  });

  it('accepts a correctly signed envelope carrying a verified actor sub', async () => {
    const db = fakeDb();
    const now = '1000000000';
    const body = new TextEncoder().encode('{"name":"new-project"}');
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body,
      actorSub: ACTOR_SUB,
      timestamp: now,
    });
    const result = await verifyPortalIdentity({
      request: requestFrom(headers),
      body,
      config: configWithSecret(),
      db,
      now,
    });
    expect('actorSub' in result && result.actorSub).toBe(ACTOR_SUB);
    expect(db.claimCalls).toBe(1);
  });

  it('prunes the nonce store on the caller clock, not on wall time', async () => {
    // Cat prune phai cung dong ho voi buoc verify da chan `|now - timestamp| <=
    // skew` tren `input.now`. Lay `Date.now()` o day thi mot dong ho tiem vao
    // (test, hoac mot buoc doi sau nay) lech voi prune, va prune co the xoa mat
    // nonce ma replay guard con can.
    const db = fakeDb();
    const now = '1000000000';
    const body = new TextEncoder().encode('{"name":"new-project"}');
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body,
      actorSub: ACTOR_SUB,
      timestamp: now,
    });
    const result = await verifyPortalIdentity({
      request: requestFrom(headers),
      body,
      config: configWithSecret(),
      db,
      now,
    });
    expect('actorSub' in result).toBe(true);
    // Tham so thu 3 cua cau claim la moc prune.
    expect(db.claimParams[2]).toBe(Number(now));
  });

  it('rejects the replayed envelope with 401 once the nonce store reports it as claimed', async () => {
    const now = '1000000000';
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body: null,
      actorSub: ACTOR_SUB,
      timestamp: now,
    });
    const first = await verifyPortalIdentity({
      request: requestFrom(headers),
      body: new Uint8Array(),
      config: configWithSecret(),
      db: fakeDb({ claimReturnsReplayed: false }),
      now,
    });
    expect('actorSub' in first).toBe(true);
    const second = await verifyPortalIdentity({
      request: requestFrom(headers),
      body: new Uint8Array(),
      config: configWithSecret(),
      db: fakeDb({ claimReturnsReplayed: true }),
      now,
    });
    expect(!('actorSub' in second) && second.status).toBe(401);
  });

  it('maps a database failure during the nonce claim to 503, not 401', async () => {
    const now = '1000000000';
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body: null,
      actorSub: ACTOR_SUB,
      timestamp: now,
    });
    const result = await verifyPortalIdentity({
      request: requestFrom(headers),
      body: new Uint8Array(),
      config: configWithSecret(),
      db: fakeDb({ claimReturnsReplayed: false, throwOnClaim: true }),
      now,
    });
    expect(!('actorSub' in result) && result.status).toBe(503);
  });

  it('propagates a failure outside the nonce claim instead of masquerading as 503', async () => {
    // Loi NOI BO verifyRequest (vi du bug lap trinh, loi moi truong crypto)
    // phai THOAT RA cho app.onError — 503 chi danh cho su co storage o claim
    // nonce; giau bug sau 503 dua van hanh di kiem tra DB nham cho.
    const now = '1000000000';
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body: null,
      actorSub: ACTOR_SUB,
      timestamp: now,
    });
    const db = fakeDb();
    const signSpy = vi
      .spyOn(crypto.subtle, 'sign')
      .mockRejectedValueOnce(new TypeError('bug outside the nonce claim'));
    try {
      await expect(
        verifyPortalIdentity({
          request: requestFrom(headers),
          body: new Uint8Array(),
          config: configWithSecret(),
          db,
          now,
        }),
      ).rejects.toThrow(TypeError);
    } finally {
      signSpy.mockRestore();
    }
    // Loi xay ra TRUOC khi chu ky duoc chung minh: store nonce khong bi dong.
    expect(db.claimCalls).toBe(0);
  });

  it('rejects an envelope whose timestamp is outside the skew window with 401', async () => {
    const db = fakeDb();
    const headers = await signedHeaders({
      method: 'POST',
      path: '/tenants/ecoma/projects',
      body: null,
      actorSub: ACTOR_SUB,
      timestamp: '1000000000',
    });
    const result = await verifyPortalIdentity({
      request: requestFrom(headers),
      body: new Uint8Array(),
      config: configWithSecret(),
      db,
      now: '1000009999',
    });
    expect(!('actorSub' in result) && result.status).toBe(401);
    expect(db.claimCalls).toBe(0);
  });
});

describe('readBodyBytes (unit)', () => {
  it('returns the exact bytes of a request body', async () => {
    const payload = new TextEncoder().encode('{"name":"p"}');
    const request = new Request('http://localhost/x', { method: 'POST', body: payload });
    const bytes = await readBodyBytes(request);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('{"name":"p"}');
  });

  it('returns empty bytes for a bodyless request', async () => {
    const bytes = await readBodyBytes(new Request('http://localhost/x'));
    expect(bytes).not.toBeNull();
    expect((bytes ?? new Uint8Array()).byteLength).toBe(0);
  });

  it('returns null — the 413 trigger — when the body exceeds the protocol limit', async () => {
    const oversized = new Uint8Array(INTERNAL_BODY_LIMIT_BYTES + 1);
    const request = new Request('http://localhost/x', { method: 'POST', body: oversized });
    expect(await readBodyBytes(request)).toBeNull();
  });
});
