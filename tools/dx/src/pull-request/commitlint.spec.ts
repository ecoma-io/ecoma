import { describe, expect, it } from 'vitest';

import { lintTitle } from './pr-check.js';

/**
 * Chính sách của `commitlint.config.mjs`, chấm bằng đúng runner mà hook
 * `commit-msg` và `pr-check` dùng.
 *
 * Không mô phỏng rule: mỗi case spawn commitlint thật với cấu hình thật của
 * repository, nên test này fail khi ai đó đổi rule, đổi extends, hoặc đổi
 * `scope-enum` — đúng những chỗ mà policy của commit message đặt niềm tin.
 *
 * `lintTitle` vốn là cánh tay của pr-check, nhưng bản chất của nó là "chấm một
 * message bằng commitlint của repository"; tái sử dụng thay vì viết một lần
 * spawn thứ hai, và cũng để mọi câu khẳng định đi qua cùng một tiến trình.
 */
function lint(message: string): { ok: boolean; report: string } {
  return lintTitle(message);
}

describe('commitlint config: scope policy', () => {
  // Timeout của các test spawn commitlint thật là `testTimeout` cấp project
  // trong vitest.config.mts — không đặt lại rời rạc từng test.
  it('accepts commits with no scope at all', async () => {
    // Scope là optional: không có gì để chấm, `scope-enum` trả `[true, …]`.
    for (const message of [
      'feat: add cache',
      'chore: update repository tooling',
      'docs: update README.md',
      'ci: update workflow',
    ]) {
      const result = lint(message);

      expect(result.ok, `${message}\n${result.report}`).toBe(true);
    }
  });

  it('accepts a scope that names an Nx project', async () => {
    for (const message of [
      'chore(dx): update repository tooling',
      'fix(home): fix route #123',
      'feat(dx)!: drop the legacy path',
    ]) {
      const result = lint(message);

      expect(result.ok, `${message}\n${result.report}`).toBe(true);
    }
  });

  it('rejects a scope that is not an Nx project', async () => {
    // Không hard-code danh sách Nx project ở đây: chỉ khẳng định một scope vô
    // nghĩa bị chặn, và chặn bởi `scope-enum` — rule đọc project graph của Nx.
    const result = lint('fix(non-existent): fix bug');

    expect(result.ok).toBe(false);
    expect(result.report).toContain('scope-enum');
  });

  it('rejects every part of a multi-part scope', async () => {
    // `scope-enum` tách scope theo `,` `/` `\` rồi kiểm từng phần, nên một
    // multi-scope chỉ qua được khi MỌI phần là Nx project. Đây là giới hạn của
    // commitlint cho commit message; số scope bị chặn chặt hơn ở PR title
    // (`checkTitlePolicy`) — xem `pr-check.spec.ts`.
    const result = lint('fix(home,non-existent): fix bug');

    expect(result.ok).toBe(false);
    expect(result.report).toContain('scope-enum');
  });
});

describe('commitlint config: ascii-only-message', () => {
  it('accepts ASCII punctuation and symbols', async () => {
    for (const message of [
      'feat(dx): support foo_bar-$%^*',
      'fix(home): fix route #123',
      'chore: update CI (v2)',
      'docs: update README.md',
      'feat(dx): add cache',
    ]) {
      const result = lint(message);

      expect(result.ok, `${message}\n${result.report}`).toBe(true);
    }
  });

  it('rejects non-ASCII characters anywhere in the message', async () => {
    // Cùng một rule cho header, body và footer: chỉ tập trung kiểm header sẽ
    // để lọt một message mà body dán tiếng Việt vào.
    const messages = [
      'feat: thêm tính năng',
      'fix(home): sửa navigation',
      'chore: 更新 workflow',
      'docs: mise à jour',
      'feat(dx): add cache\n\nBody có tiếng Việt.',
      'feat(dx): add cache\n\nBREAKING CHANGE: thay đổi contract.',
    ];

    for (const message of messages) {
      const result = lint(message);

      expect(result.ok, `${message}\n${result.report}`).toBe(false);
      expect(result.report).toContain('ascii-only-message');
    }
  });

  it('names the rule ascii-only-message, never english-only-message', async () => {
    // Rename phải trọn vẹn: còn sót tên cũ ở error message nghĩa là policy
    // vẫn đang nói về một mục đích (kiểm tra tiếng Anh) mà rule không làm.
    // Tên rule vẫn mô tả ĐÚNG việc rule làm — chặn ký tự ngoài ASCII.
    const result = lint('feat: thêm tính năng');

    expect(result.ok).toBe(false);
    expect(result.report).toContain('ascii-only-message');
    expect(result.report).not.toContain('english-only-message');
  });

  it('tells the author to write English and names the offending character', async () => {
    // Message là hướng dẫn cho agent: phải nêu ký tự gây lỗi và nói rõ commit
    // message viết bằng tiếng Anh. Trước đây message chỉ nói "must contain only
    // ASCII characters" — đọc như lời mời bỏ dấu tiếng Việt để lách rule.
    const result = lint('docs: mise à jour');

    expect(result.report).toContain("Non-ASCII character 'à' found");
    expect(result.report).toContain('must be written in English');
  });

  it('forbids stripping accents as a way around the rule', async () => {
    // Bỏ dấu là cách lách rule phổ biến nhất, và nó im lặng thành công: mọi ký
    // tự của tiếng Việt không dấu đều ASCII. Message phải cấm đúng cách lách đó.
    const result = lint('feat: thêm tính năng');

    expect(result.report).toContain('Do not work around this rule');
    expect(result.report).toContain('Vietnamese without diacritics');
    expect(result.report).toContain('Rewrite the entire commit message in English');
  });
});
