import { describe, expect, it } from 'vitest';

import {
  checkPayloadPlaintextBudget,
  isPushBodyWithinLimit,
  MAX_PAYLOAD_PLAINTEXT_BYTES,
  MAX_PUSH_BODY_BYTES,
  measurePayloadPlaintextBytes,
  PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES,
  serializePayloadCanonically,
  type NotificationPayload,
} from './notification';

/**
 * Số octet cố định của `{"title":"","body":""}` — kiểm chứng độc lập với hàm đo của
 * domain, để assertion không dùng chính thứ nó đang kiểm.
 */
const EMPTY_TITLE_BODY_OVERHEAD_BYTES = 22;

describe('payload budget is a business rule, not a wire schema', () => {
  it('declares the three numbers that make up the FR-008 budget', () => {
    expect(MAX_PAYLOAD_PLAINTEXT_BYTES).toBe(3993);
    expect(MAX_PUSH_BODY_BYTES).toBe(4096);
    expect(PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES).toBe(103);
  });

  it('keeps plaintext plus framing exactly equal to the encrypted body ceiling', () => {
    expect(MAX_PAYLOAD_PLAINTEXT_BYTES + PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES).toBe(
      MAX_PUSH_BODY_BYTES,
    );
  });
});

describe('canonical serialization is stable and ordered', () => {
  it('emits title, body, url, data in that order regardless of input order', () => {
    const a: NotificationPayload = { title: 'Tiêu đề', body: 'Nội dung' };
    const b: NotificationPayload = { body: 'Nội dung', title: 'Tiêu đề' };
    expect(serializePayloadCanonically(a)).toBe(serializePayloadCanonically(b));
    expect(serializePayloadCanonically(a)).toBe('{"title":"Tiêu đề","body":"Nội dung"}');
  });

  it('omits absent optional keys and keeps url before data', () => {
    expect(serializePayloadCanonically({ title: 'a', body: 'b' })).toBe('{"title":"a","body":"b"}');
    expect(
      serializePayloadCanonically({ title: 'a', body: 'b', url: '/u', data: { k: 'v' } }),
    ).toBe('{"title":"a","body":"b","url":"/u","data":{"k":"v"}}');
    expect(serializePayloadCanonically({ title: 'a', body: 'b', data: { k: 'v' } })).toBe(
      '{"title":"a","body":"b","data":{"k":"v"}}',
    );
  });

  it('adds no insignificant whitespace', () => {
    const serialized = serializePayloadCanonically({
      title: 'a',
      body: 'b',
      data: { k: [1, 2] },
    });
    expect(serialized).toBe('{"title":"a","body":"b","data":{"k":[1,2]}}');
    for (const whitespace of [' ', '\n', '\t']) {
      expect(serialized.includes(whitespace)).toBe(false);
    }
  });
});

describe('plaintext byte measurement uses UTF-8 octets', () => {
  it('measures an ASCII payload as the fixed overhead plus content', () => {
    const payload: NotificationPayload = { title: 'x'.repeat(10), body: 'y'.repeat(5) };
    expect(measurePayloadPlaintextBytes(payload)).toBe(EMPTY_TITLE_BODY_OVERHEAD_BYTES + 15);
  });

  it('counts multibyte characters at their real UTF-8 width', () => {
    // 'é' và 'ư' đều là 2 octet UTF-8 (không phải 1 code unit UTF-16).
    const payload: NotificationPayload = { title: 'é', body: 'ư' };
    expect(measurePayloadPlaintextBytes(payload)).toBe(EMPTY_TITLE_BODY_OVERHEAD_BYTES + 4);
    expect(serializePayloadCanonically(payload).length).toBe(EMPTY_TITLE_BODY_OVERHEAD_BYTES + 2);
  });

  it('counts 4-octet code points (emoji) correctly', () => {
    const payload: NotificationPayload = { title: '😀', body: '' };
    // 😀 là 4 octet UTF-8, 2 code unit UTF-16.
    expect(measurePayloadPlaintextBytes(payload)).toBe(EMPTY_TITLE_BODY_OVERHEAD_BYTES + 4);
  });

  it('returns null rather than throwing on an unserializable payload', () => {
    const circular: Record<string, unknown> = { k: 1 };
    circular.self = circular;
    const payload = { title: 'a', body: 'b', data: circular } as NotificationPayload;
    expect(measurePayloadPlaintextBytes(payload)).toBeNull();
  });

  it('never mutates the payload it is given', () => {
    const payload: NotificationPayload = Object.freeze({
      title: 'a',
      body: 'b',
      data: Object.freeze({ k: 'v' }),
    });
    const snapshot = structuredClone(payload);
    measurePayloadPlaintextBytes(payload);
    expect(payload).toStrictEqual(snapshot);
  });
});

describe('plaintext budget boundary is enforced exactly', () => {
  it('accepts a payload of exactly the budget', () => {
    const contentLength = MAX_PAYLOAD_PLAINTEXT_BYTES - EMPTY_TITLE_BODY_OVERHEAD_BYTES;
    const result = checkPayloadPlaintextBudget({
      title: 'a'.repeat(contentLength - 1),
      body: 'b',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plaintextBytes).toBe(MAX_PAYLOAD_PLAINTEXT_BYTES);
  });

  it('rejects a payload one octet over the budget', () => {
    const contentLength = MAX_PAYLOAD_PLAINTEXT_BYTES - EMPTY_TITLE_BODY_OVERHEAD_BYTES + 1;
    const result = checkPayloadPlaintextBudget({
      title: 'a'.repeat(contentLength - 1),
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('payload_over_budget');
  });

  it('counts data toward the budget', () => {
    const result = checkPayloadPlaintextBudget({
      title: 'a',
      body: 'b',
      data: { padding: 'p'.repeat(MAX_PAYLOAD_PLAINTEXT_BYTES) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('payload_over_budget');
  });

  it('counts multibyte characters at their real octet width', () => {
    // 1996 ký tự 'ư' = 3992 octet; cộng overhead 22 → 4014, vượt budget 3993.
    const multibyteTitle = 'ư'.repeat(1996);
    const asciiTitle = 'a'.repeat(multibyteTitle.length);
    expect(checkPayloadPlaintextBudget({ title: asciiTitle, body: '' }).ok).toBe(true);
    const result = checkPayloadPlaintextBudget({ title: multibyteTitle, body: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('payload_over_budget');
  });

  it('reports not_serializable instead of throwing on a bad payload', () => {
    const circular: Record<string, unknown> = { k: 1 };
    circular.self = circular;
    const result = checkPayloadPlaintextBudget({
      title: 'a',
      body: 'b',
      data: circular,
    } as NotificationPayload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_serializable');
  });

  it('reports the measured bytes on a successful check', () => {
    const result = checkPayloadPlaintextBudget({ title: 'abc', body: 'de' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plaintextBytes).toBe(EMPTY_TITLE_BODY_OVERHEAD_BYTES + 5);
    expect(result.plaintextBytes).toBe(measurePayloadPlaintextBytes({ title: 'abc', body: 'de' }));
  });
});

describe('encrypted body ceiling follows the plaintext budget plus framing', () => {
  it('accepts a plaintext length that fits within the encrypted body ceiling', () => {
    const maxFit = MAX_PUSH_BODY_BYTES - PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES;
    expect(isPushBodyWithinLimit(maxFit)).toBe(true);
    expect(isPushBodyWithinLimit(maxFit + 1)).toBe(false);
  });

  it('rejects a negative or non-integer plaintext length', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isPushBodyWithinLimit(value)).toBe(false);
    }
  });

  it('passes every accepted payload through the body limit check', () => {
    const result = checkPayloadPlaintextBudget({ title: 'a', body: 'b' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isPushBodyWithinLimit(result.plaintextBytes)).toBe(true);
  });
});
