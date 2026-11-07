/**
 * `semgrep-test-ci` — kiểm bộ rule đối với fixture trong GitHub Actions.
 *
 * Cùng engine với `semgrep-test-local`; tách lệnh để workflow không phải biết
 * về một lệnh "local" và để hai chế độ có thể đổi độc lập (ví dụ CI thêm bước
 * upload kết quả) mà không kéo theo hook.
 */

import { defineCommand } from 'citty';

import { reportTestResult, runSemgrepTest } from './semgrep-test.js';

export default defineCommand({
  meta: {
    name: 'semgrep-test-ci',
    description: 'Test the repository semgrep rules against their fixtures in CI, via docker',
  },

  run() {
    reportTestResult(runSemgrepTest({}), 'semgrep test');
  },
});
