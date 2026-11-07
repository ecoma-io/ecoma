import { describe, expect, it, vi } from 'vitest';

import {
  assertKid,
  assertNonceExpirySeconds,
  canonicalString,
  createNonce,
  DEFAULT_SKEW_SECONDS,
  hashBody,
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_KID_HEADER,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  InvalidCanonicalFieldError,
  InvalidKidError,
  isValidNonceExpirySeconds,
  isStrongNonce,
  MAX_NONCE_EXPIRY_EPOCH_SECONDS,
  MAX_SKEW_SECONDS,
  MIN_SKEW_SECONDS,
  NONCE_TTL_BUFFER_SECONDS,
  resolveSkewSeconds,
  signRequest,
  timingSafeEqualHex,
  verifyRequest,
  type VerifyResult,
} from './internal-auth';

const SECRET = 'shared-internal-secret-for-test-only';
const OTHER_SECRET = 'a-different-secret';
/** Khoá thứ hai — đại diện cho khoá MỚI sau khi xoay secret. */
const ROTATED_SECRET = 'the-rotated-internal-secret-for-test-only';
/** `kid` hợp lệ: 8 hex chữ thường. */
const KID = '0123abcd';
const TIMESTAMP = '1700000000';
const NONCE = '9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607';
const PATH = '/internal/session/verified';

/**
 * Encode chuỗi → byte UTF-8.
 *
 * Cần thiết vì `hashBody`/`signRequest`/`verifyRequest` nhận `Uint8Array`, không nhận
 * `string` — đó là toàn bộ điểm của F-01: không tồn tại một đường "ký chuỗi" để call site
 * vỡ dùng nhầm rồi lệch với phía bên kia.
 */
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const BODY = bytes(JSON.stringify({ handle: 'h', sub: 's' }));

/**
 * Canonicalization của `main` TRƯỚC PR này: không có dòng `PROTOCOL_ID`, length prefix
 * theo `.length` (UTF-16) chứ không theo byte UTF-8. Dùng để chứng minh verifier không
 * dual-accept bản cũ.
 */
function legacyCanonical(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return [
    method.toLowerCase(),
    `${path.length}:${path}`,
    timestamp,
    `${nonce.length}:${nonce}`,
    bodyHash,
  ].join('\n');
}

/** HMAC-SHA-256 hex, tính độc lập với `signCanonical` để chữ ký không do chính lib sinh. */
async function hmacHex(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function headersOf(result: Record<string, string>): Record<string, string> {
  return result;
}

/**
 * Bắt lỗi đồng bộ để assert trên chính object lỗi.
 *
 * `expect(() => fn()).toThrow(SomeError)` chỉ khẳng định được **loại**; nhiều bất biến ở
 * đây nói về `message` và về trường `field` của {@link InvalidCanonicalFieldError} — cụ
 * thể là chúng **không** được chứa giá trị đầu vào (cùng nguyên tắc với F-07: thông báo
 * lỗi đi thẳng vào log).
 */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('mong doi ham nem loi, nhung no khong nem');
}

/** Verify với default hợp lệ; override để test từng nhánh lỗi. */
async function verify(
  overrides: Partial<Parameters<typeof verifyRequest>[0]> = {},
): Promise<VerifyResult> {
  const headers = await signRequest({
    method: 'POST',
    path: PATH,
    body: BODY,
    secret: SECRET,
    timestamp: TIMESTAMP,
    nonce: NONCE,
  });
  // `SECRET` ở đây là hằng literal khai trong chính file test này
  // (`'shared-internal-secret-for-test-only'`), không phải credential thật và
  // không đọc từ biến môi trường nào. Giá trị đó là ĐẦU VÀO của HMAC, được
  // `verifyRequest` dùng để tính chữ ký rồi so sánh — nó không bao giờ được
  // trả ra ngoài, và `VerifyResult` chỉ mang `reason`, không mang key.
  return verifyRequest({
    method: 'POST',
    path: PATH,
    body: BODY,
    headers: headersOf(headers),
    secret: SECRET,
    now: TIMESTAMP,
    skewSeconds: 300,
    claimNonce: () => false,
    ...overrides,
  });
}

describe('canonicalString', () => {
  it('produces the documented length-prefixed format', () => {
    const hash = 'f'.repeat(64);
    // Dạng canonical: method hạ chữ thường, prefix giao thức, rồi path / timestamp /
    // nonce đều có length prefix, cuối cùng là body hash độ dài cố định.
    expect(canonicalString('GET', '/a', '1', 'nn', hash)).toBe(
      `get\necoma-internal-v2\n2:/a\n1:1\n2:nn\n${hash}\nactor-absent`,
    );
  });

  it('lowercases the method', () => {
    const hash = 'f'.repeat(64);
    expect(canonicalString('POST', '/a', '1', 'n', hash)).toBe(
      canonicalString('post', '/a', '1', 'n', hash),
    );
  });

  it('is deterministic', () => {
    const args = ['GET', '/a', '1', 'n', 'f'.repeat(64)] as const;
    expect(canonicalString(...args)).toBe(canonicalString(...args));
  });

  it('cannot collide when a boundary shifts between path and nonce', () => {
    // Nếu path và nonce chỉ được nối bằng separator, ("a/b","c") và ("a","b/c")
    // là hai cách chia khác nhau của cùng một chuỗi byte.
    expect(canonicalString('GET', 'a/b', '1', 'n', 'h')).not.toBe(
      canonicalString('GET', 'a', 'b/1', 'n', 'h'),
    );
  });

  it('cannot collide when the component LENGTHS are equal but boundaries shift', () => {
    // Trường hợp nguy hiểm hơn: "ab"/"c" và "a"/"bc" cùng dài 2, nên bất kỳ định dạng
    // nào chỉ so độ dài tổng cũng không cứu được.
    expect(canonicalString('GET', 'ab', '1', 'c', 'h')).not.toBe(
      canonicalString('GET', 'a', '1', 'bc', 'h'),
    );
  });

  it('cannot collide when a newline inside a component mimics a separator', () => {
    // Va chạm thật sự của bản chỉ-nối-bằng-separator:
    //   ("a\nb","c")  ->  get\na\nb\nc
    //   ("a","b\nc")  ->  get\na\nb\nc
    // Length-prefix phá nó vì độ dài được khai báo tường minh.
    expect(canonicalString('GET', 'a\nb', 'c', 'n', 'h')).not.toBe(
      canonicalString('GET', 'a', 'b\nc', 'n', 'h'),
    );
  });

  it('separates timestamp from nonce', () => {
    expect(canonicalString('GET', '/a', '1', '2', 'h')).not.toBe(
      canonicalString('GET', '/a', '12', '', 'h'),
    );
  });

  it('changes when any single component changes', () => {
    const hash = 'f'.repeat(64);
    const baseline = canonicalString('GET', '/a', '1', 'n', hash);
    expect(canonicalString('POST', '/a', '1', 'n', hash)).not.toBe(baseline);
    expect(canonicalString('GET', '/b', '1', 'n', hash)).not.toBe(baseline);
    expect(canonicalString('GET', '/a', '2', 'n', hash)).not.toBe(baseline);
    expect(canonicalString('GET', '/a', '1', 'm', hash)).not.toBe(baseline);
    expect(canonicalString('GET', '/a', '1', 'n', `${hash}f`)).not.toBe(baseline);
  });
});

describe('hashBody', () => {
  it('matches the known SHA-256 of the empty string', async () => {
    await expect(hashBody(bytes(''))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known SHA-256 of "abc"', async () => {
    await expect(hashBody(bytes('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('treats null and undefined the same as an empty body', async () => {
    const empty = await hashBody(bytes(''));
    await expect(hashBody(null)).resolves.toBe(empty);
    await expect(hashBody(undefined)).resolves.toBe(empty);
  });

  it('returns lowercase hex of a fixed width', async () => {
    const hash = await hashBody(BODY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('distinguishes different bodies', async () => {
    expect(await hashBody(bytes('{"a":1}'))).not.toBe(await hashBody(bytes('{"a":2}')));
  });

  it('hashes the bytes it was given, without re-encoding them as a string', async () => {
    // "é" là 2 byte UTF-8; băm từng code unit (hoặc encode lại từ một chuỗi đã decode)
    // cho hash khác.
    expect(await hashBody(bytes('é'))).not.toBe(await hashBody(bytes('e')));
  });

  it('distinguishes byte sequences that decode to the SAME string', async () => {
    // ⚠️ Đây là bất biến trung tâm của F-01, và là lý do hàm này nhận byte.
    //
    // `0xff` không phải UTF-8 hợp lệ. `TextDecoder` non-fatal biến nó thành U+FFFD, nên
    // nếu lib decode trước khi băm — như cả hai call site từng làm — thì hai payload
    // **khác nhau trên dây** cho cùng một hash, cùng một chữ ký, và verifier chấp nhận
    // một payload mà phía ký chưa từng thấy. Một bản cài đặt quay lại nhận `string` sẽ
    // làm test này đỏ ngay (nó không biên dịch được), và một bản "decode rồi encode lại"
    // bên trong `hashBody` cũng đỏ (hai hash bằng nhau).
    const invalidUtf8 = new Uint8Array([0x61, 0xff, 0x62]);
    const literalReplacement = bytes('a�b');
    expect(new TextDecoder().decode(invalidUtf8)).toBe('a�b');
    expect(await hashBody(invalidUtf8)).not.toBe(await hashBody(literalReplacement));
  });

  it('treats the same bytes as equal regardless of the buffer that holds them', async () => {
    // `Buffer` là view trên một `ArrayBuffer` dùng chung với offset riêng. Hai view khác
    // offset/`byteOffset` nhưng cùng nội dung phải cho cùng hash — nếu không, một call
    // site truyền `Buffer` và một call site truyền `Uint8Array` sẽ lệch nhau.
    const backing = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00]);
    const sliced = backing.subarray(1, 4);
    expect(sliced.byteOffset).not.toBe(0);
    expect(await hashBody(sliced)).toBe(await hashBody(bytes('abc')));
  });
});

describe('timingSafeEqualHex', () => {
  it('accepts identical hex', () => {
    expect(timingSafeEqualHex('00ff', '00ff')).toBe(true);
  });

  it('rejects a difference in one byte', () => {
    expect(timingSafeEqualHex('00ff', '00fe')).toBe(false);
  });

  it('rejects a difference in the first byte', () => {
    expect(timingSafeEqualHex('00ff', '01ff')).toBe(false);
  });

  it('rejects different lengths', () => {
    expect(timingSafeEqualHex('00ff', '00ff00')).toBe(false);
  });

  it('rejects non-hex input', () => {
    expect(timingSafeEqualHex('zz', 'zz')).toBe(false);
    expect(timingSafeEqualHex('00FF', '00FF')).toBe(false);
  });

  it('accepts two empty strings as trivially equal', () => {
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});

describe('isStrongNonce', () => {
  it('accepts a randomUUID (128 bits)', () => {
    expect(isStrongNonce(createNonce())).toBe(true);
  });

  it('accepts every UUID v4 in a 5000-sample randomUUID loop', () => {
    // Heuristic distinct-char cũ (trước S4) từ chối khoảng 0.16% UUID v4 hợp lệ:
    // UUID thật qua ít ký tự phân biệt vẫn đủ entropy thực nhưng thiếu ngưỡng ước
    // lượng. Format check phải không còn từ chối UUID nào; mẫu 5000 để reset test
    // này về đỏ nếu heuristic nguyên trạng quay lại. Dùng `crypto.randomUUID` toàn
    // cục vì `libs/**` cấm `node:crypto`.
    const rejected = Array.from({ length: 5000 }, () => crypto.randomUUID()).filter(
      (nonce) => !isStrongNonce(nonce),
    );
    expect(rejected).toEqual([]);
  });

  it('accepts an uppercase UUID v4', () => {
    expect(isStrongNonce('01234567-89AB-4CDE-8F01-23456789ABCD')).toBe(true);
  });

  it('accepts hex at full length', () => {
    expect(isStrongNonce('0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it.each([
    ['all zeros', '00000000000000000000000000000000'],
    ['single repeated char', 'aaaaaaaaaaaaaaaa'],
    ['short', 'abc123'],
    ['empty', ''],
    ['sequential counter', '00000000000000000000000000000001'],
  ])('rejects a low-entropy nonce: %s', (_label, nonce) => {
    expect(isStrongNonce(nonce)).toBe(false);
  });

  it('rejects a nonce one character over the cap even when its entropy would pass', () => {
    // ⚠️ Chuỗi này **đủ** entropy theo heuristic (`log2(distinct) * length ≫ 128`), nên
    // nó chỉ bị từ chối vì trần độ dài. Không có ca này thì việc bỏ trần sẽ không làm
    // test nào đỏ: mọi mẫu quá dài khác đều yếu vì lý do entropy.
    const overCap = '0123456789abcdef'.repeat(9);
    expect(overCap.length).toBeGreaterThan(128);
    expect(isStrongNonce(overCap)).toBe(false);
    expect(isStrongNonce(overCap.slice(0, 128))).toBe(true);
  });

  it.each([
    ['wrong version nibble', '00000000-0000-3000-8000-000000000000'],
    ['wrong variant nibble', '00000000-0000-4000-c000-000000000000'],
    ['non-hex char inside the shape', '00000000-0000-4000-8000-gggggggggggg'],
  ])('rejects a UUID-shaped nonce with %s', (_label, nonce) => {
    // Dùng mẫu yếu có chủ ý: nếu UUID này còn đủ distinct-char thì heuristic (không
    // phải lớp format) sẽ chấp nhận nó, và test này sẽ không đo được lớp format check.
    expect(isStrongNonce(nonce)).toBe(false);
  });
});

describe('createNonce', () => {
  it('produces distinct values', () => {
    const values = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(values.size).toBe(50);
  });

  it('produces values verify accepts as strong', () => {
    expect(isStrongNonce(createNonce())).toBe(true);
  });
});

describe('hashBody — a non-byte body is refused, not silently hashed as empty', () => {
  it('throws when a string is passed where bytes are required', async () => {
    // ⚠️ Ca này ghim một lỗi thật đã xảy ra: một spec truyền `body: '{"handle":"Y"}'` trực
    // tiếp. Ở TypeScript đó là lỗi kiểu, nhưng spec của một facade identity-contracts cũ
    // không nằm
    // trong tsconfig nào nên nó lọt; lúc chạy `new Uint8Array('<chuỗi>')` cho ra mảng RỖNG,
    // nên hai phía cùng băm thân rỗng và ca interop xanh mà không kiểm gì. Ném là fail-closed:
    // không có chữ ký nào được sinh ra trên một thân khác với thân được truyền vào.
    await expect(hashBody('not-bytes' as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });

  it('refuses a plain object that only claims to be a Uint8Array', async () => {
    // Chỉ `Object.prototype.toString` là không đủ: object phẳng gắn `Symbol.toStringTag`
    // giả được. `new Uint8Array(<object phẳng>)` khi đó coi nó như array-like không
    // `length` ⇒ mảng RỖNG, tức lại đúng cái bẫy băm-rỗng mà guard này tồn tại để chặn.
    const impostor = { [Symbol.toStringTag]: 'Uint8Array' } as unknown as Uint8Array;
    await expect(hashBody(impostor)).rejects.toThrow(TypeError);
  });

  it('refuses other typed-array views of the same buffer', async () => {
    // `ArrayBuffer.isView` một mình cũng không đủ: một `Uint16Array` là view hợp lệ nhưng
    // **không** phải chuỗi byte của thân request. Nhận nó là ngầm định lại cách diễn giải
    // byte của caller, đúng thứ F-01 cấm.
    await expect(hashBody(new Uint16Array(2) as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });

  it('still accepts null and undefined as the empty body', async () => {
    // Vế còn lại của bất biến: chặn chuỗi **không** được biến thành chặn luôn thân rỗng.
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    await expect(hashBody(null)).resolves.toBe(empty);
    await expect(hashBody(undefined)).resolves.toBe(empty);
    await expect(hashBody(new Uint8Array())).resolves.toBe(empty);
  });
});

describe('signRequest', () => {
  it('emits the three documented headers', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    // So bằng membership chứ không sort: `unicorn/no-array-sort` cấm `sort()` còn
    // `lib` của tsconfig.base là es2022 nên không có `toSorted()`.
    const keys = Object.keys(headers);
    expect(keys).toHaveLength(3);
    expect(keys).toContain(INTERNAL_NONCE_HEADER);
    expect(keys).toContain(INTERNAL_SIGNATURE_HEADER);
    expect(keys).toContain(INTERNAL_TIMESTAMP_HEADER);
    expect(headers[INTERNAL_TIMESTAMP_HEADER]).toBe(TIMESTAMP);
    expect(headers[INTERNAL_NONCE_HEADER]).toBe(NONCE);
  });

  it('formats the signature as v1=<hex>', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    expect(headers[INTERNAL_SIGNATURE_HEADER]).toMatch(/^v1=[0-9a-f]{64}$/u);
  });

  it('is deterministic for the same inputs', async () => {
    const args = {
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    };
    expect(await signRequest(args)).toEqual(await signRequest(args));
  });

  it('generates a nonce when none is supplied', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: bytes(SECRET),
      secret: SECRET,
      timestamp: TIMESTAMP,
    });
    expect(isStrongNonce(headers[INTERNAL_NONCE_HEADER] ?? '')).toBe(true);
  });
});

describe('verifyRequest — accept', () => {
  it('verifies a correctly signed request', async () => {
    const result = await verify();
    expect(result).toMatchObject({ ok: true, nonce: NONCE, timestamp: TIMESTAMP });
  });

  it('accepts headers supplied with different casing', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const shouty = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]),
    );
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: shouty,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a bodyless request signed with an empty body', async () => {
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'GET',
      path: '/internal/account/status',
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyRequest — reject', () => {
  it('rejects a wrong secret as bad_signature', async () => {
    const result = await verify({ secret: OTHER_SECRET });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered body as bad_signature', async () => {
    const result = await verify({ body: bytes(JSON.stringify({ handle: 'h', sub: 'TAMPERED' })) });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a swapped path as bad_signature', async () => {
    const result = await verify({ path: '/internal/account/status' });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a swapped method as bad_signature', async () => {
    const result = await verify({ method: 'GET' });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered query string as bad_signature', async () => {
    // ⚠️ §"Chữ ký phủ path nguyên văn, kể cả query string". Đổi MỘT tham số query —
    // cùng method, cùng path, cùng body — phải lệch chữ ký. Nếu một bản cài đặt lỡ
    // tách query ra khỏi phần được ký thì test này đỏ, còn mọi test ký/verify nội bộ
    // với cùng một path vẫn xanh.
    const signed = '/internal/account/status?sub=sub_01H';
    const tampered = '/internal/account/status?sub=sub_VICTIM';
    const headers = await signRequest({
      method: 'GET',
      path: signed,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'GET',
      path: tampered,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('distinguishes a raw query from its percent-encoded form', async () => {
    // ⚠️ Không có bước "chuẩn hoá query" nào trong giao thức, và đó là chủ ý: mỗi phía
    // tự nghĩ ra một quy tắc chuẩn hoá là cách hai bên lệch nhau im lặng. Verifier ký
    // lại **đúng chuỗi nó nhận**, nên `?q=a b` và `?q=a%20b` là hai chuỗi khác nhau,
    // hash ra chữ ký khác nhau, và không cái nào tự động khớp cái kia.
    const raw = '/internal/account/status?note=a b';
    const encoded = '/internal/account/status?note=a%20b';
    const headers = await signRequest({
      method: 'GET',
      path: raw,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'GET',
      path: encoded,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered timestamp inside the skew window as bad_signature', async () => {
    // Timestamp phải nằm trong header VÀ trong chuỗi ký: sửa riêng header thì lệch chữ ký.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const tampered = { ...headers, [INTERNAL_TIMESTAMP_HEADER]: '1700000060' };
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: tampered,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['timestamp', INTERNAL_TIMESTAMP_HEADER],
    ['nonce', INTERNAL_NONCE_HEADER],
    ['signature', INTERNAL_SIGNATURE_HEADER],
  ])('rejects a missing %s header as missing_header', async (_label, header) => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const partial = { ...headers };
    Reflect.deleteProperty(partial, header);
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: partial,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects an empty header value as missing_header', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_NONCE_HEADER]: '' },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a null header value as missing_header', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_SIGNATURE_HEADER]: null },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects completely absent headers as missing_header', async () => {
    const result = await verify({ headers: {} });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it.each([
    ['far in the past', '1699999000'],
    ['far in the future', '1700003600'],
  ])('rejects a timestamp %s as bad_timestamp', async (_label, timestamp) => {
    const result = await verify({ now: timestamp });
    expect(result).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('accepts a timestamp exactly at the skew boundary', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: '1700000300',
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects one second past the skew boundary', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: '1700000301',
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it.each([
    ['non-numeric', 'not-a-number'],
    ['fractional', '1700000000.5'],
    ['negative', '-1700000000'],
    ['empty-ish', ' 1700000000'],
    ['hex-like', '0x6553d100'],
  ])('rejects a %s timestamp as bad_timestamp', async (_label, timestamp) => {
    const result = await verify({ now: timestamp });
    expect(result).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects an already-claimed nonce as replayed_nonce', async () => {
    const result = await verify({ claimNonce: () => true });
    expect(result).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('rejects a replayed nonce even when the signature is perfectly valid', async () => {
    // Replay đúng chữ ký là tấn công kinh điển: cùng envelope, gửi lại lần hai.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const claimed = new Set<string>();
    const args = {
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: (n: string) => {
        if (claimed.has(n)) return true;
        claimed.add(n);
        return false;
      },
    };
    expect((await verifyRequest(args)).ok).toBe(true);
    expect(await verifyRequest(args)).toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('rejects a weak nonce as weak_nonce', async () => {
    // Nonce yếu là lớp lỗi của nonce: nó không chứng minh được tính duy nhất. Trước
    // S4 nó bị gán nhầm `replayed_nonce` khiến operator đi săn replay không tồn tại.
    const weakNonce = 'aaaa';
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: weakNonce,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'weak_nonce' });
  });

  it.each([
    ['missing v1 prefix', 'deadbeef'],
    ['wrong version', 'v2=00ff'],
    ['non-hex payload', 'v1=zzzz'],
    ['empty payload', 'v1='],
  ])('rejects a signature with %s', async (_label, signature) => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_SIGNATURE_HEADER]: signature },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('fails closed when the caller nonce store itself throws', async () => {
    await expect(
      verify({ claimNonce: () => Promise.reject(new Error('store down')) }),
    ).rejects.toThrow('store down');
  });
});

describe('F-05 — the protocol version is PROTOCOL_ID, not the `v1=` prefix', () => {
  /**
   * Hai namespace version khác nhau, và bài kiểm này là chỗ chúng không được nhập nhằng:
   *
   * * `PROTOCOL_ID` (`'ecoma-internal-v2'`) nằm **trong** chuỗi được ký — nó neo
   *   canonicalization. Đổi nó (hoặc đổi bất cứ thành phần nào của chuỗi canonical) là
   *   đổi giao thức.
   * * `v1=` là version của **định dạng chữ ký** trong header, không nằm trong chuỗi được
   *   ký. Canonicalization đổi mà chữ ký vẫn hex trong một header thì tiền tố này giữ
   *   nguyên — nên **không** được dùng nó làm dấu hiệu "envelope này thuộc phiên bản nào".
   *
   * PR hợp nhất này đổi canonicalization (thêm dòng `PROTOCOL_ID`, đổi length prefix từ
   * UTF-16 sang byte UTF-8). Vì `PROTOCOL_ID` nằm trong chuỗi ký, envelope của bản cũ
   * KHÔNG thể verify được bằng bản mới — đúng điều dưới đây khẳng định. Không có
   * dual-accept: hai Worker phải deploy cùng phiên bản giao thức.
   */

  it("rejects an envelope signed with main's legacy canonicalization", async () => {
    // Cùng secret, cùng method/path/timestamp/nonce/body — chỉ khác canonicalization.
    // Nếu verifier chấp nhận nó thì đã có dual-accept ngầm, và một bên cũ vẫn có thể
    // gửi envelope mà bên mới không phân biệt được.
    const legacy = legacyCanonical('POST', PATH, TIMESTAMP, NONCE, await hashBody(BODY));
    const signature = await hmacHex(SECRET, legacy);

    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: {
        [INTERNAL_TIMESTAMP_HEADER]: TIMESTAMP,
        [INTERNAL_NONCE_HEADER]: NONCE,
        [INTERNAL_SIGNATURE_HEADER]: `v1=${signature}`,
      },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });

    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unknown signature-format prefix even with a valid HMAC payload', async () => {
    // Cùng payload hex hợp lệ, chỉ đổi tiền tố định dạng. Verifier phải từ chối thay vì
    // bỏ qua tiền tố — nếu không, tiền tố trở thành vô nghĩa và "version" biến mất khỏi
    // dây.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const sig = headers[INTERNAL_SIGNATURE_HEADER];
    if (sig == null) {
      throw new Error('missing signature header');
    }
    const payload = sig.slice('v1='.length);

    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_SIGNATURE_HEADER]: `v2=${payload}` },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('NONCE_TTL_BUFFER_SECONDS — protocol constant, not a knob', () => {
  it('is positive, so the computed expiry outlives the replay window', () => {
    // Nonce chỉ cần sống tới `timestamp + skew`; sau đó envelope bị từ chối vì
    // `bad_timestamp`. Buffer được cộng **lên trên** skew ở mọi phía gọi
    // (`timestamp + skew + buffer`), nên bất biến là `buffer > 0` — hạn dùng luôn vượt
    // cửa sổ theo cấu trúc. Assert `buffer > skew` sẽ sai: buffer là biên cho prune chạy
    // theo lô, không phải một cửa sổ thứ hai.
    expect(NONCE_TTL_BUFFER_SECONDS).toBeGreaterThan(0);
  });

  it('is duplicated verbatim in the account migration layer', async () => {
    // `apps/account/db/migrate.mts` không import được lib này (script Node đọc `node:fs`;
    // import sẽ kéo `node:fs` vào bundle Worker). Bản lặp là cố ý và được canh bằng cách
    // đọc nguồn — hai lần nhập luôn khớp còn hai bản chép tay thì không.
    //
    // ⚠️ Đường dẫn neo theo **gốc workspace**, không theo cwd. `readFileSync` giải đường
    // dẫn tương đối theo cwd, mà `nx run <project>:test` đặt cwd ở thư mục project
    // trong khi chạy tay từ gốc repo lại xanh — đúng kiểu lỗi
    // chỉ đỏ trên CI. `import.meta.dirname` cũng không dùng được ở đây:
    // `tsconfig.spec.json` của project này là `module: nodenext` và `package.json` không
    // khai `"type": "module"`, nên file bị coi là CommonJS và TS báo TS1470.
    const { existsSync, readFileSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');

    function workspaceRoot(): string {
      let dir = resolve(process.cwd());
      for (;;) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
          return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
          throw new Error('khong tim thay goc workspace (pnpm-workspace.yaml)');
        }
        dir = parent;
      }
    }

    const src = readFileSync(join(workspaceRoot(), 'apps/account/db/migrate.mts'), 'utf8');
    const match = /INTERNAL_NONCE_BUFFER_SECONDS\s*=\s*(\d+)/u.exec(src);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(NONCE_TTL_BUFFER_SECONDS);
  });
});

describe('INTERNAL_BODY_LIMIT_BYTES — one shared bound for both sides', () => {
  it('is 64 KiB, the value documented in the envelope contract', () => {
    expect(INTERNAL_BODY_LIMIT_BYTES).toBe(64 * 1024);
  });

  it('is imported, not re-declared, by both sides of the contract', async () => {
    // ⚠️ Đây là test canh **nguồn**, không phải canh hành vi, và nó tồn tại vì lý do cụ
    // thể: bản trước của PR này có **hai** hằng 64 KiB độc lập (`apps/auth/src/main.ts`
    // tự khai, middleware `account` tự khai). Hai bản chép tay trôi khỏi nhau trong im
    // lặng — một bên nâng hạn mức thì bên kia vẫn ký/kiểm theo ngưỡng cũ, và không test
    // nào đỏ. Cách sửa là **một** nguồn: cả hai import từ lib này.
    const { existsSync, readFileSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');

    function workspaceRoot(): string {
      let dir = resolve(process.cwd());
      for (;;) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
          return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
          throw new Error('khong tim thay goc workspace (pnpm-workspace.yaml)');
        }
        dir = parent;
      }
    }

    const root = workspaceRoot();
    const files = ['apps/auth/src/main.ts', 'apps/account/server/middleware/internal-auth.ts'];
    for (const relative of files) {
      const src = readFileSync(join(root, relative), 'utf8');
      expect(src).toContain('INTERNAL_BODY_LIMIT_BYTES');
      // Cả `auth` lẫn `account` import thẳng từ lib canonical (`@ecoma-io/auth-contracts`
      // và `@ecoma-io/internal-auth-contracts` — không còn facade identity nào sau issue
      // #324) — cả hai đều là đường tới **một** hằng số.
      expect(src).toMatch(/@ecoma-io\/(?:auth|internal-auth)-contracts/u);
      // Không có literal 64 KiB nào sống lại trong file: nếu có, nó là bản sao thứ hai.
      expect(src).not.toMatch(/64\s*\*\s*1024/u);
    }
  });
});

describe('resolveSkewSeconds: one number, two sides that cannot drift apart', () => {
  it('keeps every accepted skew unchanged, and pins both bounds to the protocol constants', () => {
    expect(resolveSkewSeconds(MIN_SKEW_SECONDS)).toBe(MIN_SKEW_SECONDS);
    expect(resolveSkewSeconds(DEFAULT_SKEW_SECONDS)).toBe(DEFAULT_SKEW_SECONDS);
    expect(resolveSkewSeconds(MAX_SKEW_SECONDS)).toBe(MAX_SKEW_SECONDS);
  });

  it('treats 0 and anything above the cap as misconfiguration, not as a tighter window', () => {
    // `0` KHÔNG phải "cửa sổ chặt nhất" mà là một cửa sổ không dùng được: `now` phía nhận
    // và `timestamp` phía gọi là hai lần đọc đồng hồ khác nhau, nên `|now − timestamp|` gần
    // như luôn ≥ 1 và cửa sổ `0` từ chối gần như mọi envelope hợp lệ — một Worker Secret gõ
    // sai biến kênh nội bộ thành chết thay vì thành lỗi cấu hình. Vì vậy cả `auth` và
    // `account` từ chối nó **lúc khởi động** (`apps/auth/src/config.spec.ts`,
    // `apps/account/server/utils/config-validation.spec.ts`), và ở đây nó rơi về mặc định
    // như mọi giá trị không dùng được khác — đúng chiều fail-loose đã ghi ở JSDoc.
    for (const unusable of [0, MAX_SKEW_SECONDS + 1, 86400]) {
      expect(resolveSkewSeconds(unusable)).toBe(DEFAULT_SKEW_SECONDS);
    }
  });

  it('falls back to DEFAULT_SKEW_SECONDS for every unusable value', () => {
    // ⚠️ Đây là fail-**loose** ở đúng một chiều, và test ghi lại chiều đó thay vì để
    // người đọc sau tưởng nhầm là "siết". `Math.abs(a - b) > NaN` là `false` ⇒ cửa sổ
    // timestamp bị tắt **im lặng**; `Infinity` cũng tắt (mọi hiệu đều `<=` nó); skew âm
    // thì từ chối mọi request hợp lệ. Cả ba đều tệ hơn 300 giây, nên 300 là điểm rơi.
    for (const bad of [NaN, Infinity, -Infinity, -1, -300]) {
      expect(resolveSkewSeconds(bad)).toBe(DEFAULT_SKEW_SECONDS);
    }
  });

  it('a non-number value (JSON or env) also falls back to the default', () => {
    // Kiểu khai là `number | undefined` nhưng giá trị tới từ env/JSON ở call site, nên
    // nhánh `typeof` này là nhánh chạy thật chứ không phải code phòng xa.
    expect(resolveSkewSeconds(undefined)).toBe(DEFAULT_SKEW_SECONDS);
    for (const bad of ['300', '', null, {}, []]) {
      expect(resolveSkewSeconds(bad as unknown as number)).toBe(DEFAULT_SKEW_SECONDS);
    }
  });

  it('the TTL derived from it is never shorter than the replay window', () => {
    // Bất biến mà `resolveSkewSeconds` được export để bảo vệ: call site tính
    // `timestamp + skew + buffer` cho `expires_at`, và nếu con số đó **nhỏ hơn** cửa sổ
    // mà `verifyRequest` dùng thì prune xoá được một nonce còn phát lại được — replay
    // guard mở lại. Neo hai đầu vào cùng một hàm thì bất đẳng thức là hiển nhiên.
    for (const input of [undefined, NaN, -1, 0, 60, DEFAULT_SKEW_SECONDS, 3600]) {
      const skew = resolveSkewSeconds(input);
      expect(skew + NONCE_TTL_BUFFER_SECONDS).toBeGreaterThan(skew);
    }
  });
});

describe('canonicalString — lone surrogates are rejected, not silently normalized', () => {
  /**
   * ⚠️ Bất biến của F-06: `TextEncoder` thay lone surrogate bằng U+FFFD, nên nếu hàm này
   * chỉ encode rồi nối chuỗi thì `"/a\uD800"` và `"/a�"` cho ra **cùng** chuỗi byte
   * — tức canonical hoá không đơn ánh, và hai input khác nhau dùng chung một chữ ký.
   * Sửa bằng cách cập nhật JSDoc để "hợp thức hoá va chạm" là sai; cách đúng là **siết
   * đầu vào**: từ chối trường chứa surrogate lẻ trước khi dựng chuỗi.
   */

  const hash = 'f'.repeat(64);

  it('rejects a lone high surrogate in the path', () => {
    expect(() => canonicalString('GET', '/a\uD800', '1', 'n', hash)).toThrow(
      InvalidCanonicalFieldError,
    );
  });

  it('rejects a lone low surrogate in the path', () => {
    expect(() => canonicalString('GET', '/a\uDC00', '1', 'n', hash)).toThrow(
      InvalidCanonicalFieldError,
    );
  });

  it('rejects a lone surrogate in each canonical field, not only the path', () => {
    // A field-by-field sweep: một bản cài đặt chỉ kiểm `path` sẽ đỏ ở đây. Nếu thiếu
    // vòng lặp này thì việc bỏ kiểm một trường không làm test nào đỏ.
    expect(() => canonicalString('GET\uD800', '/a', '1', 'n', hash)).toThrow(
      InvalidCanonicalFieldError,
    );
    expect(() => canonicalString('GET', '/a', '1\uD800', 'n', hash)).toThrow(
      InvalidCanonicalFieldError,
    );
    expect(() => canonicalString('GET', '/a', '1', 'n\uD800', hash)).toThrow(
      InvalidCanonicalFieldError,
    );
  });

  it('names the offending field in the error', () => {
    // `field` là phần duy nhất của lỗi này ra tới log phía server (qua `reason:
    // invalid_field`); nó không được chứa giá trị, chỉ được chứa tên trường.
    const error = catchError(() => canonicalString('GET', '/a\uD800', '1', 'n', hash));
    expect(error).toBeInstanceOf(InvalidCanonicalFieldError);
    expect((error as InvalidCanonicalFieldError).field).toBe('path');
    expect((error as Error).message).not.toContain('/a\uD800');
  });

  it('ACCEPTS a correctly paired surrogate pair (real astral characters)', () => {
    // Mặt đối: siết quá tay thành "cấm mọi surrogate" sẽ từ chối emoji và mọi ký tự
    // ngoài BMP — tức phá tính năng, không phải tăng an toàn. Kiểm bằng một path có
    // emoji (surrogate pair hợp lệ) và một U+FFFD viết thẳng (thay thế thật, không phải
    // kết quả của va chạm).
    const emoji = '/internal/account/ghi-chu/\u{1F600}';
    expect(() => canonicalString('GET', emoji, '1', 'n', hash)).not.toThrow();
    expect(() => canonicalString('GET', '/a�', '1', 'n', hash)).not.toThrow();
  });

  it('distinguishes a lone surrogate from a real U+FFFD by REFUSING the former', () => {
    // Đây là phép kiểm đóng đúng lỗ hổng: hai chuỗi này encode ra cùng byte, nên một
    // canonical "đơn ánh" phải khiến chúng KHÔNG cùng đi qua. Vế thứ hai đi qua bình
    // thường (U+FFFD hợp lệ), vế thứ nhất ném lỗi — nên không tồn tại cặp input nào
    // dùng chung chữ ký.
    expect(new TextEncoder().encode('/a\uD800')).toEqual(new TextEncoder().encode('/a�'));
    expect(() => canonicalString('GET', '/a\uD800', '1', 'n', hash)).toThrow(
      InvalidCanonicalFieldError,
    );
    expect(canonicalString('GET', '/a�', '1', 'n', hash)).toContain(
      `${new TextEncoder().encode('/a�').length}:/a�`,
    );
  });

  it('does not let a surrogate-bearing path share a signature with its replacement form', async () => {
    // Kiểm ở tầng envelope, không chỉ ở tầng hàm dựng chuỗi. Bản trước (không kiểm) sẽ
    // ký được cả hai và ra cùng chữ ký; bản này từ chối vế surrogate với `invalid_field`.
    const lone = '/internal/account/ghi-chu/\uD800';
    const html = '/internal/account/ghi-chu/\u{1F600}';
    const headers = await signRequest({
      method: 'GET',
      path: html,
      body: bytes(''),
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    // Không ký được với path chứa surrogate lẻ — lỗi ném ngay tại `signRequest`.
    await expect(
      signRequest({
        method: 'GET',
        path: lone,
        body: bytes(''),
        secret: SECRET,
        timestamp: TIMESTAMP,
        nonce: NONCE,
      }),
    ).rejects.toBeInstanceOf(InvalidCanonicalFieldError);

    const result = await verifyRequest({
      method: 'GET',
      path: lone,
      body: bytes(''),
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_field' });
  });

  it('never consults the nonce store for an invalid_field rejection', async () => {
    // `invalid_field` là một từ chối **trước** khi chữ ký được chứng minh, nên nó không
    // được ghi vào kho nonce: người gọi chưa xác thực không có quyền chạm kho.
    const claimNonce = vi.fn<(nonce: string, timestampSeconds: number) => boolean>(() => false);
    const result = await verifyRequest({
      method: 'GET',
      path: '/a\uD800',
      body: bytes(''),
      headers: {
        [INTERNAL_TIMESTAMP_HEADER]: TIMESTAMP,
        [INTERNAL_NONCE_HEADER]: NONCE,
        [INTERNAL_SIGNATURE_HEADER]: `v1=${'0'.repeat(64)}`,
      },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_field' });
    expect(claimNonce).not.toHaveBeenCalled();
  });
});

describe('isValidNonceExpirySeconds / assertNonceExpirySeconds', () => {
  /**
   * Hợp đồng của F-04B: tầng lưu trữ phải tự bảo vệ bất biến của nó, không dựa vào
   * `config.ts` hay người gọi. Bộ test này khoá định nghĩa "expiry hợp lệ" ở **một** chỗ
   * để cả hai app dùng chung, thay vì mỗi bên tự viết một phép kiểm trôi khỏi nhau.
   */

  it('pins the ceiling to 2100-01-01T00:00:00Z, computed independently', () => {
    // Neo vào một mốc thời gian tính được, không phải một literal tuỳ ý: ai đó đổi hằng
    // số thành một giá trị khác sẽ làm test này đỏ, và giá trị đúng thì suy ra được.
    expect(MAX_NONCE_EXPIRY_EPOCH_SECONDS).toBe(Date.UTC(2100, 0, 1) / 1000);
  });

  it.each([
    ['a normal future epoch second', 1_700_000_000],
    ['the ceiling itself', MAX_NONCE_EXPIRY_EPOCH_SECONDS],
    ['the smallest valid value', 1],
  ])('accepts %s', (_label, value) => {
    expect(isValidNonceExpirySeconds(value)).toBe(true);
    expect(() => {
      assertNonceExpirySeconds(value);
    }).not.toThrow();
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
    ['a decimal', 1_700_000_000.5],
    ['one over the ceiling', MAX_NONCE_EXPIRY_EPOCH_SECONDS + 1],
    ['epoch milliseconds (a unit error)', 1_700_000_000_000],
  ])('rejects %s', (_label, value) => {
    expect(isValidNonceExpirySeconds(value)).toBe(false);
    expect(() => {
      assertNonceExpirySeconds(value);
    }).toThrow(RangeError);
  });

  it('rejects a value that is not a safe integer even if it is finite', () => {
    // `Number.MAX_SAFE_INTEGER + 2` biểu diễn được nhưng không phải safe integer; một
    // phép kiểm `Number.isInteger` đơn thuần sẽ nhận nó.
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(Number.isInteger(unsafe)).toBe(true);
    expect(isValidNonceExpirySeconds(unsafe)).toBe(false);
  });

  it('uses the caller-supplied error factory so each layer can classify the failure', () => {
    // Tầng persistence cần ném đúng loại lỗi cấu hình của nó (`AuthConfigurationError`)
    // để middleware map thành 503 thay vì 500; nếu hàm chỉ ném `RangeError` cứng thì
    // một lỗi cấu hình sẽ trông như một lỗi lập trình.
    class CallerError extends Error {}
    expect(() => {
      assertNonceExpirySeconds(Number.NaN, (message) => new CallerError(message));
    }).toThrow(CallerError);
  });

  it('does not put the offending value into the error message', () => {
    // Cùng nguyên tắc với F-07: thông báo lỗi là thứ chắc chắn vào log, nên không được
    // chứa giá trị thô của đầu vào. Ở đây đầu vào là một số, nhưng cùng một đường log
    // cũng nhận `AUTH_INTERNAL_SKEW_SECONDS` — và thông báo này không được là tiền lệ.
    const error = catchError(() => assertNonceExpirySeconds(1_700_000_000_000));
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).not.toContain('1700000000000');
  });
});

describe('verifyRequest — failure ordering', () => {
  it('reports missing_header before checking the signature', async () => {
    // Envelope rỗng + secret sai: lý do phải là thiếu header, không phải chữ ký sai.
    const result = await verify({ headers: {}, secret: OTHER_SECRET });
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('reports bad_timestamp before checking the nonce', async () => {
    const result = await verify({ now: '1699990000', claimNonce: () => true });
    expect(result).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('reports bad_signature before consulting the nonce store', async () => {
    // Sai chữ ký + nonce đã thấy: lý do vẫn phải là sai chữ ký. Nếu không, attacker
    // dùng chữ ký giả có thể "che" lỗi của chính mình bằng nonce đã dùng.
    const result = await verify({ claimNonce: () => true, secret: OTHER_SECRET });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('never consults the nonce store when the signature is forged', async () => {
    // S3: `claimNonce` là chiếm-ghi nguyên tử — nếu nó chạy trước chữ ký, attacker đọc
    // được nonce của request thật đang bay (proxy log / wrangler tail) có thể gửi
    // envelope chữ ký giả để đốt nonce đó, khiến request thật sau đó chết
    // `replayed_nonce` mà attacker không cần biết secret.
    const claimNonce = vi.fn<(nonce: string, timestampSeconds: number) => boolean>(() => false);
    const result = await verify({ secret: OTHER_SECRET, claimNonce });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(claimNonce).not.toHaveBeenCalled();
  });

  it('consults the nonce store only after a valid signature', async () => {
    // Mặt đối của trên: với chữ ký đúng, store phải được gọi — nếu không, reordered
    // sai kiểu "không bao giờ ghi nonce" cũng sẽ pass test trên.
    const claimNonce = vi.fn<(nonce: string, timestampSeconds: number) => boolean>(() => false);
    const result = await verify({ claimNonce });
    expect(result.ok).toBe(true);
    expect(claimNonce).toHaveBeenCalledWith(NONCE, Number(TIMESTAMP));
  });

  it('passes the envelope timestamp, not the verifier clock, to the nonce store', async () => {
    // Hợp đồng mới của `claimNonce`: tham số thứ hai là timestamp đã validated của
    // envelope, để callee neo `expires_at` theo replay window thật
    // (`timestamp + skew`) thay vì đoán bằng `now` của mình. `now` ở đây cố ý lệch
    // +60s so với timestamp (vẫn trong skew 300s) để hai giá trị phân biệt được.
    const claimNonce = vi.fn<(nonce: string, timestampSeconds: number) => boolean>(() => false);
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const nowSeconds = Number(TIMESTAMP) + 60;
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      now: String(nowSeconds),
      skewSeconds: 300,
      claimNonce,
    });
    expect(result.ok).toBe(true);
    expect(claimNonce).toHaveBeenCalledWith(NONCE, Number(TIMESTAMP));
    expect(claimNonce).not.toHaveBeenCalledWith(NONCE, nowSeconds);
  });
});

describe('golden vectors — computed outside this repo', () => {
  /**
   * Ba vector dưới đây KHÔNG được sinh bằng chính lib này.
   *
   * ## Vì sao cần
   *
   * Mọi test khác trong file này đều tự đối chiếu: `signRequest` ký rồi
   * `verifyRequest` kiểm, hoặc canonical string được assert theo cấu trúc. Một
   * test tự đối chiếu chỉ chứng minh **tính nhất quán nội bộ** — nếu hai phía
   * cùng trôi theo một hướng (ví dụ cùng hạ method, cùng đếm length theo
   * UTF-16), test vẫn xanh trong khi envelope đã khác giao thức đã chốt. Đó
   * đúng là cách `auth` và `account` lệch nhau mà không test nào đỏ.
   *
   * Vector ở đây được tính bằng một cài đặt **độc lập** (Python `hashlib` +
   * `hmac`), rồi dán vào. Chúng neo cả canonical string lẫn chữ ký cuối cùng,
   * nên một thay đổi ở bất kỳ thành phần nào — thứ tự trường, dấu phân tách,
   * dạng length prefix, đơn vị timestamp, cách hash body — đều làm đỏ test này.
   *
   * Đầu vào để tính lại (chạy được bằng bất kỳ công cụ HMAC nào):
   *
   * ```python
   * canonical = "\n".join([method.lower(), "ecoma-internal-v2",
   *                        f"{len(path.encode()):d}:{path}",
   *                        f"{len(timestamp.encode()):d}:{timestamp}",
   *                        f"{len(nonce.encode()):d}:{nonce}",
   *                        sha256(body.encode()).hexdigest()])
   * hmac.new(secret.encode(), canonical.encode(), sha256).hexdigest()
   * ```
   *
   * `secret` là hằng literal của chính file test này
   * (`'test-internal-hmac-secret-0123456789abcdef'`) — không phải credential
   * thật, không đọc từ biến môi trường, và không bao giờ được lib trả ra ngoài.
   */
  const GOLDEN_SECRET = 'test-internal-hmac-secret-0123456789abcdef';

  const GOLDEN_VECTORS = [
    {
      name: 'A — POST có body JSON',
      method: 'POST',
      path: '/internal/session/verified',
      timestamp: '1700000000',
      nonce: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      body: bytes('{"event_id":"evt_2026_0001"}'),
      bodyHash: '451d55b7d203d35ddff055e534a25cfed9aaf194a3053c5511921e3501a9de9e',
      canonical:
        'post\necoma-internal-v2\n26:/internal/session/verified\n10:1700000000\n36:3f2504e0-4f89-41d3-9a0c-0305e82c3301\n451d55b7d203d35ddff055e534a25cfed9aaf194a3053c5511921e3501a9de9e\nactor-absent',
      signature: 'v1=2de328e2793c8e35661998acf156b4de7cbb578817daf6fe21ef2b18f9378c69',
    },
    {
      // Path có query string — chứng minh query nằm TRONG chuỗi ký nguyên văn,
      // không bị tách ra rồi ghép lại ở mỗi phía một kiểu.
      name: 'B — GET có query string, body rỗng',
      method: 'GET',
      path: '/internal/account/status?sub=sub_01H&note=chien-thang',
      timestamp: '1700000000',
      nonce: '0f8fad5b-d9cb-469f-a165-70867728950e',
      body: bytes(''),
      bodyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      canonical:
        'get\necoma-internal-v2\n53:/internal/account/status?sub=sub_01H&note=chien-thang\n10:1700000000\n36:0f8fad5b-d9cb-469f-a165-70867728950e\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nactor-absent',
      signature: 'v1=1bf3a6a207d9666ea303df4de45d19e2616c9440d36f0ef1a3d678636d833694',
    },
    {
      // ⚠️ Vector phân biệt được đơn vị length prefix. Path này dài 37 ký tự theo
      // UTF-16 nhưng 41 byte theo UTF-8, và canonical ghi `41:` — nên một bản
      // cài đặt đếm theo UTF-16 (đúng thứ `auth` từng làm) sẽ trượt vector này.
      name: 'C — path có ký tự ngoài ASCII (length prefix phải là byte UTF-8)',
      method: 'PUT',
      path: '/internal/account/ghi-chu/chiến-thắng',
      timestamp: '1700000000',
      nonce: 'c4f9a1e2-7b3d-4a5f-9e8c-1d2b3a4c5d6e',
      body: bytes('{"note":"chiến thắng"}'),
      bodyHash: 'adf40d827202b7b896817e296f3a7c7f0a4f4426afa64dc52502beeeff7866b8',
      canonical:
        'put\necoma-internal-v2\n41:/internal/account/ghi-chu/chiến-thắng\n10:1700000000\n36:c4f9a1e2-7b3d-4a5f-9e8c-1d2b3a4c5d6e\nadf40d827202b7b896817e296f3a7c7f0a4f4426afa64dc52502beeeff7866b8\nactor-absent',
      signature: 'v1=e579f0da70dfbe91c7816661b6d94c2ba16b235e254ef50ec06e900dc6b342df',
    },
  ] as const;

  it('hashBody matches the independently computed body hash', async () => {
    for (const vector of GOLDEN_VECTORS) {
      await expect(hashBody(vector.body)).resolves.toBe(vector.bodyHash);
    }
  });

  it('canonicalString reproduces the independently computed canonical string', () => {
    for (const vector of GOLDEN_VECTORS) {
      expect(
        canonicalString(
          vector.method,
          vector.path,
          vector.timestamp,
          vector.nonce,
          vector.bodyHash,
        ),
      ).toBe(vector.canonical);
    }
  });

  it('signRequest produces the independently computed signature', async () => {
    for (const vector of GOLDEN_VECTORS) {
      const headers = await signRequest({
        method: vector.method,
        path: vector.path,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
        body: vector.body,
        secret: GOLDEN_SECRET,
      });
      expect(headers[INTERNAL_SIGNATURE_HEADER]).toBe(vector.signature);
    }
  });

  it('verifyRequest accepts every golden vector', async () => {
    for (const vector of GOLDEN_VECTORS) {
      const headers = await signRequest({
        method: vector.method,
        path: vector.path,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
        body: vector.body,
        secret: GOLDEN_SECRET,
      });
      const result = await verifyRequest({
        method: vector.method,
        path: vector.path,
        body: vector.body,
        headers,
        secret: GOLDEN_SECRET,
        now: vector.timestamp,
        skewSeconds: 300,
        claimNonce: () => false,
      });
      expect(result.ok).toBe(true);
    }
  });
});

describe('body semantics — the signature covers bytes, not JSON meaning', () => {
  /**
   * Nhóm test này chốt một hệ quả của §"Chữ ký phủ đúng byte thân request": envelope
   * không có ý kiến gì về **nội dung** của body. Nó không cần body là JSON, và hai
   * chuỗi JSON tương đương về ngữ nghĩa nhưng khác byte là hai body khác nhau.
   */

  it('does not require the body to be valid JSON', async () => {
    // Contract ký byte, nên một body không phải JSON vẫn verify được: parse JSON là
    // việc của route, không phải của envelope. Nếu lib này từ chối body không parse
    // được thì nó đã tự ý thêm một ràng buộc không có trong giao thức.
    const notJson = bytes('day khong phai JSON {{{');
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: notJson,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: notJson,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('verifies a body that is not valid UTF-8 at all', async () => {
    // Hệ quả trực tiếp của F-01: byte là byte. Chữ ký không đòi payload phải là văn bản,
    // và quan trọng hơn, một payload **không** decode được vẫn đi qua đúng cùng một
    // đường verify thay vì bị thay bằng U+FFFD rồi lặng lẽ thành payload khác.
    const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f]);
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: binary,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: binary,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a body that differs only in bytes invalid as UTF-8', async () => {
    // ⚠️ Bất biến bảo mật trung tâm của F-01, kiểm ở tầng envelope: ký `61 ff 62` rồi
    // verify `61 efbfbd 62` (tức `a�b`, chuỗi mà `TextDecoder` non-fatal sinh ra từ
    // payload đầu). Nếu một bên nào đó decode trước khi băm, hai giá trị này cùng hash
    // và request bị sửa vẫn được chấp nhận.
    const signedBytes = new Uint8Array([0x61, 0xff, 0x62]);
    const replacementBytes = bytes('a�b');
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: signedBytes,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: replacementBytes,
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a valid JSON body re-serialized with different whitespace', async () => {
    // ⚠️ Cùng một object JSON, hai cách serialize. Đây chính là lý do giao thức ký
    // byte thô thay vì parse rồi serialize lại: hai bên dùng hai thư viện JSON khác
    // nhau (hoặc hai version khác nhau của cùng một thư viện) là đủ để sinh ra
    // chuỗi byte khác và chữ ký không bao giờ khớp — lệch im lặng, không test nào đỏ
    // nếu cả hai phía đều tự đối chiếu với chính mình.
    const compact = '{"sub":"s","authn_level":"aal1"}';
    const spaced = '{ "sub": "s", "authn_level": "aal1" }';
    expect(JSON.parse(compact)).toEqual(JSON.parse(spaced));

    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: bytes(compact),
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: bytes(spaced),
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a valid JSON body carrying an invalid signature', async () => {
    const body = bytes('{"sub":"s"}');
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body,
      headers: { ...headers, [INTERNAL_SIGNATURE_HEADER]: `v1=${'0'.repeat(64)}` },
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a body one byte longer than the signed one', async () => {
    // Dịch chuyển một byte: `{"sub":"s"}` → `{"sub":"s"} ` (thêm space). Không được chia
    // sẻ chữ ký, dù phần payload "có nghĩa" không đổi.
    const signedBody = bytes('{"sub":"s"}');
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: signedBody,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: bytes('{"sub":"s"} '),
      headers,
      secret: SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

/**
 * `kid` — chỉ dẫn chọn khoá trên header `x-ecoma-internal-kid` (issue #64).
 *
 * ⚠️ Ba bất biến cốt lõi, mỗi bất biến có một test riêng:
 *
 *  1. **`kid` KHÔNG nằm trong canonical string.** Chữ ký của envelope có `kid` và
 *     envelope không `kid` phải **byte-identical** khi dùng cùng secret — nếu không,
 *     mọi golden vector cũ vỡ và việc xoay secret trở thành thay đổi giao thức.
 *  2. **`kid` sai hình dạng ⇒ `invalid_field`**, không phải `bad_signature`: nó là lỗi
 *     đầu vào, và resolver không được kích hoạt bởi một `kid` do bên gọi kiểm soát.
 *  3. **`kid` lạ (resolver ném) ⇒ `bad_signature`**, fail-closed: không có nhánh nào
 *     "chấp nhận bằng secret mặc định" cho envelope mà resolver không biết chọn khoá.
 */
describe('assertKid', () => {
  it('accepts 8 to 16 lowercase hex characters', () => {
    expect(() => assertKid('0123abcd')).not.toThrow();
    expect(() => assertKid('0123456789abcdef')).not.toThrow();
  });

  it('rejects a value shorter than 8 characters', () => {
    expect(() => assertKid('0123abc')).toThrow(InvalidKidError);
  });

  it('rejects a value longer than 16 characters', () => {
    expect(() => assertKid('0123456789abcdef0')).toThrow(InvalidKidError);
  });

  it('rejects uppercase hex', () => {
    expect(() => assertKid('0123ABCD')).toThrow(InvalidKidError);
  });

  it('rejects non-hex characters', () => {
    expect(() => assertKid('zzzzzzzz')).toThrow(InvalidKidError);
  });

  it('accepts null and undefined, so a missing kid is not a shape error', () => {
    expect(() => assertKid(null)).not.toThrow();
    expect(() => assertKid(undefined)).not.toThrow();
  });

  it('never puts the offending value in the error message', () => {
    // Giá trị `kid` đọc được ở nhiều nơi và một giá trị sai có thể là nhầm dán secret
    // ⇒ thông báo lỗi không được mang giá trị (cùng nguyên tắc với F-07).
    const error = catchError(() => assertKid('sup3rs3cret!'));
    expect(error).toBeInstanceOf(InvalidKidError);
    expect((error as InvalidKidError).message).not.toContain('sup3rs3cret');
    expect((error as InvalidKidError).field).toBe('kid');
  });
});

describe('signRequest — kid', () => {
  it('emits the kid header when a kid is supplied', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      kid: KID,
    });
    expect(headers[INTERNAL_KID_HEADER]).toBe(KID);
  });

  it('omits the kid header entirely when no kid is supplied', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    expect(INTERNAL_KID_HEADER in headers).toBe(false);
  });

  it('produces a byte-identical signature with and without the kid header', async () => {
    // Bất biến cốt lõi của issue #64: `kid` là header, KHÔNG phải một dòng trong
    // canonical string. Nếu chữ ký khác nhau thì việc thêm `kid` đã là một thay đổi
    // giao thức, và mọi golden vector cũ vỡ.
    const base = {
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    };
    const withoutKid = await signRequest(base);
    const withKid = await signRequest({ ...base, kid: KID });
    expect(withKid[INTERNAL_SIGNATURE_HEADER]).toBe(withoutKid[INTERNAL_SIGNATURE_HEADER]);
  });

  it('rejects a malformed kid before signing anything', async () => {
    await expect(
      signRequest({
        method: 'POST',
        path: PATH,
        body: BODY,
        secret: SECRET,
        timestamp: TIMESTAMP,
        nonce: NONCE,
        kid: 'not-hex',
      }),
    ).rejects.toThrow(InvalidKidError);
  });
});

describe('verifyRequest — kid', () => {
  it('verifies an envelope carrying a kid, resolving the key by that kid', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      kid: KID,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      secretByKid: async (kid) => {
        expect(kid).toBe(KID);
        return SECRET;
      },
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a kid-carrying envelope signed with the rotated key only', async () => {
    // Kịch bản xoay secret: sender đã ký bằng khoá MỚI, receiver vẫn giữ cả hai.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: ROTATED_SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      kid: KID,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      secretByKid: async (kid) => (kid === KID ? ROTATED_SECRET : ''),
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('still verifies an envelope without a kid using the current secret', async () => {
    // Phase transition: sender chưa bật `kid` ⇒ không có header `kid` ⇒ dùng secret mặc định.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      secretByKid: async () => ROTATED_SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a malformed kid as invalid_field, not as bad_signature', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_KID_HEADER]: 'NOT-HEX' },
      secret: SECRET,
      secretByKid: async () => SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_field' });
  });

  it('does not call the resolver for a malformed kid', async () => {
    // Một `kid` rác là đầu vào do bên gọi kiểm soát ⇒ không được kích hoạt lệnh tra
    // registry (đó là đường đi vào hệ thống, không phải dữ liệu cần tra).
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const resolver = vi.fn<(kid: string) => Promise<string>>(async () => SECRET);
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_KID_HEADER]: 'NOT-HEX' },
      secret: SECRET,
      secretByKid: resolver,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_field' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects an unknown kid as bad_signature when the resolver throws', async () => {
    // Fail-closed: không có nhánh nào "chấp nhận bằng secret mặc định" cho envelope mà
    // resolver không biết chọn khoá.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      kid: KID,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      secretByKid: async () => {
        throw new Error('unknown kid');
      },
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unknown kid as bad_signature when the resolver returns an empty secret', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      kid: KID,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      secretByKid: async () => '',
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an envelope whose signature was made with the key the kid does not select', async () => {
    // Resolver trả khoá A, chữ ký được tạo bằng khoá B ⇒ `bad_signature`. `kid` KHÔNG
    // phải một claim tự thuyết phục: nó chỉ là chỉ dẫn chọn khoá, còn HMAC mới là bằng
    // chứng.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: ROTATED_SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      kid: KID,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers,
      secret: SECRET,
      secretByKid: async () => SECRET,
      now: TIMESTAMP,
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('checks the kid shape before the timestamp window', async () => {
    // Thứ tự kiểm là hợp đồng: `kid` hình dạng sai là lỗi đầu vào, và nó phải được
    // phân biệt với `bad_timestamp` — timestamp ngoài cửa sổ cũng là lỗi đầu vào.
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const result = await verifyRequest({
      method: 'POST',
      path: PATH,
      body: BODY,
      headers: { ...headers, [INTERNAL_KID_HEADER]: 'NOT-HEX' },
      secret: SECRET,
      secretByKid: async () => SECRET,
      now: '1700009999',
      skewSeconds: 300,
      claimNonce: () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_field' });
  });
});
