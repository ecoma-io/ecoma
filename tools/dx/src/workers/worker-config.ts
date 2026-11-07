/**
 * Sinh cấu hình Wrangler runtime theo worktree và cô lập binding state local.
 *
 * PR3: committed `wrangler.jsonc` là NGUỒN SỰ THẬT của binding definitions.
 * Module này đọc config committed, kiểm fail-closed (không remote, không touch
 * tài nguyên remote), rồi sinh ra một config runtime disposable trong
 * `<worktreeRoot>/.worker-local-state/generated/` với:
 *
 * - `migrations_dir` tuyệt đối (để `wrangler d1 migrations apply --local` chạy
 *   đúng dù cwd khác nơi chứa config committed).
 * - persist dir theo worktree (`workerProcessStateDir` / `WORKER_STATE_DIR_NAME`)
 *   để hai worktree không dùng chung D1/Queue state.
 * - port dev xác định theo (namespace, worker name) để tránh đụng port giữa
 *   các worktree.
 *
 * Config sinh ra là disposable: xoá được an toàn, sinh lại là idempotent. Không
 * bao giờ truyền `--remote` và không bao giờ resolve binding tới tài nguyên
 * remote — mọi `remote: true` trong config committed đều bị từ chối.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { normalizeWorktreeRoot, worktreeNamespace } from '@ecoma-io/deployment';
import { workerProcessStateDir } from './worker-process.js';
import { ROOT_DIR } from '../utils.js';

/** Thư mục con chứa config runtime sinh ra, nằm trong state dir của worktree. */
export const GENERATED_CONFIG_DIR_NAME = 'generated';

/** Đường dẫn thư mục chứa config runtime sinh ra của một worktree. */
export function generatedConfigDir(worktreeRoot: string): string {
  return join(workerProcessStateDir(worktreeRoot), GENERATED_CONFIG_DIR_NAME);
}

/** Persist dir theo worktree — dùng chung cho mọi process Worker của worktree đó. */
export function persistToDir(worktreeRoot: string): string {
  return workerProcessStateDir(worktreeRoot);
}

/** D1 database entry trong committed wrangler config (subset dùng cho local). */
export interface WranglerD1Database {
  binding: string;
  database_name: string;
  database_id?: string;
  preview_database_id?: string;
  migrations_table?: string;
  migrations_dir?: string;
  migrations_pattern?: string;
  database_internal_env?: string;
  remote?: boolean;
  [key: string]: unknown;
}

/** Shape tối thiểu của committed wrangler config mà PR3 quan tâm. */
export interface CommittedWranglerConfig {
  $schema?: string;
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  account_id?: string;
  workers_dev?: boolean;
  observability?: Record<string, unknown>;
  d1_databases?: WranglerD1Database[];
  queues?: Record<string, unknown>;
  services?: Array<Record<string, unknown>>;
  vars?: Record<string, unknown>;
  triggers?: Record<string, unknown>;
  dev?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadedCommittedConfig {
  config: CommittedWranglerConfig;
  configPath: string;
  configDir: string;
}

export interface GenerateWorkerConfigOptions {
  /** Worktree root (tuyệt đối hoặc tương đối) — sẽ được normalize. */
  worktreeRoot: string;
  /** Đường dẫn tới committed wrangler.jsonc (nguồn sự thật). */
  committedConfigPath: string;
  /** Tên Worker dùng cho tên file sinh ra và port. Mặc định lấy từ config.name. */
  workerName?: string;
  /** Port dev tường minh. Nếu không truyền, tự phân bổ theo namespace. */
  port?: number;
  /**
   * Remote mode — PHẢI là false/undefined. Truyền true để báo lỗi rõ ràng
   * (fail-closed): PR3 không bao giờ chạy remote.
   */
  remote?: boolean;
}

export interface GeneratedWorkerConfigResult {
  worktreeRoot: string;
  namespace: string;
  persistTo: string;
  configPath: string;
  config: CommittedWranglerConfig;
}

export interface ApplyLocalSeedsOptions {
  /** Đường dẫn committed/generated config dùng làm --config. */
  configPath: string;
  /**
   * Tên D1 database cần execute — sẽ được đối chiếu với `d1_databases` của
   * config (khớp `binding` hay `database_name`; identifier lệch chuẩn bị từ
   * chối trước khi ghép argv của wrangler).
   */
  databaseName: string;
  /** Persist dir theo worktree (nên absolute — được resolve trước khi dùng). */
  persistTo: string;
  /** Danh sách file seed (.sql) áp dụng theo thứ tự. Rỗng → fail-loud. */
  seedFiles: string[];
  /** Remote mode — PHẢI là false/undefined, truyền true để báo lỗi. */
  remote?: boolean;
  /** Đường dẫn wrangler CLI (mặc định node_modules/wrangler/bin/wrangler.js). */
  wranglerBin?: string;
  /** cwd cho subprocess wrangler. */
  cwd?: string;
}

export interface ApplyLocalMigrationsOptions {
  configPath: string;
  /** Đối chiếu với d1_databases của config trước khi gọi wrangler. */
  databaseName: string;
  /** Nên absolute — được resolve trước khi dùng. */
  persistTo: string;
  remote?: boolean;
  wranglerBin?: string;
  cwd?: string;
}

// ---------- JSONC parser (không phụ thuộc dependency mới) ----------

/**
 * Bỏ comment (`//`, `/* *\/`) và dấu phẩy thừa trước `}`/`]` trong JSONC,
 * tôn trọng chuỗi. Trả về chuỗi JSON hợp lệ.
 */
export function stripJsonc(text: string): string {
  return stripJsoncTracked(text).output;
}

interface StripJsoncResult {
  output: string;
  /** Trạng thái parser Kag cuối cùng — 'normal' là duy nhất hợp lệ ở EOF. */
  finalState: Exclude<ParserState, 'normal'> | null;
}

type ParserState = 'normal' | 'string' | 'lineComment' | 'blockComment';

function stripJsoncTracked(text: string): StripJsoncResult {
  let out = '';
  let i = 0;
  const n = text.length;
  let state: ParserState = 'normal';
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : '';
    if (state === 'normal') {
      if (ch === '"') {
        out += ch;
        state = 'string';
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        state = 'lineComment';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'blockComment';
        i += 2;
        continue;
      }
      if (ch === ',') {
        // trailing comma: bỏ qua nếu ký tự có nghĩa tiếp theo là } hoặc ].
        // "Có nghĩa" loại trừ whitespace VÀ comment (comment bị xoá, không thực
        // sự tồn tại trong output) — stdout trước đây chỉ quét whitespace nên
        // `1, // comment\n}` bị giữ dấu phẩy → JSON.parse fail (OCR high
        // finding, repro thật trên `apps/account/wrangler.jsonc`).
        const j = skipMeaningless(text, i + 1);
        if (j < n && (text[j] === '}' || text[j] === ']')) {
          i += 1;
          continue;
        }
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'string') {
      out += ch;
      if (ch === '\\') {
        // escape: copy ký tự tiếp theo nguyên vẹn
        if (i + 1 < n) {
          out += text[i + 1];
          i += 2;
          continue;
        }
      }
      if (ch === '"') {
        state = 'normal';
      }
      i += 1;
      continue;
    }
    if (state === 'lineComment') {
      if (ch === '\n') {
        out += '\n';
        state = 'normal';
      }
      i += 1;
      continue;
    }
    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
  }
  return {
    output: out,
    // 'normal' là duy nhất kết thúc hợp lệ; các state khác báo qua finalState
    // để `parseJsonc` fail-loud theo loại lỗi (block comment / chuỗi chưa
    // đóng) thay vì throw mô hồ "không parse được JSONC".
    finalState: state === 'normal' ? null : (state as Exclude<ParserState, 'normal'>),
  };
}

/**
 * Index ký tự có nghĩa đầu tiên bắt đầu từ `start`: bỏ whitespace và toàn bộ
 * comment (line + block). Trả về `n` khi không còn ký tự có nghĩa (EOF).
 * Dùng để quyết định trailing comma — comment bị strip không phạm `}`/`]`.
 */
function skipMeaningless(text: string, start: number): number {
  let j = start;
  while (j < text.length) {
    const ch = text[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      j += 1;
      continue;
    }
    if (ch === '/' && j + 1 < text.length) {
      const kind = text[j + 1];
      if (kind === '/') {
        const stop = text.indexOf('\n', j + 2);
        j = stop === -1 ? text.length : stop + 1;
        continue;
      }
      if (kind === '*') {
        const stop = text.indexOf('*/', j + 2);
        j = stop === -1 ? text.length : stop + 2;
        continue;
      }
    }
    return j;
  }
  return j;
}

/** Parse JSONC (có comment + trailing comma) thành giá trị JS. Fail-closed khi parse lỗi. */
export function parseJsonc(text: string): unknown {
  const { output, finalState } = stripJsoncTracked(text);
  // Fail-loud theo loại lỗi thay vì throw mô hồ "không parse được JSONC":
  // block comment/chuỗi không đóng nuốt toàn bộ phần còn lại của file, author
  // committed config cần biết reachable lỗi ở đâu.
  if (finalState === 'blockComment') {
    throw new Error('JSONC has a block comment that is unterminated — check the committed config');
  }
  if (finalState === 'string') {
    throw new Error('JSONC has a string that is unterminated — check the committed config');
  }
  // 'lineComment' ở EOF là bình thường (// comment cuối file), không phải lỗi.
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`failed to parse JSONC: ${(error as Error).message}`, { cause: error });
  }
}

// ---------- Validation fail-closed ----------

/**
 * Pattern một resource identifier hợp lệ cho runtime local — identifier của D1
 * database/queue/service binding phải là tên thuần. Chặn flag smuggling (OCR
 * security finding): `--remote` hay bất kỳ token `--...` nào trượt qua
 * positional arg của wrangler (yargs parse flag ở mọi vị trí) sẽ đổi lệnh
 * `d1 execute --local` thành đường remote thật.
 */
const RESOURCE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** Validate một identifier dùng làm positional arg của wrangler CLI. */
export function validateDatabaseIdentifier(value: string): string {
  if (!RESOURCE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `invalid database identifier: '${value}' — only [A-Za-z][A-Za-z0-9_-]* is accepted ` +
        '(yargs parses --flag tokens anywhere, so a malformed identifier is flag smuggling)',
    );
  }
  return value;
}

/**
 * Container resource dùng `id` làm provisioning identifier thật — chỉ bên
 * trong các key này thì `id` của committed config phải bị chặn (OCR PR #36
 * security·medium: chặn mọi key `id` ở mọi độ sâu là false-positive — một
 * `vars.id` hay `metadata.id` của config local hợp lệ bị reject oan).
 */
const REMOTE_ID_CONTAINER_KEYS = new Set(['hyperdrive', 'kv_namespaces', 'r2_buckets']);

const REMOTE_IDENTIFIER_KEYS = new Set(['database_id', 'preview_database_id']);

function assertNoRemoteTrue(value: unknown, path: string, containerKey?: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRemoteTrue(item, `${path}[${index}]`, containerKey));
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    // Chặn cả boolean-like string `remote: "true"` lọt qua vars (OCR finding:
    // boolean-check thuần để hở path này) — normalize lowercase + trim trước
    // khi so, vì "TRUE"/" True " vẫn truthy theo mọi parser.
    const truthyRemoteString = typeof val === 'string' && val.trim().toLowerCase() === 'true';
    if (key === 'remote' && (val === true || val === 'true' || truthyRemoteString)) {
      throw new Error(
        `wrangler config contains 'remote: ${String(val)}' at ${childPath} — PR3 does not allow remote mode`,
      );
    }
    // `id` chỉ chặn trong container resource; `database_id`/`preview_database_id`
    // chặn mọi nơi. `services[].service` cố ý KHÔNG chặn: là tên Worker cùng
    // topology local (spike §2 — Service Binding kết nối Worker local theo
    // tên), chặn sẽ reject chính config của `transactional-mailer-job`.
    const idBlocked = containerKey !== undefined && REMOTE_ID_CONTAINER_KEYS.has(containerKey);
    if (
      (REMOTE_IDENTIFIER_KEYS.has(key) || (key === 'id' && idBlocked)) &&
      typeof val === 'string' &&
      val.trim().length > 0
    ) {
      throw new Error(
        `wrangler config contains a remote resource identifier '${key}: ${val}' at ${childPath} — ` +
          'the local runtime must not resolve to remote resources',
      );
    }
    assertNoRemoteTrue(val, childPath, key);
  }
}

export function validateCommittedWranglerConfig(config: unknown): CommittedWranglerConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('wrangler config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.name !== 'string' || c.name.trim().length === 0) {
    throw new Error("wrangler config is missing 'name' (non-empty string)");
  }
  if (typeof c.main !== 'string' || c.main.trim().length === 0) {
    throw new Error("wrangler config is missing 'main' (non-empty string)");
  }
  if (typeof c.compatibility_date !== 'string' || c.compatibility_date.trim().length === 0) {
    throw new Error("wrangler config is missing 'compatibility_date' (non-empty string)");
  }
  assertNoRemoteTrue(config, '');
  // account_id không được dùng trong local runtime — tránh resolve tới account thật.
  if (typeof c.account_id === 'string' && c.account_id.trim().length > 0) {
    throw new Error(
      "wrangler config declares 'account_id' — the local runtime must not resolve to a real account",
    );
  }
  return c as CommittedWranglerConfig;
}

export function loadCommittedWranglerConfig(configPath: string): LoadedCommittedConfig {
  const absolute = resolve(configPath);
  if (!existsSync(absolute)) {
    throw new Error(`committed wrangler config does not exist: ${absolute}`);
  }
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the committed wrangler config: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = parseJsonc(raw);
  const config = validateCommittedWranglerConfig(parsed);
  return { config, configPath: absolute, configDir: dirname(absolute) };
}

// ---------- Port phân bổ ----------

/** Port dev xác định theo (namespace, worker name) — tránh đụng giữa worktree. */
export function allocateWorkerPort(namespace: string, workerName: string): number {
  const input = `${namespace}\u0000${workerName}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  // range 10000..59999, tránh port privileged và hay dùng.
  return 10000 + (hash % 50000);
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'worker';
}

/** Xuất cho status của orchestration đoán tên file generated config chính xác. */
export { sanitizeFileName };

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

// ---------- Sinh config runtime ----------

export function generateWorkerConfig(
  options: GenerateWorkerConfigOptions,
): GeneratedWorkerConfigResult {
  if (options.remote === true) {
    throw new Error('generateWorkerConfig: remote mode is not allowed (PR3 fail-closed)');
  }
  const normalizedRoot = normalizeWorktreeRoot(options.worktreeRoot);
  const namespace = worktreeNamespace(normalizedRoot);
  const loaded = loadCommittedWranglerConfig(options.committedConfigPath);
  const { config: committed, configDir } = loaded;

  const generated = deepClone(committed);

  // Wrangler resolve mọi path tương đối theo THƯ MỤC CHỨA config file, không
  // phải cwd — generated config nằm ở `<root>/.worker-local-state/generated/`,
  // khác configDir của committed config, nên mọi path trỏ về repo (hiện tại
  // là `main`) phải tuyệt đối hoá bằng configDir, cùng cơ chế với
  // migrations_dir bên dưới. OCR high finding (cả hai run chốt cùng lý do).
  if (
    typeof generated.main === 'string' &&
    generated.main.trim().length > 0 &&
    !isAbsolute(generated.main)
  ) {
    generated.main = resolve(configDir, generated.main);
  }

  // migrations_dir tuyệt đối cho mọi D1 binding, và absolutize mọi path
  // tương đối khác mà committed configs trong repo khai ($schema trỏ
  // node_modules, assets.directory trỏ output build) — Wrangler resolve mọi
  // path theo thư mục chứa config file, generated config nằm chỗ khác nên
  // path tương đối sinh lại trỏ sai (OCR medium finding).
  if (Array.isArray(generated.d1_databases)) {
    for (const entry of generated.d1_databases) {
      if (entry && typeof entry === 'object') {
        const db = entry as WranglerD1Database;
        const source =
          typeof db.migrations_dir === 'string' && db.migrations_dir.trim().length > 0
            ? db.migrations_dir
            : 'migrations';
        db.migrations_dir = resolve(configDir, source);
      }
    }
  }
  if (
    generated.assets !== null &&
    typeof generated.assets === 'object' &&
    !Array.isArray(generated.assets) &&
    typeof (generated.assets as { directory?: unknown }).directory === 'string' &&
    ((generated.assets as { directory?: unknown }).directory as string).trim().length > 0 &&
    !isAbsolute((generated.assets as { directory: string }).directory)
  ) {
    const assets = generated.assets as { directory: string };
    assets.directory = resolve(configDir, assets.directory);
  }
  if (
    typeof generated.$schema === 'string' &&
    generated.$schema.trim().length > 0 &&
    !isAbsolute(generated.$schema)
  ) {
    // $schema trước đây là path tương đối `../../node_modules/wrangler/...`
    // theo configDir committed — giữ đúng đích nhưng absolutize (file generated
    // ở thư mục khác mà path tương đối sẽ trỏ node_modules sai cấp).
    generated.$schema = resolve(configDir, generated.$schema);
  }

  // Port dev theo worktree để tránh đụng port giữa các worktree, và validate
  // fail-closed ngay lúc sinh config thay vì để `wrangler dev` fail sau với
  // lỗi mơ hồ (OCR medium finding: NaN become null sau JSON.stringify, port
  // <= 0 hay > 65535 hay port privileged được ghi thẳng). >= 1024: tránh
  // privileged range; dev port KHÔNG dùng 0 (ephemeral ngẫu nhiên, mất tính
  // lặp lại được của per-namespace allocation).
  if (options.port !== undefined) {
    const requested = options.port;
    if (!Number.isInteger(requested) || requested < 1024 || requested > 65535) {
      throw new Error(
        `generateWorkerConfig: invalid port: ${String(requested)} — must be an integer in [1024, 65535]`,
      );
    }
  }
  const workerName = options.workerName ?? generated.name;
  const port = options.port ?? allocateWorkerPort(namespace, workerName);
  const existingDev =
    generated.dev && typeof generated.dev === 'object' && !Array.isArray(generated.dev)
      ? (generated.dev as Record<string, unknown>)
      : {};
  generated.dev = { ...existingDev, port };

  // Fail-closed: không còn remote:true nào lọt qua.
  assertNoRemoteTrue(generated, '');

  const persistTo = persistToDir(normalizedRoot);
  const outDir = generatedConfigDir(normalizedRoot);
  mkdirSync(outDir, { recursive: true });

  const baseName = `${sanitizeFileName(workerName)}.wrangler.jsonc`;
  const configPath = join(outDir, baseName);

  const content = `${JSON.stringify(generated, null, 2)}\n`;
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, content, 'utf8');
    renameSync(tempPath, configPath);
  } catch (error) {
    try {
      // best-effort dọn temp file nếu rename fail.
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw new Error(`cannot write the generated config: ${(error as Error).message}`, {
      cause: error,
    });
  }

  return {
    worktreeRoot: normalizedRoot,
    namespace,
    persistTo,
    configPath,
    config: generated,
  };
}

// ---------- Áp dụng seeds/migrations local ----------

const DEFAULT_WRANGLER_BIN = join(ROOT_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Export dùng chung với orchestration — một nguồn duy nhất cho quy tắc invocation. */
export function resolveWranglerInvocation(wranglerBin?: string): {
  command: string;
  prefix: string[];
} {
  const bin = wranglerBin ?? DEFAULT_WRANGLER_BIN;
  if (bin.endsWith('.js') || bin.endsWith('.mjs') || bin.endsWith('.cjs')) {
    return { command: process.execPath, prefix: [bin] };
  }
  return { command: bin, prefix: [] };
}

/**
 * Env allowlist CHUNG cho mọi subprocess wrangler (migrations/seeds ở đây và
 * `wrangler dev` ở worker-orchestration — OCR PR #36 security high: hai bản
 * copy riêng dễ drift và đường dev phải áp cùng cơ chế cô lập token).
 * Gồm biến Windows cốt lõi: Node child process thiếu SystemRoot thường fail
 * ngay khi spawn hoặc hỏng crypto/DNS một cách mơ hồ.
 */
const WRANGLER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Windows
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'ALLUSERSPROFILE',
  'APPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
] as const;

/**
 * Prefix allowlist — biến pass theo TIỀN TỐ thay vì exact-match.
 *
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` (platform facts
 * PF3, wrangler 4.x): biến môi trường duy nhất cấp connection string cho
 * Hyperdrive binding khi chạy local — wrangler đọc nó từ `process.env` của
 * PROCESS wrangler (đo thật: applyHyperdriveEnvVars đọc process.env trực tiếp,
 * KHÔNG qua `.dev.vars` của worker env), và thiếu nó khi config khai hyperdrive
 * binding là lỗi boot tường minh. Matching theo prefix là bắt buộc: phần đuôi
 * là TÊN BINDING (`_HYPERDRIVE`, `_HD2`...) do committed config của từng app
 * quyết định — allowlist exact-match không thể biết trước tên binding nào sẽ
 * xuất hiện. Phần prefix được ghim nguyên vẹn ở đây nên không mở cửa rộng:
 * biến nào không bắt đầu bằng prefix này vẫn không pass.
 */
const WRANGLER_ENV_PREFIX_ALLOWLIST = ['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_'] as const;

/**
 * HOME cô lập của wrangler subprocess — một thư mục rỗng theo persist dir,
 * cached OAuth token tại `~/.wrangler/config/default.toml` của máy developer
 * không được nhìn thấy (OCR security finding: token cache không phải env var
 * nên whitelist env var lọc không tới; trỏ HOME về thư mục worktree-local
 * thiếu credentials là defense-in-depth thực sự cho fail-closed). Áp cho
 * CẢ migrations và `wrangler dev` — process sống lâu nhất, có outbound
 * network, là chỗ token cache nguy hiểm nhất nếu bị rò.
 * Best-effort: mkdir fail (snapshot readonly...) không chặn xoay env — vẫn
 * return một path có thể không tồn tại, wrangler tự fail nếu thật sự cần.
 */
function isolatedWranglerHome(persistTo: string): string {
  const homeDir = join(persistTo, '.wrangler-home');
  try {
    mkdirSync(homeDir, { recursive: true });
  } catch {
    // ignore — caller đã mkdir persistTo trước khi gọi
  }
  return homeDir;
}

/**
 * Env allowlist object cho subprocess wrangler, HOME/USERPROFILE/XDG_CONFIG_HOME
 * cô lập vào thư mục theo `persistTo` (thường là stateDir của worktree).
 * Export dùng chung: worker-orchestration gọi cho `wrangler dev` thay vì giữ
 * bản allowlist thứ hai (drift-prone).
 */
export function sanitizedWranglerEnv(persistTo: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of WRANGLER_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Prefix rule: Hyperdrive local connection string theo binding (xem
  // WRANGLER_ENV_PREFIX_ALLOWLIST). Chỉ pass biến có giá trị non-empty —
  // biến đặt nhưng rỗng thì wrangler xử lý như "chưa cấp connection string"
  // và fail-closed lúc boot đúng như thiếu hẳn.
  for (const prefix of WRANGLER_ENV_PREFIX_ALLOWLIST) {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(prefix) && process.env[key] !== undefined && process.env[key] !== '') {
        env[key] = process.env[key];
      }
    }
  }
  // HOME/USERPROFILE cô lập — CachedCredentials của wrangler nằm dưới home dir
  // của user; trỏ cả hai về thư mục trống theo worktree.
  const isolatedHome = isolatedWranglerHome(persistTo);
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  // XDG_CONFIG_HOME trỏ cùng chỗ — vài distribution Linux của wrangler đọc
  // credentials dưới $XDG_CONFIG_HOME/.wrangler thay vì ~.
  env.XDG_CONFIG_HOME = isolatedHome;
  return env;
}

function runWrangler(
  args: string[],
  options: { wranglerBin?: string; cwd?: string; persistTo: string },
): void {
  const { command, prefix } = resolveWranglerInvocation(options.wranglerBin);
  const result = spawnSync(command, [...prefix, ...args], {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000, // không chờ wrangler treo vô hạn
    env: sanitizedWranglerEnv(options.persistTo),
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`wrangler ${args.join(' ')} exceeded the 5 minute timeout — aborting`);
    }
    throw new Error(`wrangler could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || 'unknown reason';
    throw new Error(`wrangler ${args.join(' ')} failed:\n${detail}`);
  }
}

/**
 * Persist dir dùng `resolve()` trước khi làm anything — PATH tương đối sẽ được
 * mkdir ở một chỗ (base cwd của dx process) còn wrangler ghi state ở chỗ khác
 * (base cwd của subprocess = options.cwd), phá cam kết "hai worktree không chia
 * sẻ bất kỳ byte nào" (OCR low finding). resolve() tại thời điểm gọi: caller
 * truyền absolute (từ `persistToDir(worktreeRoot)`) thì không đổi; tương đối
 * thì chuẩn hoá theo cwd hiện tại — mọi call-site của orchestration luôn truyền
 * absolute, path tương đối chỉ còn từ test/manual invocation.
 */
function resolvePersistDir(raw: string): string {
  const persistTo = resolve(raw);
  if (!existsSync(persistTo)) {
    mkdirSync(persistTo, { recursive: true });
  }
  return persistTo;
}

/**
 * Đối chiếu `databaseName` với `d1_databases` của config — fail-closed trước
 * khi ghép positional arg của wrangler (OCR high finding: tên gõ sai hay
 * identifier trỏ resource thật đi thẳng vào subprocess, chỉ fail muộn ở wrangler
 * với message mơ hồ). Khớp khi bằng `binding` hoặc `database_name` của một
 * entry D1 bất kỳ. Export cho spec phủ trực tiếp không cần chạy wrangler thật.
 */
export function assertDatabaseNameInConfig(configPath: string, databaseName: string): void {
  const { config } = loadCommittedWranglerConfig(configPath);
  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  for (const entry of databases) {
    if (entry === null || typeof entry !== 'object') continue;
    // `database_name` khớp ĐỘC LẬP với `binding` (OCR PR #36 low): entry config
    // hand-written thiếu `binding` vẫn có thể khớp qua database_name — im lặng
    // bỏ qua nó là sai khi debug (known list cũng chỉ lookup database_name).
    const binding = (entry as { binding?: unknown }).binding;
    if (
      (typeof binding === 'string' && binding === databaseName) ||
      (entry as { database_name?: unknown }).database_name === databaseName
    ) {
      return;
    }
  }
  const known = databases
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? String((entry as { database_name?: unknown }).database_name ?? '?')
        : '?',
    )
    .join(', ');
  throw new Error(
    `database '${databaseName}' matches no binding/database_name in the d1_databases of ` +
      `${configPath} (known: ${known || 'empty'}) — refusing to call wrangler with a name not present in the config`,
  );
}

export function applyLocalD1Seeds(options: ApplyLocalSeedsOptions): void {
  if (options.remote === true) {
    throw new Error('applyLocalD1Seeds: remote mode is not allowed (PR3 fail-closed)');
  }
  // `seedFiles: []` phải fail-loud (OCR low finding): pattern lệch/ glob sai
  // để lại state D1 chưa seed, "thành công" âm thầm => bug biểu hiện muộn ở
  // tầng khác khó truy vết.
  if (options.seedFiles.length === 0) {
    throw new Error(
      'applyLocalD1Seeds: seedFiles is empty — no seed would be applied, refusing to run silently (fail-closed)',
    );
  }
  const configPath = resolve(options.configPath);
  if (!existsSync(configPath)) {
    throw new Error(`config does not exist: ${configPath}`);
  }
  const persistTo = resolvePersistDir(options.persistTo);
  assertDatabaseNameInConfig(configPath, validateDatabaseIdentifier(options.databaseName));
  // Mỗi file một lần `d1 execute` — thứ tự đã được caller biên (seedFiles).
  // Idempotency là trách nhiệm của seed file: INSERT thiếu ON CONFLICT/IF NOT
  // EXISTS sẽ fail khi chạy lại sau crash (OCR finding — documented ở caller).
  for (const seedFile of options.seedFiles) {
    const absoluteSeed = resolve(seedFile);
    if (!existsSync(absoluteSeed)) {
      throw new Error(`seed file does not exist: ${absoluteSeed}`);
    }
    runWrangler(
      [
        'd1',
        'execute',
        validateDatabaseIdentifier(options.databaseName),
        '--config',
        configPath,
        '--local',
        '--persist-to',
        persistTo,
        '--file',
        absoluteSeed,
      ],
      { wranglerBin: options.wranglerBin, cwd: options.cwd, persistTo },
    );
  }
}

export function applyLocalD1Migrations(options: ApplyLocalMigrationsOptions): void {
  if (options.remote === true) {
    throw new Error('applyLocalD1Migrations: remote mode is not allowed (PR3 fail-closed)');
  }
  const configPath = resolve(options.configPath);
  if (!existsSync(configPath)) {
    throw new Error(`config does not exist: ${configPath}`);
  }
  const persistTo = resolvePersistDir(options.persistTo);
  assertDatabaseNameInConfig(configPath, validateDatabaseIdentifier(options.databaseName));
  runWrangler(
    [
      'd1',
      'migrations',
      'apply',
      validateDatabaseIdentifier(options.databaseName),
      '--config',
      configPath,
      '--local',
      '--persist-to',
      persistTo,
    ],
    { wranglerBin: options.wranglerBin, cwd: options.cwd, persistTo },
  );
}
