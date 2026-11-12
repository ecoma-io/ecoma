import { defineCommand } from 'citty';

export const app = defineCommand({
  meta: {
    name: 'Ecoma DX',
    description: 'Devtools for ecoma-io repository',
  },

  // Không có subcommand thì không làm gì; citty hiện usage sau --help.
  run: () => undefined,

  subCommands: {
    // `import()` resolve ra module namespace, nhưng citty cần chính định nghĩa
    // command, nên phải bóc default export ra.
    'repo-prepare': () => import('./repository/repo-prepare.js').then((m) => m.default),
    'sync-agent-config': () => import('./repository/sync-agent-config.js').then((m) => m.default),
    'pr-check': () => import('./pull-request/pr-check.js').then((m) => m.default),
    'arch-check': () => import('./architecture/arch-check.js').then((m) => m.default),
    'readme-check': () => import('./readme/readme-check.js').then((m) => m.default),
    'gitleak-ci': () => import('./security/gitleak-ci.js').then((m) => m.default),
    'gitleaks-scope': () => import('./security/gitleaks-scope.js').then((m) => m.default),
    'gitleak-local': () => import('./security/gitleak-local.js').then((m) => m.default),
    'semgrep-scan-local': () => import('./security/semgrep-scan-local.js').then((m) => m.default),
    'semgrep-scan-ci': () => import('./security/semgrep-scan-ci.js').then((m) => m.default),
    'semgrep-test-local': () => import('./security/semgrep-test-local.js').then((m) => m.default),
    'semgrep-test-ci': () => import('./security/semgrep-test-ci.js').then((m) => m.default),
    'commit-signing': () => import('./security/commit-signing-command.js').then((m) => m.default),
    'bootstrap-superadmin': () =>
      import('./bootstrap/bootstrap-superadmin-command.js').then((m) => m.default),
    'local-status': () =>
      import('./deployment/local-platform/local-status-command.js').then((m) => m.default),
    'local-cleanup': () =>
      import('./deployment/local-platform/local-cleanup-command.js').then((m) => m.default),
    'local-worker-up': () => import('./workers/local-worker-up-command.js').then((m) => m.default),
    'local-worker-status': () =>
      import('./workers/local-worker-status-command.js').then((m) => m.default),
    'local-worker-down': () =>
      import('./workers/local-worker-down-command.js').then((m) => m.default),
  },
});
