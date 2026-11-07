import { describe, expect, it } from 'vitest';

import { isLegalRoute, parseLegalRoute } from './legal-locale';

/**
 * Ma trận hợp lệ/không hợp lệ của bề mặt legal — tách khỏi route để test mà
 * không cần dựng Nuxt runtime (same pattern với blog-routing.spec.ts cũ).
 *
 * `validate` của route chỉ nhận topology; "slug có tồn tại" là việc của
 * content query + middleware gate, KHÔNG của parser — test ghim đúng ranh
 * giới đó: `/en/legal/unknown` hợp lệ về topology.
 */

describe('parseLegalRoute', () => {
  it('accepts the legal landing and legal documents in both locales', () => {
    expect(parseLegalRoute('/en/legal')).toEqual({
      locale: 'en',
      path: '/en/legal',
      remainder: '',
    });
    expect(parseLegalRoute('/vi/legal')).toEqual({
      locale: 'vi',
      path: '/vi/legal',
      remainder: '',
    });
    expect(parseLegalRoute('/en/legal/privacy')).toEqual({
      locale: 'en',
      path: '/en/legal/privacy',
      remainder: '/privacy',
    });
    expect(parseLegalRoute('/vi/legal/refund')).toEqual({
      locale: 'vi',
      path: '/vi/legal/refund',
      remainder: '/refund',
    });
  });

  it('rejects non-legal mounts and unknown locales', () => {
    for (const pathname of [
      '/en/docs',
      '/en/blog/url-model',
      '/fr/legal',
      '/EN/legal',
      '/legal/privacy',
      '/',
      '/en',
    ]) {
      expect([pathname, parseLegalRoute(pathname)]).toEqual([expect.any(String), null]);
    }
  });

  it('rejects non-canonical pathname shapes', () => {
    for (const pathname of ['/en/legal/', '/en//legal/privacy', '/en/legal/privacy/x']) {
      expect([pathname, parseLegalRoute(pathname)]).toEqual([expect.any(String), null]);
    }
  });

  it('accepts an unknown slug as topologically valid (content decides existence)', () => {
    // Ranh giới với registry cũ: slug lạ là câu hỏi của content query/middleware
    // gate, không phải parser. Production path lạ bị gate 404 trước khi tới
    // route; parser chỉ bảo đảm cấu trúc URL đúng.
    expect(parseLegalRoute('/en/legal/unknown')?.remainder).toBe('/unknown');
  });
});

describe('isLegalRoute', () => {
  it('mirrors parseLegalRoute !== null', () => {
    expect(isLegalRoute('/en/legal')).toBe(true);
    expect(isLegalRoute('/vi/legal/terms')).toBe(true);
    expect(isLegalRoute('/en/legal/')).toBe(false);
    expect(isLegalRoute('/fr/legal')).toBe(false);
  });
});
