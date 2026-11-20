/**
 * Entry CLI của machinery delivery (issue #351, #349, #353) — sáu lệnh, chạy qua `npx tsx`
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
 * - `npx tsx src/cli.ts vpc-service create <NAME> --tunnel-id <uuid> --hostname <host>
 *   [--tcp-port 5432] [--app-protocol postgresql|mysql]`
 *   Lane connectivity staging #349: tạo Workers VPC Service TCP tới origin
 *   PostgreSQL staging qua Cloudflare Tunnel (`02` §9.1 — Wrangler sở hữu;
 *   VP4 verified trên wrangler 4.165.0). In ra dòng machine-readable
 *   `service_id=<uuid>` — output contract cho wiring Hyperdrive #350.
 * - `npx tsx src/cli.ts staging-manifest --config <wrangler.jsonc> --sha <sha>`
 *   In build-manifest JSON (`{sha, worker}`) ra stdout — job build của workflow
 *   ghi vào artifact để job deploy đối chiếu (§7.4).
 * - `npx tsx src/cli.ts staging-plan --sha <sha> --base <sha>`
 *   Audit workspace (eligibility toàn project + drift release.projects) rồi map
 *   affected thành batch units + migration steps — NƠI DUY NHẤT sinh matrix
 *   deploy của coordinator (#362, §7.5 mục 1–2, 16–18). In JSON ra stdout.
 * - `npx tsx src/cli.ts staging-unit-gate --project <nx-name> --config <wrangler.jsonc>
 *   --ref-sha <sha>`
 *   Cổng per-unit (§7.4.3): evaluateDeployGate + audit bindings lane staging.
 *   Deny in từng lý do machine-readable rồi exit 1.
 * - `npx tsx src/cli.ts staging-guard --point <coalesce|before-deploy|before-status>
 *   --run-id <n> --head-sha <sha>`
 *   Stale-run guard tại một điểm (§7.4): tra cứu run MỚI bằng `gh api` rồi
 *   decide. Mọi đường in dòng marker cuối `staging-guard action=<tên>`;
 *   abort là exit 1 (abort-main-advanced = ĐÃ ghi failure status ở phía caller).
 * - `npx tsx src/cli.ts staging-deploy --config <wrangler.jsonc> --project <nx-name>
 *   --slug <slug> --manifest <build-manifest.json> --expect-sha <sha>
 *   [--guard-run-id <n> --guard-head-sha <sha>]`
 *   Preflight fail-closed (identity, eligibility, manifest, token) rồi
 *   `wrangler deploy --env staging` qua lớp retry §7.4 — glue của job deploy.
 *   Guard `before-deploy` bật qua cặp cờ `--guard-*` (bật cùng lúc cả hai).
 * - `npx tsx src/cli.ts staging-smoke <origin> [--redirect <from>=<to>]...
 *   [--health <path>]... [--noindex <path>]... [--budget-ms n] [--request-timeout-ms n]
 *   [--guard-run-id <n> --guard-head-sha <sha>]`
 *   Smoke HTTP thật sau deploy, khai theo khả năng của app (§7.5 mục 9).
 *   Guard `before-status` chạy NGAY SAU khi toàn bộ kiểm pass (§7.4).
 *
 * Hợp đồng marker machine-readable của guard (`staging-guard.ts`): lệnh
 * staging-deploy / staging-smoke / staging-guard LUÔN in đúng MỘT dòng
 * `staging-guard action=<tên>` cuối stdout — step của workflow đọc vào
 * GITHUB_OUTPUT để quyết định việc ghi commit status.
 *
 * CLI mỏng: mọi logic nằm trong module có spec; file này chỉ parse argv, đọc
 * stdin và map kết quả ra exit code.
 */

import { readFileSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { exec } from '@ecoma-io/deployment';

import {
  createStagingVpcService,
  type VpcAppProtocol,
  type VpcServiceInput,
} from './staging-connectivity.ts';
import {
  GUARD_MARKER_PREFIX,
  GuardAbortError,
  defaultGuardQueryDeps,
  parseGuardInputs,
  runGuardAtPoint,
  type GuardInputs,
} from './staging-guard.ts';
import { planStagingBatch, type StagingPlanDeps } from './staging-plan.ts';
import { evaluateStagingUnitGate } from './staging-unit-gate.ts';
import {
  defaultGhApiDeps,
  ensureStagingEnvironments,
  isValidRepoIdentifier,
  repoFromGh,
  stagingUnits,
  type EnvironmentReport,
} from './staging-environments.ts';
import {
  buildStagingManifest,
  runStagingDeploy,
  type StagingDeployParams,
} from './staging-deploy.ts';
import {
  runStagingSmoke,
  SMOKE_BUDGET_MS_DEFAULT,
  SMOKE_REQUEST_TIMEOUT_MS_DEFAULT,
  type StagingSmokeOptions,
} from './staging-smoke.ts';
import {
  putWorkerSecret,
  stripJsoncComments,
  trimTrailingNewline,
  type SecretAction,
} from './worker-secrets.ts';

const USAGE =
  'usage:\n' +
  '  npx tsx src/cli.ts ensure-staging-environments [--check] [--repo owner/name]\n' +
  '  npx tsx src/cli.ts worker-secret put|stage <SECRET_NAME> --config <wrangler.jsonc>   (value via stdin)\n' +
  '  npx tsx src/cli.ts vpc-service create <NAME> --tunnel-id <uuid> --hostname <host> [--tcp-port 5432] [--app-protocol postgresql|mysql]\n' +
  '  npx tsx src/cli.ts staging-manifest --config <wrangler.jsonc> --sha <sha>\n' +
  '  npx tsx src/cli.ts staging-plan --sha <commit-sha> --base <commit-sha>\n' +
  '  npx tsx src/cli.ts staging-unit-gate --project <nx-name> --config <wrangler.jsonc> --ref-sha <sha>\n' +
  '  npx tsx src/cli.ts staging-guard --point <coalesce|before-deploy|before-status> --run-id <n> --head-sha <sha>\n' +
  '  npx tsx src/cli.ts staging-deploy --config <wrangler.jsonc> --project <nx-name> --slug <slug> --manifest <build-manifest.json> --expect-sha <sha> [--guard-run-id <n> --guard-head-sha <sha>]\n' +
  '  npx tsx src/cli.ts staging-smoke <origin> [--redirect <from>=<to>]... [--health <path>]... [--noindex <path>]... [--budget-ms n] [--request-timeout-ms n] [--guard-run-id <n> --guard-head-sha <sha>]';

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
  const configPath = readRequiredFlag(argv, '--config');
  if (configPath === undefined) {
    return { kind: 'usage', message: 'missing --config <wrangler.jsonc> path' };
  }
  return { kind: 'ok', action, secretName, configPath };
}

/** Đọc một giá trị flag `--name <value>` khỏi argv; thiếu value là lỗi dùng-lệnh. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Parse argv của `vpc-service create` — dùng-lệnh sai là lỗi, không đoán.
 * Mặc định `--tcp-port 5432` / `--app-protocol postgresql` là hằng domain của
 * lane PG staging (không phải mặc định environment); name/tunnel-id/hostname
 * bắt buộc tường minh.
 */
export function parseVpcServiceArgv(
  argv: readonly string[],
): { kind: 'ok'; input: VpcServiceInput } | { kind: 'usage'; message: string } {
  const [subaction, name] = argv;
  if (subaction !== 'create') {
    return { kind: 'usage', message: 'first argument must be "create"' };
  }
  if (name === undefined || name.trim().length === 0) {
    return { kind: 'usage', message: 'missing <NAME> positional argument' };
  }
  const tunnelId = flagValue(argv, '--tunnel-id');
  if (tunnelId === undefined || tunnelId.trim().length === 0) {
    return { kind: 'usage', message: 'missing --tunnel-id <uuid> (wrangler requires it)' };
  }
  const hostname = flagValue(argv, '--hostname');
  if (hostname === undefined || hostname.trim().length === 0) {
    return { kind: 'usage', message: 'missing --hostname <origin host>' };
  }
  const tcpPortRaw = flagValue(argv, '--tcp-port') ?? '5432';
  const tcpPort = Number(tcpPortRaw);
  if (!Number.isInteger(tcpPort)) {
    return { kind: 'usage', message: `--tcp-port must be an integer, got "${tcpPortRaw}"` };
  }
  const appProtocolRaw = flagValue(argv, '--app-protocol') ?? 'postgresql';
  if (appProtocolRaw !== 'postgresql' && appProtocolRaw !== 'mysql') {
    return { kind: 'usage', message: `--app-protocol must be "postgresql" or "mysql"` };
  }
  return {
    kind: 'ok',
    input: { name, tunnelId, hostname, tcpPort, appProtocol: appProtocolRaw as VpcAppProtocol },
  };
}

/**
 * Đọc giá trị của MỘT flag yêu cầu giá trị; `undefined` khi flag vắng mặt
 * HOẶC có mặt mà không mang giá trị — caller dịch cả hai thành cùng một lỗi
 * usage của flag đó (dùng-lệnh sai là lỗi, không đoán). Giá trị bắt đầu bằng
 * '--' cũng là thiếu: đó là cờ kế đi lạc vào chỗ giá trị (indexOf có thể trúng
 * tên một cờ xuất hiện làm giá trị của cờ trước), không ăn nhầm.
 */
function readRequiredFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.trim().length === 0 || value.startsWith('--')) {
    return undefined;
  }
  return value;
}

/** Shape argv đã parse của lệnh `staging-manifest`. */
export type ParsedStagingManifestArgv =
  | { kind: 'ok'; configPath: string; sha: string }
  | { kind: 'usage'; message: string };

/** Parse argv `staging-manifest` — thiếu flag/giá trị là lỗi dùng-lệnh. */
export function parseStagingManifestArgv(argv: readonly string[]): ParsedStagingManifestArgv {
  const configPath = readRequiredFlag(argv, '--config');
  if (configPath === undefined) {
    return { kind: 'usage', message: 'missing --config <wrangler.jsonc> path' };
  }
  const sha = readRequiredFlag(argv, '--sha');
  if (sha === undefined) {
    return { kind: 'usage', message: 'missing --sha <commit-sha> value' };
  }
  return { kind: 'ok', configPath, sha };
}

/** Shape argv đã parse của lệnh `staging-plan`. */
export type ParsedStagingPlanArgv =
  | { kind: 'ok'; deploySha: string; baseSha: string }
  | { kind: 'usage'; message: string };

/** Parse argv `staging-plan` — hai SHA 40-hex đầy đủ, thiếu là lỗi dùng-lệnh. */
export function parseStagingPlanArgv(argv: readonly string[]): ParsedStagingPlanArgv {
  const deploySha = readRequiredFlag(argv, '--sha');
  if (deploySha === undefined) {
    return { kind: 'usage', message: 'missing --sha <commit-sha> value' };
  }
  const baseSha = readRequiredFlag(argv, '--base');
  if (baseSha === undefined) {
    return { kind: 'usage', message: 'missing --base <commit-sha> value' };
  }
  return { kind: 'ok', deploySha, baseSha };
}

/** Shape argv đã parse của lệnh `staging-unit-gate`. */
export type ParsedStagingUnitGateArgv =
  | { kind: 'ok'; project: string; configPath: string; refSha: string }
  | { kind: 'usage'; message: string };

/** Parse argv `staging-unit-gate` — ba flag bắt buộc, thiếu là lỗi dùng-lệnh. */
export function parseStagingUnitGateArgv(argv: readonly string[]): ParsedStagingUnitGateArgv {
  const project = readRequiredFlag(argv, '--project');
  if (project === undefined) {
    return { kind: 'usage', message: 'missing --project <nx-project-name> value' };
  }
  const configPath = readRequiredFlag(argv, '--config');
  if (configPath === undefined) {
    return { kind: 'usage', message: 'missing --config <wrangler.jsonc> path' };
  }
  const refSha = readRequiredFlag(argv, '--ref-sha');
  if (refSha === undefined) {
    return { kind: 'usage', message: 'missing --ref-sha <commit-sha> value' };
  }
  return { kind: 'ok', project, configPath, refSha };
}

const GUARD_POINTS = ['coalesce', 'before-deploy', 'before-status'] as const;

/** Shape argv đã parse của lệnh `staging-guard`. */
export type ParsedStagingGuardArgv =
  | { kind: 'ok'; input: GuardInputs }
  | { kind: 'usage'; message: string };

/**
 * Parse argv `staging-guard` — lệnh này LUÔN bật guard (khác cặp cờ tùy chọn
 * của staging-deploy/staging-smoke): thiếu --run-id/--head-sha là dùng-lệnh sai.
 */
export function parseStagingGuardArgv(argv: readonly string[]): ParsedStagingGuardArgv {
  const pointRaw = readRequiredFlag(argv, '--point');
  if (pointRaw === undefined) {
    return { kind: 'usage', message: 'missing --point <coalesce|before-deploy|before-status>' };
  }
  if (!(GUARD_POINTS as readonly string[]).includes(pointRaw)) {
    return {
      kind: 'usage',
      message: `--point must be one of ${GUARD_POINTS.join('|')}: ${pointRaw}`,
    };
  }
  const runIdRaw = readRequiredFlag(argv, '--run-id');
  if (runIdRaw === undefined) {
    return { kind: 'usage', message: 'missing --run-id <n> value' };
  }
  const headSha = readRequiredFlag(argv, '--head-sha');
  if (headSha === undefined) {
    return { kind: 'usage', message: 'missing --head-sha <commit-sha> value' };
  }
  try {
    const input = parseGuardInputs(runIdRaw, headSha, pointRaw as GuardInputs['point']);
    if (input === undefined) {
      return { kind: 'usage', message: 'guard inputs are required for the staging-guard command' };
    }
    return { kind: 'ok', input };
  } catch (error) {
    return { kind: 'usage', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Tham số lệnh `staging-deploy` sau khi parse argv. */
export type ParsedStagingDeployArgv =
  | { kind: 'ok'; params: StagingDeployParams }
  | { kind: 'usage'; message: string };

/**
 * Parse argv `staging-deploy` — đủ năm flag là điều kiện dùng-lệnh đúng; cặp
 * `--guard-*` tùy chọn nhưng phải có mặt CÙNG NHIÊU (bật một nửa là usage).
 */
export function parseStagingDeployArgv(argv: readonly string[]): ParsedStagingDeployArgv {
  const configPath = readRequiredFlag(argv, '--config');
  if (configPath === undefined) {
    return { kind: 'usage', message: 'missing --config <wrangler.jsonc> path' };
  }
  const project = readRequiredFlag(argv, '--project');
  if (project === undefined) {
    return { kind: 'usage', message: 'missing --project <nx-project-name> value' };
  }
  const slug = readRequiredFlag(argv, '--slug');
  if (slug === undefined) {
    return { kind: 'usage', message: 'missing --slug <slug> value' };
  }
  const manifestPath = readRequiredFlag(argv, '--manifest');
  if (manifestPath === undefined) {
    return { kind: 'usage', message: 'missing --manifest <build-manifest.json> path' };
  }
  const expectSha = readRequiredFlag(argv, '--expect-sha');
  if (expectSha === undefined) {
    return { kind: 'usage', message: 'missing --expect-sha <commit-sha> value' };
  }
  let guard: StagingDeployParams['guard'];
  try {
    const inputs = parseGuardInputs(
      readRequiredFlag(argv, '--guard-run-id'),
      readRequiredFlag(argv, '--guard-head-sha'),
      'before-deploy',
    );
    if (inputs !== undefined) {
      guard = { runId: inputs.runId, contextSha: inputs.contextSha };
    }
  } catch (error) {
    return { kind: 'usage', message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'ok', params: { configPath, project, slug, manifestPath, expectSha, guard } };
}

/** Shape argv đã parse của lệnh `staging-smoke`. */
export type ParsedStagingSmokeArgv =
  | { kind: 'ok'; options: StagingSmokeOptions }
  | { kind: 'usage'; message: string };

/** Parse argv `staging-smoke` — cờ kiểm lặp được, origin là positional đầu. */
export function parseStagingSmokeArgv(argv: readonly string[]): ParsedStagingSmokeArgv {
  let origin: string | undefined;
  const redirects: Array<{ from: string; to: string }> = [];
  const healthPaths: string[] = [];
  const noindexPaths: string[] = [];
  let budgetMs = SMOKE_BUDGET_MS_DEFAULT;
  let requestTimeoutMs = SMOKE_REQUEST_TIMEOUT_MS_DEFAULT;
  let guardRunId: string | undefined;
  let guardHeadSha: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const takeValue = (): string | undefined => {
      const value = argv[index + 1];
      // Giá trị bắt đầu '--' là cờ kế, không phải giá trị — trả undefined để
      // flag hiện tại báo thiếu giá trị và cờ kế được parse bình thường.
      if (value === undefined || value.trim().length === 0 || value.startsWith('--')) {
        return undefined;
      }
      index += 1;
      return value;
    };
    if (flag === '--guard-run-id' || flag === '--guard-head-sha') {
      const value = takeValue();
      if (value === undefined) {
        return { kind: 'usage', message: `missing value for ${flag}` };
      }
      if (flag === '--guard-run-id') guardRunId = value;
      else guardHeadSha = value;
      continue;
    }
    if (flag === '--redirect' || flag === '--health' || flag === '--noindex') {
      const value = takeValue();
      if (value === undefined) {
        return { kind: 'usage', message: `missing value for ${flag}` };
      }
      if (flag === '--health' || flag === '--noindex') {
        const target = flag === '--health' ? healthPaths : noindexPaths;
        target.push(value);
        continue;
      }
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        return { kind: 'usage', message: `--redirect must be in <from>=<to> form: ${value}` };
      }
      redirects.push({ from: value.slice(0, separator), to: value.slice(separator + 1) });
      continue;
    }
    if (flag === '--budget-ms' || flag === '--request-timeout-ms') {
      const value = takeValue();
      if (value === undefined) {
        return { kind: 'usage', message: `missing value for ${flag}` };
      }
      // Chỉ nhận số nguyên dương thập phân thuần: Number() còn nhận '0x10',
      // '1e2', ' 12 ' — vượt hợp đồng cờ; NaN rơi vào cùng nhánh usage.
      const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { kind: 'usage', message: `${flag} must be a positive integer: ${value}` };
      }
      if (flag === '--budget-ms') budgetMs = parsed;
      else requestTimeoutMs = parsed;
      continue;
    }
    if (flag.startsWith('--')) {
      return { kind: 'usage', message: `unsupported flag: ${flag}` };
    }
    if (origin !== undefined) {
      return { kind: 'usage', message: `unexpected argument: ${flag}` };
    }
    origin = flag;
  }
  if (origin === undefined || origin.trim().length === 0) {
    return { kind: 'usage', message: 'missing <origin> positional argument' };
  }
  // Guard `before-status` bật qua cặp cờ — bật một nửa là usage error.
  let guard: StagingSmokeOptions['guard'];
  try {
    const inputs = parseGuardInputs(guardRunId, guardHeadSha, 'before-status');
    if (inputs !== undefined) {
      guard = { runId: inputs.runId, contextSha: inputs.contextSha };
    }
  } catch (error) {
    return { kind: 'usage', message: error instanceof Error ? error.message : String(error) };
  }
  return {
    kind: 'ok',
    options: { origin, redirects, healthPaths, noindexPaths, budgetMs, requestTimeoutMs, guard },
  };
}

/** Trần dung lượng stdin của giá trị secret — 1 MiB là dư cho mọi secret hiện có. */
export const STDIN_MAX_BYTES = 1024 * 1024;

/** Cỡ khối đọc stdin — đủ lớn để ít vòng lặp, nhỏ để cap bắt sát. */
const STDIN_READ_CHUNK_SIZE = 64 * 1024;

/**
 * Đọc toàn bộ fd cho tới EOF theo khối, chặn ở trần dung lượng — không bao giờ
 * buffer vô hạn. fd là tham số để spec đọc từ file thật mà không đụng stdin.
 */
/** Trần thời gian chờ dữ liệu stdin khi fd non-blocking — không chờ vô hạn. */
const STDIN_EAGAIN_DEADLINE_MS = 10_000;

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
    // Chuỗi if/else tường minh thay ternary lồng (review checklist cấm ternary
    // lồng) — output giữ nguyên.
    let status: string;
    if (report.created) {
      status = 'created';
    } else if (report.exists) {
      status = 'existed';
    } else {
      status = 'missing';
    }
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

/** Chạy `nx <args...>` và trả danh sách dòng output — lỗi exec là blocking throw. */
function nxLines(args: string[]): string[] {
  const result = exec('npx', ['nx', ...args], process.cwd(), process.env);
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(
      `nx ${args.join(' ')} failed: ` +
        `${result.error?.message ?? (result.stderr.trim() === '' ? 'no output' : result.stderr.trim())}`,
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Deps mặc định của `staging-plan`: file thật + `nx show projects` thật. */
const defaultPlanDeps: StagingPlanDeps = {
  readTextFile: (path) => readFileSync(path, 'utf8'),
  listProjects: () => nxLines(['show', 'projects']),
  affectedProjects: (base, head) =>
    nxLines(['show', 'projects', '--affected', `--base=${base}`, '--head', head]),
};

/**
 * Map MỘT lệnh có thể ném `GuardAbortError` ra exit code theo hợp đồng marker:
 * abort in stderr + marker đúng action rồi exit 1; lỗi khác rethrow để catch-all
 * cuối cùng xử lý (exit 1 không marker — step fail với mặc định fail-closed).
 */
async function runGuardable(
  run: () => Promise<{
    guardAction: 'proceed' | 'skip' | 'abort-query-failed' | 'abort-main-advanced';
  }>,
): Promise<number> {
  try {
    const result = await run();
    process.stdout.write(`${GUARD_MARKER_PREFIX}${result.guardAction}\n`);
    return 0;
  } catch (error) {
    if (error instanceof GuardAbortError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.stdout.write(`${GUARD_MARKER_PREFIX}${error.action}\n`);
      return 1;
    }
    throw error;
  }
}

async function main(argv: readonly string[]): Promise<number> {
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
  if (command === 'vpc-service') {
    const parsed = parseVpcServiceArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    const { serviceId } = createStagingVpcService(parsed.input);
    // Dòng machine-readable `service_id=` là output contract cho wiring
    // Hyperdrive #350 (config Pulumi reference service_id này).
    process.stdout.write(`service_id=${serviceId}\n`);
    process.stdout.write(
      `vpc service ${parsed.input.name} created — feed service_id into the Hyperdrive wiring (#350), ` +
        'not into wrangler.jsonc by hand\n',
    );
    return 0;
  }
  if (command === 'staging-manifest') {
    const parsed = parseStagingManifestArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    const configText = readFileSync(parsed.configPath, 'utf8');
    const manifest = buildStagingManifest(configText, parsed.sha);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  }
  if (command === 'staging-plan') {
    const parsed = parseStagingPlanArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    const plan = planStagingBatch(
      { deploySha: parsed.deploySha, baseSha: parsed.baseSha },
      defaultPlanDeps,
    );
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  }
  if (command === 'staging-unit-gate') {
    const parsed = parseStagingUnitGateArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    const result = evaluateStagingUnitGate(parsed, {
      readTextFile: (path) => readFileSync(path, 'utf8'),
    });
    // Mọi lý do machine-readable in verbatim TRƯỚC khi chốt exit — caller đọc
    // được đầy đủ trạng thái trong MỘT lần chạy, không chỉ lỗi đầu tiên.
    for (const reason of result.decision.reasons) {
      process.stdout.write(`staging-unit-gate deny ${reason.code}: ${reason.message}\n`);
    }
    for (const problem of result.bindingProblems) {
      const binding = problem.binding === undefined ? '' : ` (${problem.binding})`;
      process.stdout.write(
        `staging-unit-gate binding-problem ${problem.kind}${binding}: ${problem.message}\n`,
      );
    }
    if (!result.allowed) {
      process.stderr.write(
        `staging-unit-gate: ${result.decision.project} denied — fix the reasons above before deploying\n`,
      );
      return 1;
    }
    process.stdout.write(
      `staging-unit-gate allow: ${result.decision.project} passed the staging gate\n`,
    );
    return 0;
  }
  if (command === 'staging-guard') {
    const parsed = parseStagingGuardArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    try {
      const { action, decision } = runGuardAtPoint(parsed.input, defaultGuardQueryDeps());
      process.stdout.write(`staging guard ${decision.code}: ${decision.message}\n`);
      process.stdout.write(`${GUARD_MARKER_PREFIX}${action}\n`);
      return 0;
    } catch (error) {
      if (error instanceof GuardAbortError) {
        process.stderr.write(`error: ${error.message}\n`);
        process.stdout.write(`${GUARD_MARKER_PREFIX}${error.action}\n`);
        return 1;
      }
      throw error;
    }
  }
  if (command === 'staging-deploy') {
    const parsed = parseStagingDeployArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    return runGuardable(() => runStagingDeploy(parsed.params));
  }
  if (command === 'staging-smoke') {
    const parsed = parseStagingSmokeArgv(argv.slice(1));
    if (parsed.kind === 'usage') {
      process.stderr.write(`${parsed.message}\n${USAGE}\n`);
      return 2;
    }
    return runGuardable(() => runStagingSmoke(parsed.options));
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

/**
 * Quyết định `argv1` có trỏ tới chính module CLI này không. So sánh realpath
 * HAI BÊN: argv[1] có thể là symlink hoặc đường tương đối (bin shim) — so
 * nguyên chuỗi sẽ lệch và main không chạy. Guard `!argv1` ở đây là nơi đúng
 * cho argv thiếu (REPL, worker, embed) — false, không main. realpath không
 * resolve được → fallback so raw string; path khớp CHÍNH entry mà vẫn không
 * quyết định được là state không thể phân loại → rethrow fail-closed thay vì
 * im lặng.
 */
export function isCliEntry(argv1: string | undefined, selfPath: string): boolean {
  if (!argv1) return false;
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
if (isCliEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  // Mọi lỗi chưa xử lý là exit 1 với thông điệp gọn — fail-closed, không stack
  // trace. Dùng exitCode + drain tự nhiên thay vì process.exit: exit ngay sau
  // write có thể cắt ngang stdout/stderr chưa flush (đặc biệt khi pipe).
  // main bất đồng bộ (deploy/smoke await network) — promise rejection thay cho
  // try/catch, semantics exit code giữ nguyên.
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      return code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
