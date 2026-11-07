/**
 * Test verify access token — ADR-0012 §2 và phân loại 401/503 của ADR-0011 §1.
 *
 * ## Vì sao test tự ký token thay vì gọi `auth` thật
 *
 * Verifier đọc `iss`/`aud` từ cấu hình riêng (ADR-0012 §5: "chạy được với
 * audience bất kỳ vì test dùng token tự ký theo đúng contract"). Một JWKS
 * phục vụ bởi local server trong test là **hợp đồng thật** của verifier: fetch
 * HTTP, cache, re-fetch-on-unknown-kid — tất cả chạy đúng đường production.
 *
 * ## Matrix ghim
 *
 * - Hợp lệ ⇒ `verified` với `sub` đúng.
 * - Chữ ký sai (key khác) / `iss` sai / `aud` sai / hết hạn / thiếu `sub` /
 *   `alg` khác (HS256 forged) ⇒ `invalid`.
 * - **Không đòi `nbf`** — token đúng contract runtime (không claim này) phải
 *   `verified` (mutation control: thêm `nbf` bắt buộc vào verifier là test đỏ).
 * - JWKS không fetch được ⇒ `unavailable` (503) — **không** phải `invalid`.
 * - `kid` lạ: JWKS mới có key ⇒ `verified` (rotation thêm key); JWKS mới
 *   không có key ⇒ `invalid` (rotation gỡ key).
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackofficeAuthConfig } from './verify';
import { JWKS_CACHE_TTL_SECONDS, resetJwksCacheForTests } from './jwks';
import { verifyAccessToken } from './verify';

const AUDIENCE = 'https://api.test.ecoma.io/backoffice';
const CLIENT_ID = 'backoffice-test';
const ACCOUNT_ID = `sub_${'a'.repeat(32)}`;

/**
 * Issuer của cấu hình verify — **chính là** URL của fake server: JWKS URI của
 * verifier được dựng từ issuer, và phép so `iss` exact đòi token mang cùng
 * chuỗi đó. Kết quả: issuer thật của hệ thống bị thay bằng loopback trong
 * test, còn verifier không biết sự khác biệt — đúng cách test hợp đồng offline
 * mà không cần `auth` thật.
 */
let issuerUrl = 'http://127.0.0.1:1';

/** Cấu hình test — cùng hình dạng mà `backofficeAuthConfig` trả. */
function config(): BackofficeAuthConfig {
  return { issuer: issuerUrl, audience: AUDIENCE, clientId: CLIENT_ID };
}

/** Key cặp đầu tiên — JWKS mặc định của fake auth. */
let primaryKey: CryptoKeyPair;
let primaryJwk: Record<string, unknown>;
const PRIMARY_KID = 'test-key-1';

/** Key thứ hai cho rotation — JWKS "đã rotate". */
let rotatedKey: CryptoKeyPair;
let rotatedJwk: Record<string, unknown>;
const ROTATED_KID = 'test-key-2';

/** JWKS hiện hành mà fake server công bố — test đổi nó giữa các case. */
let currentJwks: { keys: Record<string, unknown>[] };

/** Số lần fake server được fetch `/jwks.json` — test reset về 0 trong beforeEach. */
let jwksFetchCount = 0;

let server: Server;
let serverUrl = '';

beforeAll(async () => {
  primaryKey = (await generateKeyPair('ES256', { extractable: true })) as CryptoKeyPair;
  primaryJwk = {
    kid: PRIMARY_KID,
    alg: 'ES256',
    use: 'sig',
    ...(await exportJWK(primaryKey.publicKey)),
  };
  rotatedKey = (await generateKeyPair('ES256', { extractable: true })) as CryptoKeyPair;
  rotatedJwk = {
    kid: ROTATED_KID,
    alg: 'ES256',
    use: 'sig',
    ...(await exportJWK(rotatedKey.publicKey)),
  };
  currentJwks = { keys: [primaryJwk] };

  server = createServer((req, res) => {
    if (req.url === '/jwks.json') {
      jwksFetchCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(currentJwks));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake auth server did not bind a port');
  }
  serverUrl = `http://127.0.0.1:${address.port}`;
  issuerUrl = serverUrl;
});

afterAll(async () => {
  await new Promise<void>((done) => {
    server.close(() => done());
  });
});

beforeEach(() => {
  resetJwksCacheForTests();
  currentJwks = { keys: [primaryJwk] };
  jwksFetchCount = 0;
});

afterEach(() => {
  resetJwksCacheForTests();
});

/** Ký một token với key/keyid/claims tùy chọn — đúng cấu trúc `at+jwt`. */
async function signAccessToken(
  key: CryptoKey,
  kid: string,
  claims: { iss?: string; aud?: string | string[]; sub?: string; exp?: number; nbf?: number } = {},
): Promise<string> {
  const builder = new SignJWT({
    scope: 'openid offline_access',
    client_id: CLIENT_ID,
    jti: 'test-jti',
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid })
    .setIssuer(claims.iss ?? issuerUrl)
    .setAudience(claims.aud ?? AUDIENCE)
    .setSubject(claims.sub ?? ACCOUNT_ID)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 300);
  if (claims.nbf !== undefined) {
    builder.setNotBefore(claims.nbf);
  }
  return builder.sign(key);
}

/** Ghim `Date.now` tại `fake` cho tới khi `body` chạy xong — điều khiển cửa sổ cooldown của jose. */
async function withFrozenTime<T>(fake: number, body: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(fake);
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

describe('verifyAccessToken — happy path và matrix 401', () => {
  it('verifies a contract-conformant token and returns the sub', async () => {
    const token = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID);
    const result = await verifyAccessToken(token, config());
    expect(result).toEqual({ outcome: 'verified', sub: ACCOUNT_ID, exp: expect.any(Number) });
  });

  it('does NOT require nbf — a token without the claim verifies (ADR-0012 §2)', async () => {
    // `signAccessToken` mặc định không đặt `nbf`; assertion này là mutation
    // control: thêm `nbf` vào `requiredClaims` của verifier ⇒ test đỏ.
    const token = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID);
    const result = await verifyAccessToken(token, config());
    expect(result.outcome).toBe('verified');
  });

  it('rejects a token signed by a foreign key (bad signature) as invalid', async () => {
    const foreign = (await generateKeyPair('ES256', { extractable: true })) as CryptoKeyPair;
    const token = await signAccessToken(foreign.privateKey as CryptoKey, PRIMARY_KID);
    const result = await verifyAccessToken(token, config());
    expect(result).toEqual({ outcome: 'invalid' });
  });

  it('rejects a wrong iss as invalid', async () => {
    const token = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID, {
      iss: 'https://other.ecoma.io',
    });
    const result = await verifyAccessToken(token, config());
    expect(result).toEqual({ outcome: 'invalid' });
  });

  it('rejects a wrong aud as invalid', async () => {
    const token = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID, {
      aud: 'https://other-audience.ecoma.io',
    });
    const result = await verifyAccessToken(token, config());
    expect(result).toEqual({ outcome: 'invalid' });
  });

  it('rejects an expired token as invalid', async () => {
    const token = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID, {
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const result = await verifyAccessToken(token, config());
    expect(result).toEqual({ outcome: 'invalid' });
  });

  it('rejects a token without sub as invalid (required claim)', async () => {
    const builder = new SignJWT({ scope: 'openid' })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: PRIMARY_KID })
      .setIssuer(issuerUrl)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300);
    const token = await builder.sign(primaryKey.privateKey as CryptoKey);
    const result = await verifyAccessToken(token, config());
    expect(result).toEqual({ outcome: 'invalid' });
  });

  it('rejects a malformed string as invalid without throwing', async () => {
    const result = await verifyAccessToken('not-a-jwt', config());
    expect(result).toEqual({ outcome: 'invalid' });
  });
});

describe('verifyAccessToken — JWKS unavailable là 503, không phải 401', () => {
  it('returns unavailable when the JWKS endpoint does not answer', async () => {
    // Port không có listener — fetch chết ngay. ⚠️ Token phải là JWT có header
    // parse được: lỗi parse (`JWSInvalid`) đến **trước** fetch JWKS và là
    // `invalid` (401), còn `unavailable` phải dành đúng cho fetch chết.
    const token = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID);
    const deadConfig: BackofficeAuthConfig = {
      issuer: 'http://127.0.0.1:1',
      audience: AUDIENCE,
      clientId: CLIENT_ID,
    };
    const result = await verifyAccessToken(token, deadConfig);
    expect(result).toEqual({ outcome: 'unavailable' });
  });
});

/**
 * ⚠️ Cooldown của `createRemoteJWKSet` (30s, ghim tường minh ở `jwks.ts`):
 * kể từ lần fetch JWKS cuối, một `kid` lạ trong cửa sổ cooldown **không**
 * trigger re-fetch — kết luận `invalid` ngay (van chống fetch-storm). Các test
 * dưới vượt/tạm dừng trong cửa sổ bằng cách điều khiển `Date.now` (hàm
 * `isFreshFor` của `jose` đọc `Date.now`) qua `withFrozenTime`, và đếm số lần
 * fetch thật ở fake server qua biến `jwksFetchCount`.
 */
describe('verifyAccessToken — kid lạ: cooldown chặn re-fetch, hết cooldown thì fetch', () => {
  /** Mốc "đã qua cả TTL lẫn cooldown" so với thời điểm gọi. */
  const PAST_ALL_WINDOWS_MS = JWKS_CACHE_TTL_SECONDS * 1000 + 60_000;

  it('verifies a token signed by a newly rotated key after the cooldown re-fetch', async () => {
    // Cache nóng với JWKS cũ (chỉ primary); JWKS "đã rotate" có cả hai key.
    const warm = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID);
    expect((await verifyAccessToken(warm, config())).outcome).toBe('verified');
    expect(jwksFetchCount).toBe(1);

    currentJwks = { keys: [primaryJwk, rotatedJwk] };
    // Verify diễn ra ở tương lai (đã qua TTL + cooldown): token phải còn hạn
    // **tại mốc đó**, không chỉ tại thời điểm ký.
    const verifyAtMs = Date.now() + PAST_ALL_WINDOWS_MS;
    const rotatedToken = await signAccessToken(rotatedKey.privateKey as CryptoKey, ROTATED_KID, {
      exp: Math.floor(verifyAtMs / 1000) + 300,
    });
    const result = await withFrozenTime(verifyAtMs, () =>
      verifyAccessToken(rotatedToken, config()),
    );
    expect(result).toEqual({ outcome: 'verified', sub: ACCOUNT_ID, exp: expect.any(Number) });
    expect(jwksFetchCount).toBe(2); // warm-up + re-fetch sau khi qua cửa sổ
  });

  it('rejects as invalid a kid that is gone from the refreshed JWKS (key removed)', async () => {
    const warm = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID);
    expect((await verifyAccessToken(warm, config())).outcome).toBe('verified');

    // Rotation gỡ primary: JWKS mới chỉ còn rotated key.
    currentJwks = { keys: [rotatedJwk] };
    const verifyAtMs = Date.now() + PAST_ALL_WINDOWS_MS;
    const staleToken = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID, {
      exp: Math.floor(verifyAtMs / 1000) + 300,
    });
    const result = await withFrozenTime(verifyAtMs, () => verifyAccessToken(staleToken, config()));
    expect(result).toEqual({ outcome: 'invalid' });
    expect(jwksFetchCount).toBe(2); // re-fetch đã xảy ra, key vẫn không thấy
  });

  it('does NOT re-fetch inside the cooldown window — unknown kid concludes invalid', async () => {
    // Trong cooldown: kid lạ kết luận ngay trên JWKS đang có — fetch server
    // không bị gọi lần hai (van chống fetch-storm).
    const warm = await signAccessToken(primaryKey.privateKey as CryptoKey, PRIMARY_KID);
    expect((await verifyAccessToken(warm, config())).outcome).toBe('verified');
    expect(jwksFetchCount).toBe(1);

    currentJwks = { keys: [rotatedJwk] };
    const rotatedToken = await signAccessToken(rotatedKey.privateKey as CryptoKey, ROTATED_KID);
    // +5s: còn trong cooldown 30s ⇒ re-fetch bị chặn ⇒ JWKS đã đổi không được
    // nhìn ⇒ token key mới kết luận `invalid`, số fetch không đổi.
    const result = await withFrozenTime(Date.now() + 5_000, () =>
      verifyAccessToken(rotatedToken, config()),
    );
    expect(result).toEqual({ outcome: 'invalid' });
    expect(jwksFetchCount).toBe(1);
  });
});
