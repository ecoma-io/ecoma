import { describe, expect, it } from 'vitest';
import * as publicApi from '../index';
import { ECOMA_LOGO_HORIZONTAL_SVG_URL, EcomaLogo } from '../index';

// Test qua package entrypoint: public API là contract, không phải internal
// module — consumer không bao giờ phải import thẳng `src/lib/*`.
describe('public API entrypoint', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(new Set(Object.keys(publicApi))).toEqual(
      new Set(['ECOMA_LOGO_HORIZONTAL_SVG_URL', 'EcomaLogo']),
    );
  });

  it('exposes the raw SVG URL as a non-empty string', () => {
    expect(typeof ECOMA_LOGO_HORIZONTAL_SVG_URL).toBe('string');
    expect(ECOMA_LOGO_HORIZONTAL_SVG_URL.length).toBeGreaterThan(0);
  });

  it('exposes no localization, layout or brand-decision surface', () => {
    const surface = Object.keys(publicApi).join(' ').toLowerCase();
    for (const forbidden of [
      'publiclocale',
      'parsepublicpath',
      'switchlocale',
      'navigation',
      'mount',
      'colorway',
      'stacked',
      'wordmark',
      'symbol',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('exposes the component as a component definition', () => {
    // Component definition là object — assert mạnh hơn thuộc về hành vi render
    // (ecoma-logo.spec.ts) và SSR determinism (ecoma-logo-ssr.spec.ts); đây
    // chỉ pin export không phải undefined/giá trị primitive nào khác.
    expect(EcomaLogo).toBeTypeOf('object');
    expect(EcomaLogo).not.toBeNull();
  });
});
