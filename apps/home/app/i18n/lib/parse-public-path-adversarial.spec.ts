import { describe, it, expect } from 'vitest';
import { parsePublicPath } from '../index';

// Các case adversarial của parsePublicPath: input hỏng, encoding, unicode.
// Contract: không normalize, không decode, không trim — giữ nguyên từng byte
// hoặc trả typed reason.
describe('parsePublicPath adversarial input', () => {
  describe('malformed pathname input', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['leading whitespace', ' /en/blog'],
      ['missing leading slash', 'en/blog'],
      ['query string', '/en/blog?x=1'],
      ['bare query on locale root', '/en?x=1'],
      ['hash', '/en/blog#h'],
      ['query without locale', '/blog?x=1'],
    ])('rejects %s with not_a_pathname', (_label, pathname) => {
      expect(parsePublicPath(pathname)).toEqual({ kind: 'invalid', reason: 'not_a_pathname' });
    });

    it('rejects backslash paths instead of normalizing them like URLs do', () => {
      expect(parsePublicPath('/en\\blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicPath('\\en/blog')).toEqual({
        kind: 'invalid',
        reason: 'not_a_pathname',
      });
    });

    it('never trims whitespace: spaces stay verbatim in the remainder or fail the segment match', () => {
      // Space nằm trong remainder → giữ nguyên từng byte, không trim.
      expect(parsePublicPath('/en/blog ')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/blog ',
        remainder: '/blog ',
      });
      // Space dính vào segment đầu → không khớp locale, không được lowercase/trim.
      expect(parsePublicPath('/en /blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicPath('/en/blog\t')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/blog\t',
        remainder: '/blog\t',
      });
    });
  });

  describe('encoding and unicode preservation', () => {
    it('treats an encoded locale-looking segment as an ordinary segment', () => {
      expect(parsePublicPath('/%65n/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicPath('/%76i/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('keeps percent-encoded remainder bytes verbatim', () => {
      expect(parsePublicPath('/en/blog%2Ffoo')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/blog%2Ffoo',
        remainder: '/blog%2Ffoo',
      });
      expect(parsePublicPath('/en/caf%C3%A9')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/caf%C3%A9',
        remainder: '/caf%C3%A9',
      });
      expect(parsePublicPath('/en/a%3Fb')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/a%3Fb',
        remainder: '/a%3Fb',
      });
    });

    it('keeps raw unicode remainder verbatim without any normalization', () => {
      expect(parsePublicPath('/vi/blog/tạm')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi/blog/tạm',
        remainder: '/blog/tạm',
      });
      expect(parsePublicPath('/en/đường/dẫn')).toEqual({
        kind: 'localized',
        locale: 'en',
        path: '/en/đường/dẫn',
        remainder: '/đường/dẫn',
      });
    });

    it('accepts sub-delimiters, commas and emoji in the remainder as-is', () => {
      expect(parsePublicPath('/en/a;b').kind).toBe('localized');
      expect(parsePublicPath('/en/a,b').kind).toBe('localized');
      expect(parsePublicPath('/vi/blog/🎉')).toEqual({
        kind: 'localized',
        locale: 'vi',
        path: '/vi/blog/🎉',
        remainder: '/blog/🎉',
      });
    });
  });

  describe('determinism', () => {
    it('returns an identical result for repeated calls', () => {
      const inputs = ['/', '/en', '/blog', '/en//blog', '/en/blog', '', '/fr'];
      const first = inputs.map((input) => parsePublicPath(input));
      const second = inputs.map((input) => parsePublicPath(input));
      expect(second).toEqual(first);
    });

    it('never throws for hostile inputs', () => {
      const control = String.fromCharCode(0);
      const surrogate = String.fromCharCode(0xd800);
      const hostile = [
        '',
        '/',
        '//',
        `/${surrogate}`,
        '/en ',
        `/en/blog${control}`,
        '/\t',
        '/en\\',
        `/${'a'.repeat(1000)}`,
      ];
      for (const input of hostile) {
        expect(() => parsePublicPath(input)).not.toThrow();
        const result = parsePublicPath(input);
        expect(['root', 'localized', 'invalid']).toContain(result.kind);
      }
    });
  });
});
