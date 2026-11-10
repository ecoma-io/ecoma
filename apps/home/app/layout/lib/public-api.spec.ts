import { describe, it, expect } from 'vitest';
import * as publicApi from '../index';
import { buildPublicPath, parsePublicLayoutPath, type PublicLayoutPathInput } from '../index';

/** Throw-guard: assert một kết quả thành công và trả về nó. */
function expectSuccess(
  result: ReturnType<typeof buildPublicPath>,
): Exclude<ReturnType<typeof buildPublicPath>, { kind: 'invalid' }> {
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
        'PUBLIC_FOOTER_TAGLINE',
        'PublicFooter',
        'PublicHeader',
        'PublicShell',
        'buildPublicPath',
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

    it.each(['/en', '/vi'] as const)('build(parse(%s)) rebuilds the same path', (pathname) => {
      const parsed = expectSuccess(parsePublicLayoutPath(pathname));
      if (parsed.kind !== 'locale-root') {
        throw new Error(`table must only contain locale roots, got ${pathname}`);
      }
      const rebuilt = buildPublicPath({ locale: parsed.locale });
      expect(expectSuccess(rebuilt).path).toBe(pathname);
    });

    it('never builds the bare root or an unprefixed path', () => {
      const inputs = [
        { locale: 'en' },
        { locale: 'vi' },
      ] as const satisfies readonly PublicLayoutPathInput[];
      for (const input of inputs) {
        const path = expectSuccess(buildPublicPath(input)).path;
        expect(path.startsWith('/en') || path.startsWith('/vi')).toBe(true);
        expect(path).not.toBe('/');
        expect(path.endsWith('/')).toBe(false);
      }
    });
  });
});
