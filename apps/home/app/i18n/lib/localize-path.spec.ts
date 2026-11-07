import { describe, it, expect } from 'vitest';
import { localizePath, type PublicLocale, type PublicPathResult } from '../index';

/**
 * Assert một kết quả là `localized` và trả về nó để tiếp tục assert.
 *
 * Dùng throw-guard thay vì `expect` trong nhánh `if` — rule
 * `vitest/no-conditional-expect` cấm expect có điều kiện.
 */
function expectLocalized(
  result: PublicPathResult,
): Extract<PublicPathResult, { kind: 'localized' }> {
  if (result.kind !== 'localized') {
    throw new Error(`expected localized, got ${result.kind} (${JSON.stringify(result)})`);
  }
  return result;
}

describe('localizePath', () => {
  describe('documented examples', () => {
    it('localizes the root "/" to "/<locale>"', () => {
      expect(localizePath('en', '/')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en',
        remainder: '',
      });
      expect(localizePath('vi', '/')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi',
        remainder: '',
      });
    });

    it.each([
      ['en', '/blog', '/en/blog'],
      ['vi', '/blog/foo', '/vi/blog/foo'],
      ['vi', '/docs/api', '/vi/docs/api'],
      ['en', '/docs/api', '/en/docs/api'],
    ] as const)('localizePath(%s, %s) => %s', (locale, pathname, expected) => {
      const result = expectLocalized(localizePath(locale, pathname));
      expect(result.path).toBe(expected);
      expect(result.remainder).toBe(pathname);
    });
  });

  describe('double-localization prevention', () => {
    it.each([
      ['vi', '/en/blog'],
      ['en', '/vi/blog'],
      ['vi', '/en'],
      ['en', '/vi'],
      ['vi', '/vi/x'],
    ] as const)('rejects localizePath(%s, %s) with already_localized', (locale, pathname) => {
      expect(localizePath(locale, pathname)).toEqual({
        kind: 'invalid',
        reason: 'already_localized',
      });
    });

    it('never emits "/vi/en/blog" for localizePath("vi", "/en/blog")', () => {
      const result = localizePath('vi', '/en/blog');
      expect(result).toEqual({ kind: 'invalid', reason: 'already_localized' });
      expect(JSON.stringify(result)).not.toContain('/vi/en/blog');
    });

    it('is intentionally not idempotent: feeding its own output back fails', () => {
      const first = expectLocalized(localizePath('vi', '/blog'));
      expect(first.path).toBe('/vi/blog');
      expect(localizePath('vi', first.path)).toEqual({
        kind: 'invalid',
        reason: 'already_localized',
      });
    });
  });

  describe('non-locale lookalike remainders are accepted', () => {
    it.each([
      ['/fr/blog', '/vi/fr/blog'],
      ['/freight', '/vi/freight'],
      ['/%65n/blog', '/vi/%65n/blog'],
    ])('keeps %s as an ordinary remainder and emits %s', (pathname, expected) => {
      const result = expectLocalized(localizePath('vi', pathname));
      expect(result.path).toBe(expected);
    });
  });

  describe('invalid input', () => {
    it.each([
      ['empty string', ''],
      ['missing leading slash', 'blog'],
      ['leading whitespace', ' /blog'],
      ['query string', '/blog?x=1'],
      ['hash', '/blog#h'],
    ])('rejects %s with not_a_pathname', (_label, pathname) => {
      expect(localizePath('vi', pathname)).toEqual({ kind: 'invalid', reason: 'not_a_pathname' });
    });

    it.each(['/blog/', '/docs/api/'])(
      'rejects trailing slash %s instead of stripping',
      (pathname) => {
        expect(localizePath('vi', pathname)).toEqual({ kind: 'invalid', reason: 'trailing_slash' });
      },
    );

    it.each(['/blog//x', '//'])('rejects empty segment %s with empty_segment', (pathname) => {
      expect(localizePath('vi', pathname)).toEqual({ kind: 'invalid', reason: 'empty_segment' });
    });

    it('classifies malformed localized paths by structure before the locale check', () => {
      // Ba input cùng prefix /en nhưng ba meaning khác nhau — structure trước,
      // locale sau: input hỏng không bao giờ bị gắn nhãn already_localized.
      expect(localizePath('vi', '/en//blog')).toEqual({
        kind: 'invalid',
        reason: 'empty_segment',
      });
      expect(localizePath('vi', '/en/')).toEqual({
        kind: 'invalid',
        reason: 'trailing_slash',
      });
      expect(localizePath('vi', '/en/blog')).toEqual({
        kind: 'invalid',
        reason: 'already_localized',
      });
    });

    it('checks the target locale before the source: both bad still reports unsupported_locale', () => {
      // Step 1 của precedence là target guard — lỗi locale đích không bao giờ
      // bị che bởi lỗi cấu trúc hay locale của source.
      expect(localizePath('fr' as unknown as PublicLocale, '/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(localizePath('fr' as unknown as PublicLocale, '')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(localizePath('fr' as unknown as PublicLocale, '/en//blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('never returns not_localized: that reason belongs to switchLocale alone', () => {
      const inputs = ['/', '/blog', '/en/blog', '/en//blog', '/en/', '', 'blog'] as const;
      const observed = new Set(
        inputs.map((input) => {
          const result = localizePath('vi', input);
          return result.kind === 'invalid' ? result.reason : result.kind;
        }),
      );
      expect(observed.has('not_localized')).toBe(false);
    });

    it('rejects an unsupported target locale even when cast at runtime', () => {
      expect(localizePath('fr' as unknown as PublicLocale, '/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(localizePath('EN' as unknown as PublicLocale, '/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('rejects a non-string pathname with not_a_pathname at runtime', () => {
      expect(localizePath('vi', undefined as unknown as string)).toEqual({
        kind: 'invalid',
        reason: 'not_a_pathname',
      });
    });
  });

  describe('preservation', () => {
    it('never trims, decodes or case-folds the remainder', () => {
      expect(expectLocalized(localizePath('vi', '/blog ')).path).toBe('/vi/blog ');
      expect(expectLocalized(localizePath('en', '/caf%C3%A9')).path).toBe('/en/caf%C3%A9');
      expect(expectLocalized(localizePath('vi', '/blog/tạm')).path).toBe('/vi/blog/tạm');
    });

    it('emits path equal to "/" + locale + pathname for every valid input', () => {
      for (const pathname of ['/', '/blog', '/docs/api/foo', '/a;b,c', '/enabled']) {
        for (const locale of ['en', 'vi'] as const) {
          const result = expectLocalized(localizePath(locale, pathname));
          expect(result.path).toBe(`/${locale}${pathname === '/' ? '' : pathname}`);
          expect(result.path.endsWith('/')).toBe(false);
        }
      }
    });
  });

  describe('type safety', () => {
    it('rejects unsupported locale literals at compile time', () => {
      // @ts-expect-error -- 'fr' không thuộc PublicLocale union
      expect(() => localizePath('fr', '/blog')).not.toThrow();
    });

    it('rejects a missing argument at compile time', () => {
      // @ts-expect-error -- cần đúng hai tham số
      expect(() => localizePath('vi')).not.toThrow();
    });
  });
});
