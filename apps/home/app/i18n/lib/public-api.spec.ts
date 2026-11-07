import { describe, it, expect } from 'vitest';
import * as publicApi from '../index';
import { localizePath, parsePublicPath, switchLocale, type PublicPathResult } from '../index';

/** Throw-guard: assert kết quả là `localized` và trả về nó (không expect trong nhánh if). */
function expectLocalized(
  result: PublicPathResult,
): Extract<PublicPathResult, { kind: 'localized' }> {
  if (result.kind !== 'localized') {
    throw new Error(`expected localized, got ${result.kind} (${JSON.stringify(result)})`);
  }
  return result;
}

// Test qua package entrypoint: public API là contract, không phải internal
// module — consumer không bao giờ phải import thẳng `src/lib/*`.
describe('public API entrypoint', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(new Set(Object.keys(publicApi))).toEqual(
      new Set([
        'PUBLIC_LOCALES',
        'getLocaleDefinition',
        'isPublicLocale',
        'localizePath',
        'parsePublicPath',
        'switchLocale',
      ]),
    );
  });

  it('exposes no locale inference surface (no headers, IP, cookie, hostname)', () => {
    const surface = Object.keys(publicApi).join(' ').toLowerCase();
    for (const forbidden of ['header', 'accept', 'cookie', 'ip', 'host', 'browser', 'navigator']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('does not expose mount or app knowledge', () => {
    const surface = Object.keys(publicApi).join(' ').toLowerCase();
    expect(surface).not.toContain('mount');
    expect(surface).not.toContain('app');
  });

  describe('cross-function consistency', () => {
    const localizedPaths = [
      '/en',
      '/vi',
      '/en/blog',
      '/vi/blog',
      '/en/docs/api/foo',
      '/vi/caf%C3%A9',
    ] as const;

    it.each(localizedPaths)(
      'round-trips %s: localize(parse.remainder) rebuilds the same path',
      (pathname) => {
        const parsed = expectLocalized(parsePublicPath(pathname));
        // Locale root có remainder '' — input hợp lệ duy nhất của localizePath
        // cho resource root là '/' (contract: '' là not_a_pathname).
        const source = parsed.remainder === '' ? '/' : parsed.remainder;
        expect(expectLocalized(localizePath(parsed.locale, source)).path).toBe(pathname);
      },
    );

    it.each(localizedPaths)('switching %s to the other locale keeps the remainder', (pathname) => {
      const parsed = expectLocalized(parsePublicPath(pathname));
      const target = parsed.locale === 'en' ? ('vi' as const) : ('en' as const);
      const switched = expectLocalized(switchLocale(pathname, target));
      expect(switched.remainder).toBe(parsed.remainder);
      expect(switched.path).toBe(`/${target}${parsed.remainder}`);
      const reparsed = expectLocalized(parsePublicPath(switched.path));
      expect(reparsed.locale).toBe(target);
      expect(reparsed.remainder).toBe(parsed.remainder);
    });

    it('every localized success satisfies path = "/" + locale + remainder', () => {
      const results = [
        parsePublicPath('/en/blog'),
        localizePath('vi', '/docs'),
        switchLocale('/vi/blog', 'en'),
        switchLocale('/en', 'vi'),
        localizePath('vi', '/'),
      ];
      for (const result of results) {
        const localized = expectLocalized(result);
        expect(localized.path).toBe(`/${localized.locale}${localized.remainder}`);
        expect(localized.path.startsWith('/')).toBe(true);
        expect(localized.path.endsWith('/')).toBe(false);
      }
    });
  });

  describe('no shared mutable state', () => {
    it('registry content is identical before and after the whole suite', () => {
      expect(publicApi.PUBLIC_LOCALES).toEqual([
        { code: 'en', hreflang: 'en' },
        { code: 'vi', hreflang: 'vi-VN' },
      ]);
    });

    it('failed lookups do not grow or alter the registry', () => {
      publicApi.getLocaleDefinition('fr');
      publicApi.getLocaleDefinition('xx-long-unsupported');
      expect(publicApi.PUBLIC_LOCALES).toHaveLength(2);
    });
  });
});
