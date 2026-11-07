import { describe, it, expect } from 'vitest';
import * as publicApi from '../index';
import {
  PUBLIC_MOUNTS,
  PUBLIC_NAVIGATION,
  buildPublicPath,
  parsePublicLayoutPath,
  type PublicLayoutPathInput,
  type PublicLayoutPathResult,
} from '../index';

/** Throw-guard: assert một kết quả thành công và trả về nó. */
function expectSuccess(
  result: PublicLayoutPathResult,
): Exclude<PublicLayoutPathResult, { kind: 'invalid' }> {
  if (result.kind === 'invalid') {
    throw new Error(`expected success, got invalid: ${result.reason}`);
  }
  return result;
}

// Test qua package entrypoint: public API là contract, không phải internal
// module — consumer không bao giờ phải import thẳng `src/lib/*`.
describe('public API entrypoint', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(new Set(Object.keys(publicApi))).toEqual(
      new Set([
        'PUBLIC_FOOTER_GROUPS',
        'PUBLIC_FOOTER_TAGLINE',
        'PUBLIC_MOUNTS',
        'PUBLIC_MOUNTS_IN_DECLARATION_ORDER',
        'PUBLIC_NAVIGATION',
        'PublicFooter',
        'PublicHeader',
        'PublicShell',
        'buildPublicFooterGroups',
        'buildPublicFooterLegal',
        'buildPublicNavigation',
        'buildPublicPath',
        'getMountDefinition',
        'isPublicMount',
        'parsePublicLayoutPath',
        'resolveLocaleContext',
      ]),
    );
  });

  it('exposes no locale-ownership surface (locale belongs to app/i18n)', () => {
    const surface = Object.keys(publicApi).join(' ').toLowerCase();
    for (const forbidden of [
      'publiclocale',
      'parsepublicpath',
      'localizepath',
      'switchlocale',
      'publiclocales',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('does not expose identity, payment, analytics, CMS or SEO surface', () => {
    const surface = Object.keys(publicApi).join(' ').toLowerCase();
    for (const forbidden of [
      'auth',
      'identity',
      'payment',
      'checkout',
      'billing',
      'wallet',
      'console',
      'cms',
      'analytics',
      'seo',
      'campaign',
      'worker',
      'nx',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  describe('build/parse invariant', () => {
    it.each([
      { locale: 'en' },
      { locale: 'vi' },
    ] as const satisfies readonly PublicLayoutPathInput[])(
      'parse(build(x)) preserves locale-root semantics of x (case %#)',
      (input) => {
        const built = expectSuccess(buildPublicPath(input));
        // Semantic invariant — không chỉ path string: locale của input phải
        // được parse trả lại nguyên vẹn.
        expect(built).toMatchObject({ kind: 'locale-root', locale: input.locale });
        const reparsed = expectSuccess(parsePublicLayoutPath(built.path));
        expect(reparsed).toEqual(built);
      },
    );

    it.each([
      { locale: 'en', mount: 'blog' },
      { locale: 'vi', mount: 'blog' },
      { locale: 'en', mount: 'docs' },
      { locale: 'vi', mount: 'docs' },
      { locale: 'en', mount: 'docs/api' },
      { locale: 'en', mount: 'blog', path: '/hello-world' },
      { locale: 'vi', mount: 'docs', path: '/guide/deep' },
      { locale: 'en', mount: 'docs/api', path: '/users/42' },
      { locale: 'en', mount: 'docs/api', path: '/guide' },
    ] as const satisfies readonly PublicLayoutPathInput[])(
      'parse(build(x)) preserves the semantic topology of x (case %#)',
      (input) => {
        const built = expectSuccess(buildPublicPath(input));
        // Semantic invariant — không chỉ path string: locale, mount và
        // remainder của input phải được parse trả lại nguyên vẹn.
        expect(built).toMatchObject({
          kind: 'localized',
          locale: input.locale,
          mount: input.mount,
          remainder: input.path ?? '',
        });
        const reparsed = expectSuccess(parsePublicLayoutPath(built.path));
        expect(reparsed).toEqual(built);
      },
    );

    it('rejects an input whose joined path would change the mount topology', () => {
      // docs + /api có topology kết quả docs/api — builder fail bằng typed
      // invalid thay vì làm thay đổi mount ngầm.
      expect(buildPublicPath({ locale: 'en', mount: 'docs', path: '/api' })).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it.each([
      '/en',
      '/vi',
      '/en/blog',
      '/vi/blog',
      '/en/docs',
      '/en/docs/api',
      '/vi/docs/api/guide',
      '/en/blog/hello-world',
    ] as const)('build(parse(%s)) rebuilds the same path', (pathname) => {
      const parsed = expectSuccess(parsePublicLayoutPath(pathname));
      if (parsed.kind !== 'locale-root' && parsed.kind !== 'localized') {
        throw new Error(`table must not contain bare root, got ${pathname}`);
      }
      const rebuilt = buildPublicPath(
        parsed.kind === 'locale-root'
          ? { locale: parsed.locale }
          : { locale: parsed.locale, mount: parsed.mount, path: parsed.remainder },
      );
      expect(expectSuccess(rebuilt).path).toBe(pathname);
    });

    it('never builds the bare root or an unprefixed path', () => {
      const inputs = [
        { locale: 'en' },
        { locale: 'vi', mount: 'blog' },
      ] as const satisfies readonly PublicLayoutPathInput[];
      for (const input of inputs) {
        const path = expectSuccess(buildPublicPath(input)).path;
        expect(path.startsWith('/en') || path.startsWith('/vi')).toBe(true);
        expect(path).not.toBe('/');
        expect(path.endsWith('/')).toBe(false);
      }
    });
  });

  describe('no shared mutable state', () => {
    it('registry and navigation content are identical before and after lookups', () => {
      expect(PUBLIC_MOUNTS.map((definition) => definition.path)).toEqual([
        'docs/api',
        'blog',
        'docs',
        'legal',
      ]);
      runLookups();
      expect(PUBLIC_MOUNTS).toHaveLength(4);
      expect(PUBLIC_NAVIGATION).toHaveLength(3);
    });
  });
});

/** Lookups thất bại và thành công không được thay đổi registry. */
function runLookups(): void {
  publicApi.getMountDefinition('nope');
  publicApi.getMountDefinition('blog');
  publicApi.isPublicMount('nope');
}
