import { describe, it, expect } from 'vitest';
import { parsePublicLayoutPath } from '../index';

// Các case adversarial của parsePublicLayoutPath: input hỏng, encoding,
// unicode, ranh giới segment. Contract: không normalize, không decode, không
// trim, không repair — kế thừa từng byte từ app/i18n, phần thêm riêng chỉ
// là mount matching cũng exact-match theo segment.
describe('parsePublicLayoutPath adversarial input', () => {
  describe('structural errors pass through from app/i18n', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['leading whitespace', ' /en/docs'],
      ['missing leading slash', 'en/docs'],
      ['query string', '/en/docs?x=1'],
      ['hash', '/en/docs#h'],
      ['no leading slash with locale', 'en'],
    ])('rejects %s with not_a_pathname', (_label, pathname) => {
      expect(parsePublicLayoutPath(pathname)).toEqual({
        kind: 'invalid',
        reason: 'not_a_pathname',
      });
    });

    it('rejects backslash paths instead of normalizing them like URLs do', () => {
      expect(parsePublicLayoutPath('/en\\docs')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicLayoutPath('\\en/docs')).toEqual({
        kind: 'invalid',
        reason: 'not_a_pathname',
      });
    });

    it('reports empty segments before trailing slashes and before mount lookup', () => {
      expect(parsePublicLayoutPath('/en//docs')).toEqual({
        kind: 'invalid',
        reason: 'empty_segment',
      });
      // Kết thúc bằng '/' nhưng cũng chứa '//' — // thắng, không được gán
      // trailing_slash và càng không được gán unknown_mount.
      expect(parsePublicLayoutPath('/en/docs//')).toEqual({
        kind: 'invalid',
        reason: 'empty_segment',
      });
    });

    it('never repairs a trailing slash into the canonical path', () => {
      expect(parsePublicLayoutPath('/en/docs/')).toEqual({
        kind: 'invalid',
        reason: 'trailing_slash',
      });
      expect(parsePublicLayoutPath('/en/')).toEqual({
        kind: 'invalid',
        reason: 'trailing_slash',
      });
      // Root '/' là state riêng — không phải trailing slash.
      expect(parsePublicLayoutPath('/')).toEqual({ kind: 'root', path: '/' });
    });
  });

  describe('encoding and unicode preservation', () => {
    it('treats an encoded locale-looking segment as an ordinary segment', () => {
      expect(parsePublicLayoutPath('/%65n/docs')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicLayoutPath('/%76i/docs')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });

    it('does not decode %2F before matching: not a canonical mount URL', () => {
      // '/blog%2Ffoo' là MỘT segment — không decode thành '/blog/foo';
      // canonical URL của resource đó là '/en/blog/foo' với slash thô.
      expect(parsePublicLayoutPath('/en/blog%2Ffoo')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('keeps percent-encoded resource bytes verbatim under a matched mount', () => {
      const result = parsePublicLayoutPath('/vi/blog/t%E1%BA%ADm');
      expect(result).toEqual({
        kind: 'localized',
        locale: 'vi',
        mount: 'blog',
        path: '/vi/blog/t%E1%BA%ADm',
        remainder: '/t%E1%BA%ADm',
      });
    });

    it('keeps raw unicode resource bytes verbatim without normalization', () => {
      const result = parsePublicLayoutPath('/vi/blog/tạm');
      expect(result).toEqual({
        kind: 'localized',
        locale: 'vi',
        mount: 'blog',
        path: '/vi/blog/tạm',
        remainder: '/tạm',
      });
    });

    it('never trims whitespace inside the resource', () => {
      // Space dính sau segment mount → không khớp '/blog/' prefix → unknown.
      expect(parsePublicLayoutPath('/en/blog ')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/blog /x')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      // Space nằm sau mount hợp lệ thì giữ nguyên từng byte.
      const result = parsePublicLayoutPath('/en/docs/a b');
      expect(result).toMatchObject({ kind: 'localized', remainder: '/a b' });
    });
  });

  describe('mount matching boundaries', () => {
    it('never matches a mount on a partial segment', () => {
      expect(parsePublicLayoutPath('/en/blogging')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/blog2')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/doc')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/docsapi')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('is case-sensitive: uppercase mount paths are unknown', () => {
      expect(parsePublicLayoutPath('/vi/BLOG')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/vi/Docs')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('resolves nested mount docs/api before docs on deeper paths', () => {
      const nested = parsePublicLayoutPath('/en/docs/api/x');
      expect(nested).toMatchObject({ kind: 'localized', mount: 'docs/api', remainder: '/x' });
    });

    it('does not normalize dot segments', () => {
      // '.'/'..' là segment thường — không có path traversal normalization;
      // resource dưới mount giữ nguyên từng byte kể cả khi chứa '..'.
      const withDotDot = parsePublicLayoutPath('/en/docs/../blog');
      expect(withDotDot).toMatchObject({
        kind: 'localized',
        mount: 'docs',
        remainder: '/../blog',
      });
      expect(parsePublicLayoutPath('/en/./docs')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('rejects locale-looking first segments that are not registered locales', () => {
      expect(parsePublicLayoutPath('/EN/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicLayoutPath('/en-US/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicLayoutPath('/fr/blog')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
    });
  });
});
