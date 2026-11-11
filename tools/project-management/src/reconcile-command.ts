/**
 * Lệnh `reconcile` của CLI: entry duy nhất chạy pipeline thật qua GitHub API.
 * Token đọc từ PROJECT_MANAGEMENT_TOKEN (ưu tiên) hoặc GITHUB_TOKEN; apply
 * không có token là exit 1 ngay từ đầu, không thử gọi API thiếu credential.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { defineCommand } from 'citty';

import { createGitHubPort } from './github.js';
import { loadPolicy } from './policy.js';
import { runReconciliation } from './reconcile.js';
import { renderReportJson, renderReportText } from './report.js';

/** Đường dẫn policy mặc định, neo vào package thay vì cwd của caller. */
const DEFAULT_POLICY_PATH = fileURLToPath(
  new URL('../config/membership-policy.json', import.meta.url),
);

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface ReconcileArgs {
  mode: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
  project: string | undefined;
  policy: string | undefined;
  out: string | undefined;
}

export const reconcileCommand = defineCommand({
  meta: {
    name: 'reconcile',
    description: 'Reconcile GitHub Project membership with the repository membership policy',
  },
  args: {
    mode: {
      type: 'string',
      description: 'audit (report only, default) or apply (mutate then verify)',
      default: 'audit',
    },
    owner: {
      type: 'string',
      description: 'Organization login owning the project (e.g. ecoma-io)',
      required: true,
    },
    repo: {
      type: 'string',
      description: 'Repository full name whose issues are reconciled (e.g. ecoma-io/ecoma)',
      required: true,
    },
    project: {
      type: 'string',
      description: 'Project V2 number; defaults to the policy projectNumber',
    },
    policy: {
      type: 'string',
      description: 'Path to the membership policy JSON',
      default: DEFAULT_POLICY_PATH,
    },
    out: {
      type: 'string',
      description: 'Write the JSON report to this file',
    },
  },
  run: async ({ args }: { args: ReconcileArgs }): Promise<void> => {
    const token = process.env['PROJECT_MANAGEMENT_TOKEN'] ?? process.env['GITHUB_TOKEN'];
    if (token === undefined || token === '') {
      console.error(
        'No GitHub token available. Set PROJECT_MANAGEMENT_TOKEN (preferred) or GITHUB_TOKEN; apply mode always requires one.',
      );
      process.exitCode = 1;
      return;
    }
    const mode = args.mode;
    if (mode !== 'audit' && mode !== 'apply') {
      console.error(`Unknown mode "${mode}": expected "audit" or "apply".`);
      process.exitCode = 1;
      return;
    }
    if (mode === 'apply' && token === '') {
      console.error('apply mode requires a non-empty PROJECT_MANAGEMENT_TOKEN.');
      process.exitCode = 1;
      return;
    }
    const owner = args.owner;
    const repo = args.repo;
    if (owner === undefined || owner === '' || repo === undefined || repo === '') {
      console.error('Missing required arguments --owner and --repo.');
      process.exitCode = 1;
      return;
    }
    const policyPath = args.policy ?? DEFAULT_POLICY_PATH;
    let policy;
    try {
      policy = await loadPolicy(policyPath);
    } catch (cause) {
      console.error(`Cannot load membership policy: ${errorMessage(cause)}`);
      process.exitCode = 1;
      return;
    }
    const projectNumber = args.project === undefined ? policy.projectNumber : Number(args.project);
    if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
      console.error(
        `Invalid project number "${String(args.project)}": expected a positive integer.`,
      );
      process.exitCode = 1;
      return;
    }

    const port = createGitHubPort({ token, owner, repo, projectNumber });
    let report;
    try {
      report = await runReconciliation({ port, policy, mode });
    } catch (cause) {
      console.error(`Reconciliation crashed: ${errorMessage(cause)}`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(renderReportText(report));
    process.stdout.write('\n');

    const outPath = args.out;
    if (outPath !== undefined) {
      try {
        await writeFile(outPath, `${renderReportJson(report)}\n`, 'utf8');
        console.log(`JSON report written to ${outPath}`);
      } catch (cause) {
        console.error(`Cannot write JSON report to ${outPath}: ${errorMessage(cause)}`);
        process.exitCode = 1;
        return;
      }
    }

    // Drift là dữ liệu, không phải failure: exit 0 cho clean lẫn drift; chỉ
    // status 'failed' (inventory một phần, verify không chạy được) là exit 1.
    process.exitCode = report.status === 'failed' ? 1 : 0;
  },
});
