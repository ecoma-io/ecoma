import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkProjectReadmes } from './readme-checker.js';

/**
 * `unparseable-markdown` là nhánh phòng ngự: `mdast-util-from-markdown` được
 * thiết kế để parse mọi đầu vào thành một cái gì đó, nên nhánh này không bao giờ
 * được kích bởi dữ liệu thực. Kiểm này mô-đun giả ném lỗi từ parser để chứng
 * minh check PROJECT không bỏ qua lặng lẽ khi parse thất bại — tìm thấy một
 * finding cứng thay vì trả về danh sách rỗng.
 */

vi.mock('./markdown-ast.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./markdown-ast.js')>();
  return {
    ...actual,
    parseMarkdown: () => {
      throw new Error('simulated parse failure');
    },
  };
});

describe('unparseable-markdown', () => {
  it('reports a hard finding instead of silently passing', () => {
    const root = mkdtempSync(join(tmpdir(), 'readme-check-unparse-'));
    mkdirSync(join(root, 'libs/alpha'), { recursive: true });
    try {
      writeFileSync(join(root, 'libs/alpha/README.md'), '# anything\n');
      const result = checkProjectReadmes([{ name: 'alpha', root: 'libs/alpha' }], {
        workspaceRoot: root,
      });

      expect(result.findings).toEqual([
        expect.objectContaining({
          project: 'alpha',
          file: 'libs/alpha/README.md',
          line: 0,
          code: 'unparseable-markdown',
          message: expect.stringContaining('simulated parse failure'),
          hint: expect.stringContaining('Markdown syntax'),
        }),
      ]);
      expect(result.summary.findings).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
