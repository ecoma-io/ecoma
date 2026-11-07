/**
 * `semgrep-scan-ci` — chế độ chạy trong GitHub Actions (job `semgrep`).
 *
 * Không có điều kiện chạy: một lần scan bị bỏ qua ở đây nghĩa là required check
 * xanh trong khi chưa quét gì. Phạm vi quét và gate giống hệt
 * `semgrep-scan-local`, nên kết quả hai nơi so sánh được.
 */

import { defineCommand } from 'citty';

import { reportScanResult, runSemgrepScan } from './semgrep-scan.js';

export default defineCommand({
  meta: {
    name: 'semgrep-scan-ci',
    description: "Run the repository's own semgrep rules on the whole checkout in CI, using docker",
  },

  args: {
    'report-path': {
      type: 'string',
      required: false,
      description: 'Write the SARIF report to this path (used by CI for upload)',
    },
  },

  run({ args }) {
    reportScanResult(runSemgrepScan({ reportPath: args['report-path'] }), 'Semgrep scan');
  },
});
