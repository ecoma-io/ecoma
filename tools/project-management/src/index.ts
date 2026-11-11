/**
 * Registry lệnh của CLI project-management. Chạy không subcommand = chạy
 * `reconcile` (lệnh duy nhất): tái dùng args và run của nó ở tầng gốc.
 */

import { defineCommand } from 'citty';

import { reconcileCommand } from './reconcile-command.js';

export const app = defineCommand({
  meta: {
    name: 'project-management',
    description: 'GitHub Project membership reconciliation for ecoma-io',
  },
  args: reconcileCommand.args,
  run: reconcileCommand.run,
  subCommands: {
    reconcile: reconcileCommand,
  },
});
