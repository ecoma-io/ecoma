/**
 * Registry lệnh của CLI project-management. Tầng gốc KHÔNG có run/args riêng:
 * tái dùng `run` của subcommand ở tầng gốc khiến citty chạy pipeline HAI lần
 * với argv `reconcile ...` (root.run rồi tới subcommand). Gọi không subcommand
 * chỉ in usage — mọi thực thi phải đi qua `reconcile` tường minh.
 */

import { defineCommand } from 'citty';

import { reconcileCommand } from './reconcile-command.js';

export const app = defineCommand({
  meta: {
    name: 'project-management',
    description: 'GitHub Project membership reconciliation for ecoma-io',
  },
  subCommands: {
    reconcile: reconcileCommand,
  },
});
