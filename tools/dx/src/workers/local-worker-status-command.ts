import { defineCommand } from 'citty';

import {
  requireDirectoryRoot,
  runLocalCommand,
  workerWorktreeRootArg,
} from './../local-runtime/local-commands.js';
import { statusWorkerRuntime } from './worker-orchestration.js';

/**
 * Entry `pnpm dx local-worker-status`.
 *
 * Lệnh read-only: snapshot scan của stateDir worktree — mỗi metadata entry
 * một row với state (alive/stale/unspawned/invalid), pid, startedAt và
 * generated config có còn trên đĩa không. Không kill, không xoá — an toàn
 * để chạy bất cứ lúc nào. In JSON để caller dùng script so sánh được.
 */
export default defineCommand({
  meta: {
    name: 'local-worker-status',
    description: 'Show the local worker runtime state (scan snapshot, read-only) for this worktree',
  },

  args: {
    'worktree-root': workerWorktreeRootArg,
  },

  async run({ args }) {
    process.exitCode = await runLocalCommand('worker-status', () => {
      const rows = statusWorkerRuntime({
        worktreeRoot: requireDirectoryRoot(args['worktree-root']) ?? process.cwd(),
      });
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    });
  },
});
