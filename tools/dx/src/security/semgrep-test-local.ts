/**
 * `semgrep-test-local` — kiểm bộ rule đối với fixture ngay trên máy developer.
 *
 * Hook `pre-commit` chạy lệnh này khi thay đổi chạm `.github/semgrep/`, để một
 * rule viết sai bị bắt trước khi commit chứ không phải chờ CI. Không có điều
 * kiện nội bộ nào khác: chính hook quyết định khi nào chạy, và khi chạy thì kiểm
 * toàn bộ bộ rule.
 */

import { defineCommand } from 'citty';

import { reportTestResult, runSemgrepTest } from './semgrep-test.js';

export default defineCommand({
  meta: {
    name: 'semgrep-test-local',
    description: 'Test the repository semgrep rules against their fixtures locally, via docker',
  },

  run() {
    reportTestResult(runSemgrepTest({}), 'semgrep test');
  },
});
