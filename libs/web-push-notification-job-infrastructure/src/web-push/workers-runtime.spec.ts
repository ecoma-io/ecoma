/**
 * Kiểm chứng giả định của {@link ./webcrypto} trên **workerd thật**, không phải Node.
 *
 * ⚠️ Vì sao file này tồn tại. `webcrypto.ts` ép kiểu `deriveBits` dùng field `public` chuẩn
 * W3C thay vì `$public` mà `@cloudflare/workers-types` khai báo. Lý do: **workerd ném
 * `TypeError` khi đưa `$public`** (đo bằng Miniflare, xem `PROBE` dưới). Nếu chỉ test trên
 * Node thì cast đó đúng theo Node và **sai theo Workers** — đúng cái loại lỗi chỉ lộ ra
 * lúc deploy. Test này chạy đoạn đó trên chính workerd để giữ lại bằng chứng.
 *
 * ⚠️ Test **tự skip** nếu máy không có `workerd`/`miniflare` — nó không được phép biến một
 * môi trường thiếu dependency thành CI đỏ, và repo không cho thêm npm dependency
 * (workerd/miniflare là bản cài transitively qua wrangler, không phải dependency ta thêm).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ecdhDeriveParams } from './webcrypto';

/**
 * Nạp `miniflare` — **không** dùng bare specifier `'miniflare'`.
 *
 * ⚠️ Repo dùng pnpm, nên `miniflare` không nằm ở `node_modules/` gốc mà nằm trong store
 * dưới dependency của `wrangler`. `import('miniflare')` sẽ **ném `ERR_MODULE_NOT_FOUND`**
 * và test âm thầm bỏ qua — tức là đúng cái xanh giả mà test này sinh ra để chặn.
 *
 * Vì vậy ta dò store pnpm (`node_modules/.pnpm`, thư mục `wrangler@...`) rồi import theo
 * đường dẫn tuyệt đối. `miniflare` là dependency **transitive** của `wrangler`
 * (devDependency), không phải cái ta thêm — nên việc dùng nó ở đây không vi phạm "không
 * thêm npm dependency".
 *
 * ⚠️ Không viết dạng `node_modules/pnpm/wrangler@` trong comment này: chuỗi `*` + `/` sẽ
 * đóng sớm block comment và làm file hỏng cú pháp (đã trải qua một lần).
 *
 * ⚠️ Kiểu ở đây là **cấu trúc tự khai**, không phải `typeof import('miniflare')`.
 * `miniflare` là dependency *transitive* của `wrangler` nằm trong store pnpm, không phải
 * dependency của project này — nên `import('miniflare')` vừa **không resolve được lúc
 * typecheck** (`TS2307`) vừa **không resolve được lúc chạy** (`ERR_MODULE_NOT_FOUND`).
 * Chỉ khai đúng hai thành phần ta dùng, và không hơn: mọi thứ khác sẽ là `unknown`.
 */
interface MiniflareInstance {
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
}

interface MiniflareLike {
  Miniflare: new (options: {
    workers: Array<{
      config: {
        name: string;
        compatibilityDate: string;
        manifest: {
          mainModule: string;
          modules: Record<string, { type: 'esm'; contents: string }>;
        };
      };
    }>;
  }) => MiniflareInstance;
}

async function loadMiniflare(): Promise<MiniflareLike | null> {
  const glob = new URL('../../../../node_modules/.pnpm/', import.meta.url);
  const storeRelative = 'wrangler@';
  const storeDir = fileURLToPath(glob);
  let candidates: string[];
  try {
    candidates = readdirSync(storeDir)
      .filter((entry: string) => entry.startsWith(storeRelative))
      .map((entry: string) => join(storeDir, entry, 'node_modules', 'miniflare'));
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    const entry = join(candidate, 'dist', 'src', 'index.js');
    if (existsSync(entry)) {
      return (await import(pathToFileURL(entry).href)) as MiniflareLike;
    }
  }
  return null;
}

/**
 * Script chạy **bên trong** worker: thử cả hai hình dạng thuật toán ECDH và báo cáo kết quả.
 *
 * ⚠️ `b64u` **không** được khai báo `async`. Nếu là `async`, giá trị trả về là
 * `Promise<Uint8Array>`; khi đó `x` và `y` trong JWK là **Promise**, không phải chuỗi
 * base64url, và workerd trả `DataError: Invalid EC key in JSON Web Key; missing "x"`.
 * Chỉ đọc `async` trên hàm bên ngoài sẽ khiến chỗ này *trông* đúng nhưng hỏng lúc chạy.
 * Đây chính là loại lỗi mà test này sinh ra để bắt — nên bản thân nó cũng phải sống sót
 * qua một lần mutation riêng.
 */
const PROBE_SCRIPT = `
function b64u(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  /* replaceAll cố tình thay cho regex: trong template literal, mọi backslash phải escape
     thêm một lần nữa, và một backslash thừa làm hỏng script theo cách rất khó đoán. */
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export default {
  async fetch() {
    const result = {};
    try {
      const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
      const pair = await crypto.subtle.generateKey(ecdh, true, ['deriveBits']);
      const peer = await crypto.subtle.generateKey(ecdh, true, ['deriveBits']);

      /* Hình dạng chuẩn W3C — đúng những gì ecdhDeriveParams sinh ra. */
      try {
        const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer.publicKey }, pair.privateKey, 256);
        result.public = 'ok:' + bits.byteLength;
      } catch (error) {
        result.public = 'ERR:' + error.name;
      }

      /* Hình dạng mà @cloudflare/workers-types khai báo. */
      try {
        const bits = await crypto.subtle.deriveBits({ name: 'ECDH', $public: peer.publicKey }, pair.privateKey, 256);
        result.dollar = 'ok:' + bits.byteLength;
      } catch (error) {
        result.dollar = 'ERR:' + error.name;
      }

      /* Các primitive còn lại mà adapter dùng, trên đúng runtime này. */
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
      try {
        const imported = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, new TextEncoder().encode('x'));
        result.ecdsaSign = 'ok:' + sig.byteLength;
      } catch (error) {
        result.ecdsaSign = 'ERR:' + error.name;
      }

      try {
        /* exportKey('raw') trả ArrayBuffer chứ không phải view: gọi .subarray */
        /* trực tiếp sẽ ném TypeError và khiến test báo sai nguyên nhân (đã trải qua một */
        /* lần: jwkEcdh đỏ vì lý do này, không phải vì JWK import hỏng). */
        /* x/y phải thuộc CÙNG key pair với d. Dùng peer.publicKey (cặp khác)
           với \`pair.privateKey\` sẽ cho DataError — JWK bắt buộc nhất quán. */
        const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        const viaJwk = await crypto.subtle.importKey(
          'jwk',
          { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)), d: privJwk.d },
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveBits'],
        );
        const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer.publicKey }, viaJwk, 256);
        result.jwkEcdh = 'ok:' + bits.byteLength;
      } catch (error) {
        result.jwkEcdh = 'ERR:' + error.name + ':' + error.message;
      }

      try {
        const aes = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', false, ['encrypt']);
        result.aesGcm = 'ok:' + (await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 }, aes, new Uint8Array([1, 2, 3]))).byteLength;
      } catch (error) {
        result.aesGcm = 'ERR:' + error.name;
      }

      try {
        const hmac = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        result.hmac = 'ok:' + (await crypto.subtle.sign('HMAC', hmac, new Uint8Array([1]))).byteLength;
      } catch (error) {
        result.hmac = 'ERR:' + error.name;
      }

      result.atob = typeof atob;
      result.btoa = typeof btoa;
      result.textEncoder = typeof TextEncoder;
    } catch (error) {
      result.fatal = error.name + ': ' + error.message;
    }
    return new Response(JSON.stringify(result));
  },
};`;

describe('Workers runtime (workerd) WebCrypto behaviour', () => {
  it('accepts the standard `public` field and rejects `$public` in deriveBits', async () => {
    const miniflare = await loadMiniflare();
    if (miniflare === null) {
      // ⚠️ Cố tình **không** `it.skip`/`return` im lặng: một lần skip âm thầm là một lần
      // xanh giả, đúng thứ file này sinh ra để chặn. Nếu không resolve được workerd thì báo
      // rõ để người đọc biết bằng chứng này **chưa** được kiểm trên máy này.
      throw new Error(
        'miniflare (workerd) not resolvable from the pnpm store — the Workers-runtime evidence in this file was NOT verified on this machine',
      );
    }

    const mf = new miniflare.Miniflare({
      workers: [
        {
          config: {
            name: 'webcrypto-probe',
            compatibilityDate: '2026-01-01',
            manifest: {
              mainModule: './probe.js',
              modules: { './probe.js': { type: 'esm', contents: PROBE_SCRIPT } },
            },
          },
        },
      ],
    });

    try {
      const response = await mf.dispatchFetch('http://webcrypto-probe/');
      const probe = (await response.json()) as Record<string, string>;

      // Không có `fatal` nghĩa là probe chạy hết, nghĩa là chính runtime này được đo.
      expect(probe.fatal).toBeUndefined();

      // ⚠️ Đây là lý do `webcrypto.ts` tồn tại: workerd **không** chấp nhận `$public`.
      expect(probe.public).toBe('ok:32');
      expect(probe.dollar).toBe('ERR:TypeError');

      // Primitive còn lại phải có đúng hình dạng adapter dựa vào.
      expect(probe.ecdsaSign).toBe('ok:64'); // JOSE raw r||s, không phải DER.
      expect(probe.jwkEcdh).toBe('ok:32'); // import EC private qua JWK để deriveBits.
      expect(probe.aesGcm).toBe('ok:19'); // 3 byte plaintext + 16 byte tag.
      expect(probe.hmac).toBe('ok:32'); // HMAC-SHA-256.
      expect(probe.atob).toBe('function');
      expect(probe.btoa).toBe('function');
      expect(probe.textEncoder).toBe('function');
    } finally {
      await mf.dispose();
    }
  });

  it('builds derive parameters workerd accepts — the same shape the adapter uses', () => {
    // Ở runtime này chỉ kiểm **shape**: `ecdhDeriveParams` phải trả object có field `public`
    // và không có `$public`. Giá trị của `public` là CryptoKey, nên ta dùng key giả có đủ
    // thuộc tính — assert ở đây là về hình dạng, runtime thật đã được đo ở test trên.
    //
    // ⚠️ Không viết `as CryptoKey`: `tsconfig.spec.json` khai báo `types: [vitest, node]`
    // mà **không** có `@cloudflare/workers-types`, nên ở file này `CryptoKey` là *value*
    // của lib DOM chứ không phải *type* → `TS2749`. Ta lấy kiểu tham số từ chính hàm
    // (`Parameters<typeof …>[0]`) để không phải đoán tên type của môi trường biên dịch.
    const fakeKey = { type: 'public' } as unknown as Parameters<typeof ecdhDeriveParams>[0];
    const params = ecdhDeriveParams(fakeKey);

    expect(params.name).toBe('ECDH');
    // `EcdhDeriveParams` khai `public` là field thật nên đọc thẳng, không cần ép.
    expect(params.public).toBe(fakeKey);
    // `$public` không có trong kiểu trả về → phải kiểm bằng `Object.hasOwn`, và đây là
    // assertion *chống hồi quy*: nếu ai đó đổi lại sang `$public` thì nó phải đỏ.
    expect(Object.hasOwn(params, '$public')).toBe(false);
  });
});
