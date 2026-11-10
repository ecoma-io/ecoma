import { describe, it, expect } from 'vitest';
import { parsePublicLayoutPath } from '../index';

// Các case adversarial của parsePublicLayoutPath: input hỏng, encoding,
// unicode, ranh giới segment. Contract: không normalize, không decode, không
// trim, không repair — kế thừa từng byte từ app/i18n; phần thêm riêng là
// phân loại bề mặt, và sau khi gỡ stack content (issue #72) mọi pathname có
// remainder đều là `unknown_mount` — không segment nào được "sửa giúp" thành
// URL hợp lệ.
describe('parsePublicLayoutPath adversarial input', () => {
  describe('structural errors pass through from app/i18n', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['leading whitespace', ' /en'],
      ['missing leading slash', 'en'],
      ['query string', '/en?x=1'],
      ['hash', '/en#h'],
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

    it('reports empty segments before trailing slashes and before surface classification', () => {
      expect(parsePublicLayoutPath('/en//docs')).toEqual({
        kind: 'invalid',
        reason: 'empty_segment',
      });
      // Kết thúc bằng '/' nhưng cũng chứa '//' — // thắng, không được gán
      // trailing_slash và càng không được gán unknown_mount.
      expect(parsePublicLayoutPath('/en//')).toEqual({
        kind: 'invalid',
        reason: 'empty_segment',
      });
    });

    it('never repairs a trailing slash into the canonical path', () => {
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

    it('does not decode %2F before classifying: not a canonical URL', () => {
      // '/blog%2Ffoo' là MỘT segment — không decode thành '/blog/foo'; URL có
      // slash thô cũng không được "sửa" thành locale-root.
      expect(parsePublicLayoutPath('/en/blog%2Ffoo')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('classifies encoded remainder as unknown surface, byte-verbatim', () => {
      expect(parsePublicLayoutPath('/vi/t%E1%BA%ADm')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('classifies raw unicode remainder as unknown surface, without normalization', () => {
      expect(parsePublicLayoutPath('/vi/tạm')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('never trims whitespace inside the path', () => {
      expect(parsePublicLayoutPath('/en/blog ')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/blog /x')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });
  });

  describe('surface classification boundaries', () => {
    it('never classifies a partial locale segment as a surface', () => {
      expect(parsePublicLayoutPath('/en/blogging')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/blog2')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/e')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('is case-sensitive: uppercase locale paths are unsupported', () => {
      expect(parsePublicLayoutPath('/EN')).toEqual({
        kind: 'invalid',
        reason: 'unsupported_locale',
      });
      expect(parsePublicLayoutPath('/vi/BLOG')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
    });

    it('does not normalize dot segments', () => {
      // '.'/'..' là segment thường — không có path traversal normalization.
      expect(parsePublicLayoutPath('/en/../blog')).toEqual({
        kind: 'invalid',
        reason: 'unknown_mount',
      });
      expect(parsePublicLayoutPath('/en/.')).toEqual({
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

    it('keeps legacy mount paths rejected after the content-stack removal', () => {
      // Docs/blog/legal từng là mount — phải tiếp tục bị từ chối với
      // `unknown_mount` (404 ở runtime), không được tái hợp lệ hoá ngầm.
      for (const pathname of ['/en/docs', '/en/docs/api', '/en/blog', '/vi/legal/privacy']) {
        expect(parsePublicLayoutPath(pathname)).toEqual({
          kind: 'invalid',
          reason: 'unknown_mount',
        });
      }
    });
  });
});
