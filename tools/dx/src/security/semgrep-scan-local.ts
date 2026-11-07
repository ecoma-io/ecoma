/**
 * `semgrep-scan-local` — chế độ chạy ở máy developer (lefthook `pre-push`).
 *
 * Khác `semgrep-scan-ci` ở đúng một điều: nó có **điều kiện chạy**. Không file
 * nào thay đổi thuộc phạm vi rule thì bỏ qua để không tốn ~12s mỗi lần push.
 * Điều kiện này không thu hẹp phạm vi quét — khi chạy, nó vẫn quét toàn repo
 * (lý do ở `semgrep-scan.ts`).
 */

import { defineCommand } from 'citty';

import {
  listChangedFiles,
  localSkipReason,
  LOCAL_BASE,
  reportScanResult,
  runSemgrepScan,
} from './semgrep-scan.js';

export default defineCommand({
  meta: {
    name: 'semgrep-scan-local',
    description:
      "Run the repository's own semgrep rules for a push, using docker, when a changed file is in scope",
  },

  args: {
    'report-path': {
      type: 'string',
      required: false,
      description: 'Write the SARIF report to this path',
    },
  },

  run({ args }) {
    const skipped = localSkipReason(listChangedFiles(LOCAL_BASE));

    if (skipped !== null) {
      console.log(skipped);
      return;
    }

    reportScanResult(runSemgrepScan({ reportPath: args['report-path'] }), 'Semgrep scan');
  },
});
