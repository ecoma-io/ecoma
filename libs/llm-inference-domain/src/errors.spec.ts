/**
 * Ghim taxonomy domain error: factory đọc đúng bảng message, guard không nhận
 * code từ prototype chain, message là English, và error không mang payload.
 */

import { describe, expect, it } from 'vitest';

import {
  INFERENCE_DOMAIN_ERROR_MESSAGES,
  inferenceDomainError,
  isInferenceDomainError,
  type InferenceDomainErrorCode,
} from './errors';

const CODES = Object.keys(INFERENCE_DOMAIN_ERROR_MESSAGES) as InferenceDomainErrorCode[];

describe('inferenceDomainError', () => {
  it('pairs every declared code with its table message', () => {
    for (const code of CODES) {
      const error = inferenceDomainError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(INFERENCE_DOMAIN_ERROR_MESSAGES[code]);
    }
  });

  it('keeps every message in English', () => {
    for (const message of Object.values(INFERENCE_DOMAIN_ERROR_MESSAGES)) {
      expect(message).toMatch(/^[A-Z][\x20-\x7e]*\.$/u);
    }
  });

  it('carries no field besides code and message', () => {
    for (const code of CODES) {
      expect(Object.keys(inferenceDomainError(code)).toSorted()).toEqual(['code', 'message']);
    }
  });

  it('rejects a code outside the taxonomy', () => {
    expect(() => inferenceDomainError('not_a_code' as InferenceDomainErrorCode)).toThrow(TypeError);
  });

  it('rejects prototype-chain keys', () => {
    for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() => inferenceDomainError(code as InferenceDomainErrorCode)).toThrow(TypeError);
    }
  });

  it('produces a fresh, non-shared object each time', () => {
    const first = inferenceDomainError('request_closed');
    const second = inferenceDomainError('request_closed');
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe('isInferenceDomainError', () => {
  it('accepts every error produced by the factory', () => {
    for (const code of CODES) {
      expect(isInferenceDomainError(inferenceDomainError(code))).toBe(true);
    }
  });

  it('rejects objects with a prototype-chain code', () => {
    expect(isInferenceDomainError({ code: 'toString', message: 'x' })).toBe(false);
    expect(isInferenceDomainError({ code: 'constructor', message: 'x' })).toBe(false);
  });

  it('rejects extra payload fields', () => {
    expect(
      isInferenceDomainError({ code: 'request_closed', message: 'x', requestId: 'req_1' }),
    ).toBe(false);
  });

  it('rejects non-object values', () => {
    for (const value of [null, undefined, 'request_closed', 42, []]) {
      expect(isInferenceDomainError(value)).toBe(false);
    }
  });
});
