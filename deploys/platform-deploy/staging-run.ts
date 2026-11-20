/**
 * Execution engine của lane staging cho `platform-deploy` — executor ĐẦU TIÊN
 * của hợp đồng provisioning/reconciliation staging (#368), chạy trên nền
 * adapter seam `@ecoma-io/deployment` (#367).
 *
 * Tách bạch hai lifecycle (§7.4.1): module này chỉ provision infrastructure
 * Pulumi — deploy Worker là Wrangler (#362/#350), migration là `deploys/*-db`
 * (#373/#374); không đường nào ở đây đụng hai lifecycle đó.
 *
 * Stack mapping đã chốt bởi #345 (§7.4.1): MỘT stack `staging` cho mỗi Pulumi
 * project, backend R2 qua `ECOMA_PULUMI_STATE_URL_STAGING`, passphrase
 * per-stack. Executor này TIÊU THỤ mapping đó qua
 * `stagingDeploymentAdapter.stackSelection()` — không suy lại tên stack ở đây.
 *
 * Ranh giới credential (§6/§7.4.1): mọi credential đi qua environment của
 * process Pulumi, KHÔNG BAO GIỜ qua argv (`/proc/<pid>/cmdline` đọc được) và
 * không bao giờ được ghi vào file trong repo. Inventory thiếu khóa nào là
 * fail-closed kèm danh sách ĐẦY ĐỦ tên khóa thiếu — không fallback, không đoán
 * (`ECOMA_PULUMI_STATE_URL_STAGING` thiếu nghĩa là staging chưa được bootstrap
 * — #350 — tuyệt đối không "dùng local tạm").
 *
 * Chương trình Pulumi của platform-deploy trên stack staging khai resource
 * thật từ #349 (DNS zone `ecoma.io.vn` qua `staging-program.ts`; trước đó là
 * marker-only 0-resource theo #368). Guard ở `index.ts` vẫn chặn stack lạ —
 * resource staging của CÁC unit khác (`staging-pg-host`...) nằm trên stack
 * Pulumi riêng của unit đó, không phải ở đây.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deployProjectDir,
  exec,
  pulumiRun,
  stagingDeploymentAdapter,
  stackRef,
  type ExecResult,
  type StackSelection,
  STAGING_STATE_URL_ENV_KEY,
} from '@ecoma-io/deployment';

/** Slot duy nhất executor này chạy: continuous lane. Candidate slot là #381. */
const STAGING_SLOT = 'staging' as const;

/** Phase lifecycle mà executor này mở cho staging — KHÔNG có `down`/`destroy`. */
export type StagingPhase = 'preview' | 'up';

/** Library deps được inject để spec chạy không cần Pulumi thật. */
export interface StagingExecDeps {
  execFn: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ExecResult;
}

const defaultDeps: StagingExecDeps = { execFn: exec };

/**
 * Phân loại stack ref đầy đủ của platform-deploy theo lane.
 *
 * `local-*` — lane local hiện hành (namespace worktree); `staging`/`staging-candidate`
 * — slot staging (khai resource thật từ #349/#350 — zone + DNS records qua
 * `staging-program.ts`); còn lại — KHÔNG ĐƯỢC chạy: mỗi thân lane khai
 * resource đúng cho lane của nó, chạy trên stack lạ là khai resource sai
 * environment (hazard thật trước #368 — program không có guard).
 */
export function classifyPlatformStack(rawStackRef: string): 'local' | 'staging' | 'unknown' {
  const slug = rawStackRef.slice(rawStackRef.lastIndexOf('/') + 1);
  if (slug.startsWith('local-')) return 'local';
  if (slug === 'staging' || slug === 'staging-candidate') return 'staging';
  return 'unknown';
}

/** Env runtime đã resolve cho subprocess Pulumi của một lần chạy staging. */
export interface StagingRunEnv {
  /** URL backend R2 đã qua kiểm tra tổ hợp stack↔backend. */
  backendUrl: string;
  /** Env ĐẦY ĐỦ cho subprocess Pulumi (đã set/cắt biến theo inventory). */
  env: NodeJS.ProcessEnv;
}

/**
 * Inventory credential fail-closed cho một lần chạy staging.
 *
 * Bắt buộc:
 * - `ECOMA_PULUMI_STATE_URL_STAGING` — backend state R2 (bootstrap #350);
 * - `PULUMI_CONFIG_PASSPHRASE` — passphrase per-stack (GitHub Environment
 *   secret của stack khi chạy CI; operator export khi chạy tay);
 * - `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — token R2 scope một bucket
 *   (`04` R23): backend s3 đọc credential chain của AWS env ở MỌI lệnh.
 *
 * - `CLOUDFLARE_API_TOKEN` — provider control-plane Cloudflare của
 *   `staging-program.ts` (`Provider` + `Zone` root #349/#350). NẰM TRONG
 *   inventory bắt buộc: thiếu token bị chặn TẠI ENGINE (throw dưới đây, trước
 *   khi Pulumi chạy) — không để provider thất bại sâu bên trong Pulumi.
 *   Ranh giới giữ nguyên: env-only, không argv, không Git.
 *
 * Thiếu bất kỳ khóa nào → throw với danh sách ĐẦY ĐỦ khóa thiếu (không dừng ở
 * khóa đầu — operator phải sửa hết trong một lần, không lặp chuỗi chạy-thất-bại).
 */
export function resolveStagingRunEnv(source: NodeJS.ProcessEnv = process.env): StagingRunEnv {
  const required: Array<[key: string, value: string | undefined]> = [
    [STAGING_STATE_URL_ENV_KEY, source[STAGING_STATE_URL_ENV_KEY]],
    ['PULUMI_CONFIG_PASSPHRASE', source.PULUMI_CONFIG_PASSPHRASE],
    ['AWS_ACCESS_KEY_ID', source.AWS_ACCESS_KEY_ID],
    ['AWS_SECRET_ACCESS_KEY', source.AWS_SECRET_ACCESS_KEY],
    ['CLOUDFLARE_API_TOKEN', source.CLOUDFLARE_API_TOKEN],
  ];
  const missing = required
    .filter(([, value]) => value === undefined || value.trim().length === 0)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `staging provisioning credentials missing: ${missing.join(', ')} — set them in the ` +
        'operator environment (per-stack passphrase and R2 bucket-scoped token); ' +
        `an unset ${STAGING_STATE_URL_ENV_KEY} means the staging state backend is not bootstrapped yet (#350) ` +
        'and the run must not fall back to another backend',
    );
  }
  const backendUrl = source[STAGING_STATE_URL_ENV_KEY] as string;
  // Adapter tự validate tổ hợp stack↔backend (staging chỉ đi với s3:// R2 đủ
  // endpoint/region/s3ForcePathStyle) — sai tổ hợp là từ chối ngay đây.
  stagingDeploymentAdapter.stackSelection('platform-deploy', { slot: STAGING_SLOT, backendUrl });
  const env: NodeJS.ProcessEnv = {
    ...source,
    PULUMI_BACKEND_URL: backendUrl,
    PULUMI_SKIP_UPDATE_CHECK: '1',
    PULUMI_CONFIG_PASSPHRASE: source.PULUMI_CONFIG_PASSPHRASE as string,
  };
  // Cắt file-passphrase variant: env là nguồn passphrase duy nhất của lane
  // staging (per-stack secret), để biến còn sót là CLI đổi thứ tự ưu tiên im lặng.
  delete env.PULUMI_CONFIG_PASSPHRASE_FILE;
  return { backendUrl, env };
}

/**
 * `stack init` stack staging của project; đã có thì `stack select`.
 *
 * Đối xứng `ensureStack` của lane local TRỪ bước `mkdir`: backend s3 không đòi
 * thư mục local, và tạo thư mục state local trong một lần chạy staging là
 * mutation sai lane. `stack init` exit 0 khi vừa tạo; exit != 0 khi đã có
 * (hoặc lỗi thật) — phân biệt bằng `stack select` (đúng cơ chế `ensureStack`).
 */
export function ensureStagingStack(
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = defaultDeps,
): void {
  const init = deps.execFn('pulumi', ['stack', 'init', selection.stackName], projectDir, env);
  if (init.status !== 0) {
    const select = deps.execFn(
      'pulumi',
      ['stack', 'select', selection.fullStackRef],
      projectDir,
      env,
    );
    if (select.status !== 0) {
      throw new Error(
        `pulumi stack init/select ${selection.stackName} failed:\n${init.stderr}\n${select.stderr}`,
      );
    }
  }
}

/** Đếm resource change từ stdout `--json` của `pulumi preview`/`up`. */
export type StagingResourceChanges = Record<string, number>;

/**
 * Parse summary resourceChanges từ stdout `--json`.
 *
 * Defensive: CLI đổi shape hoặc in thêm dòng nào đó → `undefined` (record ghi
 * thiếu phần này, KHÔNG chết) — evidence không được biến parse-fail thành run
 * fail, và cũng không được bịa số 0.
 */
export function parseResourceChanges(stdout: string): StagingResourceChanges | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  const summary = (parsed as { summary?: { resourceChanges?: unknown } }).summary;
  const changes = summary?.resourceChanges;
  if (typeof changes !== 'object' || changes === null) return undefined;
  const out: StagingResourceChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (typeof value === 'number') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Revision hiện hành của stack từ `pulumi stack history --json`. */
export function readStagingRevision(
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = defaultDeps,
): number | undefined {
  const history = deps.execFn(
    'pulumi',
    ['stack', 'history', '--json', '--stack', selection.fullStackRef],
    projectDir,
    env,
  );
  if (history.status !== 0) return undefined;
  try {
    const entries = JSON.parse(history.stdout) as Array<{ version?: unknown }>;
    const version = entries[0]?.version;
    return typeof version === 'number' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** SHA của workspace HEAD tại thời điểm chạy — revision của PROGRAM được apply. */
export function readGitHeadSha(
  cwd: string,
  deps: StagingExecDeps = defaultDeps,
): string | undefined {
  // Least privilege (§6/§7.4.1): `git rev-parse` không cần credential nào —
  // truyền env tối thiểu thay vì passthrough toàn bộ process.env (passphrase/
  // token chỉ được đi đúng đường env của process Pulumi, không rò sang
  // subprocess metadata).
  const result = deps.execFn('git', ['rev-parse', 'HEAD'], cwd, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
}

/** Bản ghi evidence cho MỘT lần chạy phase (§7.3 provenance contract — MOD2 #346). */
export interface StagingProvisioningRecord {
  schemaVersion: 1;
  stackRef: string;
  slot: typeof STAGING_SLOT;
  backendBucket: string;
  gitSha: string | null;
  phase: StagingPhase;
  revision: number | null;
  resourceChanges: StagingResourceChanges | null;
  outcome: 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string;
}

/**
 * Ghi evidence append-only: mỗi lần chạy MỘT file JSON mới trong
 * `.staging-evidence/` của project (ngoài Git — `.gitignore`; CI wiring #350+
 * upload record vào provenance store thay vị trí này). Filename mang
 * timestamp + phase nên chạy lại KHÔNG BAO GIỜ ghi đè record cũ.
 */
export function appendStagingRecord(projectDir: string, record: StagingProvisioningRecord): string {
  const dir = join(projectDir, '.staging-evidence');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${record.startedAt.replace(/[:.]/gu, '-')}-${record.phase}-${record.outcome}.json`,
  );
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

/** Bucket identity của backend URL — host của URL s3, không kèm query. */
export function backendBucket(backendUrl: string): string {
  return new URL(backendUrl).host;
}

/**
 * Chạy MỘT phase (`preview` hoặc `up`) trên stack staging của project, trả
 * record evidence. `--json` thay progress hiển thị: record phải mang diff đủ
 * nguyên vẹn. Stack hiện tại khai resource thật từ #349/#350 (zone + DNS
 * records) nên mỗi phase vẫn nhanh; entry có thể đổi sang stream + `stack
 * history` mà không đổi hợp đồng record.
 *
 * `pulumiRun` reuse: tự ghép `--stack <fullRef>` và xử lý lỗi spawn/exit đúng
 * cơ chế chung; `prepareStack` để false vì `ensureStack` của local có `mkdir`
 * file:// — stack staging được chuẩn bị bởi `ensureStagingStack` ở trên.
 */
export function runStagingPhase(
  phase: StagingPhase,
  project: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: StagingExecDeps = defaultDeps,
): { record: StagingProvisioningRecord; recordPath: string } {
  const projectDir = deployProjectDir(project);
  // Inventory credential TRƯỚC: thiếu khóa là fail-closed với danh sách ĐẦY ĐỦ
  // khóa thiếu, trước mọi lời gọi adapter (lần gọi đầu từng đứng trước để sau
  // đó adapter tự fallback đọc env khi `backendUrl` undefined — đường lỗi kép
  // đã được OCR chỉ ra).
  const { backendUrl, env } = resolveStagingRunEnv(sourceEnv);
  const selection = stagingDeploymentAdapter.stackSelection(project, {
    slot: STAGING_SLOT,
    backendUrl,
  });
  const startedAt = new Date().toISOString();
  const gitSha = readGitHeadSha(projectDir, deps);
  ensureStagingStack(projectDir, selection, env, deps);
  const ctx = {
    worktreeRoot: projectDir,
    namespace: '',
    stackName: selection.stackName,
    stateUrl: backendUrl,
  };
  const phaseArgs = phase === 'up' ? ['up', '--yes', '--json'] : ['preview', '--json'];
  const outcome = {
    record: {
      schemaVersion: 1 as const,
      stackRef: stackRef(project, selection.stackName),
      slot: STAGING_SLOT,
      backendBucket: backendBucket(backendUrl),
      gitSha: gitSha ?? null,
      phase,
      revision: null as number | null,
      resourceChanges: null as StagingResourceChanges | null,
      outcome: 'succeeded' as 'succeeded' | 'failed',
      startedAt,
      finishedAt: '',
    },
    recordPath: '',
  };
  try {
    const stdout = pulumiRun(projectDir, project, phaseArgs, ctx, env) ?? '';
    outcome.record.resourceChanges = parseResourceChanges(stdout) ?? null;
    outcome.record.revision = readStagingRevision(projectDir, selection, env, deps) ?? null;
    outcome.record.outcome = 'succeeded';
  } catch (error) {
    outcome.record.outcome = 'failed';
    outcome.record.finishedAt = new Date().toISOString();
    const path = appendStagingRecord(projectDir, outcome.record);
    throw Object.assign(
      new Error(
        `staging ${phase} failed on ${outcome.record.stackRef}: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { recordPath: path },
    );
  }
  outcome.record.finishedAt = new Date().toISOString();
  outcome.recordPath = appendStagingRecord(projectDir, outcome.record);
  return outcome;
}

/**
 * Đối số phase của entry CLI — destroy/refuse là đường TƯỜNG MINH: `down`/
 * `destroy` KHÔNG phải phase của lane staging (teardown staging không có
 * workflow; checklist tay thuộc runbook #364). Thiếu đối số là lỗi dùng-lệnh,
 * không phải đoán `preview`.
 */
export function parseStagingPhaseArg(
  argv: readonly string[],
): { kind: 'ok'; phase: StagingPhase } | { kind: 'refused'; verb: string } | { kind: 'missing' } {
  const verb = argv[0];
  if (verb === undefined || verb.trim().length === 0) return { kind: 'missing' };
  if (verb === 'preview' || verb === 'up') return { kind: 'ok', phase: verb };
  return { kind: 'refused', verb };
}
