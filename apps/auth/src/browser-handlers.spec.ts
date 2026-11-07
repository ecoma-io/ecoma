import { describe, expect, it } from 'vitest';

import { loadAuthConfig, type AuthConfig } from './config';
import { handleAuthorize, handleAuthorizeConfirm, type AuthorizeQuery } from './browser-handlers';
import { hashHandle } from '@ecoma-io/auth-domain';
import type {
  AuthorizationTransactionRecord,
  AuthStore,
  RegisteredClient,
} from '@ecoma-io/auth-application';

/**
 * Unit cho glue `/authorize` — phần chọn `resource` theo client_id (registry
 * `AUTH_RESOURCES`). Các đường persistence thật (PostgreSQL, provider) thuộc
 * suite integration; ở đây chỉ khóa hình dạng mapping trong glue.
 */

/** Store stub: chỉ `findClient` được gọi trên đường begin — trả client public. */
function stubStore(clientId: string, matchAny = false): AuthStore {
  const client: RegisteredClient = {
    client_id: clientId,
    client_type: 'public',
    redirect_uris: ['https://rp.example.com/cb'],
    allowed_scopes: ['openid', 'offline_access'],
    isActive: true,
  };
  return {
    findTransactionByHandleX: async () => undefined,
    createTransaction: async () => undefined,
    transition: async () => true,
    insertAuthorizationCode: async () => undefined,
    findGrant: async () => undefined,
    findClient: async (id: string) => (matchAny || id === clientId ? client : undefined),
    checkRevocation: async () => 'not_revoked',
  };
}

async function makeConfig(): Promise<AuthConfig> {
  // PEM không được chạm: đường `handleAuthorize` chỉ dùng handle key + resources.
  // Khoá signing chỉ cần pass qua `loadAuthConfig` — một PEM PKCS#8 hợp lệ.
  const { exportPKCS8, generateKeyPair } = await import('jose');
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  return await loadAuthConfig({
    HYPERDRIVE: { connectionString: 'hyperdrive-internal-placeholder' },
    ACCOUNT_SERVICE: { fetch: async () => new Response('{}') },
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-browser-handlers',
    AUTH_HANDLE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: 'internal-secret-test',
    AUTH_ISSUER: 'https://auth.ecoma.io',
    AUTH_AUDIENCE: 'https://api.ecoma.io',
    AUTH_RESOURCES: JSON.stringify([
      { audience: 'https://api.ecoma.io', clientIds: [] },
      { audience: 'https://backoffice.ecoma.io', clientIds: ['backoffice'] },
    ]),
    AUTH_COOKIE_KEYS: 'test-cookie-key-1',
    AUTH_ACCOUNT_BASE_URL: 'https://account.ecoma.io',
  });
}

function baseQuery(clientId: string | string[]): AuthorizeQuery {
  const challenge = 'a'.repeat(43);
  return {
    response_type: 'code',
    // Ghi đè kiểu của AuthorizeQuery: đây chính là ca "query lặp tham số"
    // mà glue phải chuẩn hoá.
    client_id: clientId as string,
    redirect_uri: 'https://rp.example.com/cb',
    scope: 'openid offline_access',
    state: 'st-1',
    nonce: 'n-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
}

describe('handleAuthorize — resource selection by client_id', () => {
  it('maps a plain-string client_id to its registered audience', async () => {
    const config = await makeConfig();
    const response = await handleAuthorize({
      config,
      store: stubStore('backoffice'),
      query: baseQuery('backoffice'),
      cookieHeader: undefined,
      now: new Date(),
    });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location') as string);
    expect(target.searchParams.get('resource')).toBe('https://backoffice.ecoma.io');
  });

  it('falls back to the primary audience for an unmapped client', async () => {
    const config = await makeConfig();
    const response = await handleAuthorize({
      config,
      store: stubStore('other-client'),
      query: baseQuery('other-client'),
      cookieHeader: undefined,
      now: new Date(),
    });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location') as string);
    expect(target.searchParams.get('resource')).toBe('https://api.ecoma.io');
  });

  it('normalizes a repeated client_id (array) and maps via any candidate', async () => {
    // Hono `c.req.query()` trả `Record<string, string>` nhưng nguồn thật là
    // URLSearchParams — glue phải tự phòng ca mảng. Array-form candidate là
    // một chính sách phòng thủ, KHÔNG phải hợp đồng của hono.
    const config = await makeConfig();
    // beginAuthorization nhận raw `client_id` (chưa chuẩn hoá) rồi đẩy thẳng
    // vào `findClient`; stub so sánh chuỗi sẽ không khớp mảng. Test này nhắm
    // vào mapping resource, không phải resolution client ⇒ `matchAny` để đường
    // chạy đi tới được phần glue cần khóa.
    const response = await handleAuthorize({
      config,
      store: stubStore('backoffice', true),
      query: baseQuery(['unknown-client', 'backoffice'] as unknown as string),
      cookieHeader: undefined,
      now: new Date(),
    });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location') as string);
    expect(target.searchParams.get('resource')).toBe('https://backoffice.ecoma.io');
  });
});

/** Transaction thật hình dạng, băm binding tính từ cookie test. */
async function confirmedTransaction(): Promise<AuthorizationTransactionRecord> {
  return {
    transaction_id: 'b'.repeat(43),
    handle_hash_x: await hashHandle('handle-x-confirm-test'),
    state: 'browser_confirmed',
    client_id: 'client-1',
    redirect_uri: 'https://rp.example.com/cb',
    requested_scopes: ['openid'],
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    browser_binding_hash: await hashHandle('binding-cookie-confirm-test'),
    key_version: 1,
    expires_at: new Date(Date.now() + 60_000),
    sub: null,
    acr: null,
    authn_at: null,
    account_session_ref: null,
    client_state: null,
    nonce: null,
    event_id: null,
    event_payload_hash: null,
  };
}

function confirmStore(transaction: AuthorizationTransactionRecord) {
  const calls: string[] = [];
  const store: AuthStore & { calls: string[] } = {
    calls,
    findTransactionByHandleX: async () => transaction,
    createTransaction: async () => {
      calls.push('createTransaction');
    },
    transition: async () => {
      calls.push('transition');
      return true;
    },
    insertAuthorizationCode: async () => undefined,
    findGrant: async () => undefined,
    findClient: async () => undefined,
    checkRevocation: async () => 'not_revoked',
  };
  return store;
}

describe('handleAuthorizeConfirm — first confirm and same-browser replay', () => {
  const confirmQuery: AuthorizeQuery = { handle: 'handle-x-confirm-test' };

  it('first confirm — 302 to /login/continue with the handle', async () => {
    const transaction = await confirmedTransaction();
    // pending_browser: lần confirm đầu — CAS chạy.
    const store = confirmStore({ ...transaction, state: 'pending_browser' });
    const response = await handleAuthorizeConfirm({
      store,
      query: confirmQuery,
      cookieHeader: '__Host-auth-browser=binding-cookie-confirm-test',
      accountBaseUrl: 'https://account.ecoma.io',
      now: new Date(),
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://account.ecoma.io/login/continue');
    expect(location.searchParams.get('handle')).toBe('handle-x-confirm-test');
    expect(store.calls).toContain('transition');
  });

  it('same-browser replay (already browser_confirmed) — SAME 302, no state change', async () => {
    // Hop confirm nằm trên đường browser (§5.1.2 hàng 2): điều hướng trùng của
    // chính browser đã confirm phải nhận cùng đích, không phải `invalid_request`.
    const transaction = await confirmedTransaction();
    const store = confirmStore(transaction);
    const response = await handleAuthorizeConfirm({
      store,
      query: confirmQuery,
      cookieHeader: '__Host-auth-browser=binding-cookie-confirm-test',
      accountBaseUrl: 'https://account.ecoma.io',
      now: new Date(),
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://account.ecoma.io/login/continue');
    expect(location.searchParams.get('handle')).toBe('handle-x-confirm-test');
    // Idempotency: không CAS lại, không event mới.
    expect(store.calls).not.toContain('transition');
  });

  it('replay from a DIFFERENT browser (binding mismatch) — JSON invalid_request, no redirect', async () => {
    const transaction = await confirmedTransaction();
    const store = confirmStore(transaction);
    const response = await handleAuthorizeConfirm({
      store,
      query: confirmQuery,
      cookieHeader: '__Host-auth-browser=cookie-of-the-thief',
      accountBaseUrl: 'https://account.ecoma.io',
      now: new Date(),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('expired browser_confirmed replay — JSON invalid_request', async () => {
    // Cửa sổ idempotent đòi còn TTL; hết hạn là đường CAS/thất bại như mọi
    // state khác (hàng 12 của state machine).
    const transaction = await confirmedTransaction();
    transaction.expires_at = new Date(Date.now() - 1);
    const store = confirmStore(transaction);
    const response = await handleAuthorizeConfirm({
      store,
      query: confirmQuery,
      cookieHeader: '__Host-auth-browser=binding-cookie-confirm-test',
      accountBaseUrl: 'https://account.ecoma.io',
      now: new Date(),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });
});
