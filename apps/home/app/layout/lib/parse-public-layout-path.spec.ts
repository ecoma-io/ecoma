import { describe, it, expect } from 'vitest';
import { parsePublicLayoutPath, type PublicLayoutPathResult } from '../index';

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

  it('keeps path = "/" + locale on every locale-root success', () => {
    for (const pathname of ['/en', '/vi']) {
      const result = expectLocaleRoot(parsePublicLayoutPath(pathname));
      expect(result.path).toBe(`/${result.locale}`);
    }
  });

  describe('invalid paths', () => {
    it.each([
      ['/en/', 'trailing_slash'],
      ['/vi/', 'trailing_slash'],
      ['/en//docs', 'empty_segment'],
      // Mọi pathname có remainder đều không còn bề mặt phục vụ sau khi stack
      // content bị xoá (issue #72) — kể cả mount từng tồn tại.
      ['/en/docs', 'unknown_mount'],
      ['/en/blog', 'unknown_mount'],
      ['/en/blog/hello-world', 'unknown_mount'],
      ['/en/legal', 'unknown_mount'],
      ['/vi/legal/privacy', 'unknown_mount'],
      ['/en/unknown', 'unknown_mount'],
      ['/en/blogging', 'unknown_mount'],
      ['/blog', 'unsupported_locale'],
      ['/EN', 'unsupported_locale'],
      ['/fr', 'unsupported_locale'],
      ['/enabled', 'unsupported_locale'],
      ['', 'not_a_pathname'],
      ['en', 'not_a_pathname'],
      ['/en?q=1', 'not_a_pathname'],
      ['/en#h', 'not_a_pathname'],
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
