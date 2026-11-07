import { describe, it, expect } from 'vitest';
import { buildPublicPath, type PublicLayoutPathInput, type PublicLayoutPathResult } from '../index';

/** Kết quả build thành công: locale-root hoặc localized — không bao giờ root. */
type BuiltPath = Extract<
  PublicLayoutPathResult,
  { readonly kind: 'locale-root' } | { readonly kind: 'localized' }
>;

/** Throw-guard: assert kết quả build thành công và trả về nó. */
function expectBuilt(result: PublicLayoutPathResult): BuiltPath {
  if (result.kind === 'invalid') {
    throw new Error(`expected a built path, got invalid: ${result.reason}`);
  }
  if (result.kind === 'root') {
    throw new Error('buildPublicPath never produces root');
  }
  return result;
}

describe('buildPublicPath', () => {
  describe('locale-root surface', () => {
    it.each([
      ['en', '/en'],
      ['vi', '/vi'],
    ] as const)('builds { locale: %s } to %s', (locale, expected) => {
      const result = expectBuilt(buildPublicPath({ locale }));
      expect(result).toEqual({ kind: 'locale-root', locale, path: expected });
    });

    it('treats an empty path without a mount as locale-root (runtime contract)', () => {
      // TS cấm nhánh này; JS caller có thể vẫn truyền — '' nghĩa là "không có path".
      const input = {
        locale: 'en',
        mount: undefined,
        path: '',
      } as unknown as PublicLayoutPathInput;
      expect(expectBuilt(buildPublicPath(input)).path).toBe('/en');
    });
  });

  describe('mounted surface', () => {
    it.each([
      ['en', 'blog', '', '/en/blog'],
      ['en', 'docs', '', '/en/docs'],
      ['en', 'docs/api', '', '/en/docs/api'],
      ['vi', 'blog', '', '/vi/blog'],
      ['vi', 'docs', '', '/vi/docs'],
      ['vi', 'docs/api', '', '/vi/docs/api'],
      ['en', 'blog', '/hello-world', '/en/blog/hello-world'],
      ['vi', 'docs', '/guide', '/vi/docs/guide'],
      ['en', 'docs/api', '/users', '/en/docs/api/users'],
    ] as const)('builds locale %s, mount %s, path %s to %s', (locale, mount, path, expected) => {
      const result = expectBuilt(buildPublicPath({ locale, mount, path }));
      expect(result.path).toBe(expected);
    });

    it('defaults path to empty string (mount root)', () => {
      const result = expectBuilt(buildPublicPath({ locale: 'en', mount: 'docs' }));
      expect(result).toEqual({
        kind: 'localized',
        locale: 'en',
        mount: 'docs',
        path: '/en/docs',
        remainder: '',
      });
    });

    it('rejects a resource path that would cross into a nested mount (exact collision)', () => {
      // docs + /api có topology kết quả là docs/api ≠ docs — builder từ chối
      // thay vì âm thầm reinterpret; caller phải dựng { mount: 'docs/api' }.
      expect(buildPublicPath({ locale: 'en', mount: 'docs', path: '/api' })).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(buildPublicPath({ locale: 'vi', mount: 'docs', path: '/api' })).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it.each([
      ['/api/foo', 'unknown_mount'],
      ['/api/foo/bar', 'unknown_mount'],
      // Pathname hỏng cấu trúc vẫn do i18n layer trả reason của nó trước
      // topology check — builder không kiểm tra cấu trúc lần hai.
      ['/api/', 'trailing_slash'],
      ['/api?x=1', 'not_a_pathname'],
      ['/api#h', 'not_a_pathname'],
      ['/api//x', 'empty_segment'],
    ] as const)(
      'rejects docs + %s with %s (topology boundary, not a literal /api check)',
      (path, reason) => {
        expect(buildPublicPath({ locale: 'en', mount: 'docs', path })).toEqual({
          kind: 'invalid',
          reason,
        });
      },
    );

    it('rejects without ever producing the nested mount path', () => {
      // Kết quả invalid không có `path` — kiểm tra thay vì assert vế vacuous.
      const result = buildPublicPath({ locale: 'en', mount: 'docs', path: '/api' });
      expect(result.kind).toBe('invalid');
      expect((result as { path?: string }).path).toBeUndefined();
    });

    it('accepts resources that stay within the requested mount', () => {
      // docs + /guide: topology vẫn docs — không phải mọi path bắt đầu bằng
      // chữ cái của mount lồng nhau đều bị chặn.
      expect(expectBuilt(buildPublicPath({ locale: 'en', mount: 'docs', path: '/guide' }))).toEqual(
        {
          kind: 'localized',
          locale: 'en',
          mount: 'docs',
          path: '/en/docs/guide',
          remainder: '/guide',
        },
      );
      // docs/api + /guide: topology vẫn docs/api.
      expect(
        expectBuilt(buildPublicPath({ locale: 'en', mount: 'docs/api', path: '/guide' })),
      ).toEqual({
        kind: 'localized',
        locale: 'en',
        mount: 'docs/api',
        path: '/en/docs/api/guide',
        remainder: '/guide',
      });
      // Mirror positives chứng minh rule phụ thuộc mount, không hard-code
      // literal '/api': cùng path /api dưới mount khác vẫn được accept.
      expect(expectBuilt(buildPublicPath({ locale: 'en', mount: 'blog', path: '/api' }))).toEqual({
        kind: 'localized',
        locale: 'en',
        mount: 'blog',
        path: '/en/blog/api',
        remainder: '/api',
      });
      expect(
        expectBuilt(buildPublicPath({ locale: 'en', mount: 'docs/api', path: '/api' })),
      ).toEqual({
        kind: 'localized',
        locale: 'en',
        mount: 'docs/api',
        path: '/en/docs/api/api',
        remainder: '/api',
      });
    });

    it('keeps non-canonical sibling resources under the given mount', () => {
      const result = expectBuilt(
        buildPublicPath({ locale: 'vi', mount: 'docs', path: '/api-docs' }),
      );
      expect(result).toMatchObject({
        mount: 'docs',
        path: '/vi/docs/api-docs',
        remainder: '/api-docs',
      });
    });
  });

  describe('invalid input is a typed result, never a throw', () => {
    it('rejects an unsupported locale cast', () => {
      expect(buildPublicPath({ locale: 'fr' as never, mount: 'blog' })).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(buildPublicPath({ locale: 'EN' as never })).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('rejects an unregistered mount cast', () => {
      expect(buildPublicPath({ locale: 'en', mount: 'pricing' as never })).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(buildPublicPath({ locale: 'en', mount: 'BLOG' as never })).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('rejects a non-empty path without a mount', () => {
      const input = { locale: 'en', path: '/docs' } as unknown as PublicLayoutPathInput;
      expect(buildPublicPath(input)).toEqual({ kind: 'invalid', reason: 'unknown_mount' });
    });

    it('rejects a path that does not start with a slash before joining', () => {
      expect(buildPublicPath({ locale: 'en', mount: 'blog', path: 'foo' })).toEqual({
        kind: 'invalid',
        reason: 'not_a_pathname',
      });
      expect(
        buildPublicPath({ locale: 'en', mount: 'blog', path: 42 as unknown as string }),
      ).toEqual({ kind: 'invalid', reason: 'not_a_pathname' });
    });

    it.each([
      ['/', 'trailing_slash'],
      ['/foo/', 'trailing_slash'],
      ['//foo', 'empty_segment'],
      ['/foo?x=1', 'not_a_pathname'],
      ['/foo#h', 'not_a_pathname'],
    ] as const)('rejects path %s with %s', (path, reason) => {
      expect(buildPublicPath({ locale: 'en', mount: 'blog', path })).toEqual({
        kind: 'invalid',
        reason,
      });
    });

    it('rejects a null or undefined input without throwing (runtime JS caller)', () => {
      // Contract "no throw" áp cho cả caller JS truyền sai — không chỉ cast.
      expect(buildPublicPath(null as unknown as PublicLayoutPathInput)).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(buildPublicPath(undefined as unknown as PublicLayoutPathInput)).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('never throws on any input class', () => {
      const inputs: readonly (PublicLayoutPathInput | null | undefined)[] = [
        { locale: 'en' },
        { locale: 'en', mount: 'blog' },
        { locale: 'en', mount: 'blog', path: '/x' },
        { locale: 'nope' as never },
        { locale: 'en', mount: 'nope' as never },
        { locale: 'en', path: '/x' } as unknown as PublicLayoutPathInput,
        null,
        undefined,
      ];
      for (const input of inputs) {
        expect(() => buildPublicPath(input as PublicLayoutPathInput)).not.toThrow();
      }
    });
  });
});
