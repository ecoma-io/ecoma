/**
 * Đường deploy staging cho một deploy unit (slice đầu tiên của lane Continuous
 * Staging — issue #353; hợp đồng `02-delivery.md` §7.4, §7.5):
 *
 * Preflight fail-closed TRƯỚC khi wrangler chạy — bất kỳ bước nào thiếu là
 * dừng với lỗi tiếng Anh nêu đúng thứ phải sửa, không có lệnh nào được thực
 * thi nửa vời:
 *
 * 1. slug an toàn (^[a-z0-9-]+$) — slug này là nửa tên Environment
 *    `staging-<slug>` và nửa tên Worker `stg-<slug>` (§7.2: suy sai slug là
 *    lỗi chặn, không đoán).
 * 2. `--expect-sha` là commit SHA 40-hex đầy đủ — bằng chứng exact-SHA của
 *    lane (§7.3); ref khác dạng đó là input hỏng, không deploy.
 * 3. `env.staging.name` của wrangler.jsonc tồn tại, là identity `stg-<unit>`
 *    với `<unit>` là tên Worker production của cùng config, và slug của caller
 *    là đuôi unit đó — Environment `staging-<slug>` và wrangler config phải
 *    tả cùng một deploy unit (§6.12).
 * 4. Eligibility: project phải khai `staging: "releaseable"` trong
 *    `config/deploy-eligibility.jsonc` (nguồn phân loại canonical, #360).
 * 5. build manifest của artifact khớp run: sha đúng và worker đúng — job
 *    deploy chỉ dùng artifact khớp manifest của run mình (§7.4).
 * 6. Cặp credential control-plane của lane staging — `ECOMA_CLOUDFLARE_STAGING_API_TOKEN`
 *    + `ECOMA_CLOUDFLARE_STAGING_ACCOUND_ID` — có trong env
 *    (`resolveSecretRunEnv('staging', …)` — tái dụng pipeline worker-secrets,
 *    không tái hiện thực; §6.12).
 *
 * Sau preflight, TRƯỚC `wrangler deploy`: stale-run guard điểm `before-deploy`
 * (§7.4) — khi caller bật guard qua cờ `--guard-run-id`/`--guard-head-sha`,
 * một lượt tra cứu run MỚI được chạy rồi đưa vào `evaluateRunnerGuard`;
 * `skip` là exit 0 KHÔNG deploy, abort là exit khác 0 qua `GuardAbortError`
 * (marker machine-readable do CLI in). Guard không bật → hành vi cũ giữ
 * nguyên (lane caller không bật guard không bị đổi contract).
 *
 * Sau guard: `wrangler deploy` qua lớp retry §7.4 (`wrangler-deploy.ts`).
 * Token KHÔNG BAO GIỜ qua argv và không được log; mọi thông điệp lỗi chỉ chứa
 * tên biến và path, không chứa giá trị env.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  classifyWorkerName,
  parseWranglerConfig,
  resolveSecretRunEnv,
  stagingWorkerNameFromConfig,
  stagingWorkerNameFromParsed,
  stripJsoncComments,
} from './worker-secrets.ts';
import {
  deployStagingWorker,
  type DeployStagingWorkerOptions,
  type DeployStagingWorkerResult,
} from './wrangler-deploy.ts';
import {
  defaultGuardQueryDeps,
  evaluateGuardAtPoint,
  queryFreshRunState,
  type GuardAction,
  type RunListQueryResult,
} from './staging-guard.ts';

/** Đường dẫn tuyệt đối của inventory eligibility (cùng nguồn với cli.ts). */
export function deployEligibilityPath(): string {
  return fileURLToPath(new URL('../config/deploy-eligibility.jsonc', import.meta.url));
}

/** Deps inject để spec chạy không cần file/token/wrangler thật. */
export interface StagingDeployDeps {
  readTextFile: (path: string) => string;
  deployStaging: (options: DeployStagingWorkerOptions) => Promise<DeployStagingWorkerResult>;
  /** MỘT lượt tra cứu run MỚI cho guard `before-deploy` (§7.4) — mỗi lượt gọi tra lại. */
  queryRuns: () => RunListQueryResult;
  out: { write(text: string): unknown };
}

const defaultDeps: StagingDeployDeps = {
  readTextFile: (path) => readFileSync(path, 'utf8'),
  deployStaging: (options) => deployStagingWorker(options),
  queryRuns: () => queryFreshRunState(defaultGuardQueryDeps()),
  out: process.stdout,
};

/** Nhận dạng run cho guard `before-deploy` — cờ CLI, bật cùng lúc cả hai. */
export interface StagingDeployGuardInput {
  runId: number;
  contextSha: string;
}

/** Tham số argv đã parse của lệnh `staging-deploy`. */
export interface StagingDeployParams {
  configPath: string;
  project: string;
  slug: string;
  manifestPath: string;
  expectSha: string;
  /** Có mặt → guard `before-deploy` chạy ngay trước `wrangler deploy`. */
  guard?: StagingDeployGuardInput;
}

/** Kết quả một lần `runStagingDeploy` — marker cho workflow step đọc. */
export interface StagingDeployRunResult {
  /** `false` khi guard `skip` — KHÔNG có deploy nào chạy (exit vẫn là 0). */
  deployed: boolean;
  /** Hành động guard đã chạy — `proceed` khi guard không bật. */
  guardAction: GuardAction;
}

/** Commit SHA đầy đủ — mọi quyết định SHA của lane đọc dạng 40-hex. */
export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value);
}

/**
 * Đọc quyết định eligibility của MỘT project từ deploy-eligibility.jsonc.
 * Thiếu entry, sai trạng thái hay file hỏng đều là lỗi chặn với đúng tên file
 * — không suy từ "có wrangler.jsonc hay không" (§7.5 mục 2).
 */
export function readEligibilityDecision(
  project: string,
  deps: Pick<StagingDeployDeps, 'readTextFile'>,
): 'releaseable' {
  const path = deployEligibilityPath();
  let config: { projects?: Record<string, { staging?: string }> };
  try {
    config = JSON.parse(stripJsoncComments(deps.readTextFile(path))) as typeof config;
  } catch (error) {
    throw new Error(
      `deploy eligibility config is unreadable at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const entry = config.projects?.[project];
  if (entry === undefined) {
    throw new Error(
      `project "${project}" has no entry in ${path} — every project must be classified ` +
        'explicitly; an unclassified project must never reach the deploy step (§7.5 item 2)',
    );
  }
  if (entry.staging !== 'releaseable') {
    throw new Error(
      `project "${project}" is not staging-releaseable in ${path} (status: ` +
        `${entry.staging ?? 'missing'}) — fix the classification before deploying`,
    );
  }
  return 'releaseable';
}

/**
 * Resolve Worker identity staging từ config và khớp với slug của caller.
 * Hai quy tắc suy (§6.12, §7.2) — kiểm CẢ HAI trước khi wrangler chạy:
 * - Worker staging là `stg-<unit>` với `<unit>` là tên Worker production
 *   (top-level `name`) của cùng config — `stg-ecoma-home` cho unit
 *   `ecoma-home`; một tên `stg-*` không trỏ đúng unit production là lệch.
 * - Slug của caller là phần đuôi unit (Environment `staging-<slug>` suy từ
 *   tên project, cùng quy tắc `staging-environments.ts`): `home` khớp unit
 *   `ecoma-home` (đuôi `-home`).
 */
export function resolveStagingWorkerIdentity(
  configText: string,
  slug: string,
  configPath: string,
): string {
  // MỘT lần parse cho CẢ hai tên: production và staging đọc từ cùng object
  // đã parse — không có chỗ nào sửa một bên quên bên kia.
  const parsed = parseWranglerConfig(configText);
  const staging = stagingWorkerNameFromParsed(parsed);
  if (classifyWorkerName(staging) !== 'staging') {
    throw new Error(
      `resolved worker "${staging}" from ${configPath} is not a staging identity ` +
        '(expected prefix "stg-") — refusing to deploy outside the staging scope',
    );
  }
  const production = parsed.name;
  if (typeof production !== 'string' || production.trim().length === 0) {
    throw new Error(
      `wrangler config at ${configPath} declares no top-level "name" — the staging identity ` +
        'must derive from the production worker name (stg-<unit>, §6.12)',
    );
  }
  if (staging !== `stg-${production}`) {
    throw new Error(
      `worker identity mismatch: ${configPath} declares env.staging.name "${staging}" but ` +
        `the production unit is "${production}" — the staging identity must be "stg-<unit>" ` +
        'exactly (§6.12)',
    );
  }
  if (production !== slug && !production.endsWith(`-${slug}`)) {
    throw new Error(
      `worker identity mismatch: caller slug "${slug}" does not name this deploy unit — ` +
        `${configPath} declares unit "${production}" (expected a name ending in "-${slug}"); ` +
        `the GitHub Environment "staging-${slug}" and the wrangler config must describe ` +
        'the same deploy unit',
    );
  }
  return staging;
}

/** Shape của build-manifest.json mà job build viết vào artifact. */
export interface BuildManifest {
  sha: string;
  worker: string;
}

/** Manifest từ config + SHA của lần build — đầu vào của lệnh `staging-manifest`. */
export function buildStagingManifest(configText: string, sha: string): BuildManifest {
  if (!isFullCommitSha(sha)) {
    throw new Error(
      `build manifest requires a full 40-hex commit SHA, got "${sha}" — the deploy lane ` +
        'records evidence against the exact SHA only (§7.3)',
    );
  }
  return { sha, worker: stagingWorkerNameFromConfig(configText) };
}

/**
 * Kiểm manifest của artifact khớp run: sha đúng và worker đúng. Lệch là lỗi
 * chặn — job deploy không bao giờ deploy artifact của run khác (§7.4).
 */
export function verifyBuildManifest(
  manifestText: string,
  manifestPath: string,
  expectSha: string,
  worker: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new Error(
      `build manifest at ${manifestPath} is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const manifest = parsed as Partial<BuildManifest>;
  if (manifest.sha !== expectSha) {
    throw new Error(
      `build manifest at ${manifestPath} records sha ${String(manifest.sha)} but this run ` +
        `deploys ${expectSha} — refusing to deploy an artifact that does not match the ` +
        'verified revision of this run (§7.4)',
    );
  }
  if (manifest.worker !== worker) {
    throw new Error(
      `build manifest at ${manifestPath} records worker ${String(manifest.worker)} but the ` +
        `config declares "${worker}" — refusing to deploy an artifact built for another ` +
        'deploy unit',
    );
  }
}

/**
 * Chạy trọn preflight + guard `before-deploy` + deploy staging cho một unit.
 * Ném lỗi ở bất kỳ bước preflight nào (không có gì được thực thi nửa vời) và
 * throw `GuardAbortError` cho đường abort của guard; ghi mỗi bước ra `out`
 * để log job đọc được thứ tự kiểm.
 */
export async function runStagingDeploy(
  params: StagingDeployParams,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: StagingDeployDeps = defaultDeps,
): Promise<StagingDeployRunResult> {
  if (!/^[a-z0-9-]+$/u.test(params.slug)) {
    throw new Error(
      `unsafe slug "${params.slug}" — expected lowercase letters, digits and hyphens only; ` +
        'the slug names both the GitHub Environment and the stg- worker identity',
    );
  }
  if (!isFullCommitSha(params.expectSha)) {
    throw new Error(
      `--expect-sha must be a full 40-hex commit SHA, got "${params.expectSha}" — the lane ` +
        'deploys and records evidence against the exact verified SHA only (§7.3)',
    );
  }
  const configAbs = resolve(params.configPath);
  let configText: string;
  try {
    configText = deps.readTextFile(configAbs);
  } catch (error) {
    throw new Error(
      `cannot read wrangler config at ${configAbs}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const worker = resolveStagingWorkerIdentity(configText, params.slug, configAbs);
  deps.out.write(`staging deploy: worker identity resolved (${worker})\n`);

  readEligibilityDecision(params.project, deps);
  deps.out.write(
    `staging deploy: project ${params.project} is staging-releaseable in ` +
      `${deployEligibilityPath()}\n`,
  );

  let manifestText: string;
  try {
    manifestText = deps.readTextFile(resolve(params.manifestPath));
  } catch (error) {
    throw new Error(
      `cannot read build manifest at ${params.manifestPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  verifyBuildManifest(manifestText, params.manifestPath, params.expectSha, worker);
  deps.out.write(
    `staging deploy: build manifest matches run sha ${params.expectSha} for ${worker}\n`,
  );

  // Cặp credential staging fail-closed với đúng tên org secret — tái dụng
  // pipeline worker-secrets (§6.12), không nhận credential nào khác và không
  // log giá trị.
  const { env } = resolveSecretRunEnv('staging', sourceEnv);

  // Guard `before-deploy` (§7.4): tra cứu run MỚI NGAY TRƯỚC wrangler deploy.
  // skip = exit 0 không deploy; abort = throw (CLI in marker + exit khác 0).
  if (params.guard !== undefined) {
    const { action, decision } = evaluateGuardAtPoint(
      { contextSha: params.guard.contextSha, runId: params.guard.runId, point: 'before-deploy' },
      deps.queryRuns(),
    );
    deps.out.write(`staging guard ${decision.code}: ${decision.message}\n`);
    if (action === 'skip') {
      return { deployed: false, guardAction: action };
    }
  }

  const result = await deps.deployStaging({ configPath: configAbs, env });
  deps.out.write(
    `staging deploy: ${worker} deployed from sha ${params.expectSha} ` +
      `after ${result.attempts} attempt(s)\n`,
  );
  return { deployed: true, guardAction: 'proceed' };
}
