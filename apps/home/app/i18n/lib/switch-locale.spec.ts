import { describe, it, expect } from 'vitest';
import { switchLocale, type PublicLocale, type PublicPathResult } from '../index';

/** Throw-guard: assert kết quả là `localized` và trả về nó (không expect trong nhánh if). */
function expectLocalized(
  result: PublicPathResult,
): Extract<PublicPathResult, { kind: 'localized' }> {
  if (result.kind !== 'localized') {
    throw new Error(`expected localized, got ${result.kind} (${JSON.stringify(result)})`);
  }
  return result;
}

describe('switchLocale', () => {
  describe('documented examples', () => {
    it.each([
      ['/en/blog/foo', 'vi', '/vi/blog/foo'],
      ['/vi/blog/foo', 'en', '/en/blog/foo'],
      ['/vi/docs/api', 'en', '/en/docs/api'],
      ['/en/docs/api/foo', 'vi', '/vi/docs/api/foo'],
      ['/en', 'vi', '/vi'],
      ['/vi', 'en', '/en'],
    ] as const)('switchLocale(%s, %s) => %s', (pathname, locale, expected) => {
      expect(expectLocalized(switchLocale(pathname, locale)).path).toBe(expected);
    });
  });

  describe('path preservation', () => {
    it('preserves a deep remainder byte-for-byte', () => {
      expect(switchLocale('/en/docs/api/v1/resources', 'vi')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi/docs/api/v1/resources',
        remainder: '/docs/api/v1/resources',
      });
    });

    it('preserves percent-encoded and unicode remainders verbatim', () => {
      expect(expectLocalized(switchLocale('/en/caf%C3%A9', 'vi')).path).toBe('/vi/caf%C3%A9');
      expect(expectLocalized(switchLocale('/en/blog/tạm', 'vi')).path).toBe('/vi/blog/tạm');
    });

    it('keeps locale-like deeper segments untouched', () => {
      const result = expectLocalized(switchLocale('/vi/en', 'en'));
      expect(result.path).toBe('/en/en');
      expect(result.remainder).toBe('/en');
    });
  });

  describe('root', () => {
    it('never turns "/" into "/vi": root carries no locale to switch', () => {
      expect(switchLocale('/', 'vi')).toEqual({ kind: 'invalid', reason: 'not_localized' });
      expect(switchLocale('/', 'en')).toEqual({ kind: 'invalid', reason: 'not_localized' });
    });
  });

  describe('idempotence', () => {
    it('switching to the same locale returns the same path', () => {
      expect(switchLocale('/en/blog', 'en')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/blog',
        remainder: '/blog',
      });
      expect(switchLocale('/vi', 'vi')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi',
        remainder: '',
      });
    });
  });

  describe('invalid source paths', () => {
    it.each([
      ['/blog', 'not_localized'],
      ['/fr/blog', 'not_localized'],
      ['/EN/blog', 'not_localized'],
      ['/enabled', 'not_localized'],
      ['/en/blog/', 'trailing_slash'],
      ['/en//blog', 'empty_segment'],
      ['/en/blog?x=1', 'not_a_pathname'],
      ['', 'not_a_pathname'],
      ['en/blog', 'not_a_pathname'],
    ] as const)('switchLocale(%s, "vi") => invalid/%s', (pathname, reason) => {
      expect(switchLocale(pathname, 'vi')).toEqual({ kind: 'invalid', reason });
    });

    it('never repairs an unprefixed source into a localized one', () => {
      const result = switchLocale('/blog', 'vi');
      expect(result).toEqual({ kind: 'invalid', reason: 'not_localized' });
      expect(JSON.stringify(result)).not.toContain('/vi/blog');
    });
  });

  describe('error reason semantics', () => {
    it('distinguishes an unsupported target locale from a source that is not localized', () => {
      // Target 'fr' không có trong registry — nguồn vẫn valid.
      expect(switchLocale('/en/blog', 'fr' as unknown as PublicLocale)).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      // Target 'vi' supported hoàn toàn — vấn đề là source không mang locale.
      expect(switchLocale('/', 'vi')).toEqual({ kind: 'invalid', reason: 'not_localized' });
      expect(switchLocale('/blog', 'vi')).toEqual({ kind: 'invalid', reason: 'not_localized' });
      expect(switchLocale('/fr/blog', 'vi')).toEqual({ kind: 'invalid', reason: 'not_localized' });
    });

    it('uses unsupported_locale only for the target: source failures never produce it', () => {
      const nonLocalizedSources = ['/', '/blog', '/fr/blog', '/EN/blog', '/enabled'] as const;
      for (const source of nonLocalizedSources) {
        const result = switchLocale(source, 'vi');
        expect(result).toEqual({ kind: 'invalid', reason: 'not_localized' });
      }
    });

    it('checks the target locale before the source: both bad still reports unsupported_locale', () => {
      expect(switchLocale('/blog', 'fr' as unknown as PublicLocale)).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('never returns already_localized: that reason belongs to localizePath', () => {
      // switch là operation duy nhất được phép thay thế locale, nên input đã
      // localized là input hợp lệ của nó — không bao giờ bị từ chối bằng
      // already_localized.
      const sources = ['/', '/blog', '/en/blog', '/vi', '/en//blog', '/en/', ''] as const;
      const observed = new Set(
        sources.map((source) => {
          const result = switchLocale(source, 'vi');
          return result.kind === 'invalid' ? result.reason : result.kind;
        }),
      );
      expect(observed.has('already_localized')).toBe(false);
    });
  });

  describe('invalid target locale', () => {
    it('rejects an unsupported target locale even when cast at runtime', () => {
      expect(switchLocale('/en/blog', 'fr' as unknown as PublicLocale)).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });
  });

  describe('type safety', () => {
    it('rejects unsupported locale literals at compile time', () => {
      // @ts-expect-error -- 'de' không thuộc PublicLocale union
      expect(() => switchLocale('/en/blog', 'de')).not.toThrow();
    });

    it('rejects a non-string pathname argument at compile time', () => {
      // @ts-expect-error -- pathname phải là string
      expect(() => switchLocale(42, 'vi')).not.toThrow();
    });
  });
});
