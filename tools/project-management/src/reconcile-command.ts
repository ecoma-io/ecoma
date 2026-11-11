/**
 * Lệnh `reconcile` của CLI: entry duy nhất chạy pipeline thật qua GitHub API.
 * Token đọc từ PROJECT_MANAGEMENT_TOKEN (ưu tiên) hoặc GITHUB_TOKEN; apply
 * không có token là exit 1 ngay từ đầu, không thử gọi API thiếu credential.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  verifyDeadlineMs: string | undefined;
}

type ResolvedRepo = { ok: true; repo: string } | { ok: false; error: string };

/**
 * `--repo` chấp nhận tên đầy đủ `owner/name` (khớp workflow, vd
 * `ecoma-io/ecoma`) hoặc tên trần `name`. GraphQL `repository(owner:, name:)`
 * cần tên trần, nên chuỗi đầy đủ phải tách và phần owner phải khớp `--owner`.
 */
export function resolveRepoName(owner: string, repoArg: string): ResolvedRepo {
  const parts = repoArg.split('/');
  if (parts.length === 1) {
    return { ok: true, repo: parts[0] };
  }
  if (parts.length !== 2 || parts[1] === '') {
    return {
      ok: false,
      error: `Invalid --repo "${repoArg}": expected a bare name (ecoma) or a full name (ecoma-io/ecoma).`,
    };
  }
  if (parts[0] !== owner) {
    return {
      ok: false,
      error: `Repository full name "${repoArg}" does not match --owner "${owner}".`,
    };
  }
  return { ok: true, repo: parts[1] };
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
    verifyDeadlineMs: {
      type: 'string',
      description:
        'Total budget for post-apply verification polling in ms (default 120000; propagation-pending residuals poll with bounded backoff until this deadline)',
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
    const owner = args.owner;
    const repoArg = args.repo;
    if (owner === undefined || owner === '' || repoArg === undefined || repoArg === '') {
      console.error('Missing required arguments --owner and --repo.');
      process.exitCode = 1;
      return;
    }
    const resolvedRepo = resolveRepoName(owner, repoArg);
    if (!resolvedRepo.ok) {
      console.error(resolvedRepo.error);
      process.exitCode = 1;
      return;
    }
    const repo = resolvedRepo.repo;
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
    let verifyDeadlineMs: number | undefined;
    if (args.verifyDeadlineMs !== undefined) {
      verifyDeadlineMs = Number(args.verifyDeadlineMs);
      if (!Number.isInteger(verifyDeadlineMs) || verifyDeadlineMs <= 0) {
        console.error(
          `Invalid --verify-deadline-ms "${args.verifyDeadlineMs}": expected a positive integer.`,
        );
        process.exitCode = 1;
        return;
      }
    }

    const port = createGitHubPort({ token, owner, repo, projectNumber });
    let report;
    try {
      report = await runReconciliation({
        port,
        policy,
        mode,
        ...(verifyDeadlineMs === undefined ? {} : { verify: { deadlineMs: verifyDeadlineMs } }),
      });
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
        // Thư mục cha có thể chưa tồn tại trên checkout mới (vd test-output
        // trong workflow) — mkdir recursive trước khi ghi để không ENOENT.
        await mkdir(dirname(outPath), { recursive: true });
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
