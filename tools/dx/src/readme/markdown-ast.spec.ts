import { describe, expect, it } from 'vitest';

import { parseMarkdown, splitLines } from './markdown-ast.js';

/**
 * Parser fixtures cho readme-check.
 *
 * Mỗi fixture dưới đây lấy từ cú pháp Markdown THỰC SỰ dùng trong repository
 * (được nhận diện qua bộ khảo sát tất cả file `.md` đã tracked), rồi rút gọn
 * xuống đoạn ngắn gọn giữ lại đúng cấu trúc cần kiểm. Hướng dẫn language policy
 * vẫn áp cho comment/JSDoc này (tiếng Việt); chuỗi trong fixture là mẫu dữ liệu
 * kiểm thử, không phải chuỗi runtime, nên được phép chứa tiếng Việt.
 */

describe('parseMarkdown', () => {
  describe('inline link', () => {
    it('extracts a plain inline link with its line', () => {
      const parsed = parseMarkdown('[docs](docs/architecture/06-testing.md)\n');

      expect(parsed.links).toEqual([
        {
          kind: 'link',
          target: 'docs/architecture/06-testing.md',
          text: 'docs',
          line: 1,
        },
      ]);
    });

    it('extracts the angle-bracket destination form', () => {
      const parsed = parseMarkdown('[file](<path with spaces.md>)\n');

      expect(parsed.links).toEqual([
        {
          kind: 'link',
          target: 'path with spaces.md',
          text: 'file',
          line: 1,
        },
      ]);
    });

    it('extracts links in table cells (real syntax from CONTRIBUTING.md)', () => {
      // CONTRIBITING.md có cột chứa [`docs/...`](docs/...) trong bảng.
      const parsed = parseMarkdown(
        '| Document | Link |\n| --- | --- |\n| [`docs/engineering/evolution-process.md`](docs/engineering/evolution-process.md) |\n',
      );

      expect(parsed.links).toEqual([
        {
          kind: 'link',
          target: 'docs/engineering/evolution-process.md',
          text: 'docs/engineering/evolution-process.md',
          line: 3,
        },
      ]);
    });

    it('does not extract a link inside a code fence', () => {
      // Pattern thực tế: CONTRIBUTING.md và docs/* có code fence chứa `[t](target)`.
      const source = `\
## 2.1 Chuẩn bị môi trường

\`\`\`bash
pnpm install   # [docs](docs/architecture/06-testing.md) sẽ không phải link
\`\`\`
`;
      const parsed = parseMarkdown(source);

      expect(parsed.links).toEqual([]);
    });

    it('does not extract a link inside an inline code span', () => {
      const parsed = parseMarkdown('xem `[docs](x.md)` trong code span\n');

      expect(parsed.links).toEqual([]);
    });

    it('does not extract an escaped bracket sequence', () => {
      const parsed = parseMarkdown('[docs\\(x\\)]\n');

      expect(parsed.links).toEqual([]);
    });

    it('treats [A-Za-z0-9][A-Za-z0-9_-] in prose as plain text, not links', () => {
      // Biểu thức chính xác trong docs/applications/staff-access/03-operations.md:
      // hai nhóm ngoặc vuông liền nhau mà KHÔNG có definition — GitHub render
      // literal, check cũng phải không coi là link.
      const parsed = parseMarkdown(`khớp của [A-Za-z0-9][A-Za-z0-9_-]\n`);

      expect(parsed.links).toEqual([]);
    });
  });

  describe('autolink and image', () => {
    it('treats an autolink as an external link the caller skips', () => {
      const parsed = parseMarkdown('<https://github.com/ecoma-io/ecoma>\n');

      expect(parsed.links).toEqual([
        {
          kind: 'link',
          target: 'https://github.com/ecoma-io/ecoma',
          text: 'https://github.com/ecoma-io/ecoma',
          line: 1,
        },
      ]);
    });

    it('extracts an image as a link candidate', () => {
      const parsed = parseMarkdown('![logo](./settings-after.png)\n');

      expect(parsed.links).toEqual([
        { kind: 'image', target: './settings-after.png', text: 'logo', line: 1 },
      ]);
    });

    it('extracts an image nested inside a link text', () => {
      const parsed = parseMarkdown('[![alt](./x.png)](https://example.com)\n');

      // Thứ tự là thứ tự cây AST: link bao ngoài đến trước, image bên trong sau.
      expect(parsed.links).toEqual([
        { kind: 'link', target: 'https://example.com', text: 'alt', line: 1 },
        { kind: 'image', target: './x.png', text: 'alt', line: 1 },
      ]);
    });
  });

  describe('reference-style link', () => {
    it('resolves full reference against its definition, first definition wins', () => {
      const parsed = parseMarkdown(
        '[t][id]\n\n[t][id2]\n\n[id]: ./first.md\n[id2]: ./second.md\n[id]: ./ignored.md\n',
      );

      expect(parsed.links).toEqual([
        { kind: 'reference', target: 'id', text: 't', line: 1, referenceType: 'full' },
        { kind: 'reference', target: 'id2', text: 't', line: 3, referenceType: 'full' },
      ]);
      expect(parsed.definitions.get('id')?.target).toBe('./first.md');
      expect(parsed.definitions.get('id2')?.target).toBe('./second.md');
    });

    it('supports collapsed reference [t][]', () => {
      const parsed = parseMarkdown('[t][]\n\n[t]: ./t.md\n');

      expect(parsed.links).toEqual([
        { kind: 'reference', target: 't', text: 't', line: 1, referenceType: 'collapsed' },
      ]);
      expect(parsed.definitions.get('t')?.target).toBe('./t.md');
    });

    it('treats shortcut reference without definition as plain text, not a link', () => {
      const parsed = parseMarkdown('[t]\n\n[no definition here]\n');

      expect(parsed.links).toEqual([]);
    });

    it('treats shortcut reference WITH definition as a link candidate', () => {
      const parsed = parseMarkdown('[t]\n\n[t]: ./t.md\n');

      expect(parsed.links).toEqual([
        { kind: 'reference', target: 't', text: 't', line: 1, referenceType: 'shortcut' },
      ]);
    });

    it('is case-insensitive for reference identifiers', () => {
      const parsed = parseMarkdown('[T][id]\n\n[id]: ./x.md\n');

      expect(parsed.links[0].kind).toBe('reference');
      expect(parsed.links[0].target).toBe('id');
    });
  });

  describe('unsupported construct (hard finding)', () => {
    it('reports HTML carrying href/src as unsupported', () => {
      // Thực tế repository chỉ có HTML trong code fence; đây là kiểm contract:
      // một người viết HTML link trong README phải bị bắt, không được bỏ qua.
      const parsed = parseMarkdown('<a href="./x.md">x</a>\n');

      expect(parsed.unsupported).toEqual([
        {
          line: 1,
          detail:
            'HTML carrying a link attribute (href/src); plain Markdown link syntax is required so the checker can verify the target',
        },
      ]);
    });

    it('exempts an HTML comment from unsupported and from links', () => {
      // Mẫu thực tế từ libs/ui-app-shell/README.md: comment trong code fence Vue.
      const parsed = parseMarkdown(
        `\`\`\`vue
<template #brand><!-- logo/thương hiệu của app --></template>
\`\`\`
`,
      );

      expect(parsed.links).toEqual([]);
      expect(parsed.unsupported).toEqual([]);
    });

    it('reports a footnote-style reference as unsupported', () => {
      const parsed = parseMarkdown('[^1]\n\n[^1]: note\n');

      expect(parsed.links).toEqual([]);
      expect(parsed.unsupported).toEqual([
        {
          line: 1,
          detail:
            'footnote-style reference "[^1]"; footnotes are outside the supported CommonMark subset',
        },
      ]);
    });
  });

  describe('heading', () => {
    it('collects headings with depth, text and lines', () => {
      const parsed = parseMarkdown('# Tiêu đề\n\n## Section hai\n');

      expect(parsed.headings).toEqual([
        { depth: 1, text: 'Tiêu đề', line: 1, endLine: 1 },
        { depth: 2, text: 'Section hai', line: 3, endLine: 3 },
      ]);
    });

    it('keeps Vietnamese diacritics in heading text', () => {
      const parsed = parseMarkdown('## Mục đích của project\n');

      expect(parsed.headings[0].text).toBe('Mục đích của project');
    });

    it('parses a setext H2 under a line of text', () => {
      const parsed = parseMarkdown('Testing\n-------\n');

      expect(parsed.headings).toEqual([{ depth: 2, text: 'Testing', line: 1, endLine: 2 }]);
    });

    it('counts inline emphasis inside heading as plain text', () => {
      const parsed = parseMarkdown('## **Testing** phần mềm\n');

      expect(parsed.headings[0].text).toBe('Testing phần mềm');
    });
  });

  describe('splitLines', () => {
    it('keeps one entry per line including the trailing empty line', () => {
      expect(splitLines('a\nb\nc\n')).toEqual(['a', 'b', 'c', '']);
    });
  });
});
