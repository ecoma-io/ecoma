import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { defineCommand } from 'citty';

import {
  requireDirectoryRoot,
  runLocalCommand,
  worktreeRootArg,
} from './../../local-runtime/local-commands.js';
import { ROOT_DIR } from './../../utils.js';

/**
 * Entry `pnpm dx local-status` — ADAPTER mỏng, không phải implementation.
 *
 * Implementation sở hữu bởi `platform-deploy` (`platform-status.ts`): platform
 * là unit duy nhất sở hữu stack outputs mà status đọc, nên logic đọc-trắng-hại-
 * đọc sống cạnh entry của platform. Lệnh DX này chỉ spawn entry đó qua tsx với
 * đúng cwd, rồi nhận exit code — KHÔNG import implementation nào từ `deploys/`
 * (chiều phụ thuộc hợp lệ là deploy → lib dùng chung; dx import ngược deploy
 * là vi phạm ranh giới được siết lại ở PR này).
 *
 * Lệnh read-only: in namespace, resource names, và outputs platform hiện có.
 * Không up/destroy gì — an toàn để chạy bất cứ lúc nào.
 */
export default defineCommand({
  meta: {
    name: 'local-status',
    description: 'Show the local deployment namespace, resources and platform outputs',
  },

  args: {
    'worktree-root': worktreeRootArg,
  },

  async run({ args }) {
    const worktreeRoot = requireDirectoryRoot(args['worktree-root']);
    process.exitCode = await runLocalCommand('status', () => {
      // `stdio: 'inherit'` — stdout/stderr của status là output DUY NHẤT của
      // lệnh; bọc thêm lớp nào là log nói dối hai lớp. `--worktree-root` được
      // validate ở đây (`requireDirectoryRoot`) rồi truyền tiếp qua argv —
      // entry platform nhận cùng giá trị mà người dùng đã gõ.
      const platformArgs = ['tsx', 'platform-status.ts'];
      if (worktreeRoot !== undefined) {
        platformArgs.push('--worktree-root', worktreeRoot);
      }
      const result = spawnSync('npx', platformArgs, {
        cwd: join(ROOT_DIR, 'deploys', 'platform-deploy'),
        stdio: 'inherit',
      });
      return result.status ?? 1;
    });
  },
});
