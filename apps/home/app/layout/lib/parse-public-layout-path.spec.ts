import { describe, it, expect } from 'vitest';
import { parsePublicLayoutPath, type PublicLayoutPathResult } from '../index';

/** Throw-guard: assert kết quả là `localized` và trả về nó. */
function expectLocalized(
  result: PublicLayoutPathResult,
): Extract<PublicLayoutPathResult, { kind: 'localized' }> {
  if (result.kind !== 'localized') {
    throw new Error(`expected localized, got ${result.kind} (${JSON.stringify(result)})`);
  }
  return result;
}

/** Throw-guard: assert kết quả là `locale-root` và trả về nó. */
function expectLocaleRoot(
  result: PublicLayoutPathResult,
): Extract<PublicLayoutPathResult, { kind: 'locale-root' }> {
  if (result.kind !== 'locale-root') {
    throw new Error(`expected locale-root, got ${result.kind} (${JSON.stringify(result)})`);
  }
  return result;
}

describe('parsePublicLayoutPath core topology', () => {
  it('classifies exactly / as root — the locale-resolution entry point', () => {
    expect(parsePublicLayoutPath('/')).toEqual({ kind: 'root', path: '/' });
  });

  it('never treats / as locale = en', () => {
    const result = parsePublicLayoutPath('/');
    expect(result).not.toHaveProperty('locale');
    expect(result.kind).toBe('root');
  });

  it.each(['/en', '/vi'] as const)('classifies %s as locale-root surface', (pathname) => {
    const result = expectLocaleRoot(parsePublicLayoutPath(pathname));
    expect(result.path).toBe(pathname);
    expect(result.locale).toBe(pathname.slice(1));
  });

  it.each([
    ['/en/blog', 'en', 'blog', ''],
    ['/vi/blog', 'vi', 'blog', ''],
    ['/en/docs', 'en', 'docs', ''],
    ['/vi/docs', 'vi', 'docs', ''],
    ['/en/docs/api', 'en', 'docs/api', ''],
    ['/vi/docs/api', 'vi', 'docs/api', ''],
    ['/en/blog/hello-world', 'en', 'blog', '/hello-world'],
    ['/vi/blog/hello-world', 'vi', 'blog', '/hello-world'],
    ['/en/docs/guide', 'en', 'docs', '/guide'],
    ['/en/docs/api/guide', 'en', 'docs/api', '/guide'],
    ['/vi/docs/api/guide', 'vi', 'docs/api', '/guide'],
    ['/en/legal', 'en', 'legal', ''],
    ['/vi/legal', 'vi', 'legal', ''],
    ['/en/legal/privacy', 'en', 'legal', '/privacy'],
    ['/vi/legal/refund', 'vi', 'legal', '/refund'],
  ] as const)(
    'parses %s to locale %s, mount %s, remainder %s',
    (pathname, locale, mount, remainder) => {
      const result = expectLocalized(parsePublicLayoutPath(pathname));
      expect(result.locale).toBe(locale);
      expect(result.mount).toBe(mount);
      expect(result.remainder).toBe(remainder);
      expect(result.path).toBe(pathname);
    },
  );

  it('resolves the nested mount before its parent', () => {
    const result = expectLocalized(parsePublicLayoutPath('/en/docs/api'));
    expect(result.mount).toBe('docs/api');
    expect(result.remainder).toBe('');
  });

  it('keeps sibling segments under the parent mount', () => {
    // /en/docs/api2 là resource dưới docs, KHÔNG phải dưới docs/api.
    const result = expectLocalized(parsePublicLayoutPath('/en/docs/api2'));
    expect(result.mount).toBe('docs');
    expect(result.remainder).toBe('/api2');
  });

  it('treats resource paths under a mount as opaque (app decides 404)', () => {
    const result = expectLocalized(parsePublicLayoutPath('/en/docs/unknown'));
    expect(result.mount).toBe('docs');
    expect(result.remainder).toBe('/unknown');
  });

  it('keeps path = "/" + locale + "/" + mount + remainder on every localized success', () => {
    for (const pathname of ['/en/blog', '/vi/docs/api/guide', '/en/docs/api']) {
      const result = expectLocalized(parsePublicLayoutPath(pathname));
      expect(result.path).toBe(`/${result.locale}/${result.mount}${result.remainder}`);
    }
  });

  it('keeps path = "/" + locale on every locale-root success', () => {
    for (const pathname of ['/en', '/vi']) {
      const result = expectLocaleRoot(parsePublicLayoutPath(pathname));
      expect(result.path).toBe(`/${result.locale}`);
    }
  });

  describe('invalid paths', () => {
    it.each([
      ['/en/', 'trailing_slash'],
      ['/en/docs/', 'trailing_slash'],
      ['/vi/blog/', 'trailing_slash'],
      ['/en//docs', 'empty_segment'],
      ['/en/docs//x', 'empty_segment'],
      ['/en/unknown', 'unknown_mount'],
      ['/en/blogging', 'unknown_mount'],
      ['/en/doc', 'unknown_mount'],
      ['/en/home', 'unknown_mount'],
      ['/blog', 'unsupported_locale'],
      ['/EN/docs', 'unsupported_locale'],
      ['/fr', 'unsupported_locale'],
      ['/enabled', 'unsupported_locale'],
      ['', 'not_a_pathname'],
      ['en/docs', 'not_a_pathname'],
      ['/en/docs?q=1', 'not_a_pathname'],
      ['/en/docs#h', 'not_a_pathname'],
    ] as const)('rejects %s with %s', (pathname, reason) => {
      expect(parsePublicLayoutPath(pathname)).toEqual({ kind: 'invalid', reason });
    });
  });

  it('distinguishes / from /en and / from /vi', () => {
    expect(parsePublicLayoutPath('/').kind).toBe('root');
    expect(parsePublicLayoutPath('/en').kind).toBe('locale-root');
    expect(parsePublicLayoutPath('/vi').kind).toBe('locale-root');
  });

  it('does not throw for any input class', () => {
    for (const pathname of ['/', '/en', '/en/bogus', '/en/', '', 'nonsense']) {
      expect(() => parsePublicLayoutPath(pathname)).not.toThrow();
    }
  });
});
