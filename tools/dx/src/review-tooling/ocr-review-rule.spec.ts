import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT_DIR } from '../utils.js';

/**
 * Rule của OpenCodeReview là *policy* của repository, không phải config của một
 * app: nó quyết định file nào được đưa vào AI Review. Spec này ghim phần policy
 * đó để một thay đổi vô tình không âm thầm bật/tắt phạm vi review. Phạm vi đó
 * là markdown **cộng cả file test** (`*.spec.*`/`*.test.*` họ js-ts, `*_test.py`
 * — issue #399): CLI mặc định loại mọi file test với `exclude_reason:
 * "default_path"`, nên chỉ `include` của rule mới đưa chúng vào.
 *
 * Điều spec này KHÔNG chứng minh: CLI có thật sự chọn `.md` hay file test hay
 * không. Bằng chứng cho hành vi đó là `ocr review --preview --from <base> --to
 * <head>` chạy trên artifact thật (xem PR của issue #239) và probe
 * `ocr-selection-probe.mjs` (ca 6 ghim file test trên CLI pinned), vì chỉ CLI
 * mới có quyền quyết định — spec này không mô phỏng lại doublestar của CLI.
 */
/**
 * Project rule của repository.
 *
 * Đường dẫn này đã được move từ `.opencodereview/rule.json` sang
 * `.github/ocr-rules.json`, và đây là hằng duy nhất chỉ tới nó — spec còn lại
 * không đọc file này.
 */
const RULE_PATH = join(ROOT_DIR, '.github', 'ocr-rules.json');

/**
 * Tập pattern `exclude` được phép dùng: đúng các pattern của
 * `internal/config/allowlist/default_exclude_patterns.json` (ref action đang
 * ghim) mà một file Markdown có thể khớp, cộng bốn pattern mở rộng cho tên khóa
 * riêng tư có hậu tố (upstream chỉ khớp tên khóa chính xác, ví dụ `id_rsa`, nên
 * không phủ `id_rsa.md`). Thêm pattern ngoài tập này là đổi policy review — phải
 * sửa spec này một cách có chủ ý, cùng lúc với rule.
 */
const ALLOWED_EXCLUDES = new Set([
  '**/*.generated.*',
  '**/testdata/**',
  '**/fixtures/**',
  '**/__tests__/**',
  '**/__snapshots__/**',
  '**/dist/**',
  '**/.nuxt/**',
  '**/{id_rsa,id_dsa,id_ecdsa,id_ed25519}*',
]);

const MARKDOWN_GLOBS = ['**/*.md', '**/*.markdown', '**/*.mdx'];

/**
 * Ba glob mở rộng phạm vi review sang **file test** (issue #399): CLI mặc định
 * loại mọi file test với `exclude_reason: "default_path"`, nên chỉ `include`
 * của rule mới đưa chúng vào. Giữ đúng ba glob này — thêm/bớt là đổi policy.
 */
const TEST_FILE_GLOBS = ['**/*.spec.{js,jsx,ts,tsx}', '**/*.test.{js,jsx,ts,tsx}', '**/*_test.py'];

type RuleFile = { include?: unknown; exclude?: unknown };

function readRule(): RuleFile {
  return JSON.parse(readFileSync(RULE_PATH, 'utf8')) as RuleFile;
}

describe('OpenCodeReview project rule', () => {
  it('includes every markdown and test file extension the CLI does not support by default', () => {
    const rule = readRule();
    expect(Array.isArray(rule.include)).toBe(true);
    expect(rule.include).toStrictEqual([...MARKDOWN_GLOBS, ...TEST_FILE_GLOBS]);
  });

  it('keeps a non-empty exclude list', () => {
    const rule = readRule();
    expect(Array.isArray(rule.exclude)).toBe(true);
    expect(rule.exclude).not.toHaveLength(0);
  });

  it('does not exclude any file the rule set was widened to review', () => {
    const rule = readRule();
    // Một pattern phủ toàn bộ Markdown (`**/*.md`) sẽ vô hiệu hóa chính tính
    // năng này mà mọi check khác vẫn xanh.
    const catchAll = ['**/*.md', '**/*.markdown', '**/*.mdx', '**'];
    for (const pattern of rule.exclude as unknown[]) {
      expect(catchAll).not.toContain(pattern);
    }
  });

  it('only uses documented exclude patterns', () => {
    const rule = readRule();
    const unexpected = (rule.exclude as unknown[]).filter(
      (pattern) => typeof pattern !== 'string' || !ALLOWED_EXCLUDES.has(pattern),
    );
    expect(unexpected).toStrictEqual([]);
  });
});
