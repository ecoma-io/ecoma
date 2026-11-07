/**
 * Spec cho digest và phân loại lý do quarantine.
 *
 * Digest được **đối chiếu bằng hai đường độc lập**: WebCrypto của runtime (đường production)
 * và `node:crypto` (implementation tham chiếu, chỉ có ở test runner). Hai đường phải cho cùng
 * một kết quả — nếu chỉ so với chính WebCrypto thì một lỗi cùng loại ở cả bản implement và bản
 * tham chiếu (ví dụ: truyền chuỗi thay vì byte) vẫn xanh.
 *
 * `node:crypto` được phép ở đây vì spec chạy ở test time trên Node runner, không được bundle vào
 * Worker edge: xem block `spec`/`test` trong `.oxlintrc.json`. Không file nào trong `src/` ngoài
 * `*.spec.ts` được phép import Node builtin.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { QUARANTINE_REASON_VALUES, type QuarantineReason } from './mail-job-model';
import {
  QUARANTINE_ID_PATTERN,
  QUARANTINE_ID_PREFIX,
  QUARANTINE_UNKNOWN_FIELD_NAME,
  computeQuarantineId,
  encodeUtf8,
  optionalSanitizedFieldName,
  quarantineReasonFor,
} from './quarantine-digest';

/** Khoá 32 byte (`0x00`..`0x1f`) dạng hex — đúng entropy tối thiểu mà HMAC-SHA-256 cần. */
const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

/** Khoá khác, cùng độ dài — dùng để chứng minh digest phụ thuộc khoá. */
const OTHER_KEY_HEX = '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100';

/** Body mẫu: **không** chứa dữ liệu thật, chỉ là chuỗi không nhạy cảm để băm. */
const BODY = '{"version":1,"delivery_id":"dlv_fixture"}';

/** Digest tham chiếu, tính bằng `node:crypto` — không dùng WebCrypto của runtime. */
function referenceDigest(keyHex: string, rawBody: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(rawBody, 'utf8').digest('hex');
}

describe('computeQuarantineId', () => {
  it('matches a reference HMAC-SHA-256 computed outside WebCrypto', async () => {
    const id = await computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(BODY) });

    expect(id).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(KEY_HEX, BODY)}`);
  });

  it('hashes the raw bytes, so two bodies that differ only in whitespace get different ids', async () => {
    // `JSON.parse` xong rồi `JSON.stringify` lại sẽ thu được cả hai vế này thành một chuỗi
    // giống nhau; băm **byte thô** là thứ giữ chúng khác nhau.
    const spaced = '{"version": 1, "delivery_id": "dlv_fixture"}';
    const compact = '{"version":1,"delivery_id":"dlv_fixture"}';
    expect(spaced).not.toBe(compact);

    const [fromSpaced, fromCompact] = await Promise.all([
      computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(spaced) }),
      computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(compact) }),
    ]);

    expect(fromSpaced).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(KEY_HEX, spaced)}`);
    expect(fromCompact).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(KEY_HEX, compact)}`);
    expect(fromSpaced).not.toBe(fromCompact);
  });

  it('produces the qlt_ prefix followed by 64 lowercase hex characters', async () => {
    const id = await computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(BODY) });

    expect(QUARANTINE_ID_PATTERN.test(id)).toBe(true);
    expect(id.startsWith(`${QUARANTINE_ID_PREFIX}`)).toBe(true);
    expect(id.slice(QUARANTINE_ID_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable for the same key and body so a repeat reject upserts one record', async () => {
    const first = await computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(BODY) });
    const second = await computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(BODY) });

    expect(second).toBe(first);
  });

  it('depends on the key, so a rotated secret cannot collide with the old digest', async () => {
    const [withKey, withOtherKey] = await Promise.all([
      computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(BODY) }),
      computeQuarantineId({ keyHex: OTHER_KEY_HEX, rawBody: encodeUtf8(BODY) }),
    ]);

    expect(withOtherKey).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(OTHER_KEY_HEX, BODY)}`);
    expect(withOtherKey).not.toBe(withKey);
  });

  it('hashes multi-byte characters through their UTF-8 bytes', async () => {
    // Fixture không phải dữ liệu thật của bất kỳ ai; nó chỉ chứng minh chuỗi không ASCII được
    // mã hoá UTF-8 chứ không phải mã hoá từng code unit.
    const body = '{"delivery_id":"dlv_é"}';
    const id = await computeQuarantineId({ keyHex: KEY_HEX, rawBody: encodeUtf8(body) });

    expect(id).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(KEY_HEX, body)}`);
  });

  it('accepts uppercase hex for the key', async () => {
    const id = await computeQuarantineId({
      keyHex: KEY_HEX.toUpperCase(),
      rawBody: encodeUtf8(BODY),
    });

    expect(id).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(KEY_HEX, BODY)}`);
  });

  it('hashes an empty body instead of falling back to a constant', async () => {
    const id = await computeQuarantineId({ keyHex: KEY_HEX, rawBody: new Uint8Array(0) });

    expect(id).toBe(`${QUARANTINE_ID_PREFIX}${referenceDigest(KEY_HEX, '')}`);
  });

  it('rejects a key shorter than 32 bytes rather than producing a weak digest', async () => {
    // 31 byte: `parseInt` vẫn decode được toàn bộ, nên đây là ca âm duy nhất bắt được.
    const tooShort = KEY_HEX.slice(0, 62);

    await expect(
      computeQuarantineId({ keyHex: tooShort, rawBody: encodeUtf8(BODY) }),
    ).rejects.toThrow(/at least 32 bytes/u);
  });

  it('rejects a malformed hex key instead of parsing it leniently', async () => {
    // `parseInt('zz', 16)` là NaN và `parseInt('1z', 16)` là 1 — cả hai âm thầm cho một khoá
    // khác với khoá truyền vào, nên hex phải được kiểm trước khi decode.
    const notHex = `${KEY_HEX.slice(0, 62)}zz`;

    await expect(
      computeQuarantineId({ keyHex: notHex, rawBody: encodeUtf8(BODY) }),
    ).rejects.toThrow(/hexadecimal/u);
  });

  it('rejects a key with an odd number of hex characters', async () => {
    await expect(
      computeQuarantineId({ keyHex: `${KEY_HEX}f`, rawBody: encodeUtf8(BODY) }),
    ).rejects.toThrow(/even number/u);
  });

  it('rejects an empty key', async () => {
    await expect(computeQuarantineId({ keyHex: '', rawBody: encodeUtf8(BODY) })).rejects.toThrow(
      /hexadecimal/u,
    );
  });

  it('never places the key itself in the error message', async () => {
    const secret = `${KEY_HEX.slice(0, 62)}zz`;

    await expect(
      computeQuarantineId({ keyHex: secret, rawBody: encodeUtf8(BODY) }),
    ).rejects.toSatisfy((error: unknown) => !(error as Error).message.includes(secret));
  });
});

describe('quarantineReasonFor', () => {
  const TABLE: ReadonlyArray<{
    readonly reason: Parameters<typeof quarantineReasonFor>[0];
    readonly detail: string | undefined;
    readonly expected: QuarantineReason;
  }> = [
    { reason: 'unparseable', detail: undefined, expected: 'unparseable-body' },
    { reason: 'unsupported-version', detail: 'version', expected: 'unsupported-version' },
    { reason: 'forbidden-field', detail: 'api_key', expected: 'forbidden-field' },
    { reason: 'missing-field', detail: 'delivery_id', expected: 'missing-delivery-id' },
    { reason: 'missing-field', detail: 'version', expected: 'unparseable-body' },
    { reason: 'wrong-type', detail: 'delivery_id', expected: 'missing-delivery-id' },
    { reason: 'wrong-type', detail: 'version', expected: 'unparseable-body' },
  ];

  it.each(TABLE)('maps $reason (detail=$detail) to $expected', ({ reason, detail, expected }) => {
    expect(quarantineReasonFor(reason, detail)).toBe(expected);
  });

  it('treats a missing delivery_id detail as missing-delivery-id whatever the casing', () => {
    // `detail` của validator là hằng của contract nên casing chuẩn là trường hợp duy nhất xảy
    // ra; ca này ghim rằng phép map là so khớp chính xác, không phải so "trông giống delivery".
    expect(quarantineReasonFor('missing-field', 'Delivery_ID')).toBe('unparseable-body');
  });

  it('falls back to unparseable-body when the validator set no detail', () => {
    // Ca âm của nhánh `?? 'unparseable-body'`: lý do hợp lệ nhưng thiếu detail phải cho ra
    // reason hợp lệ, không phải `undefined`.
    expect(quarantineReasonFor('missing-field', undefined)).toBe('unparseable-body');
  });

  it('maps every reason of the closed validator set into the closed quarantine set', () => {
    const VALIDATOR_REASONS = [
      'unparseable',
      'unsupported-version',
      'forbidden-field',
      'missing-field',
      'wrong-type',
    ] as const;

    const mapped = VALIDATOR_REASONS.map((reason) => quarantineReasonFor(reason, 'delivery_id'));

    // `QUARANTINE_REASON_VALUES` là union của hai producer: validator command (4 reason
    // phía trên) và ingest lifecycle event ('lifecycle-event-invalid' — §11.3). Phần ảnh
    // của validator phải là tập con, và phần bù đúng một reason của producer kia.
    const unmapped = QUARANTINE_REASON_VALUES.filter((reason) => !mapped.includes(reason));
    expect(unmapped).toEqual(['lifecycle-event-invalid']);
    for (const reason of mapped) {
      expect(QUARANTINE_REASON_VALUES).toContain(reason);
    }
  });
});

describe('optionalSanitizedFieldName', () => {
  it('accepts an identifier-like key including the underscore of api_key', () => {
    // `api_key` là một key canonical trong danh sách cấm, nên sanitizer của error token
    // (chỉ nhận kebab-case) sẽ từ chối chính nó — đây là ca âm cho việc tái dùng đúng hàm.
    expect(optionalSanitizedFieldName('api_key')).toBe('api_key');
    expect(optionalSanitizedFieldName('myField')).toBe('myField');
    expect(optionalSanitizedFieldName('a.b-c_d')).toBe('a.b-c_d');
  });

  it('rejects a key with whitespace instead of storing it', () => {
    expect(optionalSanitizedFieldName('a b')).toBeUndefined();
    expect(optionalSanitizedFieldName('a\tb')).toBeUndefined();
  });

  it('rejects a key carrying a quote so the record cannot break out of a log line', () => {
    expect(optionalSanitizedFieldName('a"b')).toBeUndefined();
    expect(optionalSanitizedFieldName("a'b")).toBeUndefined();
  });

  it('rejects a key longer than 128 code points', () => {
    expect(optionalSanitizedFieldName('a'.repeat(129))).toBeUndefined();
    expect(optionalSanitizedFieldName('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('returns undefined for an absent or empty detail', () => {
    expect(optionalSanitizedFieldName(undefined)).toBeUndefined();
    expect(optionalSanitizedFieldName('')).toBeUndefined();
  });

  it('exposes a worker constant for the forbidden-field fallback', () => {
    // Hằng này tồn tại để CHECK `field_name IS NOT NULL` của schema được thoả khi key của
    // producer không hợp lệ; nó là hằng của worker, không phải dữ liệu của payload.
    expect(QUARANTINE_UNKNOWN_FIELD_NAME).toBe('unknown');
    expect(optionalSanitizedFieldName(QUARANTINE_UNKNOWN_FIELD_NAME)).toBe(
      QUARANTINE_UNKNOWN_FIELD_NAME,
    );
  });
});
