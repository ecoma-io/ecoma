import { decodeProtectedHeader, exportPKCS8, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { expect, it, describe } from 'vitest';

import type { SigningKeyProvider } from '@ecoma-io/auth-domain';

import { signingKeyProviderFromPemForSpec } from './signing-key-test-support';
import {
  JWT_SIGNING_ALG,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  MAX_ACCESS_TOKEN_TTL_SECONDS,
  assertAccessTokenTtl,
  buildJwks,
  createRefreshToken,
  issueAccessToken,
} from './token-service';

/** Sinh khoa that de test chay tren cung duong code voi production. */
async function makeSigningKey(): Promise<SigningKeyProvider> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  return signingKeyProviderFromPemForSpec({ pem, kid: 'kid-test' });
}

describe('assertAccessTokenTtl — the TTL bounds are the revocation delay', () => {
  it('accepts a TTL inside the bounds', () => {
    expect(() => assertAccessTokenTtl(300)).not.toThrow();
    expect(() => assertAccessTokenTtl(MAX_ACCESS_TOKEN_TTL_SECONDS)).not.toThrow();
  });

  it('REJECTS a TTL past the bounds — because those bounds are the revocation delay', () => {
    // Access token verify offline nen khong the thu hoi som. Mot TTL 24h
    // nghia la grant bi thu hoi van dung duoc 24h nua.
    expect(() => assertAccessTokenTtl(86400)).toThrow(/vuot tran|do tre thu hoi/u);
  });

  it('REJECTS a TTL that is negative or non-integer', () => {
    expect(() => assertAccessTokenTtl(0)).toThrow(/nguyen duong/u);
    expect(() => assertAccessTokenTtl(-1)).toThrow(/nguyen duong/u);
    expect(() => assertAccessTokenTtl(1.5)).toThrow(/nguyen duong/u);
  });
});

describe('createRefreshToken — opaque, only the hash is stored', () => {
  it('the plaintext and the hash DIFFER, and the hash does not contain the plaintext', async () => {
    const token = await createRefreshToken({ familyId: 'fam-1' });

    // Bat bien quan trong nhat: ban luu KHONG duoc la ban dung. Neu hash ===
    // plaintext thi mot lan doc bang la mot lan mao danh duoc moi phien.
    expect(token.hash).not.toBe(token.plaintext);
    expect(token.hash).not.toContain(token.plaintext);
    expect(token.plaintext).not.toContain(token.hash);
  });

  it('two generations for different plaintexts', async () => {
    const a = await createRefreshToken({ familyId: 'fam-1' });
    const b = await createRefreshToken({ familyId: 'fam-1' });
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it('the plaintext carries enough entropy and uses the base64url charset', async () => {
    const token = await createRefreshToken({ familyId: 'fam-1' });
    // 32 byte -> 43 ky tu base64url khong padding.
    expect(token.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('the family id is preserved so the whole family can be revoked', async () => {
    const token = await createRefreshToken({ familyId: 'fam-abc' });
    expect(token.familyId).toBe('fam-abc');
  });

  it('an injected crypto source drives the plaintext — deterministic bytes, hash of the exact plaintext', async () => {
    // ⚠️ Seam `crypto` của hàm: plaintext là base64url của ĐÚNG 32 byte nguồn
    //     tiêm vào, không phải ngẫu nhiên thứ hai. Kiểm bằng nguồn cố định:
    //     bytes lặp 0..31 ⇒ plaintext tính được trước; `hash` phải là
    //     SHA-256-base64url của chính plaintext đó (có thể tính độc lập bằng
    //     WebCrypto) — chứng minh hàm băm bám bản rõ đã phát, không phải một
    //     bản rõ nội bộ nào khác.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i;
    }
    const deterministic: Crypto = {
      getRandomValues<T extends ArrayBufferView>(target: T): T {
        new Uint8Array(target.buffer as ArrayBuffer, target.byteOffset, target.byteLength).set(
          bytes.subarray(0, target.byteLength),
        );
        return target;
      },
    } as unknown as Crypto;

    const token = await createRefreshToken({ familyId: 'fam-det', crypto: deterministic });

    const expectedPlaintext = Buffer.from(bytes).toString('base64url');
    expect(token.plaintext).toBe(expectedPlaintext);

    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(expectedPlaintext),
    );
    const expectedHash = Buffer.from(digest).toString('base64url');
    expect(token.hash).toBe(expectedHash);
  });
});

describe('buildJwks — publishes only the public key', () => {
  it('never contains a `d` field', () => {
    // Bat bien cua JWKS. Mot truong `d` trong response cong khai la mot lan ro
    // private key ra internet.
    const jwks = buildJwks([
      { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb', alg: 'ES256', use: 'sig', kid: 'k1' },
    ]);

    expect(jwks.keys).toHaveLength(1);
    for (const key of jwks.keys) {
      expect(key).not.toHaveProperty('d');
      expect(Object.keys(key).toSorted()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    }
  });
});

describe('issueAccessToken — signs with ES256, full claim set', () => {
  it('the token verifies against the public key from JWKS — that is, offline validation', async () => {
    const signingKey = await makeSigningKey();
    // ⚠️ Dung thoi gian THAT, khong truyen `currentDate` cho `jwtVerify`. Mot
    // moc thoi gian gia se khien test kiem tra duong `jwtVerify` da bi goi
    // loi — va do la thu duy nhat no dang kiem. Truyen `now` gia vao day thi
    // test chi con chung minh rang ta biet cach truyen tham so.
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);

    const token = await issueAccessToken({
      signingKey,
      claims: {
        sub: 'account-1',
        aud: 'https://api.ecoma.io',
        iss: 'https://auth.ecoma.io',
        iat: nowSeconds,
        nbf: nowSeconds,
        exp: nowSeconds + DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        client_id: 'client-1',
        scope: 'openid profile',
        transaction_id: 'tx-1',
      },
    });

    // Verify CHI bang public JWK — khong goi auth, khong doc database. Day
    // chinh la tinh chat khien token dung duoc o resource server.
    const jwk = await signingKey.publicJwk();
    const publicKey = await importJWK(jwk, JWT_SIGNING_ALG);
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      issuer: 'https://auth.ecoma.io',
      audience: 'https://api.ecoma.io',
    });

    expect(payload.sub).toBe('account-1');
    expect(payload['client_id']).toBe('client-1');
    expect(protectedHeader.alg).toBe(JWT_SIGNING_ALG);
  });

  it('the full claim set round-trips: scope, transaction_id, nbf, iat and exp survive signing verbatim', async () => {
    // ⚠️ Test trên chỉ assert `sub`/`client_id`. Resource server dựa vào các
    //     claim còn lại để ủy quyền (scope) và truy vết (transaction_id); lệch
    //     một claim khi ký là sai lệch im lặng. Ghim đủ: `setIssuedAt`/
    //     `setNotBefore`/`setExpirationTime` phải đặt ĐÚNG giá trị caller
    //     truyền, không phải `now()` của lúc ký — một token ký lúc T với
    //     `iat` caller truyền từ T-5s phải giữ nguyên T-5s.
    const signingKey = await makeSigningKey();
    const iat = Math.floor(Date.now() / 1000) - 5;
    const ttl = 120;

    const token = await issueAccessToken({
      signingKey,
      claims: {
        sub: 'account-2',
        aud: 'https://api.ecoma.io',
        iss: 'https://auth.ecoma.io',
        iat,
        nbf: iat,
        exp: iat + ttl,
        client_id: 'client-2',
        scope: 'openid profile email',
        transaction_id: 'a'.repeat(43),
      },
    });

    const publicKey = await importJWK(await signingKey.publicJwk(), JWT_SIGNING_ALG);
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: 'https://auth.ecoma.io',
      audience: 'https://api.ecoma.io',
    });

    expect(payload.aud).toBe('https://api.ecoma.io');
    expect(payload.iss).toBe('https://auth.ecoma.io');
    expect(payload.iat).toBe(iat);
    expect(payload.nbf).toBe(iat);
    expect(payload.exp).toBe(iat + ttl);
    expect(payload['scope']).toBe('openid profile email');
    expect(payload['transaction_id']).toBe('a'.repeat(43));
  });

  it('the header carries `kid` so key rotation picks the right JWKS key', async () => {
    const signingKey = await makeSigningKey();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await issueAccessToken({
      signingKey,
      claims: {
        sub: 'account-1',
        aud: 'https://api.ecoma.io',
        iss: 'https://auth.ecoma.io',
        iat: nowSeconds,
        nbf: nowSeconds,
        exp: nowSeconds + 300,
        client_id: 'client-1',
        scope: 'openid',
        transaction_id: 'tx-1',
      },
    });

    const header = decodeProtectedHeader(token);
    expect(header.kid).toBe('kid-test');
    // `at+jwt` (RFC 9068) de resource server phan biet voi id token — khong co
    // no thi mot id token co the bi dung nhu access token.
    expect(header.typ).toBe('at+jwt');
  });

  it('REJECTS signing a token whose TTL is past the bounds', async () => {
    const signingKey = await makeSigningKey();
    const nowSeconds = Math.floor(Date.now() / 1000);
    await expect(
      issueAccessToken({
        signingKey,
        claims: {
          sub: 'account-1',
          aud: 'https://api.ecoma.io',
          iss: 'https://auth.ecoma.io',
          iat: nowSeconds,
          nbf: nowSeconds,
          exp: nowSeconds + 86400,
          client_id: 'client-1',
          scope: 'openid',
          transaction_id: 'tx-1',
        },
      }),
    ).rejects.toThrow(/vuot tran|do tre thu hoi/u);
  });
});
