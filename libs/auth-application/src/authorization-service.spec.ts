import { exportPKCS8, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import type { AccountStatusResponseValue } from '@ecoma-io/account-contracts';
import { type SigningKeyProvider, hashHandle } from '@ecoma-io/auth-domain';

import { signingKeyProviderFromPemForSpec } from './signing-key-test-support';
import {
  type AccountClient,
  type AuthStore,
  type AuthorizationTransactionRecord,
  type RegisteredClient,
  beginAuthorization,
  completeAuthorization,
  confirmBrowser,
  exchangeAuthorizationCode,
} from './authorization-service';

/**
 * Các bất biến của tầng điều phối.
 *
 * ⚠️ Những test này kiểm THỨ TỰ và SỰ FAIL-CLOSED, không kiểm SQL. Chúng dùng
 * một store giả để cô lập tầng này — còn tính nguyên tử thật của database được
 * kiểm bằng PostgreSQL thật ở `auth-infrastructure`.
 */

/** Store giả, ghi lại mọi lời gọi để kiểm thứ tự. */
function makeStore(overrides: Partial<AuthStore> = {}): AuthStore & { calls: string[] } {
  const calls: string[] = [];
  const store: AuthStore & { calls: string[] } = {
    calls,
    async findClient(): Promise<RegisteredClient | undefined> {
      calls.push('findClient');
      return {
        client_id: 'client-1',
        client_type: 'public',
        redirect_uris: ['https://app.example.com/cb'],
        allowed_scopes: ['openid', 'profile'],
        isActive: true,
      };
    },
    async createTransaction() {
      calls.push('createTransaction');
    },
    async transition() {
      calls.push('transition');
      return true;
    },
    async insertAuthorizationCode() {
      calls.push('insertAuthorizationCode');
    },
    async findGrant() {
      return undefined;
    },
    async checkRevocation() {
      calls.push('checkRevocation');
      return 'not_revoked';
    },
    async findTransactionByHandleX() {
      return undefined;
    },
    ...overrides,
  };
  return store;
}

/** Account giả. `checkStatus` ném khi `fail` — mô phỏng Account không gọi được. */
function makeAccount(fail = false, status: 'active' | 'suspended' = 'active'): AccountClient {
  return {
    async verifySession() {
      return { outcome: 'verified', accountId: 'account-1' };
    },
    async checkStatus() {
      if (fail) {
        throw new Error('account khong goi duoc');
      }
      return status;
    },
  };
}

/** Sinh khoa that de test chay tren cung duong code voi production. */
async function makeSigningKey(): Promise<SigningKeyProvider> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  return signingKeyProviderFromPemForSpec({ pem, kid: 'kid-test' });
}

/**
 * `K_auth` gia lap: 32 byte base64url, dung dang Worker Secret that.
 * KHONG phai browser binding — hai thu nay la hai dieu khien khac nhau.
 */
const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const VALID_RAW = {
  response_type: 'code',
  client_id: 'client-1',
  redirect_uri: 'https://app.example.com/cb',
  scope: 'openid',
  state: 'xyz',
  nonce: undefined,
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
};

const TRANSACTION: AuthorizationTransactionRecord = {
  transaction_id: 'a'.repeat(43),
  handle_hash_x: 'hash-1',
  state: 'browser_confirmed',
  client_id: 'client-1',
  redirect_uri: 'https://app.example.com/cb',
  requested_scopes: ['openid'],
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  browser_binding_hash: 'binding-hash-1',
  key_version: 1,
  expires_at: new Date(Date.now() + 60_000),
  sub: 'account-1',
  acr: 'urn:ecoma:acr:email-otp',
  authn_at: new Date(),
  account_session_ref: 'asr-1',
  client_state: 'xyz',
  nonce: null,
};

describe('beginAuthorization — the open-redirect boundary', () => {
  it('an unregistered redirect_uri — the error is NOT redirectable', async () => {
    // ⚠️ Đây là bất biến quan trọng nhất của /authorize. Nếu lỗi này mang
    // `redirectable: true`, handler sẽ redirect về một URI do kẻ tấn công
    // chọn — đúng định nghĩa open redirect.
    const store = makeStore();
    await expect(
      beginAuthorization({
        store,
        raw: { ...VALID_RAW, redirect_uri: 'https://evil.example.com/cb' },
        browserBinding: 'binding-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', redirectable: false });

    // Va khong duoc tao transaction nao.
    expect(store.calls).not.toContain('createTransaction');
  });

  it('a non-existent client — invalid_client, NOT redirectable', async () => {
    const store = makeStore({ findClient: async () => undefined });
    await expect(
      beginAuthorization({
        store,
        raw: VALID_RAW,
        handleKey: HANDLE_KEY,
        handleKeyVersion: 1,
        browserBinding: 'binding-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_client', redirectable: false });
  });

  it('a disabled client — NOT redirectable', async () => {
    const store = makeStore({
      findClient: async () => ({
        client_id: 'client-1',
        client_type: 'public',
        redirect_uris: ['https://app.example.com/cb'],
        allowed_scopes: ['openid'],
        isActive: false,
      }),
    });
    await expect(
      beginAuthorization({
        store,
        raw: VALID_RAW,
        handleKey: HANDLE_KEY,
        handleKeyVersion: 1,
        browserBinding: 'binding-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ redirectable: false });
  });

  it('a scope outside the allowed list — IS redirectable (the boundary has been crossed)', async () => {
    // Sau khi `redirect_uri` da duoc xac minh, loi MOI duoc phep redirect ve no.
    // Day la ve khac cua cung mot ranh gioi.
    const store = makeStore();
    await expect(
      beginAuthorization({
        store,
        raw: { ...VALID_RAW, scope: 'openid admin' },
        handleKey: HANDLE_KEY,
        handleKeyVersion: 1,
        browserBinding: 'binding-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_scope', redirectable: true });
  });

  it('the returned handle is the CLEARTEXT, not a hash', async () => {
    const store = makeStore();
    const result = await beginAuthorization({
      store,
      raw: VALID_RAW,
      handleKey: HANDLE_KEY,
      handleKeyVersion: 1,
      browserBinding: 'binding-1',
      now: new Date(),
      newId: () => 'a'.repeat(43),
    });

    expect(result.transactionId).toBe('a'.repeat(43));
    // Handle phai la chuoi base64url dai (HMAC-SHA-256 = 32 byte -> 43 ky tu).
    expect(result.handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('the default id must be long enough — `crypto.randomUUID()` would make every request collide', async () => {
    // ⚠️ Regression test cho mot bug co that: id mac dinh ban dau la
    // `crypto.randomUUID()`, ma UUID chi co 36 ky tu trong khi
    // `MIN_TRANSACTION_ID_LENGTH` la 43. Ket qua la MOI request uy quyen nem
    // `AuthConfigurationError('transaction_id qua ngan')` — khong phai mot
    // request hiem, ma la toan bo duong dang nhap.
    //
    // Test nay goi KHONG truyen `newId`, nen no chay dung duong production.
    const store = makeStore();
    const result = await beginAuthorization({
      store,
      raw: VALID_RAW,
      handleKey: HANDLE_KEY,
      handleKeyVersion: 1,
      browserBinding: 'binding-1',
      now: new Date(),
    });

    expect(result.transactionId.length).toBeGreaterThanOrEqual(43);
    expect(result.transactionId).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('the client state is preserved so it can be echoed back in the redirect', async () => {
    let captured: { client_state: string | null } | undefined;
    const store = makeStore({
      createTransaction: async (record) => {
        captured = { client_state: record.client_state };
      },
    });
    await beginAuthorization({
      store,
      raw: { ...VALID_RAW, state: 'client-state-abc' },
      handleKey: HANDLE_KEY,
      handleKeyVersion: 1,
      browserBinding: 'binding-1',
      now: new Date(),
      newId: () => 'b'.repeat(43),
    });
    expect(captured?.client_state).toBe('client-state-abc');
  });

  it('missing state — still creates the transaction with client_state NULL (RFC 6749 state is optional)', async () => {
    // ⚠️ Đây là hợp đồng của C1: một `/authorize` hợp lệ không gửi `state`
    // không được thất bại vì DB áp NOT NULL sai với protocol. `undefined` ở
    // tầng TS phải được adapter chuyển thành NULL — hàm này chốt nửa TS.
    let captured: { client_state: string | null; nonce: string | null } | undefined;
    const store = makeStore({
      createTransaction: async (record) => {
        captured = { client_state: record.client_state, nonce: record.nonce };
      },
    });
    const result = await beginAuthorization({
      store,
      raw: { ...VALID_RAW, state: undefined, nonce: undefined },
      handleKey: HANDLE_KEY,
      handleKeyVersion: 1,
      browserBinding: 'binding-1',
      now: new Date(),
      newId: () => 'c'.repeat(43),
    });
    expect(result.transactionId).toBe('c'.repeat(43));
    expect(captured?.client_state).toBeNull();
    expect(captured?.nonce).toBeNull();
  });

  it('nonce present — is preserved through createTransaction', async () => {
    // SR-007: nonce chép xuống transaction rồi sang authorization code, để
    // id_token nhúng đúng giá trị client gửi. Parse-rồi-bỏ (finding #15 của
    // #181) là mất ràng buộc chống replay không tầng nào khôi phục.
    let captured: { nonce: string | null } | undefined;
    const store = makeStore({
      createTransaction: async (record) => {
        captured = { nonce: record.nonce };
      },
    });
    await beginAuthorization({
      store,
      raw: { ...VALID_RAW, nonce: 'n-0psAq5fKCg' },
      handleKey: HANDLE_KEY,
      handleKeyVersion: 1,
      browserBinding: 'binding-1',
      now: new Date(),
      newId: () => 'd'.repeat(43),
    });
    expect(captured?.nonce).toBe('n-0psAq5fKCg');
  });

  it('requested_scopes is an ARRAY, not silently flattened into a string', async () => {
    // `scope: string` cũ là kiểu của một bản thiết kế cũ; schema là `text[]`.
    // Nối chuỗi ở application (`join(' ')`) sẽ biến mảng thành string ngầm và
    // adapter phải tách lại — hai lần serialize là hai chỗ lệch nhau.
    let captured: { requested_scopes: readonly string[] } | undefined;
    const store = makeStore({
      createTransaction: async (record) => {
        captured = { requested_scopes: record.requested_scopes };
      },
    });
    await beginAuthorization({
      store,
      raw: { ...VALID_RAW, scope: 'openid profile' },
      handleKey: HANDLE_KEY,
      handleKeyVersion: 1,
      browserBinding: 'binding-1',
      now: new Date(),
      newId: () => 'e'.repeat(43),
    });
    expect([...(captured?.requested_scopes ?? [])]).toEqual(['openid', 'profile']);
  });

  it('key_version flows from the parameter into createTransaction (recorded at mint time)', async () => {
    // §5.6: "Ghi key_version lúc mint; retry dùng đúng version đó". Không
    // hard-code: một hằng ẩn dưới này biến rotation thành vô dụng.
    let captured: { key_version: number } | undefined;
    const store = makeStore({
      createTransaction: async (record) => {
        captured = { key_version: record.key_version };
      },
    });
    await beginAuthorization({
      store,
      raw: VALID_RAW,
      handleKey: HANDLE_KEY,
      handleKeyVersion: 7,
      browserBinding: 'binding-1',
      now: new Date(),
      newId: () => 'f'.repeat(43),
    });
    expect(captured?.key_version).toBe(7);
  });
});

describe('confirmBrowser — the handle-theft guard', () => {
  it('the binding does NOT match — REJECTED, and not redirectable', async () => {
    // ⚠️ Day la dieu kien 2 cua §5.1.0. Mot browser khac trinh mot handle da
    // danh cap se khong co cookie __Host-auth-browser khop. Neu check nay bi bo
    // qua thi handle theft du thua: ke tan cong day duoc ket qua xac thuc bang
    // session cua chinh han.
    const store = makeStore();
    await expect(
      confirmBrowser({
        store,
        transaction: { ...TRANSACTION, state: 'pending_browser' },
        presentedBinding: 'cookie-cua-ke-tan-cong',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ redirectable: false });

    expect(store.calls).not.toContain('transition');
  });

  it('the binding MATCHES — moves to browser_confirmed', async () => {
    const store = makeStore();
    // Bam cua 'binding-cookie-hop-le' phai khop `browser_binding_hash` trong
    // fixture. Tinh bang chinh ham cua domain de khong lap lai logic.
    const bindingHash = await hashHandle('binding-cookie-hop-le');

    await confirmBrowser({
      store,
      transaction: { ...TRANSACTION, state: 'pending_browser', browser_binding_hash: bindingHash },
      presentedBinding: 'binding-cookie-hop-le',
      now: new Date(),
    });

    expect(store.calls).toContain('transition');
  });

  it('the transaction was already confirmed by another request — REJECTED', async () => {
    const store = makeStore({ transition: async () => false });
    const bindingHash = await hashHandle('binding-cookie-hop-le');

    await expect(
      confirmBrowser({
        store,
        transaction: {
          ...TRANSACTION,
          state: 'pending_browser',
          browser_binding_hash: bindingHash,
        },
        presentedBinding: 'binding-cookie-hop-le',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ redirectable: false });
  });

  it('the SAME browser replays confirm on browser_confirmed — already-confirmed, NO second CAS', async () => {
    // §5.1.2 hàng 2, cột "khi retry": hop confirm nằm trên ĐƯỜNG browser, nên
    // một điều hướng trùng (reload, back, request lặp) của chính browser đã
    // confirm không được là lỗi — đích tiếp theo giống hệt lần đầu. Cửa sổ
    // idempotent đòi CẢ hai điều kiện: binding khớp VÀ state còn
    // `browser_confirmed` VÀ chưa hết TTL.
    const store = makeStore();
    const bindingHash = await hashHandle('binding-cookie-hop-le');
    const now = new Date();

    const result = await confirmBrowser({
      store,
      transaction: {
        ...TRANSACTION,
        state: 'browser_confirmed',
        browser_binding_hash: bindingHash,
        expires_at: new Date(now.getTime() + 60_000),
      },
      presentedBinding: 'binding-cookie-hop-le',
      now,
    });

    expect(result.status).toBe('already-confirmed');
    // Không CAS lại, không event mới: trạng thái đã đúng là toàn bộ ý nghĩa
    // của idempotency.
    expect(store.calls).not.toContain('transition');
  });

  it('a replay on browser_confirmed but EXPIRED — falls through to the CAS path and is rejected', async () => {
    // Cửa sổ idempotent NGẶT hết hạn: CAS đã gộp expiry vào WHERE, nhưng nhánh
    // idempotent KHÔNG chạy CAS — nó đọc hàng rồi quyết định, nên expiry phải
    // được so tường minh ở đây. Bỏ kiểm này là một transaction hết hạn được
    // redirect tiếp như còn sống.
    const store = makeStore({ transition: async () => false });
    const bindingHash = await hashHandle('binding-cookie-hop-le');
    const now = new Date();

    await expect(
      confirmBrowser({
        store,
        transaction: {
          ...TRANSACTION,
          state: 'browser_confirmed',
          browser_binding_hash: bindingHash,
          expires_at: new Date(now.getTime() - 1),
        },
        presentedBinding: 'binding-cookie-hop-le',
        now,
      }),
    ).rejects.toMatchObject({ redirectable: false });
  });

  it.each(['awaiting_consent', 'ready_to_complete', 'completed', 'denied'] as const)(
    'a replay binding match in terminal state %s — REJECTED, no idempotent window',
    async (state) => {
      // Chỉ `browser_confirmed` mở cửa sổ idempotent. Mọi state khác nghĩa là
      // giao dịch đã đi tiếp (X bị event khác tiêu thụ, code đã cấp, bị deny)
      // — một request đến muộn không được mở lại; CAS/throw giữ nguyên.
      const store = makeStore({ transition: async () => false });
      const bindingHash = await hashHandle('binding-cookie-hop-le');
      const now = new Date();

      await expect(
        confirmBrowser({
          store,
          transaction: {
            ...TRANSACTION,
            state,
            browser_binding_hash: bindingHash,
            expires_at: new Date(now.getTime() + 60_000),
          },
          presentedBinding: 'binding-cookie-hop-le',
          now,
        }),
      ).rejects.toMatchObject({ redirectable: false });
      expect(store.calls).not.toContain('transition');
    },
  );
});

describe('completeAuthorization — fail-closed', () => {
  it('Account is NOT called — nothing is issued, and the error stays internal', async () => {
    // ⚠️ Bat bien fail-closed. Khong co nhanh "coi nhu khoa khoe". Neu test nay
    // xanh khi Account nem, thi mot su co Account se thanh mot su co bao mat.
    const store = makeStore();
    await expect(
      completeAuthorization({
        store,
        account: makeAccount(true),
        transaction: TRANSACTION,
        accountId: 'account-1',
        now: new Date(),
      }),
    ).rejects.toThrow('account khong goi duoc');

    expect(store.calls).not.toContain('insertAuthorizationCode');
  });

  it('Account is suspended — access_denied, nothing is issued', async () => {
    const store = makeStore();
    await expect(
      completeAuthorization({
        store,
        account: makeAccount(false, 'suspended'),
        transaction: TRANSACTION,
        accountId: 'account-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });

    expect(store.calls).not.toContain('insertAuthorizationCode');
  });

  it('the transaction has not been confirmed by the browser — REJECTED before Account is called', async () => {
    // ⚠️ Thu tu nay co nghia: kiem tra binding phai chay TRUOC moi thu khac,
    // vi neu handle bi trao thi moi field khac cua hang deu khong dang tin.
    const store = makeStore();
    const checkStatus = vi.fn<() => Promise<AccountStatusResponseValue>>();
    await expect(
      completeAuthorization({
        store,
        account: {
          verifySession: vi.fn<() => Promise<{ outcome: 'unverified' }>>(),
          checkStatus,
        } as unknown as AccountClient,
        transaction: { ...TRANSACTION, state: 'pending_browser' },
        accountId: 'account-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ redirectable: false });

    expect(checkStatus).not.toHaveBeenCalled();
  });

  it('the grant has been revoked — access_denied, nothing is issued', async () => {
    const store = makeStore({ checkRevocation: async () => 'revoked' });
    await expect(
      completeAuthorization({
        store,
        account: makeAccount(),
        transaction: TRANSACTION,
        accountId: 'account-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });

    expect(store.calls).not.toContain('insertAuthorizationCode');
  });

  it('the user denies consent — `access_denied`, and NO code is issued', async () => {
    const store = makeStore();
    await expect(
      completeAuthorization({
        store,
        account: makeAccount(),
        transaction: TRANSACTION,
        accountId: 'account-1',
        consentDecision: 'deny',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });

    expect(store.calls).not.toContain('insertAuthorizationCode');
  });

  it('the transaction already changed state (lost CAS) — NO second code is issued', async () => {
    // ⚠️ Hai request hoan tat dong thoi: chi mot duoc phat code. `transition`
    // tra false cho ke thua, va o day dieu do phai chan viec phat hanh.
    const store = makeStore({ transition: async () => false });
    await expect(
      completeAuthorization({
        store,
        account: makeAccount(),
        transaction: TRANSACTION,
        accountId: 'account-1',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(store.calls).not.toContain('insertAuthorizationCode');
  });

  it('the happy path — issues a code and stores the HASH, never the cleartext', async () => {
    let saved: Awaited<Parameters<AuthStore['insertAuthorizationCode']>[0]> | undefined;
    const store = makeStore({
      insertAuthorizationCode: async (code) => {
        saved = code;
      },
    });

    const result = await completeAuthorization({
      store,
      account: makeAccount(),
      transaction: TRANSACTION,
      accountId: 'account-1',
      now: new Date(),
      newId: () => 'plaintext-code-value',
    });

    expect(result.code).toBe('plaintext-code-value');
    // ⚠️ Ban luu KHONG duoc bang ban ro. Neu bang nhau thi mot lan doc bang la
    // mot lan doi code lay token duoc.
    expect(saved?.code_hash).toBeDefined();
    expect(saved?.code_hash).not.toBe('plaintext-code-value');
  });

  it('code DTO matches schema 0004 — sub, granted_scopes, nonce, FK follows the transaction', async () => {
    // ⚠️ Finding #16 của #181: `NewAuthorizationCode` cũ thiếu `sub`, dùng
    // `transaction_id` thay vì `authorization_transaction_id` và `scope: string`
    // thay vì `granted_scopes text[]` — ba lệch khiến `insertAuthorizationCode`
    // không thể ghi được schema thật. Test này ghim shape đúng.
    let saved: Awaited<Parameters<AuthStore['insertAuthorizationCode']>[0]> | undefined;
    const store = makeStore({
      insertAuthorizationCode: async (code) => {
        saved = code;
      },
    });

    const transaction = {
      ...TRANSACTION,
      requested_scopes: ['openid', 'profile'],
      nonce: 'n-echo-check',
    };

    await completeAuthorization({
      store,
      account: makeAccount(),
      transaction,
      accountId: 'account-1',
      now: new Date(),
      newId: () => 'g'.repeat(43),
    });

    expect(saved?.authorization_transaction_id).toBe(transaction.transaction_id);
    expect(saved?.sub).toBe('account-1');
    expect([...(saved?.granted_scopes ?? [])]).toEqual(['openid', 'profile']);
    expect(saved?.nonce).toBe('n-echo-check');
    expect(saved?.code_challenge_method).toBe('S256');
  });
});

describe('exchangeAuthorizationCode — PKCE', () => {
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('a code_verifier with the right format but the wrong value — invalid_grant', async () => {
    const signingKey = await makeSigningKey();
    await expect(
      exchangeAuthorizationCode({
        account: makeAccount(),
        signingKey,
        consumedCode: {
          transactionRef: 'a'.repeat(43),
          client_id: 'client-1',
          redirect_uri: 'https://app.example.com/cb',
          granted_scopes: ['openid'],
          code_challenge: CHALLENGE,
        },
        // 43 ky tu unreserved — dung dinh dang RFC 7636 nhung khong hash ra CHALLENGE.
        codeVerifier: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        issuer: 'https://auth.ecoma.io',
        audience: 'https://api.ecoma.io',
        accountId: 'account-1',
        accessTokenTtlSeconds: 300,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('a code_verifier with the wrong FORMAT — invalid_request before the challenge is compared', async () => {
    const signingKey = await makeSigningKey();
    await expect(
      exchangeAuthorizationCode({
        account: makeAccount(),
        signingKey,
        consumedCode: {
          transactionRef: 'a'.repeat(43),
          client_id: 'client-1',
          redirect_uri: 'https://app.example.com/cb',
          granted_scopes: ['openid'],
          code_challenge: CHALLENGE,
        },
        // 37 ky tu — duoi nguong 43 ky tu cua RFC 7636.
        codeVerifier: 'sai-hoan-toan-verifier-nay-khong-dung',
        issuer: 'https://auth.ecoma.io',
        audience: 'https://api.ecoma.io',
        accountId: 'account-1',
        accessTokenTtlSeconds: 300,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('a CORRECT code_verifier — issues a token, and the access token verifies offline', async () => {
    const signingKey = await makeSigningKey();
    const tokens = await exchangeAuthorizationCode({
      account: makeAccount(),
      signingKey,
      consumedCode: {
        transactionRef: 'a'.repeat(43),
        client_id: 'client-1',
        redirect_uri: 'https://app.example.com/cb',
        granted_scopes: ['openid'],
        code_challenge: CHALLENGE,
      },
      codeVerifier: VERIFIER,
      issuer: 'https://auth.ecoma.io',
      audience: 'https://api.ecoma.io',
      accountId: 'account-1',
      accessTokenTtlSeconds: 300,
      now: new Date(),
    });

    // Verify CHI bang JWKS — day chinh la tinh chat offline validation.
    const publicKey = await importJWK(await signingKey.publicJwk(), 'ES256');
    const { payload } = await jwtVerify(tokens.accessToken, publicKey);

    expect(payload.sub).toBe('account-1');
    // Refresh token tra ve la BAN RO cho client, kem ban bam de luu.
    expect(tokens.refreshToken.plaintext).not.toBe(tokens.refreshToken.hash);
  });

  it('Account gets locked between code issuance and code exchange — NO token is issued', async () => {
    // Khoang giua hai buoc la co that. Bo lan kiem nay nghia la mot account da
    // bi khoa van nhan duoc token.
    const signingKey = await makeSigningKey();
    await expect(
      exchangeAuthorizationCode({
        account: makeAccount(false, 'suspended'),
        signingKey,
        consumedCode: {
          transactionRef: 'a'.repeat(43),
          client_id: 'client-1',
          redirect_uri: 'https://app.example.com/cb',
          granted_scopes: ['openid'],
          code_challenge: CHALLENGE,
        },
        codeVerifier: VERIFIER,
        issuer: 'https://auth.ecoma.io',
        audience: 'https://api.ecoma.io',
        accountId: 'account-1',
        accessTokenTtlSeconds: 300,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant', redirectable: false });
  });
});
