import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkProjectReadmes } from './readme-checker.js';
import type { ReadmeTarget } from './project-graph.js';

/**
 * Orchestrator readme-checker với fixture workspace trên ổ.
 *
 * Không spawn Nx: targets giả được truyền trực tiếp, nên kiểm này không phụ thuộc
 * trạng thái workspace thật và chạy lại giống hệt trên mọi máy. Mỗi `it` dựng
 * workspace riêng trong `os.tmpdir()` và dọn sạch sau.
 */

const WORKSPACE_PREFIX = join(tmpdir(), 'readme-checker-fixture-');

const makeWorkspace = (projects: readonly ReadmeTarget[]): string => {
  const root = mkdtempSync(WORKSPACE_PREFIX);
  for (const project of projects) {
    mkdirSync(join(root, project.root), { recursive: true });
  }
  return root;
};

const writeReadme = (root: string, project: ReadmeTarget, content: string): void => {
  writeFileSync(join(root, project.root, 'README.md'), content);
};

const validReadme = (name: string): string =>
  `# ${name}\n\n` +
  `## Purpose\n\n${name} purpose.\n\n` +
  `## Responsibilities\n\nowns ${name}.\n\n` +
  `## Boundaries\n\nno external calls.\n\n` +
  `## Development\n\nrun tests.\n\n` +
  `## Testing\n\nunit tests pass.\n\n` +
  `## Related Documentation\n\nsee docs.\n`;

const check = (root: string, targets: readonly ReadmeTarget[]) =>
  checkProjectReadmes(targets, { workspaceRoot: root });

const clean = (root: string): void => rmSync(root, { recursive: true, force: true });

describe('checkProjectReadmes', () => {
  describe('passing README', () => {
    it('returns zero findings for two projects with valid READMEs', () => {
      const root = makeWorkspace([
        { name: 'alpha', root: 'libs/alpha' },
        { name: 'zeta', root: 'apps/zeta' },
      ]);
      try {
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, validReadme('alpha'));
        writeReadme(root, { name: 'zeta', root: 'apps/zeta' }, validReadme('zeta'));

        const result = check(root, [
          { name: 'zeta', root: 'apps/zeta' },
          { name: 'alpha', root: 'libs/alpha' },
        ]);

        expect(result.findings).toEqual([]);
        expect(result.summary).toEqual({
          projects: 2,
          findings: 0,
          externalLinks: 0,
        });
      } finally {
        clean(root);
      }
    });
  });

  describe('file-level findings', () => {
    it('reports a missing README', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({
            project: 'alpha',
            file: 'libs/alpha/README.md',
            line: 0,
            code: 'missing-readme',
            message: expect.stringContaining('no README.md exists'),
          }),
        ]);
        expect(result.summary.findings).toBe(1);
      } finally {
        clean(root);
      }
    });

    it('reports an empty README', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        writeFileSync(join(root, 'libs/alpha/README.md'), '');
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({ code: 'empty-readme', line: 0 }),
        ]);
      } finally {
        clean(root);
      }
    });

    it('reports a symlinked README as a finding, whatever its target', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        // Một file thật cùng workspace làm mục tiêu symlink — dù target tồn tại
        // và nằm trong workspace, symlink vẫn là finding vì nội dung không được
        // sở hữu bởi project.
        writeFileSync(join(root, 'real.md'), '# real\n');
        symlinkSync(join(root, 'real.md'), join(root, 'libs/alpha/README.md'));
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({ code: 'symlinked-readme', line: 0 }),
        ]);
        expect(result.summary.findings).toBe(1);
      } finally {
        clean(root);
      }
    });

    it('reports a directory named README.md as not-a-file', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        mkdirSync(join(root, 'libs/alpha/README.md'), { recursive: true });
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({ code: 'readme-not-a-file', line: 0 }),
        ]);
      } finally {
        clean(root);
      }
    });
  });

  describe('contract headings on a real README file', () => {
    it('reports missing H1 and each missing section', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, '# alpha\n\n## Purpose\n\nbody\n');
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        const codes = result.findings.map((f) => f.code);
        const sortedCodes = [...codes];
        sortedCodes.sort(); // mảng copy riêng — sort tại chỗ (target es2022 chưa có toSorted)
        expect(sortedCodes).toEqual([
          'missing-section',
          'missing-section',
          'missing-section',
          'missing-section',
          'missing-section',
        ]);
        expect(result.summary.findings).toBe(5);
      } finally {
        clean(root);
      }
    });

    it('reports an empty section body at its heading line', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({
            code: 'empty-section-body',
            message: expect.stringContaining('Purpose'),
            line: 3,
          }),
        ]);
      } finally {
        clean(root);
      }
    });

    it('detects duplicated H1 headings', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nbody\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n\n# alpha again\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings.map((f) => f.code)).toContain('multiple-h1');
        const multiple = result.findings.find((f) => f.code === 'multiple-h1');
        expect(multiple).toBeDefined();
        expect(multiple?.line).toBeGreaterThan(0);
        expect(multiple?.message).toContain('line 1');
      } finally {
        clean(root);
      }
    });
  });

  describe('link resolution end to end', () => {
    it('reports a broken internal link at its line with message and hint', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nxem [missing](./missing.md)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({
            project: 'alpha',
            file: 'libs/alpha/README.md',
            line: 5,
            code: 'target-not-found',
            message: expect.stringContaining('does not exist'),
            hint: expect.stringContaining('relative to the README'),
          }),
        ]);
      } finally {
        clean(root);
      }
    });

    it('passes a link to an existing file and to a directory', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        writeFileSync(join(root, 'libs/alpha', 'guide.md'), '# guide\n');
        mkdirSync(join(root, 'libs/alpha', 'docs'), { recursive: true });
        const source =
          '# alpha\n\n## Purpose\n\nxem [guide](./guide.md) và [docs](./docs)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });

    it('counts external links but never fetches them', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nxem [repo](https://github.com/ecoma-io/ecoma) và [liên hệ](mailto:team@example.com)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
        expect(result.summary.externalLinks).toBe(2);
      } finally {
        clean(root);
      }
    });

    it('validates a same-file anchor against the README headings', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        // Anchor `#testing` khớp H2 "Testing" của chính README (GitHub slug:
        // lowercase, space → hyphen).
        const source =
          '# alpha\n\n## Purpose\n\nxem [mục testing](#testing)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });

    it('validates a same-file anchor with Vietnamese diacritics', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        // Anchor giữ dấu: "Mục đích" → "mục-đích" (GitHub KHÔNG fold dấu).
        const source =
          '# alpha\n\n## Purpose\n\nxem [mục đích](#mục-đích)\n\n## Mục đích\n\nnội dung\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });

    it('reports an invalid same-file anchor', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nxem [không có](#khong-co)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({
            code: 'anchor-not-found',
            message: expect.stringContaining('#khong-co'),
            hint: expect.stringContaining('GitHub anchor'),
            line: 5,
          }),
        ]);
      } finally {
        clean(root);
      }
    });

    it('validates an anchor in another Markdown file', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        writeFileSync(
          join(root, 'libs/alpha', 'other.md'),
          '# other\n\n## một section khác\n\nnội dung\n',
        );
        const source =
          '# alpha\n\n## Purpose\n\nxem [section](./other.md#một-section-khác)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });

    it('reports an anchor that does not exist in the target file', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        writeFileSync(join(root, 'libs/alpha', 'other.md'), '# other\n\n');
        const source =
          '# alpha\n\n## Purpose\n\nxem [section](./other.md#khong-co)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({
            code: 'anchor-not-found',
            message: expect.stringContaining('other.md'),
            line: 5,
          }),
        ]);
      } finally {
        clean(root);
      }
    });

    it('does not report a reference whose definition is missing (plain text on GitHub)', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        // CommonMark: reference không có definition render thành văn bản thường.
        // README thật của repository có `[A-Za-z0-9][A-Za-z0-9_-]` trong prose
        // (mẫu regex) — báo chúng là link hỏng sẽ oan.
        const source =
          '# alpha\n\n## Purpose\n\nxem [doc][missing]\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });

    it('resolves a reference-style link against its definition', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        writeFileSync(join(root, 'libs/alpha', 'guide.md'), '# guide\n');
        const source =
          '# alpha\n\n## Purpose\n\nxem [guide][g]\n\n[g]: ./guide.md\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });

    it('reports a reference-style link whose definition points at a missing file', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nxem [guide][g]\n\n[g]: ./missing.md\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([
          expect.objectContaining({
            code: 'target-not-found',
            // Finding gắn với DÒNG CỦA REFERENCE — chỗ người đọc nhấp vào link.
            line: 5,
          }),
        ]);
      } finally {
        clean(root);
      }
    });

    it('does not report a shortcut reference without definition (plain text on GitHub)', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nxem [doc]\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        const result = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(result.findings).toEqual([]);
      } finally {
        clean(root);
      }
    });
  });

  describe('nested project roots', () => {
    it('checks both projects when one root is an ancestor of the other', () => {
      const root = makeWorkspace([
        { name: 'parent-project', root: 'parent' },
        { name: 'child-project', root: 'parent/child' },
      ]);
      try {
        writeReadme(root, { name: 'parent-project', root: 'parent' }, validReadme('parent'));
        writeReadme(root, { name: 'child-project', root: 'parent/child' }, validReadme('child'));
        const result = check(root, [
          { name: 'child-project', root: 'parent/child' },
          { name: 'parent-project', root: 'parent' },
        ]);

        expect(result.findings).toEqual([]);
        expect(result.summary.projects).toBe(2);
      } finally {
        clean(root);
      }
    });
  });

  describe('determinism', () => {
    it('sorts findings by project, file, line regardless of target order and repeats identically', () => {
      const root = makeWorkspace([
        { name: 'zeta', root: 'apps/zeta' },
        { name: 'alpha', root: 'libs/alpha' },
        { name: 'beta', root: 'libs/beta' },
      ]);
      try {
        const brokenReadme =
          '# alpha\n\n## Purpose\n\nxem [missing](./missing.md)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, brokenReadme);
        writeReadme(root, { name: 'zeta', root: 'apps/zeta' }, validReadme('zeta'));
        // beta không có README → finding ở cấp file (line 0).

        const targets = [
          { name: 'zeta', root: 'apps/zeta' },
          { name: 'beta', root: 'libs/beta' },
          { name: 'alpha', root: 'libs/alpha' },
        ];
        const first = check(root, targets).findings;
        const reversed = [...targets];
        reversed.reverse(); // mảng copy riêng — target es2022 chưa có toReversed
        const second = check(root, reversed).findings;

        // Cùng input → cùng output, bất kể thứ tự target.
        expect(first).toEqual(second);
        // Sắp theo project: alpha < beta < zeta.
        expect(first.map((f) => f.project)).toEqual(['alpha', 'beta']);
        // Trong một project, theo dòng.
        expect(first.map((f) => f.line)).toEqual([5, 0]);
        expect(first[0].code).toBe('target-not-found');
        expect(first[1].code).toBe('missing-readme');
      } finally {
        clean(root);
      }
    });

    it('produces byte-identical output across repeated runs', () => {
      const root = makeWorkspace([{ name: 'alpha', root: 'libs/alpha' }]);
      try {
        const source =
          '# alpha\n\n## Purpose\n\nxem [missing](./missing.md) và [ok](./ok.md)\n\n## Responsibilities\n\nbody\n\n## Boundaries\n\nbody\n\n## Development\n\nbody\n\n## Testing\n\nbody\n\n## Related Documentation\n\nbody\n';
        writeReadme(root, { name: 'alpha', root: 'libs/alpha' }, source);
        writeFileSync(join(root, 'libs/alpha/ok.md'), '# ok\n');

        const first = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);
        const second = check(root, [{ name: 'alpha', root: 'libs/alpha' }]);

        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      } finally {
        clean(root);
      }
    });
  });
});
