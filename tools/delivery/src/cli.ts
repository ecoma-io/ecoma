/**
 * Entry CLI của machinery delivery (issue #351) — hai lệnh, chạy qua `npx tsx`
 * (import `@ecoma-io/deployment` dùng specifier `.js` mà node type-stripping
 * thuần không remap được — cùng runner với các entry `deploys/*`):
 *
 * - `npx tsx src/cli.ts ensure-staging-environments [--check] [--repo owner/name]`
 *   Tạo/xác minh GitHub Environments `staging-<slug>` cho toàn bộ inventory
 *   staging-releaseable. Idempotent; `--check` chỉ đọc, không mutation (đường
 *   guard chống auto-create-không-bảo-vệ, §6.13). Exit 1 khi còn violation,
 *   exit 2 khi dùng lệnh sai.
 * - `npx tsx src/cli.ts worker-secret put|stage <SECRET_NAME> --config <wrangler.jsonc>`
 *   Giá trị secret đọc từ STDIN (`echo "..." | npx tsx src/cli.ts worker-secret ...`).
 *   `put` deploy ngay (WS1 — provision lần đầu); `stage` chỉ stage version
 *   xoay vòng, publish vẫn qua delivery gate.
 *
 * CLI mỏng: mọi logic nằm trong module có spec; file này chỉ parse argv, đọc
 * stdin và map kết quả ra exit code.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  defaultGhApiDeps,
  ensureStagingEnvironments,
  repoFromGh,
  stagingUnits,
  type EnvironmentReport,
} from './staging-environments.ts';
import {
  putWorkerSecret,
  stripJsoncComments,
  trimTrailingNewline,
  type SecretAction,
} from './worker-secrets.ts';

const USAGE = `usage:
  npx tsx src/cli.ts ensure-staging-environments [--check] [--repo owner/name]
  npx tsx src/cli.ts worker-secret put|stage <SECRET_NAME> --config <wrangler.jsonc>   (value via stdin)`;

/** Shape tối thiểu khi parse argv `worker-secret`. */
export type ParsedWorkerSecretArgv =
  | { kind: 'ok'; action: SecretAction; secretName: string; configPath: string }
  | { kind: 'usage'; message: string };

/** Parse argv của `worker-secret` — dùng-lệnh sai là lỗi, không đoán. */
export function parseWorkerSecretArgv(argv: readonly string[]): ParsedWorkerSecretArgv {
  const [action, secretName] = argv;
  if (action !== 'put' && action !== 'stage') {
    return { kind: 'usage', message: 'first argument must be "put" or "stage"' };
  }
  if (secretName === undefined || secretName.trim().length === 0) {
    return { kind: 'usage', message: 'missing SECRET_NAME argument' };
  }
  const configFlag = argv.indexOf('--config');
  const configPath = configFlag >= 0 ? argv[configFlag + 1] : undefined;
  if (configPath === undefined || configPath.trim().length === 0) {
    return { kind: 'usage', message: 'missing --config <wrangler.jsonc> path' };
  }
  return { kind: 'ok', action, secretName, configPath };
}

/** Đọc giá trị secret từ stdin (fd 0) — KHÔNG bao giờ qua argv. */
function readStdinValue(): string {
  // TTY là fail-closed: readFileSync(0) trên TTY sẽ treo vô hạn chờ gõ tay —
  // từ chối ngay thay vì treo pipeline.
  if (process.stdin.isTTY) {
    throw new Error(
      'secret value must be piped via stdin (echo "..." | npx tsx src/cli.ts worker-secret ...)',
    );
  }
  try {
    return trimTrailingNewline(readFileSync(0, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read the secret value from stdin: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * In report Environment ra `out`; trả số violation tìm thấy — main map số này
 * ra exit code (bất kỳ violation nào là exit 1, gồm cả mode check).
 */
export function printReports(
  out: { write(text: string): unknown },
  reports: EnvironmentReport[],
): number {
  let failed = 0;
  for (const report of reports) {
    const changes = [
      report.created ? 'created' : report.exists ? 'existed' : 'missing',
      report.policyFixed ? 'branch policy set' : null,
      report.branchPolicyAdded ? '"main" branch policy added' : null,
    ]
      .filter((part) => part !== null)
      .join(', ');
    out.write(`${report.environment}: ${changes}\n`);
    for (const violation of report.violations) {
      failed += 1;
      out.write(`${report.environment}: VIOLATION — ${violation}\n`);
    }
  }
  return failed;
}

function main(argv: readonly string[]): number {
  const command = argv[0];
  if (command === 'ensure-staging-environments') {
    const check = argv.includes('--check');
    const repoFlag = argv.indexOf('--repo');
    const repoArg = repoFlag >= 0 ? argv[repoFlag + 1] : undefined;
    if (repoFlag >= 0 && (repoArg === undefined || repoArg.trim().length === 0)) {
      process.stderr.write('--repo requires an owner/name value\n');
      return 2;
    }
    const repo = repoArg ?? process.env.GITHUB_REPOSITORY ?? repoFromGh();
    const configPath = fileURLToPath(
      new URL('../config/deploy-eligibility.jsonc', import.meta.url),
    );
    // File là JSONC thật (trailing comma trong khối "//") — JSON.parse thuần không đọc được.
    const config = JSON.parse(stripJsoncComments(readFileSync(configPath, 'utf8'))) as Parameters<
      typeof stagingUnits
    >[0];
    const units = stagingUnits(config);
    const reports = ensureStagingEnvironments(
      units,
      repo,
      defaultGhApiDeps(),
      check ? 'check' : 'ensure',
    );
    const failed = printReports(process.stdout, reports);
    process.stdout.write(
      failed === 0
        ? `all ${reports.length} staging environments verified\n`
        : `${failed} violation(s) across ${reports.length} staging environments\n`,
    );
    return failed === 0 ? 0 : 1;
  }
  if (command === 'worker-secret') {
    const parsed = parseWorkerSecretArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    const value = readStdinValue();
    const { worker } = putWorkerSecret(parsed.action, parsed.secretName, parsed.configPath, value);
    process.stdout.write(
      parsed.action === 'put'
        ? `secret ${parsed.secretName} provisioned (deployed) on ${worker}\n`
        : `secret ${parsed.secretName} staged on ${worker} — publish goes through the delivery gate, not this path\n`,
    );
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// Chỉ exit khi được thực thi trực tiếp qua `npx tsx`; khi bị import (spec)
// không chạy main — argv[1] là file entry này mới là đường chạy thật.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Mọi lỗi chưa xử lý là exit 1 với thông điệp gọn — fail-closed, không stack trace.
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
