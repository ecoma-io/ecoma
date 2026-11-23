/**
 * Engine dùng chung của lane staging cho MỌI `deploys/*-deploy` — hợp nhất của
 * 12 bản copy `staging-run.ts` (issue #543; bản gốc `platform-deploy` #453, các
 * bản copy #350/#354/#355/#358/#359/#539). Trước đây mỗi deploy project giữ một
 * bản copy có chủ đích; từ #543 phần chung sống ở đây và phần per-unit (hằng
 * tên tài nguyên, tên stack output, classify lane, origin Hyperdrive) là tham
 * số tường minh — thân mỏng per-unit ở `deploys/<unit>/staging-run.ts` bọc
 * engine này với đúng hằng của unit.
 *
 * Behavior lấy bản TIẾN HOÁ NHẤT trong các bản copy (OCR round 3–5):
 * - inventory fail-closed với danh sách ĐẦY ĐỦ khóa thiếu (5 khóa, giống nhau
 *   ở cả 12 bản) — thiếu là từ chối TRƯỚC KHI đụng Pulumi;
 * - env subprocess Pulumi là ALLOWLIST (khóa inventory + PATH/HOME, fallback
 *   `source.PATH ?? process.env.PATH`) — không passthrough process.env;
 * - `stackSelection` được gọi đúng MỘT lần, selection trả về cho caller;
 * - `ensureStagingStack` chỉ fallback `stack select` khi stderr của `init`
 *   mang "already exists" (lỗi thật của init không bị che);
 * - parse `--json` thử TỪNG vị trí `{` (dòng progress chứa `{` không làm mất
 *   resourceChanges), parse-fail warn ra stderr — provenance gap, không phải
 *   run failure;
 * - `readGitHeadSha` nhận `sourceEnv` (test được) với fallback PATH/HOME;
 * - evidence append-only: filename mang hậu tố đếm stateless (readdirSync) —
 *   hai lần chạy cùng mili-giây không bao giờ ghi đè nhau;
 * - lỗi ghi evidence không THAY lỗi Pulumi gốc (nhánh thất bại giữ `cause`),
 *   và trên nhánh thành công lỗi ghi evidence không biến provision xanh thành
 *   throw — recordPath rỗng là tín hiệu provenance gap.
 *
 * Tách bạch hai lifecycle (§7.4.1): module này chỉ provision infrastructure
 * Pulumi — deploy Worker là Wrangler, migration là `databases/*-db`; không đường
 * nào ở đây đụng hai lifecycle đó.
 *
 * Ranh giới credential (§6/§7.4.1): mọi credential đi qua environment của
 * process Pulumi, KHÔNG BAO GIỜ qua argv (`/proc/<pid>/cmdline` đọc được) và
 * không bao giờ được ghi vào file trong repo.
 */

import type { Input } from '@pulumi/pulumi';

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Nguồn cụ thể từng module — KHÔNG import qua `./index.js` (index tái xuất
// module này; vòng import qua index là chu kỳ không cần thiết).
import {
  STAGING_STATE_URL_ENV_KEY,
  stagingDeploymentAdapter,
  type StackSelection,
} from './deploy-environment.js';
import { deployProjectDir } from './local-entry.js';
import { exec, pulumiRun, stackRef, type ExecResult } from './pulumi-context.js';

/** Slot duy nhất engine này chạy: continuous lane. Candidate slot là #381. */
export const STAGING_SLOT = 'staging' as const;

/**
 * Origin keys trên stack config của stack staging — tên ngắn trong namespace
 * `namespace:` của project (đọc bằng `pulumi.Config('namespace')`; key đầy đủ
 * mà operator set là `namespace:<tên>`).
 */
export const STAGING_ORIGIN_HOST_CONFIG_KEY = 'originHost';
export const STAGING_ORIGIN_PORT_CONFIG_KEY = 'originPort';
export const STAGING_ORIGIN_PASSWORD_CONFIG_KEY = 'originPassword';

/**
 * Id tài nguyên thật — UUID non-empty, không phải placeholder toàn số 0 (cùng
 * invariant với guard `resource-bindings` của `tools/delivery`: id thiếu/toàn-
 * zeros là placeholder). Hằng so khớp đặt tên để test đọc đúng ý. Dùng chung
 * cho HyperdriveConfig lẫn D1 database — hình id do Cloudflare cấp là như nhau.
 */
export const RESOURCE_PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isProvisionedResourceId(value: string): boolean {
  return RESOURCE_ID_PATTERN.test(value) && value !== RESOURCE_PLACEHOLDER_ID;
}

/**
 * Rút account id Cloudflare từ state URL staging theo `04` R22: endpoint
 * path-style `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (jurisdiction
 * thêm tiền tố nhãn đầu `eu.`/`fedramp.`/`us.`) nằm ở query parameter
 * `endpoint` của URL `s3://`. Program staging đọc qua đây để KHÔNG đòi thêm
 * biến môi trường nào cho identity account — state URL contract là nguồn sự
 * thật duy nhất cho cả backend lẫn provider Cloudflare.
 */
export function r2AccountIdFromStateUrl(stateUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(stateUrl);
  } catch {
    // intentional: lỗi gốc không actionable — message dưới mang nguyên
    // `stateUrl` đầu vào cho operator.
    throw new Error(`${stateUrl} is not a valid staging state URL`);
  }
  const endpoint = parsed.searchParams.get('endpoint');
  if (endpoint === null || endpoint.trim().length === 0) {
    throw new Error(
      `staging state URL ${stateUrl} carries no "endpoint" query parameter — ` +
        'cannot derive the Cloudflare account id for the provider',
    );
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error(`staging state URL endpoint "${endpoint}" is not a valid URL`);
  }
  const suffix = '.r2.cloudflarestorage.com';
  if (!endpointUrl.host.endsWith(suffix)) {
    throw new Error(
      `staging state URL endpoint "${endpoint}" is not an R2 path-style endpoint — ` +
        `expected a host ending in ${suffix} (04-platform-facts R22)`,
    );
  }
  // Nhãn cuối trước suffix là account id; các nhãn còn lại (nếu có) là tiền tố
  // jurisdiction của R22 — bỏ cả khối, không đoán ý nghĩa từng nhãn.
  const accountId = endpointUrl.host.slice(0, -suffix.length).split('.').at(-1) ?? '';
  if (accountId.length === 0) {
    throw new Error(
      `staging state URL endpoint "${endpoint}" carries no account id before ${suffix}`,
    );
  }
  return accountId;
}

/** Phase lifecycle mà engine này mở cho staging — KHÔNG có `down`/`destroy`. */
export type StagingPhase = 'preview' | 'up';

/** Library deps được inject để spec chạy không cần Pulumi thật. */
export interface StagingExecDeps {
  execFn: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ExecResult;
  /**
   * `pulumiRun` override cho spec (mock lane, không đụng Pulumi thật) — bỏ trống
   * thì dùng hàm thật của lib. Inject qua deps thay vì mock module để spec mock
   * được đường phase mà không phụ thuộc cơ chế mock module.
   */
  pulumiRunFn?: typeof pulumiRun;
  /** `deployProjectDir` override cho spec (trỏ evidence về tmpdir) — như trên. */
  projectDirFn?: (project: string) => string;
}

const defaultDeps: StagingExecDeps = { execFn: exec };

/**
 * Phân loại stack ref đầy đủ theo lane — nguyên thủy chung của mọi unit.
 *
 * `local-*` — lane local hiện hành (namespace worktree); `staging` — slot
 * staging continuous; `staging-candidate` — slot candidate, được nhận diện
 * RIÊNG để guard từ chối tường minh (tên tài nguyên slot `-cand` thuộc #381,
 * chạy chương trình continuous trên đó là collision tên account-unique); còn
 * lại — KHÔNG ĐƯỢC chạy (lane local khai Docker resource dùng config namespace,
 * chạy trên stack lạ là khai resource sai environment — hazard thật trước lane
 * guard, cùng hình #368).
 *
 * Unit không có lane local hoặc route candidate chung với staging bọc hàm này
 * ở thân mỏng per-unit với mapping riêng của nó.
 */
export function classifyDeployStackRef(
  rawStackRef: string,
): 'local' | 'staging' | 'staging-candidate' | 'unknown' {
  const slug = rawStackRef.slice(rawStackRef.lastIndexOf('/') + 1);
  if (slug.startsWith('local-')) return 'local';
  if (slug === 'staging') return 'staging';
  if (slug === 'staging-candidate') return 'staging-candidate';
  return 'unknown';
}

/** Env runtime đã resolve cho subprocess Pulumi của một lần chạy staging. */
export interface StagingRunEnv {
  /** URL backend R2 đã qua kiểm tra tổ hợp stack↔backend. */
  backendUrl: string;
  /** Env ĐẦY ĐỦ cho subprocess Pulumi (allowlist: khóa inventory + PATH/HOME). */
  env: NodeJS.ProcessEnv;
  /**
   * Selection do adapter cấp NGAY TRONG hàm này — `stackSelection` được gọi
   * đúng MỘT lần trên một lần chạy; caller dùng lại giá trị này, không gọi lại.
   */
  selection: StackSelection;
}

/**
 * Inventory credential fail-closed cho một lần chạy staging — 5 khóa giống
 * nhau ở mọi unit (các bản copy #350/#354/#355/#358/#359 đều đối chiếu tại
 * #543):
 *
 * Bắt buộc:
 * - `ECOMA_PULUMI_STATE_URL_STAGING` — backend state R2 (bootstrap một lần);
 * - `PULUMI_CONFIG_PASSPHRASE` — passphrase per-stack (GitHub Environment
 *   secret của stack khi chạy CI; operator export khi chạy tay);
 * - `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — token R2 scope một bucket
 *   (`04` R23): backend s3 đọc credential chain của AWS env ở MỌI lệnh;
 * - `CLOUDFLARE_API_TOKEN` — token Cloudflare quyền provision resource
 *   account (`04` R24): program staging khai resource Cloudflare nên provider
 *   được consult ở MỌI `preview`/`up`. Biến chỉ passthrough qua env của
 *   subprocess và KHÔNG BAO GIỜ được truyền vào provider config — Pulumi ghi
 *   provider config vào state, còn token phải đứng hoàn toàn ngoài state
 *   (§7.4.1); provider đọc thẳng biến môi trường khi config bỏ trống.
 *
 * Thiếu bất kỳ khóa nào → throw với danh sách ĐẦY ĐỦ khóa thiếu (không dừng ở
 * khóa đầu — operator phải sửa hết trong một lần, không lặp chuỗi chạy-thất-bại).
 */
export function resolveStagingRunEnv(
  project: string,
  source: NodeJS.ProcessEnv = process.env,
): StagingRunEnv {
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
        `an unset ${STAGING_STATE_URL_ENV_KEY} means the staging state backend is not bootstrapped yet ` +
        'and the run must not fall back to another backend',
    );
  }
  const backendUrl = source[STAGING_STATE_URL_ENV_KEY] as string;
  // Adapter tự validate tổ hợp stack↔backend (staging chỉ đi với s3:// R2 đủ
  // endpoint/region/s3ForcePathStyle) — sai tổ hợp là từ chối ngay đây.
  // Selection được trả về cho caller DÙNG LẠI, không gọi adapter lần hai (OCR
  // round 2).
  const selection = stagingDeploymentAdapter.stackSelection(project, {
    slot: STAGING_SLOT,
    backendUrl,
  });
  // Least privilege: env của subprocess Pulumi là ALLOWLIST tường minh — đúng
  // các khóa inventory phía trên + PATH/HOME (pulumi/git cần để chạy); không
  // passthrough toàn bộ process.env — credential khác trong môi trường operator
  // không được rò sang metadata của subprocess (cùng pattern với #551). Hệ quả:
  // file-passphrase variant (`PULUMI_CONFIG_PASSPHRASE_FILE`) cũng không bao giờ
  // lọt vào env này — env là nguồn passphrase duy nhất của lane staging
  // (per-stack secret), để biến còn sót là CLI đổi thứ tự ưu tiên im lặng.
  // OCR round 5: `source` là tham số — caller truyền env thiếu PATH/HOME là
  // spawn chết ENOENT khó chẩn đoán; fallback về process.env giữ path của
  // chính lane (không rò khóa nào khác) và đúng triết lý fail-closed.
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? process.env.PATH,
    HOME: source.HOME ?? process.env.HOME,
    [STAGING_STATE_URL_ENV_KEY]: source[STAGING_STATE_URL_ENV_KEY],
    AWS_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY,
    CLOUDFLARE_API_TOKEN: source.CLOUDFLARE_API_TOKEN,
    PULUMI_BACKEND_URL: backendUrl,
    PULUMI_SKIP_UPDATE_CHECK: '1',
    PULUMI_CONFIG_PASSPHRASE: source.PULUMI_CONFIG_PASSPHRASE as string,
  };
  return { backendUrl, env, selection };
}

/**
 * `stack init` stack staging của project; đã có thì `stack select`.
 *
 * Đối xứng `ensureStack` của lane local TRỪ bước `mkdir`: backend s3 không đòi
 * thư mục local, và tạo thư mục state local trong một lần chạy staging là
 * mutation sai lane. `stack init` exit 0 khi vừa tạo; exit != 0 khi đã có
 * (hoặc lỗi thật) — stderr của `init` phải mang "already exists" mới được
 * fallback sang `stack select` (OCR round 3: lỗi mạng/backend/credential của
 * `init` không được che bằng một lần `select` thành công trùng tên stack); khi
 * `select` cũng thất bại, stderr của CẢ HAI lệnh vào cùng một lỗi.
 */
export function ensureStagingStack(
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = defaultDeps,
): void {
  const init = deps.execFn('pulumi', ['stack', 'init', selection.stackName], projectDir, env);
  if (init.status !== 0) {
    // OCR round 4: stderr tuân thủ kiểu luôn là string (ExecResult), nhưng
    // guard tường minh chặn ép kiểu "undefined" vào regex — lỗi ném ra mang
    // nguyên giá trị thô thay vì chuỗi "undefined" gây nhiễu chẩn đoán.
    const initAlreadyExists =
      typeof init.stderr === 'string' && /already exists/iu.test(init.stderr);
    if (!initAlreadyExists) {
      throw new Error(
        `pulumi stack init ${selection.stackName} failed:\n${
          typeof init.stderr === 'string' ? init.stderr : String(init.stderr)
        }`,
      );
    }
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

// oxlint-disable no-console -- parse-fail của evidence phải báo VỚI operator
// (OCR round 3: format Pulumi CLI đổi là provenance lặng lẽ degrade); hàm thuần
// nên chỉ warn, không throw — record vẫn ghi thiếu phần này thay vì run chết.

/**
 * Parse summary resourceChanges từ stdout `--json`.
 *
 * Defensive: CLI đổi shape hoặc in thêm dòng nào đó → `undefined` (record ghi
 * thiếu phần này, KHÔNG chết) — evidence không được biến parse-fail thành run
 * fail, và cũng không được bịa số 0. Lần parse-fail được warn ra stderr để
 * khoảng trống provenance nhìn thấy được, không âm thầm.
 */
const warnResourceChangesUnparseable = (): void => {
  console.warn(
    '[staging-run] evidence resourceChanges could not be parsed from the Pulumi --json output — the record will omit them (provenance gap, not a run failure)',
  );
};

export function parseResourceChanges(stdout: string): StagingResourceChanges | undefined {
  // OCR round 5: dòng progress/log trước JSON có thể chứa `{` — thử từng vị
  // trí `{` và lấy vị trí ĐẦU TIÊN parse được thành JSON, thay vì parse từ vị
  // trí đầu tiên và mất resourceChanges khi chuỗi đó chưa phải JSON thật.
  let parsed: unknown;
  let parseFailed = true;
  let start = stdout.indexOf('{');
  while (start >= 0 && parseFailed) {
    try {
      parsed = JSON.parse(stdout.slice(start));
      parseFailed = false;
    } catch {
      start = stdout.indexOf('{', start + 1);
    }
  }
  if (parseFailed) {
    warnResourceChangesUnparseable();
    return undefined;
  }
  const summary = (parsed as { summary?: { resourceChanges?: unknown } }).summary;
  const changes = summary?.resourceChanges;
  if (typeof changes !== 'object' || changes === null) {
    warnResourceChangesUnparseable();
    return undefined;
  }
  const out: StagingResourceChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (typeof value === 'number') out[key] = value;
  }
  if (Object.keys(out).length === 0) {
    warnResourceChangesUnparseable();
    return undefined;
  }
  return out;
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

/**
 * Id tài nguyên từ một stack output — nguồn ĐỊNH DANH cho wiring wrangler.jsonc
 * của unit (§9.1: id do Pulumi cung cấp, Wrangler không tự tạo resource). Tên
 * output là tham số (`hyperdriveConfigId`, `mailDatabaseId`,
 * `<target>HyperdriveConfigId`, …). Chỉ đọc SAU một lần `up` thành công (trước
 * đó output chưa tồn tại là lỗi dùng-lệnh, không phải dữ liệu). Đọc lỗi/parse
 * lỗi/id không qua kiểm `isProvisionedResourceId` (placeholder toàn-zeros) →
 * `undefined`: evidence không bịa id, entry in cảnh báo wiring thay vì chặn
 * một lần provision đã thành công.
 */
export function readStackOutputId(
  outputName: string,
  projectDir: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  deps: StagingExecDeps = defaultDeps,
): string | undefined {
  const output = deps.execFn(
    'pulumi',
    ['stack', 'output', outputName, '--stack', selection.fullStackRef],
    projectDir,
    env,
  );
  if (output.status !== 0) return undefined;
  const id = output.stdout.trim();
  return isProvisionedResourceId(id) ? id : undefined;
}

/** SHA của workspace HEAD tại thời điểm chạy — revision của PROGRAM được apply. */
export function readGitHeadSha(
  cwd: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: StagingExecDeps = defaultDeps,
): string | undefined {
  // Least privilege (§6/§7.4.1): `git rev-parse` không cần credential nào —
  // truyền env tối thiểu từ NGUỒN ĐƯỢC TRUYỀN vào (không đọc process.env trực
  // tiếp: unit test với sourceEnv mock phải bất định, và không passthrough toàn
  // bộ env — passphrase/token chỉ được đi đúng đường env của process Pulumi,
  // không rò sang subprocess metadata).
  // OCR round 5: fallback process.env — sourceEnv là tham số, thiếu PATH/HOME
  // thì git chết khó chẩn đoán thay vì degrade về `gitSha: null` rõ ràng.
  const result = deps.execFn('git', ['rev-parse', 'HEAD'], cwd, {
    PATH: sourceEnv.PATH ?? process.env.PATH,
    HOME: sourceEnv.HOME ?? process.env.HOME,
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
 * timestamp + phase nên chạy lại KHÔNG BAO GIỜ ghi đè record cũ; hậu tố suffix
 * phân biệt hai lần chạy cùng mili-giây với cùng phase/outcome: đếm số file
 * tồn tại với cùng tiền tố — stateless (không có state module dùng chung giữa
 * các test) và không có wraparound (hợp đồng append-only không ngoại lệ —
 * đồng bộ pattern #551).
 */
export function appendStagingRecord(projectDir: string, record: StagingProvisioningRecord): string {
  const dir = join(projectDir, '.staging-evidence');
  mkdirSync(dir, { recursive: true });
  const prefix = `${record.startedAt.replace(/[:.]/gu, '-')}-${record.phase}-${record.outcome}`;
  const suffix = String(readdirSync(dir).filter((f) => f.startsWith(prefix)).length).padStart(
    4,
    '0',
  );
  const file = join(dir, `${prefix}-${suffix}.json`);
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
 * nguyên vẹn. `pulumiRun` reuse: tự ghép `--stack <fullRef>` và xử lý lỗi
 * spawn/exit đúng cơ chế chung; `prepareStack` để false vì `ensureStack` của
 * local có `mkdir` file:// — stack staging được chuẩn bị bởi
 * `ensureStagingStack` ở trên.
 *
 * Trả kèm `selection` + `env` + `projectDir` đã resolve: entry (staging.ts)
 * dùng lại đúng inventory + selection của lần phase vừa chạy cho bước đọc
 * output id sau `up` — `resolveStagingRunEnv` chạy ĐÚNG MỘT lần, không gọi lại
 * ở entry (OCR round 2).
 */
export function runStagingPhase(
  phase: StagingPhase,
  project: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: StagingExecDeps = defaultDeps,
): {
  record: StagingProvisioningRecord;
  recordPath: string;
  env: NodeJS.ProcessEnv;
  selection: StackSelection;
  /** projectDir đã resolve — caller tái dùng, KHÔNG gọi deployProjectDir lần hai. */
  projectDir: string;
} {
  const projectDir = (deps.projectDirFn ?? deployProjectDir)(project);
  // Inventory credential TRƯỚC: thiếu khóa là fail-closed với danh sách ĐẦY ĐỦ
  // khóa thiếu, trước mọi lời gọi adapter (lần gọi đầu từng đứng trước để sau
  // đó adapter tự fallback đọc env khi `backendUrl` undefined — đường lỗi kép
  // đã được OCR chỉ ra). Selection lấy từ `resolveStagingRunEnv` — adapter
  // được gọi đúng MỘT lần trên một lần chạy.
  const { backendUrl, env, selection } = resolveStagingRunEnv(project, sourceEnv);
  const startedAt = new Date().toISOString();
  const gitSha = readGitHeadSha(projectDir, sourceEnv, deps);
  ensureStagingStack(projectDir, selection, env, deps);
  const ctx = {
    worktreeRoot: projectDir,
    // Staging là shared lane, không namespace worktree — `pulumiRun` chỉ đọc
    // `stackName`/`stateUrl` của ctx (`fullStackRef` không đụng `namespace`),
    // chuỗi rỗng là placeholder vô hình, không phải giá trị bị mất.
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
    env,
    selection,
    projectDir,
  };
  try {
    const stdout = (deps.pulumiRunFn ?? pulumiRun)(projectDir, project, phaseArgs, ctx, env) ?? '';
    outcome.record.resourceChanges = parseResourceChanges(stdout) ?? null;
    outcome.record.revision = readStagingRevision(projectDir, selection, env, deps) ?? null;
    outcome.record.outcome = 'succeeded';
  } catch (error) {
    outcome.record.outcome = 'failed';
    outcome.record.finishedAt = new Date().toISOString();
    // Ghi evidence trong try riêng: lỗi filesystem không được THAY lỗi Pulumi
    // gốc (operator cần nguyên nhân thật), cũng như không được nuốt lỗi thật.
    let path: string | undefined;
    try {
      path = appendStagingRecord(projectDir, outcome.record);
    } catch (recordError) {
      // `cause` giữ nguyên lỗi Pulumi gốc (ES2022): caller cần phân loại theo
      // lỗi gốc vẫn unwrap được; message gộp CẢ HAI nguyên nhân cho operator.
      throw Object.assign(
        new Error(
          `staging ${phase} failed on ${outcome.record.stackRef}: ${error instanceof Error ? error.message : String(error)} ` +
            `(evidence write failed: ${recordError instanceof Error ? recordError.message : String(recordError)})`,
          { cause: error },
        ),
        { recordPath: undefined },
      );
    }
    throw Object.assign(
      new Error(
        `staging ${phase} failed on ${outcome.record.stackRef}: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { recordPath: path },
    );
  }
  outcome.record.finishedAt = new Date().toISOString();
  // Pulumi đã THÀNH CÔNG — lỗi filesystem ở đây không được biến một lần
  // provision xanh thành throw; evidence bị thiếu là tổn hao provenance, được
  // báo qua recordPath rỗng (entry CLI in cảnh báo, không fake đường file).
  try {
    outcome.recordPath = appendStagingRecord(projectDir, outcome.record);
  } catch {
    outcome.recordPath = '';
  }
  return outcome;
}

/**
 * Đường evidence của một lần chạy thất bại — lỗi `runStagingPhase` ném mang
 * `recordPath` (file append-only đã ghi trước khi throw); entry CLI đọc qua
 * đây để in đường cho operator. Lỗi khác (inventory thiếu, usage) không mang
 * evidence → `undefined` (pattern #551).
 */
export function stagingEvidencePath(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('recordPath' in error)) return undefined;
  const path = (error as { recordPath?: unknown }).recordPath;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
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

/**
 * Bước wiring sau một lần `up` xanh — TRẢ EXIT CODE cho entry: id đọc được →
 * in hướng dẫn fill và 0; id không đọc được (stack output thiếu, đọc lỗi, hoặc
 * placeholder toàn-zeros) → in lỗi tường minh nêu đúng target id thiếu
 * (`hyperdriveConfigId`) và wiring step bị chặn, rồi 1. Một `up` thành công
 * PHẢI sinh id thật — exit 0 im lặng sẽ giấu wiring debt khỏi operator (#350);
 * đọc id bằng đúng `selection` + `env` của lần phase vừa chạy nên không resolve
 * lại inventory. Binding name và đường wrangler.jsonc là tham số per-unit
 * (chỉ hai unit remote-cache dùng hàm này — #350/#357).
 */

// oxlint-disable no-console -- báo cáo operator của entry staging chạy qua hàm
// này để spec unit-test được; console là kênh duy nhất như `staging.ts`.

export function stagingHyperdriveWiringExit(
  project: string,
  selection: StackSelection,
  env: NodeJS.ProcessEnv,
  wiring: { binding: string; wranglerPath: string },
  deps: StagingExecDeps = defaultDeps,
): number {
  // Cùng đường resolve projectDir với `runStagingPhase` — mock `projectDirFn`
  // trong test phải có hiệu lực ở bước wiring, không chỉ lúc provision.
  const projectDir = (deps.projectDirFn ?? deployProjectDir)(project);
  const hyperdriveConfigId = readStackOutputId(
    'hyperdriveConfigId',
    projectDir,
    selection,
    env,
    deps,
  );
  if (hyperdriveConfigId === undefined) {
    console.error(
      `[${project}] staging up OK but the hyperdrive config id is MISSING — stack output ` +
        '`hyperdriveConfigId` (the target id this lane provisions for HyperdriveConfig) was absent, ' +
        'unreadable, or placeholder-shaped. A successful up MUST produce a real id: the wiring step it ' +
        'feeds — filling `env.staging.hyperdrive[0].id` in the unit wrangler.jsonc — is BLOCKED until the ' +
        'stack output carries a real id. Inspect the stack and re-run `pulumi stack output ' +
        'hyperdriveConfigId` manually; refusing to exit 0 so the wiring debt is not silently missed (#350)',
    );
    return 1;
  }
  console.log(
    `[${project}] hyperdrive config id: ${hyperdriveConfigId} — wiring step: fill it as ` +
      `\`env.staging.hyperdrive[0].id\` (binding ${wiring.binding}) in ${wiring.wranglerPath}; ` +
      'never a placeholder (review guard refuses all-zeros/empty ids) (#350)',
  );
  return 0;
}

/**
 * Origin Hyperdrive đã resolve — hình dạng cấu trúc khớp
 * `HyperdriveConfigOriginArgs` của `@pulumi/cloudflare` (v6: `database`,
 * `host`, `password`, `port`, `scheme`, `user`) mà KHÔNG import provider vào
 * engine (engine thuần, chỉ cần structural typing).
 */
export interface StagingHyperdriveOrigin {
  host: string;
  port: number;
  database: string;
  user: string;
  scheme: string;
  password: Input<string>;
}

/** Đầu vào resolve origin — giá trị thô đọc từ stack config của program. */
export interface StagingHyperdriveOriginConfig {
  originHost: string | undefined;
  originPort: string | undefined;
  originPassword: Input<string> | undefined;
}

/**
 * Resolve origin của HyperdriveConfig từ stack config — FAIL CLOSED khi
 * origin chưa tồn tại: đường tới origin private là Tunnel/VPC Service của
 * #349, chưa provision lần nào, nên thiếu `namespace:originHost` hoặc
 * `namespace:originPassword` là trạng thái ĐÚNG của hiện tại và phải dừng với
 * lỗi nêu rõ #349 — tuyệt đối không bịa hostname, không trỏ origin local,
 * không đặt placeholder (placeholder origin = config staging trỏ nhầm origin).
 * Database và role runtime là tham số per-unit — Hyperdrive kết nối origin
 * bằng role runtime, KHÔNG bao giờ bằng migrator/owner (§4.2: cặp role
 * `_migrator`/`_runtime`; serving path dùng đúng role hẹp của nó).
 *
 * `originPort` thiếu là default 5432 (HD của Cloudflare: default Postgres);
 * giá trị present mà không parse được thành port hợp lệ là lỗi cấu hình
 * fail-closed, không đoán. Password giữ nguyên `Input` — program bọc
 * `conf.getSecret` nên giá trị KHÔNG BAO GIỜ nằm plaintext trong state/log.
 */
export function resolveStagingHyperdriveOrigin(
  config: StagingHyperdriveOriginConfig,
  database: string,
  user: string,
  project: string,
): StagingHyperdriveOrigin {
  const missing: string[] = [];
  if (config.originHost === undefined || config.originHost.trim().length === 0) {
    missing.push(`namespace:${STAGING_ORIGIN_HOST_CONFIG_KEY}`);
  }
  // Password cùng đường fail-closed với host: rỗng/toàn-trắng counted thiếu.
  // Output của `conf.getSecret` không phải string — chỉ trim-kiểm khi là string
  // (pattern #549). Ranh giới đã biết: password rỗng bọc trong Output KHÔNG
  // được kiểm ở lúc đánh giá chương trình (kiểm đồng bộ chỉ thấy `object`);
  // giá trị đó fail sau, tại lúc provision khi Hyperdrive không kết nối được
  // origin — không đường nào cho nó vào config "thành công" âm thầm.
  if (
    config.originPassword === undefined ||
    (typeof config.originPassword === 'string' && config.originPassword.trim().length === 0)
  ) {
    missing.push(`namespace:${STAGING_ORIGIN_PASSWORD_CONFIG_KEY}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `staging hyperdrive origin is not configured: missing stack config ${missing.join(', ')} — ` +
        `set them on the ${project} staging stack before running this program. The private route ` +
        `to the staging PostgreSQL origin (Cloudflare Tunnel / Workers VPC Service) is issue #349 ` +
        `and is not provisioned yet; refusing to guess or fake an origin`,
    );
  }
  const port = config.originPort?.trim();
  const resolvedPort = port === undefined || port.length === 0 ? 5432 : Number(port);
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    throw new Error(
      `staging hyperdrive origin port "${config.originPort}" is not a valid TCP port — ` +
        `fix namespace:${STAGING_ORIGIN_PORT_CONFIG_KEY} on the ${project} staging stack`,
    );
  }
  return {
    host: config.originHost as string,
    port: resolvedPort,
    database,
    user,
    // 'postgres' — scheme enum của Cloudflare Hyperdrive cho Postgres; TLS tới
    // origin bắt buộc theo HD2 (sslmode default `require`, không hỗ trợ none).
    scheme: 'postgres',
    password: config.originPassword as Input<string>,
  };
}
