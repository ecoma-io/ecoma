import { defineCommand } from 'citty';

import {
  requireDirectoryRoot,
  runLocalCommandAsync,
  workerWorktreeRootArg,
} from './../local-runtime/local-commands.js';
import { stopWorkerRuntime } from './worker-orchestration.js';

/**
 * Entry `pnpm dx local-worker-down`.
 *
 * Bring down WORKER runtime của worktree: scan stateDir và xử lý từng entry
 * theo trạng thái (kill process sống khi identity khớp; dọn metadata mồ côi;
 * giữ file hỏng làm bằng chứng). Idempotent — chạy khi không còn gì up chỉ
 * ra rows rỗng và exit 0. Một entry lỗi không cản các entry khác.
 *
 * Exit code (OCR PR #36 medium): exit 0 CHỈ khi mọi entry đã xoá dứt
 * (terminated/cleaned/rows rỗng). Có bất kỳ row nào `kept-evidence`
 * (process còn sống, identity guard chặn, file hỏng giữ lại...) → exit 1
 * với cảnh báo trên stderr — caller script/CI phải phân biệt được "down
 * sạch" với "down từng phần, port còn bị chiếm".
 *
 * Là cặp ngược của `local-worker-up` (spawn detached SURVIVE CLI exit).
 */
export default defineCommand({
  meta: {
    name: 'local-worker-down',
    description:
      'Stop the local worker runtime of this worktree (scans stateDir metadata; does not re-run opt-in marker discovery)',
  },

  args: {
    'worktree-root': workerWorktreeRootArg,
  },

  run({ args }) {
    process.exitCode = 0;
    // Async boundary — error policy `[local-<cmd>] ...` + exit 1 nằm một
    // nơi duy nhất (`runLocalCommandAsync`).
    void runLocalCommandAsync('worker-down', async () => {
      const report = await stopWorkerRuntime({
        worktreeRoot: requireDirectoryRoot(args['worktree-root']) ?? process.cwd(),
      });
      const incomplete = report.rows.filter((row) => row.action === 'kept-evidence');
      for (const row of report.rows) {
        const error = row.error !== undefined ? ` (${row.error})` : '';
        console.log(`worker ${row.name}: ${row.before} → ${row.action}${error}`);
      }
      console.log(`worker runtime down (${report.rows.length} entries)`);
      if (incomplete.length > 0) {
        console.error(
          `[local-worker-down] partial failure: ${incomplete.length} entry(ies) kept-evidence — ` +
            'process/file still alive or insufficient evidence for a safe delete',
        );
        process.exitCode = 1;
      }
    });
  },
});
