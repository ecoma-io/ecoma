import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Cổng `ocr-result-gate.mjs` là entrypoint Node thuần (không phụ thuộc package
 * nào) vì job `code-review` không cài `node_modules`. Vì vậy spec chạy đúng
 * tiến trình mà workflow chạy — không import nội bộ, chỉ quan sát exit code và
 * output thật. Đó cũng là cách duy nhất chạm được hợp đồng của entrypoint.
 */
const GATE = fileURLToPath(new URL('../../scripts/ocr-result-gate.mjs', import.meta.url));

let workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  workdirs = [];
});

/**
 * Dựng `ocr-result.json` + `ocr-stderr.log` (và tùy chọn `rule.json`) trong thư
 * mục tạm riêng.
 * @param result nội dung JSON (object) hoặc chuỗi thô để test JSON hỏng
 * @param stderr nội dung log stderr
 * @param rule project rule, hoặc `null` để không tạo file rule
 */
function writeCase(
  result: unknown,
  stderr: string,
  rule: unknown = null,
): { result: string; stderr: string; rule?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ocr-gate-'));
  workdirs.push(dir);
  const resultPath = join(dir, 'ocr-result.json');
  const stderrPath = join(dir, 'ocr-stderr.log');
  const rulePath = join(dir, 'rule.json');
  writeFileSync(resultPath, typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  writeFileSync(stderrPath, stderr);
  const paths: { result: string; stderr: string; rule?: string } = {
    result: resultPath,
    stderr: stderrPath,
  };
  if (rule !== null) {
    writeFileSync(rulePath, typeof rule === 'string' ? rule : JSON.stringify(rule, null, 2));
    paths.rule = rulePath;
  }
  return paths;
}

function runGate(paths: { result: string; stderr?: string; rule?: string }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const args = ['--result', paths.result];
  if (paths.stderr !== undefined) {
    args.push('--stderr', paths.stderr);
  }
  if (paths.rule !== undefined) {
    args.push('--rule', paths.rule);
  }
  const proc = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

type CoverageItem = { item_id: string; path: string; fingerprint?: string };

function item(path: string): CoverageItem {
  return { item_id: `i_${path}`, path, fingerprint: `f_${path}` };
}

/**
 * Kết quả OCR tối thiểu theo schema thật (`ocr.run-manifest/v1`); các test tự
 * ghi đè phần cần đo.
 */
function ocrResult(overrides: {
  status?: string;
  summary?: unknown;
  manifest?: unknown;
  message?: string;
}): Record<string, unknown> {
  return {
    status: 'complete',
    message: 'Review complete: 0 finding(s) across 2 selected item(s).',
    tool_calls: { total: 0, by_tool: {}, failure: 0, failure_by_tool: {}, failure_details: [] },
    comments: [],
    summary: {
      files_reviewed: 2,
      comments: 0,
      total_tokens: 1200,
      input_tokens: 1000,
      output_tokens: 200,
      elapsed: '3s',
    },
    manifest: {
      schema_version: 'ocr.run-manifest/v1',
      terminal_state: 'complete',
      coverage: {
        selected: [item('docs/a.md'), item('docs/b.md')],
        completed: [item('docs/a.md'), item('docs/b.md')],
        reused: [],
        failed: [],
        waived: [],
      },
    },
    ...overrides,
  };
}

const CLEAN_STDERR =
  '[ocr] 4 file(s) changed, reviewing 2 in /repo\n' +
  '[ocr] Skipping pnpm-lock.yaml — filtered by path/extension rules\n' +
  '[ocr] Skipping .env — matches a built-in secret path\n' +
  '[ocr] Filtered 2 file(s) by include/exclude rules\n';

/**
 * Kết quả `skipped` đúng schema thật (mọi coverage array rỗng); các test
 * nothing-in-scope dùng lại nguyên khối và chỉ đổi stderr/rule.
 */
function skippedResult(): Record<string, unknown> {
  return ocrResult({
    status: 'skipped',
    message: 'Review skipped: no items were selected.',
    summary: { files_reviewed: 0, comments: 0, total_tokens: 0, elapsed: '0s' },
    manifest: {
      schema_version: 'ocr.run-manifest/v1',
      terminal_state: 'skipped',
      coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
    },
  });
}

describe('ocr-result-gate', () => {
  it('passes when the review completed on at least one file', () => {
    const paths = writeCase(ocrResult({}), CLEAN_STDERR);
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).toContain('files_reviewed=2');
    expect(stdout).toContain('skipped by design');
  });

  it('fails when the review was skipped because no item was selected', () => {
    // Under the issue #391 contract this fixture still fails, and honestly so:
    // no rule file exists on disk (`rule: null` -> default path unreadable), so
    // the audit falls back to the MARKDOWN_EXT heuristic; the skipped files
    // docs/a.md and docs/b.md match that fallback, so the gate cannot prove
    // they are outside the review scope. Without that proof the skipped path
    // stays fail-closed — exactly the #239 guard. A spec-only diff would pass
    // here; a markdown diff must not.
    const paths = writeCase(
      ocrResult({
        status: 'skipped',
        message: 'Review skipped: no items were selected.',
        summary: { files_reviewed: 0, comments: 0, total_tokens: 0, elapsed: '0s' },
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'skipped',
          coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
        },
      }),
      '[ocr] 2 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping docs/a.md — filtered by path/extension rules\n' +
        '[ocr] Skipping docs/b.md — filtered by path/extension rules\n' +
        '[ocr] Filtered 2 file(s) by include/exclude rules\n' +
        '[ocr] No supported files changed. Skipping review.\n',
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('NOT VERIFIED');
    expect(stdout).toContain('terminal_state is "skipped"');
    expect(stdout).toContain('::error::');
  });

  it('fails when files_reviewed is 0 even though terminal_state is complete', () => {
    const paths = writeCase(
      ocrResult({
        summary: { files_reviewed: 0, comments: 0, total_tokens: 0, elapsed: '0s' },
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'complete',
          coverage: {
            selected: [item('docs/a.md')],
            completed: [item('docs/a.md')],
            reused: [],
            failed: [],
            waived: [],
          },
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('summary.files_reviewed is 0: no file was reviewed');
  });

  it('fails when summary.files_reviewed is missing', () => {
    const paths = writeCase(ocrResult({ summary: { comments: 0 } }), CLEAN_STDERR);
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('summary.files_reviewed is not a non-negative integer');
  });

  it('fails when the manifest is missing', () => {
    const paths = writeCase(ocrResult({ manifest: undefined }), CLEAN_STDERR);
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('manifest missing');
  });

  it('fails on malformed JSON', () => {
    const paths = writeCase('{ "status": "complete",,', CLEAN_STDERR);
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('cannot parse');
  });

  it('fails when the result file does not exist', () => {
    const { status, stdout } = runGate({ result: '/nonexistent/ocr-result.json' });
    expect(status).toBe(1);
    expect(stdout).toContain('NOT VERIFIED');
    expect(stdout).toContain('cannot read');
  });

  it('fails on a partial review and names the failed items', () => {
    const failed = { ...item('apps/home/package.json'), classification: 'budget' };
    const paths = writeCase(
      ocrResult({
        status: 'partial',
        message: 'Review partially complete: 0 finding(s); 1 of 2 selected item(s) failed.',
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'partial',
          coverage: {
            selected: [item('docs/a.md'), { ...item('apps/home/package.json') }],
            completed: [item('docs/a.md')],
            reused: [],
            failed: [failed],
            waived: [],
          },
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('terminal_state is "partial"');
    expect(stdout).toContain('apps/home/package.json (budget)');
  });

  it('fails when a file was dropped for exceeding the size limit', () => {
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/big.md (~189000 tokens exceeds 80% of max_tokens(200000))\n' +
        '[ocr] Pre-filtered 1 file(s) exceeding 80% of max_tokens\n',
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('dropped for exceeding the size limit');
    expect(stdout).toContain('docs/big.md');
  });

  it('fails when a file was skipped for an unrecognized reason', () => {
    const paths = writeCase(ocrResult({}), '[ocr] Skipping docs/a.md — some future gate\n');
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('unrecognized reason');
    expect(stdout).toContain('docs/a.md');
  });

  it('fails when no item is completed or reused although something was reviewed', () => {
    // terminal_state nói "complete" và files_reviewed > 0, nhưng coverage không
    // có item nào hoàn tất — dữ liệu tự mâu thuẫn nên không được tin.
    const paths = writeCase(
      ocrResult({
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'complete',
          coverage: {
            selected: [item('docs/a.md')],
            completed: [],
            reused: [],
            failed: [],
            waived: [],
          },
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('neither a completed nor a reused item');
  });

  it('fails on the size rollup line alone', () => {
    // CLI có thể chỉ in dòng tổng hợp; khi đó vẫn phải coi là review chưa đầy đủ.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Pre-filtered 3 file(s) exceeding 80% of max_tokens\n',
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('pre-filtered file(s) exceeding the size limit');
  });

  it('passes when every item was reused from a previous run', () => {
    // Lần chạy này không review file nào, nhưng checkpoint đã review đủ item —
    // đây không phải "xanh giả" nên chỉ ghi chú, không fail.
    const paths = writeCase(
      ocrResult({
        summary: { files_reviewed: 0, comments: 0, total_tokens: 0, elapsed: '0s' },
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'complete',
          coverage: {
            selected: [item('docs/a.md')],
            completed: [],
            reused: [item('docs/a.md')],
            failed: [],
            waived: [],
          },
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).toContain('reused from a previous run');
  });

  it('fails when the token budget truncated the review', () => {
    const paths = writeCase(
      ocrResult({
        summary: {
          files_reviewed: 2,
          comments: 0,
          total_tokens: 9,
          elapsed: '3s',
          budget_exceeded: true,
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('token budget was reached');
  });

  it('fails when coverage does not match a complete terminal state', () => {
    const paths = writeCase(
      ocrResult({
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'complete',
          coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('coverage.selected is empty');
  });

  it('fails when the stderr log is unavailable because size skips cannot be ruled out', () => {
    // Không có log thì không thể biết file nào bị bỏ vì vượt kích thước, mà JSON
    // lại không mang thông tin đó: thiếu dữ liệu không phải là review sạch.
    const paths = writeCase(ocrResult({}), CLEAN_STDERR);
    const { status, stdout } = runGate({ result: paths.result, stderr: '/nonexistent.log' });
    expect(status).toBe(1);
    expect(stdout).toContain('NOT VERIFIED');
    expect(stdout).toContain('cannot rule out size-gated skips');
    expect(stdout).toContain('is unreadable');
  });

  it('fails when the stderr log is empty', () => {
    // Log rỗng cũng vô dụng như log thiếu: `stream_progress` tắt là một cách làm
    // mất tín hiệu kích thước.
    const paths = writeCase(ocrResult({}), '');
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('cannot rule out size-gated skips');
    expect(stdout).toContain('is empty');
  });

  it('passes when every changed file is provably outside the rule scope (issue 391)', () => {
    // Đúng bằng chứng của run thật PR #390 (run 40836248838): 1 file spec duy
    // nhất bị CLI loại theo path/extension, rule chỉ include Markdown → không có
    // gì trong phạm vi để review. Cổng phải pass kèm ghi chú thay vì đỏ vĩnh
    // viễn một diff hợp lệ.
    const paths = writeCase(
      skippedResult(),
      '[ocr] 1 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping tools/dx/src/security/semgrep-scan.spec.ts — filtered by path/extension rules\n' +
        '[ocr] Filtered 1 file(s) by include/exclude rules\n' +
        '[ocr] No supported files changed. Skipping review.\n',
      {
        include: ['**/*.md', '**/*.markdown', '**/*.mdx'],
        exclude: [
          '**/*.generated.*',
          '**/testdata/**',
          '**/fixtures/**',
          '**/__tests__/**',
          '**/__snapshots__/**',
          '**/dist/**',
          '**/.nuxt/**',
          '**/{id_rsa,id_dsa,id_ecdsa,id_ed25519}*',
        ],
      },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).toContain('0 in-scope file(s): nothing to review under the project rule');
    expect(stdout).not.toContain('::error::');
    expect(stdout).not.toContain('NOT VERIFIED');
  });

  it('fails when a skipped file was inside the rule include scope', () => {
    // Bảo vệ #239 trên đường `skipped`: file Markdown thuộc phạm vi rule mà vẫn
    // bị bỏ nghĩa là rule mất hiệu lực cho run này — không được cấp qua.
    const paths = writeCase(
      skippedResult(),
      '[ocr] 2 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping docs/architecture.md — filtered by path/extension rules\n' +
        '[ocr] Skipping tools/dx/src/app.spec.ts — filtered by path/extension rules\n' +
        '[ocr] Filtered 2 file(s) by include/exclude rules\n',
      { include: ['**/*.md'], exclude: ['**/dist/**'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('inside the project rule include scope were skipped');
    expect(stdout).toContain('docs/architecture.md');
    expect(stdout).toContain('::error::');
  });

  it('fails when a skipped review has an unrecognized skip reason', () => {
    // Lý do lạ = có thể là một gate mới đang bỏ file trong phạm vi — không đủ
    // bằng chứng "mọi file đều ngoài phạm vi".
    const paths = writeCase(
      skippedResult(),
      '[ocr] 1 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping tools/dx/src/app.spec.ts — some future gate\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('unrecognized reason');
    expect(stdout).toContain('::error::');
  });

  it('fails when a skipped review has a size-gated skip', () => {
    // File bị gate kích thước là file lớn — luôn đáng review nếu nằm trong phạm
    // vi, nên không bao giờ coi là "nothing in scope".
    const paths = writeCase(
      skippedResult(),
      '[ocr] 1 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping docs/big.md (~189000 tokens exceeds 80% of max_tokens(200000))\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('dropped for exceeding the size limit');
    expect(stdout).toContain('::error::');
  });

  it('fails when the stderr log is missing on a skipped review', () => {
    // Không log = không có bằng chứng file nào bị bỏ vì sao — không thể chứng
    // minh "mọi file đều ngoài phạm vi".
    const paths = writeCase(skippedResult(), CLEAN_STDERR);
    const { status, stdout } = runGate({ result: paths.result, stderr: '/nonexistent.log' });
    expect(status).toBe(1);
    expect(stdout).toContain('terminal_state is "skipped"');
    expect(stdout).toContain('cannot prove nothing-in-scope');
    expect(stdout).toContain('::error::');
  });

  it('fails when the selection line contradicts the skipped state', () => {
    // CLI nói `reviewing 2` nhưng manifest nói `skipped`: dữ liệu tự mâu thuẫn,
    // không được dùng làm bằng chứng "nothing in scope".
    const paths = writeCase(
      skippedResult(),
      '[ocr] 4 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping pnpm-lock.yaml — filtered by path/extension rules\n' +
        '[ocr] Skipping .env — matches a built-in secret path\n' +
        '[ocr] Filtered 2 file(s) by include/exclude rules\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('terminal_state is "skipped"');
    expect(stdout).toContain('::error::');
  });

  it('fails when the selection line is absent from a skipped review stderr', () => {
    // Không có dòng selection thì không chứng minh được CLI thực sự thấy 0 file
    // đáng chọn — thiếu bằng chứng, fail-closed.
    const paths = writeCase(
      skippedResult(),
      '[ocr] Skipping tools/dx/src/app.spec.ts — filtered by path/extension rules\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('terminal_state is "skipped"');
    expect(stdout).toContain('::error::');
  });

  it('fails when the changed count does not match the skip lines on a skipped review', () => {
    // 2 file thay đổi nhưng chỉ 1 dòng skip: file còn lại không giải thích được —
    // có thể là file trong phạm vi bị bỏ im lặng.
    const paths = writeCase(
      skippedResult(),
      '[ocr] 2 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping tools/dx/src/app.spec.ts — filtered by path/extension rules\n' +
        '[ocr] Filtered 1 file(s) by include/exclude rules\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('terminal_state is "skipped"');
    expect(stdout).toContain('::error::');
  });

  it('passes when a skipped review only filtered binary and secret files out of scope', () => {
    // PR chỉ đổi lockfile/binary/secret: các lý do bỏ qua đều không cần rule để
    // biện minh (binary và secret không bao giờ thuộc phạm vi review), nên đây
    // là "nothing in scope" chính đáng.
    const paths = writeCase(
      skippedResult(),
      '[ocr] 3 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping pnpm-lock.yaml — filtered by path/extension rules\n' +
        '[ocr] Skipping assets/logo.png — binary file\n' +
        '[ocr] Skipping .env — matches a built-in secret path\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).toContain('0 in-scope file(s): nothing to review under the project rule');
    expect(stdout).not.toContain('::error::');
  });

  it('passes when the selection line is preceded by other stderr output', () => {
    // CLI có thể in dòng progress/warning trước dòng selection: `SELECTION_LINE`
    // phải neo theo đầu từng dòng (cờ `m`) và parser phải tìm được dòng selection
    // ở bất kỳ vị trí nào, nếu không một diff hợp lệ ngoài phạm vi sẽ đỏ oan
    // (findings OCR của PR #403, run 40863933482).
    const paths = writeCase(
      skippedResult(),
      '[ocr] resolving repository context\n' +
        '[ocr] 1 file(s) changed, reviewing 0 in /repo\n' +
        '[ocr] Skipping tools/dx/src/security/semgrep-scan.spec.ts — filtered by path/extension rules\n' +
        '[ocr] Filtered 1 file(s) by include/exclude rules\n',
      {
        include: ['**/*.md', '**/*.markdown', '**/*.mdx'],
        exclude: [],
      },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).toContain('0 in-scope file(s): nothing to review under the project rule');
    expect(stdout).not.toContain('::error::');
  });

  it('fails when a skipped manifest still lists selected coverage items', () => {
    // Manifest tự mâu thuẫn: `terminal_state: "skipped"` nhưng coverage có item
    // selected/completed/reused. Stderr có thể sạch (mọi file được giải thích),
    // nhưng CLI thực không thể vừa "skipped" vừa có item đã chọn — dữ liệu mâu
    // thuẫn không được dùng làm bằng chứng "nothing in scope" (findings OCR của
    // PR #403, run 40863933482).
    const provablyOutOfScopeStderr =
      '[ocr] 1 file(s) changed, reviewing 0 in /repo\n' +
      '[ocr] Skipping tools/dx/src/security/semgrep-scan.spec.ts — filtered by path/extension rules\n' +
      '[ocr] Filtered 1 file(s) by include/exclude rules\n';
    const rule = { include: ['**/*.md', '**/*.markdown', '**/*.mdx'], exclude: [] };
    for (const field of ['selected', 'completed', 'reused'] as const) {
      const contradiction = skippedResult();
      const base = contradiction.manifest as Record<string, unknown>;
      const coverage = base.coverage as Record<string, unknown>;
      contradiction.manifest = {
        ...base,
        coverage: { ...coverage, [field]: [item('docs/a.md')] },
      };
      const paths = writeCase(contradiction, provablyOutOfScopeStderr, rule);
      const { status, stdout } = runGate(paths);
      expect(status, `coverage.${field} non-empty must block the grant`).toBe(1);
      expect(stdout).toContain('terminal_state is "skipped"');
      expect(stdout).toContain('::error::');
    }
  });

  it('notes a missing stderr log without piling on when the review already failed', () => {
    const paths = writeCase(
      ocrResult({
        status: 'skipped',
        message: 'Review skipped: no items were selected.',
        summary: { files_reviewed: 0, comments: 0, total_tokens: 0, elapsed: '0s' },
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'skipped',
          coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
        },
      }),
      CLEAN_STDERR,
    );
    const { status, stdout } = runGate({ result: paths.result, stderr: '/nonexistent.log' });
    expect(status).toBe(1);
    expect(stdout).toContain('terminal_state is "skipped"');
    expect(stdout).toContain('note: /nonexistent.log is unreadable');
    expect(stdout).not.toContain('cannot rule out size-gated skips');
  });

  it('fails when a file inside the rule include scope was skipped by path/extension rules', () => {
    // Đây là lỗi #239 tái diễn trong âm thầm: rule mở phạm vi ra Markdown, nhưng
    // file .md lại bị bỏ vì path/extension trong khi một file code vẫn được
    // review — nếu chỉ đòi "có ít nhất một file được review" thì sẽ xanh giả.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/architecture.md — filtered by path/extension rules\n' +
        '[ocr] Filtered 1 file(s) by include/exclude rules\n',
      { include: ['**/*.md'], exclude: ['**/dist/**'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('inside the project rule include scope were skipped');
    expect(stdout).toContain('docs/architecture.md');
  });

  it('passes when the skipped files are outside the rule include scope', () => {
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 4 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping pnpm-lock.yaml — filtered by path/extension rules\n' +
        '[ocr] Skipping assets/logo.png — filtered by path/extension rules\n' +
        '[ocr] Filtered 2 file(s) by include/exclude rules\n',
      { include: ['**/*.md'], exclude: ['**/dist/**'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).toContain('rule=');
  });

  it('passes when the rule itself excludes the skipped markdown file', () => {
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 4 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/api.generated.md — filtered by path/extension rules\n' +
        '[ocr] Skipping dist/bundle.md — filtered by path/extension rules\n' +
        '[ocr] Filtered 2 file(s) by include/exclude rules\n',
      { include: ['**/*.md'], exclude: ['**/*.generated.*', '**/dist/**'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('fails when markdown was skipped but the rule cannot be read', () => {
    // Không đọc được rule thì không chứng minh được file bị bỏ nằm ngoài phạm vi
    // review của repo — thiếu bằng chứng, không được coi là review sạch.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/architecture.md — filtered by path/extension rules\n',
    );
    const { status, stdout } = runGate({ ...paths, rule: '/nonexistent/rule.json' });
    expect(status).toBe(1);
    expect(stdout).toContain('cannot prove');
    expect(stdout).toContain('docs/architecture.md');
  });

  it('does not fail on a skipped non-markdown file when the rule cannot be read', () => {
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping pnpm-lock.yaml — filtered by path/extension rules\n',
    );
    const { status, stdout } = runGate({ ...paths, rule: '/nonexistent/rule.json' });
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('matches a nested path against a `**/dir/**` exclude pattern', () => {
    // `**/dist/**` phải khớp cả đường dẫn lồng nhau; nếu `**` bị hiểu thành một
    // segment thì file nằm sâu trong dist/ sẽ bị coi là trong phạm vi review.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping packages/app/dist/generated/notes.md — filtered by path/extension rules\n',
      { include: ['**/*.md'], exclude: ['**/dist/**'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('matches a brace-list exclude pattern', () => {
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping keys/id_rsa.md — filtered by path/extension rules\n',
      { include: ['**/*.md'], exclude: ['**/{id_rsa,id_dsa,id_ecdsa,id_ed25519}*'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('drives scope from the rule include list, not from a hardcoded extension', () => {
    // Scope của cổng phải đọc từ `include` của rule: một file `.txt` được include
    // mà bị bỏ cũng là "rule không còn hiệu lực".
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/guide.txt — filtered by path/extension rules\n',
      { include: ['**/*.txt'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('docs/guide.txt');
  });

  it('ignores the benign LLM-grouping progress line', () => {
    // CLI in `[ocr] Skipping LLM grouping ...` cho mọi thay đổi 2–3 file
    // (grouping.go); cùng mở đầu "Skipping" nhưng không phải file bị loại.
    // Không phân biệt được thì mọi job review hoàn chỉnh có 2–3 file đều fail.
    const paths = writeCase(
      ocrResult({
        summary: { files_reviewed: 3, comments: 0, total_tokens: 0, elapsed: '3s' },
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          terminal_state: 'complete',
          coverage: {
            selected: [item('docs/a.md'), item('docs/b.md'), item('docs/c.md')],
            completed: [item('docs/a.md'), item('docs/b.md'), item('docs/c.md')],
            reused: [],
            failed: [],
            waived: [],
          },
        },
      }),
      '[ocr] 4 file(s) changed, reviewing 3 in /repo\n' +
        '[ocr] Skipping src/migrations.spec.ts — filtered by path/extension rules\n' +
        '[ocr] Skipping LLM grouping for 3 file(s), 94 changed line(s) — reviewing as one group\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
    expect(stdout).not.toContain('unrecognized reason');
  });

  it('still fails on an unknown skip reason alongside the grouping line', () => {
    // Dòng grouping vô hại không được che lấp một lý do bỏ qua lạ thật sự.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/a.md — some novel reason\n' +
        '[ocr] Skipping LLM grouping for 2 file(s), 40 changed line(s) — reviewing as one group\n',
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('unrecognized reason');
  });

  it('matches rule excludes case-insensitively like the CLI', () => {
    // CLI hạ cả pattern lẫn path về chữ thường trước khi so; cổng cũng phải
    // như vậy, nếu không thì file bị exclude với chữ hoa sẽ bị coi là trong
    // phạm vi review và fail một job sạch.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping Docs/Notes.GENERATED.md — filtered by path/extension rules\n',
      { include: ['**/*.md'], exclude: ['**/*.generated.*'] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('does not treat a rule with an empty include as an empty scope', () => {
    // Rule hợp lệ JSON nhưng `include` rỗng không có nghĩa "không file nào trong
    // phạm vi": nếu vậy thì mọi file bị bỏ đều hợp lệ và cổng thành fail-open.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/architecture.md — filtered by path/extension rules\n',
      {},
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('the rule is not in effect');
    expect(stdout).toContain('docs/architecture.md');
  });

  it('ignores the benign plan-phase progress line', () => {
    // `agent.go` in dòng plan phase cho mỗi group nhỏ — cũng mở đầu "Skipping"
    // nhưng không phải file bị loại; nhầm nó thành lý do lạ sẽ fail job sạch.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 4 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping plan phase for group "apps/auth/migrations/0010_x.sql" (1 file(s), max 18 lines, total 18 lines)\n' +
        '[ocr] Skipping plan phase for group "apps/account/db/migrations/0003_y.sql" (1 file(s), max 13 lines, total 13 lines)\n',
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('fails on a `[ocr] Skipping` line it cannot classify', () => {
    // Nếu CLI đổi dấu phân cách (em-dash -> `--`) thì mẫu skip không khớp; dòng
    // đó phải thành lý do chưa nhận dạng chứ không được bỏ qua âm thầm, nếu
    // không một file bị bỏ sẽ biến mất và cổng trả VERIFIED sai.
    const paths = writeCase(
      ocrResult({}),
      '[ocr] 3 file(s) changed, reviewing 2 in /repo\n' +
        '[ocr] Skipping docs/architecture.md -- filtered by path/extension rules\n',
      { include: ['**/*.md'], exclude: [] },
    );
    const { status, stdout } = runGate(paths);
    expect(status).toBe(1);
    expect(stdout).toContain('unrecognized reason');
  });

  it('exits 2 on a usage error', () => {
    const paths = writeCase(ocrResult({}), CLEAN_STDERR);
    const proc = spawnSync(process.execPath, [GATE, '--bogus', paths.result], { encoding: 'utf8' });
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('unknown argument');
  });
});
