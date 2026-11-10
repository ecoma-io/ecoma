import { describe, it, expect } from 'vitest';
import { buildPublicPath, type PublicLayoutPathInput, type PublicLayoutPathResult } from '../index';

/** Kết quả build thành công: chỉ còn locale-root — không bao giờ root. */
type BuiltPath = Extract<PublicLayoutPathResult, { readonly kind: 'locale-root' }>;

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
  });

  describe('invalid input is a typed result, never a throw', () => {
    it('rejects an unsupported locale cast', () => {
      expect(buildPublicPath({ locale: 'fr' as never })).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(buildPublicPath({ locale: 'EN' as never })).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
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
        { locale: 'nope' as never },
        null,
        undefined,
      ];
      for (const input of inputs) {
        expect(() => buildPublicPath(input as PublicLayoutPathInput)).not.toThrow();
      }
    });
  });
});
