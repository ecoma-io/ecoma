/**
 * Engine chạy `semgrep --test` trên bộ rule của repository, dùng chung cho
 * `semgrep-test-local` và `semgrep-test-ci`.
 *
 * `--test` chỉ đọc `.github/semgrep/` (rule + fixture của chúng), không quét
 * source của repo, nên nó không cần git dir — khác `semgrep-scan*`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { gitEnv, ROOT_DIR } from '../utils.js';
import { SEMGREP_IMAGE } from './semgrep-scan.js';

/**
 * Đường dẫn mount BẮT BUỘC phải là `/src`.
 *
 * Semgrep tự phát hiện mình đang chạy trong container và bắt buộc code volume
 * nằm đúng ở `/src` — mount chỗ khác thì nó ném
 * `Detected Docker environment without a code volume`.
 */
const CONTAINER_SOURCE_DIR = '/src';

/** Thư mục chứa rule của repository và fixture của chúng. */
export const RULES_DIR = '.github/semgrep';

export type TestResult = { ok: true } | { ok: false; reason: string };

/**
 * Chạy `semgrep --test` trong một container duy nhất: image đã có cả engine lẫn
 * `python3`, nên không cần bước phụ nào.
 */
export function runSemgrepTest(options: { rootDir?: string; image?: string }): TestResult {
  const rootDir = options.rootDir ?? ROOT_DIR;

  if (!existsSync(join(rootDir, RULES_DIR))) {
    return {
      ok: false,
      reason: `semgrep test aborted: rules directory ${join(rootDir, RULES_DIR)} not found.`,
    };
  }

  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--volume',
      `${rootDir}:${CONTAINER_SOURCE_DIR}`,
      '--workdir',
      CONTAINER_SOURCE_DIR,
      options.image ?? SEMGREP_IMAGE,
      'semgrep',
      '--test',
      '--config',
      RULES_DIR,
      RULES_DIR,
    ],
    { cwd: rootDir, stdio: 'inherit', env: gitEnv() },
  );

  if (run.error !== undefined) {
    return {
      ok: false,
      reason:
        `could not run docker: ${run.error.message}. ` +
        'The semgrep test needs a running Docker daemon; it does not have a non-docker fallback.',
    };
  }

  if (run.status !== 0) {
    const detail =
      run.status === null
        ? `docker was terminated by ${run.signal ?? 'a signal'}`
        : `semgrep exited with code ${run.status}`;

    return { ok: false, reason: `${detail}. See the semgrep output above for the test results.` };
  }

  return { ok: true };
}

/** In kết quả của một lần chạy và đặt exit code khi rule không khớp fixture. */
export function reportTestResult(result: TestResult, label: string): void {
  if (result.ok) {
    console.log(`${label} passed: all rules pass against their fixtures.`);
    return;
  }

  console.error(`${label} failed: ${result.reason}`);
  process.exitCode = 1;
}
