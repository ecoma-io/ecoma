import { defineCommand } from 'citty';

import { runLocalCleanup, type CleanupReport } from './local-cleanup.js';
import { runLocalCommand, worktreeRootArg } from './../../local-runtime/local-commands.js';

/**
 * Entry `pnpm dx local-cleanup`.
 *
 * Dọn Docker resource mồ côi của worktree đã bị xoá. PostgreSQL volume bị
 * XOÁ như mọi resource mồ côi đủ điều kiện — cùng contract với down vô điều
 * kiện của `platform-deploy`; sự an toàn nằm ở check ownership + presence
 * (thiếu label, worktree còn sống là KHÔNG xoá), không ở hành vi "giữ".
 * `--dry-run` không phát lệnh destructive nào — chỉ báo cáo.
 *
 * KHÔNG lấy khóa nào (lifecycle cũng không có khóa lane toàn cục — PR #424):
 * quyết định xoá của cleanup dựa trên presence của worktree + labels ownership
 * (bắt buộc đủ bốn label) — không dựa trên pha của lane; race còn lại chỉ là
 * nhiễu báo cáo (inspect lỗi giữa chừng → `skipped`, behavior fail-safe đã
 * tài liệu hoá). Tầng bảo vệ thật là các check đó.
 */
export default defineCommand({
  meta: {
    name: 'local-cleanup',
    description:
      'Remove orphaned local deployment Docker resources whose worktree no longer exists (never touches live worktrees or resources without valid ownership labels)',
  },

  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Report what would be removed without issuing any destructive Docker command',
      default: false,
    },
    'worktree-root': worktreeRootArg,
  },

  async run({ args }) {
    process.exitCode = await runLocalCommand('cleanup', () => {
      // Filter diagnostics: KHÔNG bắt buộc path tồn tại — worktree bị xoá là
      // đối tượng chính của cleanup, và filter trỏ worktree không còn trên đĩa
      // hợp lệ (chỉ match không resource nào, xem `runLocalCleanup`).
      let worktreeRoot: string | undefined;
      if (typeof args['worktree-root'] === 'string' && args['worktree-root'].length > 0) {
        worktreeRoot = args['worktree-root'];
      }
      const report = runLocalCleanup({
        worktreeRoot,
        dryRun: args['dry-run'] === true,
        env: process.env,
      });
      printReport(report);
      return report.errors.length > 0 ? 1 : 0;
    });
  },
});

function printReport(report: CleanupReport): void {
  console.log('[local-cleanup] results:');
  for (const entry of report.entries) {
    console.log(
      `  ${entry.action.padEnd(13)} ${entry.kind.padEnd(16)} ${entry.name} — ${entry.reason}`,
    );
  }
  if (report.entries.length === 0) {
    console.log('  (no ecoma resources on this host)');
  }
  if (report.errors.length > 0) {
    for (const error of report.errors) {
      console.error(`[local-cleanup] ${error}`);
    }
  }
}
