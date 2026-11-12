import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveLinkTarget,
  displayPath,
  type LinkResolution,
  type ResolutionContext,
} from './link-targets.js';

/**
 * Fixture workspace trên ổ (temporary directory) cho resolve link.
 *
 * Vì check đường dẫn phải đúng trên filesystem thực (symlink, case-sensitive,
 * traversal), nên không dùng mock filesystem: mỗi `it` dựng workspace riêng và
 * xóa sau. Helper `workspace` tạo một thư mục rỗng và trả về đối tượng context
 * sẵn dùng cho `resolveLinkTarget` (đã có cache readdir chia sẻ trong một lần
 * chạy).
 */

const workspace = (subdir?: string): ResolutionContext => {
  const root = mkdtempSync(join(tmpdir(), 'readme-check-'));
  const readmeDir = subdir ? join(root, subdir) : root;
  mkdirSync(readmeDir, { recursive: true });
  return { readmeDir, workspaceRoot: root, readdirCache: new Map() };
};

const clean = (ctx: ResolutionContext): void =>
  rmSync(ctx.workspaceRoot, { recursive: true, force: true });

/**
 * Thu hẹp kiểu theo `kind` để assert được thuộc tính riêng của từng nhánh
 * (`code`/`message`/`hint` của nhánh broken, `absPath` của nhánh file).
 * `expect()` của Vitest không thu hẹp kiểu, nên helper này trả về chính giá
 * trị đã thu hẹp.
 */
const broken = (result: LinkResolution): Extract<LinkResolution, { kind: 'broken' }> => {
  expect(result.kind).toBe('broken');
  return result as Extract<LinkResolution, { kind: 'broken' }>;
};

const fileResult = (result: LinkResolution): Extract<LinkResolution, { kind: 'file' }> => {
  expect(result.kind).toBe('file');
  return result as Extract<LinkResolution, { kind: 'file' }>;
};

describe('resolveLinkTarget', () => {
  describe('relative and bare path', () => {
    it('resolves ./path relative to the README directory', () => {
      const ctx = workspace('sub');
      const file = join(ctx.readmeDir, 'docs', 'x.md');
      mkdirSync(join(ctx.readmeDir, 'docs'), { recursive: true });
      writeFileSync(file, '');

      const result = resolveLinkTarget('./docs/x.md', ctx);

      expect(result.kind).toBe('file');
      expect(result).toMatchObject({ absPath: file });
      clean(ctx);
    });

    it('resolves a bare path relative to the README directory', () => {
      const ctx = workspace();
      const file = join(ctx.readmeDir, 'x.md');
      writeFileSync(file, '');

      expect(resolveLinkTarget('x.md', ctx)).toMatchObject({ kind: 'file', absPath: file });
      clean(ctx);
    });

    it('climbing .. past the workspace root is blocked lexically before any fs access', () => {
      const ctx = workspace();

      const result = resolveLinkTarget('../x.md', ctx);

      expect(broken(result).code).toBe('path-escapes-workspace');
      clean(ctx);
    });

    it('treats a directory link without anchor as resolvable', () => {
      const ctx = workspace();
      mkdirSync(join(ctx.readmeDir, 'docs'), { recursive: true });

      expect(resolveLinkTarget('./docs', ctx).kind).toBe('directory');
      clean(ctx);
    });
  });

  describe('root-relative link', () => {
    it('resolves /path against the repository root, not the README directory', () => {
      const ctx = workspace('sub/project');
      const file = join(ctx.workspaceRoot, 'shared', 'x.md');
      mkdirSync(join(ctx.workspaceRoot, 'shared'), { recursive: true });
      writeFileSync(file, '');

      const result = resolveLinkTarget('/shared/x.md', ctx);

      expect(relative(ctx.workspaceRoot, fileResult(result).absPath)).toBe('shared/x.md');
      clean(ctx);
    });

    it('blocks an absolute path that would leave the repository root', () => {
      const ctx = workspace();

      // `/...` trên GitHub luôn là đường dẫn TRONG repository, nên `/etc/passwd`
      // không đọc file hệ thống — nó là `<repo>/etc/passwd`, tức target-not-found.
      const result = resolveLinkTarget('/etc/passwd', ctx);

      const failure = broken(result);
      expect(failure.code).toBe('target-not-found');
      expect(failure.message).not.toContain('/etc/passwd" resolves');
      clean(ctx);
    });

    it('blocks a root-relative path that climbs out of the repository root', () => {
      const ctx = workspace();

      const result = resolveLinkTarget('/../etc/passwd', ctx);

      expect(broken(result).code).toBe('path-escapes-workspace');
      clean(ctx);
    });
  });

  describe('percent-encoding', () => {
    it('decodes %20 to a space', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'file name.md'), '');

      expect(resolveLinkTarget('file%20name.md', ctx)).toMatchObject({ kind: 'file' });
      clean(ctx);
    });

    it('treats invalid %zz as literal (GitHub behavior)', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'a%zz.md'), '');

      expect(resolveLinkTarget('a%zz.md', ctx)).toMatchObject({ kind: 'file' });
      clean(ctx);
    });
  });

  describe('fragment / anchor split', () => {
    it('splits at # and keeps anchor on the resolution', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'x.md'), '');

      expect(resolveLinkTarget('x.md#section', ctx)).toMatchObject({
        kind: 'file',
        anchor: 'section',
      });
      clean(ctx);
    });

    it('treats [t](#) as page-top, always resolvable', () => {
      const ctx = workspace();

      expect(resolveLinkTarget('#', ctx)).toMatchObject({ kind: 'page-top' });
      expect(resolveLinkTarget('()', ctx)).toMatchObject({
        kind: 'broken',
        code: 'target-not-found',
      });
      clean(ctx);
    });
  });

  describe('safety', () => {
    it('rejects ../ traversal that escapes the workspace', () => {
      const ctx = workspace();

      const result = resolveLinkTarget('../../etc/passwd', ctx);

      expect(broken(result).code).toBe('path-escapes-workspace');
      clean(ctx);
    });

    it('follows a symlink inside the workspace', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.workspaceRoot, 'real.md'), '');
      symlinkSync(join(ctx.workspaceRoot, 'real.md'), join(ctx.readmeDir, 'link.md'));

      expect(resolveLinkTarget('link.md', ctx)).toMatchObject({ kind: 'file' });
      clean(ctx);
    });

    it('rejects a symlink whose target escapes the workspace', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.workspaceRoot, '..', 'outside.md'), '');
      symlinkSync(
        join(ctx.workspaceRoot, '..', 'outside.md'),
        join(ctx.readmeDir, 'outside-link.md'),
      );

      const result = resolveLinkTarget('outside-link.md', ctx);

      const failure = broken(result);
      expect(failure.code).toBe('symlink-escapes-workspace');
      expect(failure.message).toContain('outside');
      clean(ctx);
    });

    it('reports a directory target carrying an anchor as broken', () => {
      const ctx = workspace();
      mkdirSync(join(ctx.readmeDir, 'docs'), { recursive: true });

      expect(resolveLinkTarget('docs#anything', ctx)).toMatchObject({
        kind: 'broken',
        code: 'anchor-on-directory',
      });
      clean(ctx);
    });

    it('reports parent-not-directory when a path component is a file', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'x.md'), '');

      const result = resolveLinkTarget('x.md/y.md', ctx);

      expect(broken(result).code).toBe('parent-not-directory');
      clean(ctx);
    });
  });

  describe('case sensitivity', () => {
    it('accepts exact casing', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'X.md'), '');

      expect(resolveLinkTarget('X.md', ctx)).toMatchObject({ kind: 'file' });
      clean(ctx);
    });

    it('reports case mismatch with the on-disk name, even though readdir could find it', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'X.md'), '');

      const result = resolveLinkTarget('x.md', ctx);

      const failure = broken(result);
      expect(failure.code).toBe('case-mismatch');
      expect(failure.message).toContain('X.md');
      expect(failure.hint).toContain('X.md');
      clean(ctx);
    });

    it('reports target-not-found when nothing matches even case-insensitively', () => {
      const ctx = workspace();
      writeFileSync(join(ctx.readmeDir, 'X.md'), '');

      expect(resolveLinkTarget('z.md', ctx)).toMatchObject({
        kind: 'broken',
        code: 'target-not-found',
      });
      clean(ctx);
    });
  });

  describe('external link (never fetched)', () => {
    it.each([
      'http://example.com',
      'https://example.com/x.md',
      'mailto:team@example.com',
      'tel:+12345',
    ])('treats %s as external and never touches filesystem', (url) => {
      const ctx = workspace();

      const result = resolveLinkTarget(url, ctx);

      expect(result).toMatchObject({ kind: 'external', url });
      clean(ctx);
    });
  });

  describe('displayPath', () => {
    it('returns repo-relative path for a file inside the workspace', () => {
      const ctx = workspace('libs/a');
      const abs = join(ctx.workspaceRoot, 'libs', 'a', 'README.md');

      expect(displayPath(abs, ctx.workspaceRoot)).toBe('libs/a/README.md');
      clean(ctx);
    });
  });
});
