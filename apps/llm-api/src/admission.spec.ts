/**
 * Unit test các quyết định admission thuần (`admission.ts`): id tất định,
 * request_id/payload hash idempotency, bảng validation body, và hai cận token
 * (DECISION 2). Mọi hàm ở đây là thuần — không workerd, không PostgreSQL.
 *
 * Hai identity ĐỘC LẬP được ghim ở đây ở mức contract: quota identity suy từ
 * `request_id`, financial identity suy từ `(request_id, attempt_id)` — không
 * bao giờ trùng nhau dù cùng request.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  computeTokenBounds,
  deriveAttemptId,
  deriveChargeId,
  deriveCompletionId,
  deriveFinancialReservationId,
  deriveQuotaReservationId,
  deriveSettlementId,
  estimatePromptCharacters,
  resolveRequestId,
  validateChatRequest,
  type ChatRequestFailure,
} from './admission';

/** Narrow kết quả validation sang failure — test chỉ quan tâm mã failure. */
function failureOf(body: unknown): ChatRequestFailure {
  const result = validateChatRequest(body);
  if (result.kind !== 'invalid') {
    throw new Error('expected the request to be invalid');
  }
  return result.failure;
}

describe('deterministic admission ids', () => {
  const REQUEST_ID = 'req-abc-123';
  const ATTEMPT_ID = deriveAttemptId(REQUEST_ID, 1);

  it('derives each id from its documented inputs', () => {
    expect(deriveQuotaReservationId(REQUEST_ID)).toBe('quota:req-abc-123');
    expect(ATTEMPT_ID).toBe('attempt:req-abc-123:1');
    expect(deriveFinancialReservationId(REQUEST_ID, ATTEMPT_ID)).toBe(
      'finres:req-abc-123:attempt:req-abc-123:1',
    );
    expect(deriveSettlementId(REQUEST_ID, ATTEMPT_ID)).toBe(
      'settle:req-abc-123:attempt:req-abc-123:1',
    );
    expect(deriveChargeId(REQUEST_ID, ATTEMPT_ID)).toBe('charge:req-abc-123:attempt:req-abc-123:1');
    expect(deriveCompletionId(REQUEST_ID)).toBe('chatcmpl-req-abc-123');
  });

  it('keeps the quota identity and the financial identity forever distinct', () => {
    // Invariant 1: quota reservation_id ≠ financial admission identity, kể cả
    // khi cùng request_id.
    const quotaId = deriveQuotaReservationId(REQUEST_ID);
    const financialId = deriveFinancialReservationId(REQUEST_ID, ATTEMPT_ID);
    expect(quotaId).not.toBe(financialId);
    expect(quotaId.startsWith('quota:')).toBe(true);
    expect(financialId.startsWith('finres:')).toBe(true);
  });

  it('is stable across repeated calls with the same inputs', () => {
    expect(deriveSettlementId(REQUEST_ID, ATTEMPT_ID)).toBe(
      deriveSettlementId(REQUEST_ID, ATTEMPT_ID),
    );
    expect(deriveAttemptId(REQUEST_ID, 2)).toBe('attempt:req-abc-123:2');
  });
});

describe('resolveRequestId', () => {
  it('generates a UUID-shaped id when the header is absent', () => {
    const resolution = resolveRequestId(undefined);
    expect(resolution.kind).toBe('generated');
    // Narrow qua helper thay vì `if` quanh expect (vitest/no-conditional-expect).
    const generated = resolution.kind === 'generated' ? resolution.requestId : '';
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it('trims surrounding whitespace of a provided id', () => {
    const resolution = resolveRequestId('  req-7  ');
    expect(resolution).toEqual({ kind: 'provided', requestId: 'req-7' });
  });

  it('rejects an empty or whitespace-only header instead of generating silently', () => {
    expect(resolveRequestId('').kind).toBe('invalid');
    expect(resolveRequestId('   ').kind).toBe('invalid');
  });

  it('rejects a header longer than the opaque id bound', () => {
    expect(resolveRequestId('x'.repeat(201)).kind).toBe('invalid');
    expect(resolveRequestId('x'.repeat(200)).kind).toBe('provided');
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively so key order never changes the hash input', () => {
    const left = canonicalJson({ model: 'dronie-flash', messages: [{ role: 'user' }] });
    const right = canonicalJson({ messages: [{ role: 'user' }], model: 'dronie-flash' });
    expect(left).toBe(right);
  });

  it('sorts nested object keys too', () => {
    const left = canonicalJson({ a: { c: 1, b: 2 } });
    const right = canonicalJson({ a: { b: 2, c: 1 } });
    expect(left).toBe('{"a":{"b":2,"c":1}}');
    expect(right).toBe(left);
  });

  it('keeps array element order (order is meaningful in messages)', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('drops undefined fields like JSON.stringify does', () => {
    expect(canonicalJson({ keep: 1, drop: undefined })).toBe('{"keep":1}');
  });

  it('renders scalars through JSON semantics', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('validateChatRequest', () => {
  const VALID = {
    model: 'dronie-flash',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
  };

  it('accepts a minimal valid request and keeps only the served fields', () => {
    const result = validateChatRequest(VALID);
    expect(result).toEqual({
      kind: 'valid',
      request: { model: 'dronie-flash', messages: VALID.messages, maxTokens: 64 },
    });
  });

  it('accepts stream:false and a missing stream field alike', () => {
    expect(validateChatRequest({ ...VALID, stream: false }).kind).toBe('valid');
    expect(validateChatRequest(VALID).kind).toBe('valid');
  });

  it('rejects a non-object body as missing_model', () => {
    expect(failureOf(null)).toBe('missing_model');
    expect(failureOf('x')).toBe('missing_model');
    expect(failureOf([VALID])).toBe('missing_model');
  });

  it('rejects a missing or empty model as missing_model', () => {
    expect(failureOf({ messages: VALID.messages, max_tokens: 1 })).toBe('missing_model');
    expect(failureOf({ ...VALID, model: '' })).toBe('missing_model');
    expect(failureOf({ ...VALID, model: 7 })).toBe('missing_model');
  });

  it('rejects a missing or empty messages array as missing_messages', () => {
    expect(failureOf({ model: 'm', max_tokens: 1 })).toBe('missing_messages');
    expect(failureOf({ ...VALID, messages: [] })).toBe('missing_messages');
    expect(failureOf({ ...VALID, messages: 'hi' })).toBe('missing_messages');
  });

  it('rejects a message without object shape or role string as invalid_messages', () => {
    expect(failureOf({ ...VALID, messages: ['user'] })).toBe('invalid_messages');
    expect(failureOf({ ...VALID, messages: [{}] })).toBe('invalid_messages');
    expect(failureOf({ ...VALID, messages: [{ role: 1 }] })).toBe('invalid_messages');
  });

  it('rejects stream:true and any non-boolean stream as streaming_not_supported', () => {
    expect(failureOf({ ...VALID, stream: true })).toBe('streaming_not_supported');
    expect(failureOf({ ...VALID, stream: 'yes' })).toBe('streaming_not_supported');
  });

  it('rejects an absent max_tokens as max_tokens_required', () => {
    expect(failureOf({ model: 'm', messages: VALID.messages })).toBe('max_tokens_required');
    expect(failureOf({ model: 'm', messages: VALID.messages, max_tokens: null })).toBe(
      'max_tokens_required',
    );
  });

  it('rejects a non-positive, fractional or non-numeric max_tokens as invalid_max_tokens', () => {
    expect(failureOf({ model: 'm', messages: VALID.messages, max_tokens: 0 })).toBe(
      'invalid_max_tokens',
    );
    expect(failureOf({ model: 'm', messages: VALID.messages, max_tokens: -5 })).toBe(
      'invalid_max_tokens',
    );
    expect(failureOf({ model: 'm', messages: VALID.messages, max_tokens: 1.5 })).toBe(
      'invalid_max_tokens',
    );
    expect(failureOf({ model: 'm', messages: VALID.messages, max_tokens: '64' })).toBe(
      'invalid_max_tokens',
    );
  });
});

describe('estimatePromptCharacters', () => {
  it('sums string content lengths across messages', () => {
    const messages = [
      { role: 'system', content: 'abcd' },
      { role: 'user', content: 'xyz' },
    ];
    expect(estimatePromptCharacters(messages)).toBe(7);
  });

  it('sums text parts of array content and ignores non-text parts', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: 'https://x' },
          { type: 'text', text: '!' },
        ],
      },
    ];
    expect(estimatePromptCharacters(messages)).toBe(6);
  });

  it('skips malformed messages without throwing', () => {
    expect(estimatePromptCharacters([null, 7, { content: 12 }, { role: 'user' }])).toBe(0);
  });

  it('returns zero for an empty array', () => {
    expect(estimatePromptCharacters([])).toBe(0);
  });
});

describe('computeTokenBounds', () => {
  const CAPS = { maxInputTokensPerRequest: 8192n, maxOutputTokensPerRequest: 4096n };

  it('estimates the input bound as ceil(prompt characters / 2)', () => {
    expect(computeTokenBounds({ promptCharacters: 10, maxTokens: 5, ...CAPS }).inputTokens).toBe(
      5n,
    );
    expect(computeTokenBounds({ promptCharacters: 11, maxTokens: 5, ...CAPS }).inputTokens).toBe(
      6n,
    );
    expect(computeTokenBounds({ promptCharacters: 0, maxTokens: 5, ...CAPS }).inputTokens).toBe(0n);
  });

  it('takes the output bound directly from the required max_tokens', () => {
    expect(computeTokenBounds({ promptCharacters: 4, maxTokens: 64, ...CAPS }).outputTokens).toBe(
      64n,
    );
  });

  it('caps both bounds by the pricing snapshot per-request limits', () => {
    const bounds = computeTokenBounds({
      promptCharacters: 100_000,
      maxTokens: 10_000,
      ...CAPS,
    });
    expect(bounds.inputTokens).toBe(8192n);
    expect(bounds.outputTokens).toBe(4096n);
  });

  it('does not cap bounds below the snapshot limits', () => {
    const bounds = computeTokenBounds({ promptCharacters: 10, maxTokens: 10, ...CAPS });
    expect(bounds.inputTokens).toBe(5n);
    expect(bounds.outputTokens).toBe(10n);
  });
});
