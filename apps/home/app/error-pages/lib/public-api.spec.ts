import { describe, it, expect } from 'vitest';
import * as publicApi from '../index';
import { ForbiddenPage, NotFoundPage } from '../index';

// Test qua package entrypoint: public API là contract, không phải internal
// module — consumer không bao giờ phải import thẳng `src/lib/*`.
describe('public API entrypoint', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(new Set(Object.keys(publicApi))).toEqual(new Set(['ForbiddenPage', 'NotFoundPage']));
  });

  it('exposes no ownership surface outside error presentation', () => {
    // Library là pure presenter: không sở hữu locale, routing, HTTP status
    // hay nội dung. Ký hiệu bị cấm dưới đây là các "từ khóa sở hữu" — nếu
    // xuất hiện trên API nghĩa là library đang lấn ranh giới của app
    // (locale policy), Nuxt (routing) hay seam HTTP (status).
    const surface = Object.keys(publicApi).join(' ').toLowerCase();
    for (const forbidden of ['locale', 'route', 'path', 'status', 'http', 'nuxt']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('exports both pages as components', () => {
    // Component object của Vue SFC: có `render` (compiled) hoặc setup state.
    expect(typeof NotFoundPage).toBe('object');
    expect(typeof ForbiddenPage).toBe('object');
    expect(NotFoundPage).not.toBe(ForbiddenPage);
  });
});
