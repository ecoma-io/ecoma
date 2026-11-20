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

import { readFileSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  defaultGhApiDeps,
  ensureStagingEnvironments,
  isValidRepoIdentifier,
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

const USAGE =
  'usage:\n' +
  '  npx tsx src/cli.ts ensure-staging-environments [--check] [--repo owner/name]\n' +
  '  npx tsx src/cli.ts worker-secret put|stage <SECRET_NAME> --config <wrangler.jsonc>   (value via stdin)';

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

/** Trần dung lượng stdin của giá trị secret — 1 MiB là dư cho mọi secret hiện có. */
export const STDIN_MAX_BYTES = 1024 * 1024;

/** Cỡ khối đọc stdin — đủ lớn để ít vòng lặp, nhỏ để cap bắt sát. */
export const STDIN_READ_CHUNK_SIZE = 64 * 1024;

/**
 * Đọc toàn bộ fd cho tới EOF theo khối, chặn ở trần dung lượng — không bao giờ
 * buffer vô hạn. fd là tham số để spec đọc từ file thật mà không đụng stdin.
 */
/** Trần thời gian chờ dữ liệu stdin khi fd non-blocking — không chờ vô hạn. */
export const STDIN_EAGAIN_DEADLINE_MS = 10_000;

export function readStdinFrom(fd: number, maxBytes: number = STDIN_MAX_BYTES): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(STDIN_READ_CHUNK_SIZE);
  const deadline = Date.now() + STDIN_EAGAIN_DEADLINE_MS;
  // EAGAIN là "chưa có dữ liệu" trên fd non-blocking (stdin pipe mặc định của
  // node), không phải lỗi — chờ 1ms (sleep sync qua Atomics) rồi đọc lại, trong
  // trần thời gian để một pipe không bao giờ đóng không treo CLI vô hạn.
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EAGAIN') {
        if (Date.now() > deadline) {
          throw new Error(
            `stdin produced no data within ${STDIN_EAGAIN_DEADLINE_MS}ms — aborting the bounded read`,
            { cause: error },
          );
        }
        Atomics.wait(sleeper, 0, 0, 1);
        continue;
      }
      throw error;
    }
    if (read === 0) break;
    total += read;
    if (total > maxBytes) {
      throw new Error(
        `stdin value exceeds the ${maxBytes}-byte cap — refusing to buffer an unbounded value`,
      );
    }
    // Copy từng khối: `buffer` được dùng lại ở lần đọc kế nên subarray là view.
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Đọc giá trị secret từ stdin (fd 0) — KHÔNG bao giờ qua argv. */
function readStdinValue(): string {
  // TTY là fail-closed: read trên TTY sẽ treo vô hạn chờ gõ tay — từ chối ngay
  // thay vì treo pipeline.
  if (process.stdin.isTTY) {
    throw new Error(
      'secret value must be piped via stdin (echo "..." | npx tsx src/cli.ts worker-secret ...)',
    );
  }
  try {
    const value = trimTrailingNewline(readStdinFrom(0));
    // Chặn sớm giá trị rỗng trước khi putWorkerSecret — lỗi rõ ngay tại lớp đọc.
    if (value.length === 0) {
      throw new Error('secret value must not be empty — pipe a non-empty value via stdin');
    }
    return value;
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
    // Ternary lồng tách biến — cùng output, dễ đọc.
    const status = report.created ? 'created' : report.exists ? 'existed' : 'missing';
    const changes = [
      status,
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
    // repoFromGh tự validate; `--repo` và GITHUB_REPOSITORY là input ngoài
    // không tin được — repo này được ghép thẳng vào path API của gh.
    if (!isValidRepoIdentifier(repo)) {
      process.stderr.write(
        `invalid repository identifier "${repo}" — expected exactly two owner/name segments without "." or ".."\n`,
      );
      return 2;
    }
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

/**
 * Quyết định `argv1` có trỏ tới chính module CLI này không. So sánh realpath
 * HAI BÊN: argv[1] có thể là symlink hoặc đường tương đối (bin shim) — so
 * nguyên chuỗi sẽ lệch và main không chạy. realpath không resolve được →
 * fallback so raw string; path khớp CHÍNH entry mà vẫn không quyết định được
 * là state không thể phân loại → rethrow fail-closed thay vì im lặng.
 */
export function isCliEntry(argv1: string, selfPath: string): boolean {
  try {
    return realpathSync(argv1) === realpathSync(selfPath);
  } catch (error) {
    if (argv1 === selfPath) {
      throw new Error(
        `cannot determine whether this process is the CLI entry (${argv1}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return false;
  }
}

// Chỉ exit khi được thực thi trực tiếp qua `npx tsx`; khi bị import (spec)
// không chạy main.
if (process.argv[1] !== undefined && isCliEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  // Mọi lỗi chưa xử lý là exit 1 với thông điệp gọn — fail-closed, không stack
  // trace. Dùng exitCode + drain tự nhiên thay vì process.exit: exit ngay sau
  // write có thể cắt ngang stdout/stderr chưa flush (đặc biệt khi pipe).
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
