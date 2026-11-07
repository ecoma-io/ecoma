import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DATA_MODE_MOCK,
  ACCOUNT_DATA_MODE_REAL,
  resolveAccountDataMode,
} from './data-mode';

/**
 * Matrix quyết định chế độ dữ liệu của data domain `account`.
 *
 * Luật là fail-closed, nên test phải khẳng định mọi tổ hợp không đúng
 * (`raw === 'mock'` **và** `isDev === true`) đều rơi về `'real'`. Các giá trị
 * "gần đúng" quan trọng hơn cả: một `vars` bị gõ `Mock` hay thừa khoảng trắng
 * không được mở cổng mock, và `mock` đặt trong artifact thì càng không.
 */
describe('resolveAccountDataMode', () => {
  it('enables mock only when the value equals the specified string and the runtime is dev', () => {
    expect(resolveAccountDataMode(ACCOUNT_DATA_MODE_MOCK, true)).toBe('mock');
    expect(ACCOUNT_DATA_MODE_MOCK).toBe('mock');
    expect(ACCOUNT_DATA_MODE_REAL).toBe('real');
  });

  it('fails closed to real when the exact value appears outside nuxt dev', () => {
    // Artifact (isDev = false): ngay cả chuỗi đúng `'mock'` cũng không mở cổng —
    // đây là bất biến trung tâm của seam.
    expect(resolveAccountDataMode('mock', false)).toBe('real');
  });

  it('defaults to mock when unconfigured under nuxt dev', () => {
    expect(resolveAccountDataMode(undefined, true)).toBe('mock');
    expect(resolveAccountDataMode('', true)).toBe('mock');
  });

  it('defaults to real when unconfigured in an artifact', () => {
    expect(resolveAccountDataMode(undefined, false)).toBe('real');
    expect(resolveAccountDataMode('', false)).toBe('real');
  });

  it.each([
    ['explicit real under dev', 'real', true],
    ['explicit real in artifact', 'real', false],
    ['wrong case', 'MOCK', true],
    ['capitalised', 'Mock', true],
    ['trailing whitespace', 'mock ', true],
    ['leading whitespace', ' mock', true],
    ['misspelled', 'mok', true],
    ['unsupported synonym', 'preview', true],
    ['unsupported synonym', 'prototype', true],
    ['unrelated string', 'yes', false],
    ['another app value', 'staging', true],
  ])('%s resolves to real (fail closed)', (_label, raw, isDev) => {
    expect(resolveAccountDataMode(raw, isDev)).toBe('real');
  });

  it.each([
    ['boolean true', true],
    ['boolean false', false],
    ['number 1', 1],
    ['number 0', 0],
    ['object', { mode: 'mock' }],
    ['array', ['mock']],
  ])('non-string value %s in dev resolves to real', (_label, raw) => {
    expect(resolveAccountDataMode(raw, true)).toBe('real');
  });

  it('an object parsed from env never enables mock even under dev', () => {
    // `destr` của Nitro có thể parse JSON từ env; một object tới đây là cấu hình
    // sai kiểu, không phải cấu hình hợp lệ.
    expect(resolveAccountDataMode({ value: 'mock' }, true)).toBe('real');
  });
});
