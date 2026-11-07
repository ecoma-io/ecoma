import { describe, it, expect, expectTypeOf } from 'vitest';
import { parsePublicPath } from '../index';

describe('parsePublicPath', () => {
  describe('root', () => {
    it('treats "/" as its own success state with path "/"', () => {
      expect(parsePublicPath('/')).toEqual({ kind: 'root', path: '/' });
    });
  });

  describe('valid localized paths', () => {
    it.each([
      ['/en', 'en', ''],
      ['/vi', 'vi', ''],
      ['/en/blog', 'en', '/blog'],
      ['/vi/blog', 'vi', '/blog'],
      ['/en/docs/api', 'en', '/docs/api'],
      ['/vi/docs/api/foo', 'vi', '/docs/api/foo'],
    ])('parses %s as locale %s with remainder %s', (pathname, locale, remainder) => {
      expect(parsePublicPath(pathname)).toEqual({
        kind: 'localized',
        locale,
        path: pathname,
        remainder,
      });
    });
  });

  describe('missing locale', () => {
    it.each(['/blog', '/docs/api', '/foo/bar'])(
      'rejects %s because the first segment is not a supported locale',
      (pathname) => {
        expect(parsePublicPath(pathname)).toEqual({
          kind: 'invalid',
          reason: 'unsupported_locale',
        });
      },
    );
  });

  describe('locale in wrong position', () => {
    it.each(['/blog/vi', '/docs/api/vi'])(
      'rejects %s because only the first segment can be a locale',
      (pathname) => {
        expect(parsePublicPath(pathname)).toEqual({
          kind: 'invalid',
          reason: 'unsupported_locale',
        });
      },
    );

    it('keeps a locale-like deeper segment as part of the remainder', () => {
      expect(parsePublicPath('/vi/en')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi/en',
        remainder: '/en',
      });
      expect(parsePublicPath('/en/blog/en/vi')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/blog/en/vi',
        remainder: '/blog/en/vi',
      });
    });
  });

  describe('unsupported locale', () => {
    it.each(['/fr', '/ja/blog'])('rejects %s as unsupported locale', (pathname) => {
      expect(parsePublicPath(pathname)).toEqual({ kind: 'invalid', reason: 'unsupported_locale' });
    });
  });

  describe('case sensitivity', () => {
    it.each(['/EN/blog', '/Vi/blog', '/EN'])(
      'never case-folds %s: unsupported locale, never recognized as en or vi',
      (pathname) => {
        expect(parsePublicPath(pathname)).toEqual({
          kind: 'invalid',
          reason: 'unsupported_locale',
        });
      },
    );

    it('only the first segment decides the locale: deeper case is preserved', () => {
      expect(parsePublicPath('/vi/Vi')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi/Vi',
        remainder: '/Vi',
      });
      expect(parsePublicPath('/en/BLOG')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/BLOG',
        remainder: '/BLOG',
      });
    });
  });

  describe('trailing slash', () => {
    it.each(['/en/', '/vi/blog/', '/en/docs/api/', '/blog/'])(
      'rejects %s with trailing_slash instead of stripping it',
      (pathname) => {
        expect(parsePublicPath(pathname)).toEqual({ kind: 'invalid', reason: 'trailing_slash' });
      },
    );
  });

  describe('empty segments', () => {
    it.each(['/en//blog', '/vi//docs', '/en//', '//', '///'])(
      'rejects %s with empty_segment',
      (pathname) => {
        expect(parsePublicPath(pathname)).toEqual({ kind: 'invalid', reason: 'empty_segment' });
      },
    );

    it('never collapses "//" into the root state', () => {
      expect(parsePublicPath('//').kind).toBe('invalid');
    });
  });

  describe('canonical boundary', () => {
    it.each(['/enabled', '/en-US', '/en_GB', '/env', '/english', '/en-GB/blog'])(
      'does not recognize %s as locale "en"',
      (pathname) => {
        expect(parsePublicPath(pathname)).toEqual({
          kind: 'invalid',
          reason: 'unsupported_locale',
        });
      },
    );

    it('matches the locale only at an exact segment boundary', () => {
      expect(parsePublicPath('/en/blogging')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/blogging',
        remainder: '/blogging',
      });
    });
  });

  describe('success invariants', () => {
    it.each(['/en', '/vi', '/en/blog', '/vi/docs/api/foo', '/en/caf%C3%A9'])(
      'emits path equal to "/" + locale + remainder for %s',
      (pathname) => {
        const result = parsePublicPath(pathname);
        if (result.kind !== 'localized') {
          throw new Error(`expected localized for ${pathname}, got ${result.kind}`);
        }
        expect(result.path).toBe(`/${result.locale}${result.remainder}`);
        expect(result.path).toBe(pathname);
        expect(result.path.endsWith('/')).toBe(false);
      },
    );
  });

  describe('reason partition', () => {
    it('never returns not_localized or already_localized: those reasons belong to other functions', () => {
      // not_localized là của switchLocale; already_localized là của localizePath.
      // parse chỉ phân loại, không đổi và không dựng path.
      const inputs = [
        '/',
        '/en',
        '/blog',
        '/fr/blog',
        '/en//blog',
        '/en/',
        '',
        'en/blog',
        '/en/blog?x=1',
      ] as const;
      const observed = new Set(
        inputs.map((input) => {
          const result = parsePublicPath(input);
          return result.kind === 'invalid' ? result.reason : result.kind;
        }),
      );
      expect(observed.has('not_localized')).toBe(false);
      expect(observed.has('already_localized')).toBe(false);
    });
  });

  describe('type safety', () => {
    it('rejects non-string arguments at compile time', () => {
      // @ts-expect-error -- pathname phải là string
      expect(() => parsePublicPath(123)).not.toThrow();
    });

    it('narrows the discriminated result without any cast', () => {
      const result = parsePublicPath('/en/blog');
      if (result.kind !== 'localized') {
        throw new Error('expected localized');
      }
      expectTypeOf(result.locale).toEqualTypeOf<import('../index').PublicLocale>();
      expect(result.locale).toBe('en');
      expect(result.remainder).toBe('/blog');
    });
  });
});
