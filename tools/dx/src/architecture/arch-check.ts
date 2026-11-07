import { defineCommand } from 'citty';

import { main } from './arch-tags.js';

/**
 * Entry `pnpm dx arch-check`.
 *
 * `main()` trả exit code; caddy run() chỉ đặt `process.exitCode` thay vì
 * `process.exit()` để stdout kịp flush — cùng lý do pr-check làm vậy.
 */
export default defineCommand({
  meta: {
    name: 'arch-check',
    description:
      'Validate Nx architecture tags, the deployment map and target refs against the project graph and disk',
  },

  run() {
    process.exitCode = main();
  },
});
