import { describe, expect, it } from 'vitest';

import {
  BACKOFFICE_PREVIEW_DATA_MODE,
  BACKOFFICE_REALTIME_DATA_MODE,
  resolveBackofficeDataMode,
} from './data-mode';

/**
 * Matrix quyết định chế độ dữ liệu.
 *
 * Luật là fail-closed, nên test phải khẳng định **mọi** giá trị không đúng chuỗi
 * `'prototype'` đều rơi vào `'unavailable'`. Các giá trị "gần đúng" quan trọng
 * hơn cả: một `vars` bị gõ `Prototype` hay thừa khoảng trắng không được mở cổng
 * mock ở Production.
 */
describe('resolveBackofficeDataMode', () => {
  it('enables prototype only when the value equals the specified string exactly', () => {
    expect(resolveBackofficeDataMode(BACKOFFICE_PREVIEW_DATA_MODE)).toBe('prototype');
    expect(BACKOFFICE_PREVIEW_DATA_MODE).toBe('prototype');
  });

  it('enables realtime only when the value equals the specified string exactly', () => {
    expect(resolveBackofficeDataMode(BACKOFFICE_REALTIME_DATA_MODE)).toBe('realtime');
    expect(BACKOFFICE_REALTIME_DATA_MODE).toBe('realtime');
  });

  it('fails closed when configuration is missing', () => {
    expect(resolveBackofficeDataMode(undefined)).toBe('unavailable');
    expect(resolveBackofficeDataMode(null)).toBe('unavailable');
  });

  it.each([
    ['chuỗi rỗng', ''],
    ['giá trị disabled tường minh', 'disabled'],
    ['sai hoa/thường', 'PROTOTYPE'],
    ['viết hoa chữ đầu', 'Prototype'],
    ['thừa khoảng trắng', 'prototype '],
    ['từ đồng nghĩa không được hỗ trợ', 'preview'],
    ['từ đồng nghĩa không được hỗ trợ', 'mock'],
    ['chuỗi boolean', 'true'],
    ['giá trị không liên quan', 'yes'],
    ['giá trị của app khác', 'staging'],
  ])('chuỗi %s → unavailable', (_label, raw) => {
    expect(resolveBackofficeDataMode(raw)).toBe('unavailable');
  });

  it.each([
    ['boolean true', true],
    ['boolean false', false],
    ['số 1', 1],
    ['số 0', 0],
    ['object', { mode: 'prototype' }],
    ['array', ['prototype']],
  ])('giá trị không phải chuỗi (%s) → unavailable', (_label, raw) => {
    expect(resolveBackofficeDataMode(raw)).toBe('unavailable');
  });

  it('an object that looks like valid configuration still does not enable prototype', () => {
    // `destr` của Nitro có thể parse JSON từ env; một object tới đây là cấu hình
    // sai kiểu, không phải cấu hình hợp lệ.
    expect(resolveBackofficeDataMode({ value: 'prototype' })).toBe('unavailable');
  });
});
