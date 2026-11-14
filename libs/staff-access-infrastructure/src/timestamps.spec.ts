import { describe, expect, it } from 'vitest';

import { iso, isoNullable } from './timestamps';

/**
 * `timestamps.ts` — bề mặt chuẩn hoá `timestamptz` dùng chung giữa repository
 * và route layer. Contract wire chỉ chấp nhận ISO 8601 string, nên helper phải
 * chuyển `Date` (thứ `postgres.js` thật sự trả cho OID 1184) và giữ nguyên
 * string đã đúng (chế độ text của driver).
 */
describe('timestamp normalisation', () => {
  it('serialises a Date as an ISO 8601 string', () => {
    expect(iso(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05.678Z');
  });

  it('passes an already-stringified timestamp through unchanged', () => {
    expect(iso('2026-01-02T03:04:05.678+00:00')).toBe('2026-01-02T03:04:05.678+00:00');
  });

  it('keeps null for nullable columns', () => {
    expect(isoNullable(null)).toBeNull();
  });

  it('normalises a non-null nullable column', () => {
    expect(isoNullable(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05.678Z');
  });
});
