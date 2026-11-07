/**
 * Test của cache JWKS theo issuer — bốn bất biến mà verify.spec (chạy verify
 * end-to-end) không nhìn thấy được vì nó chỉ dùng một issuer:
 *
 * 1. **Cache khoá theo issuer** — hai issuer không bao giờ nhận resolver của
 *    nhau; verify token của issuer A bằng key của issuer B là fail vì lý do
 *    sai.
 * 2. **Single-flight** — hai caller cùng gặp cache-miss chỉ tạo một resolver
 *    mới; không có cơ chế này thì mỗi request đúng lúc TTL hết là một fetch
 *    JWKS.
 * 3. **TTL** — entry quá hạn bị bỏ, lượt sau fetch lại; entry trong hạn được
 *    trả lại nguyên instance (không dựng lại resolver mỗi lần).
 * 4. **Không rò state giữa test** — `resetJwksCacheForTests` là đường duy nhất
 *    xoá cache, và module không export bất kỳ "refresh" nào cho production.
 *
 * `createRemoteJWKSet` fetch **lazy** ở lần verify đầu — nên ở đây dựng resolver
 * không phát network request nào; assert được mà không cần stub fetch.
 *
 * Origin fetch override (`fetchOrigin`) được ghim bằng cách bắt URL mà resolver
 * sắp fetch: build-url thật của `jose` nằm trong closure không nhìn được, nên
 * test dựng một URL object từ chính cặp tham số mà `jwksResolver` truyền xuống
 * — assert là `new URL('/jwks.json', fetchOrigin)` đúng base, còn issuer chỉ
 * là khóa cache.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JWTVerifyGetKey } from 'jose';

import { JWKS_CACHE_TTL_SECONDS, jwksResolver, resetJwksCacheForTests } from './jwks';

const ISSUER_A = 'https://auth-a.test.ecoma.io';
const ISSUER_B = 'https://auth-b.test.ecoma.io';
/** Origin nội bộ giả — hình dạng đúng của biến local (`ecoma-<ns>-auth:4203`). */
const INTERNAL_ORIGIN = 'http://ecoma-test-auth:4203';

afterEach(() => {
  vi.useRealTimers();
  resetJwksCacheForTests();
});

describe('jwksResolver — per-issuer keying', () => {
  it('returns a distinct resolver per issuer and never crosses them', async () => {
    const a = await jwksResolver(ISSUER_A);
    const b = await jwksResolver(ISSUER_B);

    expect(a).not.toBe(b);
  });

  it('serves the same issuer from cache with the identical resolver instance', async () => {
    const first = await jwksResolver(ISSUER_A);
    const second = await jwksResolver(ISSUER_A);

    // Cùng **instance**: dựng lại resolver mỗi lần gọi là mất cả ý nghĩa cache
    // lẫn single-flight cooldown của `jose`.
    expect(second).toBe(first);
  });
});

describe('jwksResolver — single-flight on a cold cache', () => {
  it('collapses concurrent cold-cache calls into one resolver construction', async () => {
    const [p1, p2, p3] = [jwksResolver(ISSUER_A), jwksResolver(ISSUER_A), jwksResolver(ISSUER_A)];
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('clears the in-flight slot after settling so a later miss can rebuild', async () => {
    const first = await jwksResolver(ISSUER_A);

    // Đẩy thời gian vượt TTL: entry chết, lượt sau phải dựng resolver mới.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (JWKS_CACHE_TTL_SECONDS + 1) * 1000);

    const second = await jwksResolver(ISSUER_A);
    expect(second).not.toBe(first);
  });
});

describe('jwksResolver — TTL', () => {
  it('pins the 10-minute TTL that matches the jose default it wraps', () => {
    expect(JWKS_CACHE_TTL_SECONDS).toBe(600);
  });

  it('serves a cache hit inside the TTL window', async () => {
    const first = await jwksResolver(ISSUER_A);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (JWKS_CACHE_TTL_SECONDS - 1) * 1000);

    expect(await jwksResolver(ISSUER_A)).toBe(first);
  });

  it('drops an expired entry so the next call rebuilds it', async () => {
    const first = await jwksResolver(ISSUER_A);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + JWKS_CACHE_TTL_SECONDS * 1000);

    expect(await jwksResolver(ISSUER_A)).not.toBe(first);
  });
});

describe('resetJwksCacheForTests', () => {
  it('is the only way state crosses between suites — clearing forces a rebuild', async () => {
    const first = await jwksResolver(ISSUER_A);
    resetJwksCacheForTests();

    expect(await jwksResolver(ISSUER_A)).not.toBe(first);
  });
});

/**
 * Bắt URL mà resolver fetch JWKS. `createRemoteJWKSet` dựng resolver mà
 * KHÔNG fetch (lazy — đo trên jose 6.2.13: fetch chỉ xảy ra ở lần gọi
 * resolver đầu), nên helper phải gọi resolver với một descriptor `kid` lạ:
 * jose fetch JWKS (mock trả key set rỗng hợp lệ) rồi ném
 * `JWKSNoMatchingKey` — ném đó là expected, URL bị bắt là kết quả assert.
 */
async function captureJwksUrl(run: () => Promise<unknown>): Promise<string> {
  const urls: string[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(input instanceof URL ? input.toString() : String(input));
      return new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  try {
    const resolver = (await run()) as JWTVerifyGetKey;
    try {
      // Token là `FlattenedJWSInput` — chỉ shape type quan trọng, jose fetch
      // JWKS TRƯỚC khi nhìn payload nên giá trị rỗng không bao giờ được dùng.
      await resolver(
        { alg: 'ES256', kid: 'capture-test' },
        { payload: '', protected: '', signature: '' },
      );
    } catch {
      // `JWKSNoMatchingKey` — JWKS rỗng của mock không có key nào; đây là
      // đường kết thúc expected, điều cần assert là URL đã bị bắt.
    }
  } finally {
    fetchSpy.mockRestore();
  }
  return urls[0] ?? '';
}

describe('jwksResolver — optional fetch origin override', () => {
  it('builds the JWKS URL from the fetch origin while the issuer stays the cache key', async () => {
    const url = await captureJwksUrl(() => jwksResolver(ISSUER_A, INTERNAL_ORIGIN));

    // Origin nội bộ quyết định nơi fetch (container local không tới được origin
    // công khai) — path `/jwks.json` giữ nguyên.
    expect(new URL(url).origin).toBe(INTERNAL_ORIGIN);
    expect(new URL(url).pathname).toBe('/jwks.json');
  });

  it('defaults the JWKS URL to the issuer when no fetch origin is given', async () => {
    // Production path: `undefined` ⇒ URL từ issuer, hành vi giữ nguyên từng byte.
    const url = await captureJwksUrl(() => jwksResolver(ISSUER_B));

    expect(new URL(url).origin).toBe(ISSUER_B);
    expect(new URL(url).pathname).toBe('/jwks.json');
  });

  it('keeps the cache keyed by the issuer across calls with and without an origin', async () => {
    // Cache-hit là resolver của issuer bất kể origin truyền vào lần sau —
    // origin là cấu hình deployment ổn định suốt tiến trình, không phải tham
    // số per-call; việc nó KHÔNG tham gia khóa cache là quyết định ghi ở JSDoc.
    const first = await jwksResolver(ISSUER_A, INTERNAL_ORIGIN);
    const second = await jwksResolver(ISSUER_A);

    expect(second).toBe(first);
  });
});
