/**
 * Ghim validation và bất biến subset của token usage.
 */

import { describe, expect, it } from 'vitest';

import { isTokenUsage, readRequestCount, readTokenUsage } from './token-usage';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

const VALID_USAGE = {
  inputTokens: 1000,
  cachedTokens: 200,
  outputTokens: 500,
  reasoningTokens: 100,
} as const;

describe('readTokenUsage', () => {
  it('reads a complete usage record into bigint counts', () => {
    const usage = expectOk(readTokenUsage(VALID_USAGE));
    expect(usage).toEqual({
      inputTokens: 1000n,
      cachedTokens: 200n,
      outputTokens: 500n,
      reasoningTokens: 100n,
    });
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it('accepts zero counts and the exact subset boundaries', () => {
    expect(
      expectOk(
        readTokenUsage({
          inputTokens: 10,
          cachedTokens: 10,
          outputTokens: 5,
          reasoningTokens: 5,
        }),
      ),
    ).toEqual({
      inputTokens: 10n,
      cachedTokens: 10n,
      outputTokens: 5n,
      reasoningTokens: 5n,
    });
    expect(
      expectOk(
        readTokenUsage({
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        }),
      ),
    ).toEqual({ inputTokens: 0n, cachedTokens: 0n, outputTokens: 0n, reasoningTokens: 0n });
  });

  it('accepts bigint and decimal string counts', () => {
    expect(
      expectOk(
        readTokenUsage({
          inputTokens: 10n,
          cachedTokens: '0',
          outputTokens: '20',
          reasoningTokens: 0n,
        }),
      ),
    ).toEqual({
      inputTokens: 10n,
      cachedTokens: 0n,
      outputTokens: 20n,
      reasoningTokens: 0n,
    });
  });

  it('rejects a missing category instead of treating it as zero', () => {
    expect(
      expectRejection(readTokenUsage({ cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 })),
    ).toEqual('incomplete_usage');
    expect(
      expectRejection(readTokenUsage({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0 })),
    ).toEqual('incomplete_usage');
    expect(
      expectRejection(readTokenUsage({ inputTokens: 0, cachedTokens: 0, reasoningTokens: 0 })),
    ).toEqual('incomplete_usage');
    expect(
      expectRejection(readTokenUsage({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 })),
    ).toEqual('incomplete_usage');
  });

  it('rejects negative, fractional and unsafe counts', () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, '1.5', Number.NaN]) {
      expect(expectRejection(readTokenUsage({ ...VALID_USAGE, inputTokens: value }))).toEqual(
        'invalid_usage',
      );
    }
  });

  it('rejects a cached count above the input count', () => {
    expect(expectRejection(readTokenUsage({ ...VALID_USAGE, cachedTokens: 1001 }))).toEqual(
      'token_subset_violation',
    );
  });

  it('rejects a reasoning count above the output count', () => {
    expect(expectRejection(readTokenUsage({ ...VALID_USAGE, reasoningTokens: 501 }))).toEqual(
      'token_subset_violation',
    );
  });

  it('rejects a non-record payload', () => {
    expect(expectRejection(readTokenUsage(null))).toEqual('invalid_usage');
    expect(expectRejection(readTokenUsage('1000'))).toEqual('invalid_usage');
  });
});

describe('isTokenUsage', () => {
  it('accepts a normalized bigint record and rejects a subset violation', () => {
    expect(isTokenUsage(expectOk(readTokenUsage(VALID_USAGE)))).toBe(true);
    expect(isTokenUsage({ ...VALID_USAGE, cachedTokens: 2000 })).toBe(false);
    expect(isTokenUsage(null)).toBe(false);
  });

  it('rejects a record whose fields are not bigint', () => {
    // Guard phải khớp đúng kiểu mà chữ ký hứa: một object mang `number` hay
    // chuỗi mà guard nhận sẽ khiến TypeScript narrow sai, và phép nhân tiền sau
    // đó ném `TypeError` thay vì trả domain error.
    expect(isTokenUsage(VALID_USAGE)).toBe(false);
    expect(
      isTokenUsage({
        inputTokens: '1000',
        cachedTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
      }),
    ).toBe(false);
    expect(
      isTokenUsage({ inputTokens: -1n, cachedTokens: 0n, outputTokens: 0n, reasoningTokens: 0n }),
    ).toBe(false);
  });
});

describe('readRequestCount', () => {
  it('accepts zero and positive integer counts', () => {
    expect(expectOk(readRequestCount(0))).toEqual(0n);
    expect(expectOk(readRequestCount(3))).toEqual(3n);
    expect(expectOk(readRequestCount('3'))).toEqual(3n);
  });

  it('rejects negative, fractional and missing counts', () => {
    for (const value of [-1, 1.5, Number.NaN, undefined, null, 'three']) {
      expect(expectRejection(readRequestCount(value))).toEqual('invalid_usage');
    }
  });
});
