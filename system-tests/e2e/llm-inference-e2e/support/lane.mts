/**
 * Helper lane cho suite E2E inference: accessor env do runner nạp (`LLM_E2E_*`),
 * probe readiness qua container ephemeral trong network, HTTP client in-network
 * (`support/client.mjs`), psql read-only qua `docker exec`, và docker logs.
 *
 * Luật suite (06-testing.md §2/§6 + README): suite CHỈ ĐỌC — psql SELECT qua
 * `docker exec ... psql -tAc`, không migration, không seed, không vòng đời
 * container. Mọi lệnh Docker dùng namespace từ env nên hai worktree không đụng
 * nhau. Plaintext key consumer chỉ sống trong env của process vitest và header
 * của request — KHÔNG bao giờ ghép vào argv (`/proc/<pid>/cmdline`) hay log.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '../../..');

/** Image Node pin digest — cùng bản mà lane dùng cho mọi container ephemeral. */
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS nội bộ của worker WIC trên platform network (index.ts của deploy). */
export const WORKER_BASE_URL = 'http://ecoma-llm-api:4211';

/** Tên database vật lý mà mỗi schema LLM sống trong (provision của deploy unit). */
export const GATEWAY_DATABASE = 'db-llm-gateway';
export const MARKETPLACE_DATABASE = 'db-llm-marketplace';
export const TENANT_DATABASE = 'db-llm-tenant';

/** Định danh canonical của bootstrap (bootstrap-shared.mts — nguồn cùng lane). */
export const SELLER_TENANT_ID = 'seller-tenant-dronie';
export const CONSUMER_TENANT_ID = 'consumer-tenant-ecoma';
export const SPONSOR_ID = 'sponsor_ecoma_internal';
/** Model normalized của offer Dronie (pricing snapshot seed + dispatch path). */
export const DRONIE_MODEL_ID = 'dronie-flash';
/** Content deterministic của mock upstream khi MOCK_UPSTREAM_CONTENT không set. */
export const MOCK_DETERMINISTIC_CONTENT = 'Hello from llm-upstream-mock.';
/** Amount grant khởi tạo của lane (config `namespace:sponsorGrantAmount`, minor UC). */
export const SPONSOR_GRANT_AMOUNT_MINOR = '100000000000';

/** Đọc một biến env lane — thiếu là lỗi contract giữa runner và suite, fail-closed. */
function requireLaneEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `environment variable ${name} is missing — run the suite via the system-test target (bin/run-system-test.mjs), never a bare vitest`,
    );
  }
  return value;
}

export function laneNamespace(): string {
  return requireLaneEnv('LLM_E2E_NAMESPACE');
}

export function laneNetwork(): string {
  return requireLaneEnv('LLM_E2E_NETWORK');
}

export function laneTenantOwnerSub(): string {
  return requireLaneEnv('LLM_E2E_TENANT_OWNER_SUB');
}

export function laneConsumerApiKey(): string {
  return requireLaneEnv('LLM_E2E_CONSUMER_API_KEY');
}

/** Tên container PostgreSQL platform của namespace worktree. */
export function postgresContainer(): string {
  return `ecoma-${laneNamespace()}-postgres`;
}

/** Tên container mock upstream của lane E2E (lane-invocation.ts cùng hình dạng). */
export function mockContainer(): string {
  return `ecoma-${laneNamespace()}-llm-upstream-mock`;
}

/** Tên container WIC của worker (dockerResourceName(ns, 'llm-api-wic') của deploy). */
export function workerContainer(): string {
  return `ecoma-${laneNamespace()}-llm-api-wic`;
}

/**
 * SHA-256 hex của một chuỗi — đối chiếu key_hash/credential_hash hash-only.
 *
 * Đây KHÔNG phải lưu mật khẩu: domain đã chọn SHA-256 làm hàm one-way duy
 * nhất cho `api_keys.key_hash` (mọi mutation gateway đi qua cùng hàm), suite
 * tính lại đúng digest đó để ghim fence "DB chỉ giữ hash của key lane, không
 * giữ plaintext". Không có cách tính khác mà vẫn so khớp được cột domain.
 */
export function sha256Hex(value: string): string {
  //lgtm [js/insufficient-password-hash]
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Lỗi exec có exit + stderr gốc (log pulumi/docker — không secret). */
export class LaneCommandError extends Error {}

/** Tuỳ chọn exec mà helper này cần — input (stdin) và timeout duy nhất. */
interface RunOptions {
  input?: string;
  timeout?: number;
}

function runOrThrow(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  if (result.error !== undefined && result.error !== null) {
    throw new LaneCommandError(`starting ${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new LaneCommandError(`${command} exited with ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * MỘT HTTP request qua container client ephemeral trong network — stdin mang
 * JSON request (Authorization sống ở đây, không argv), stdout MỘT dòng JSON
 * `{status, body}` của `support/client.mjs`.
 */
export function requestInNetwork(request: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): { status: number; body: string } {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      laneNetwork(),
      '-i',
      '-v',
      `${repoRoot}:/repo:ro`,
      NODE_IMAGE,
      'node',
      '/repo/system-tests/e2e/llm-inference-e2e/support/client.mjs',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      input: JSON.stringify(request),
    },
  );
  if (result.error !== undefined && result.error !== null) {
    throw new LaneCommandError(`starting the in-network client failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new LaneCommandError(
      `in-network client exited with ${String(result.status)}: ${result.stderr}`,
    );
  }
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last === undefined || !last.startsWith('{')) {
    throw new LaneCommandError(
      'in-network client printed no JSON result line; the client contract is broken',
    );
  }
  const parsed: unknown = JSON.parse(last);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { status?: unknown }).status !== 'number' ||
    typeof (parsed as { body?: unknown }).body !== 'string'
  ) {
    throw new LaneCommandError(
      'in-network client JSON result lacks status/body; the client contract is broken',
    );
  }
  return parsed as { status: number; body: string };
}

/**
 * SELECT read-only qua `docker exec` psql — `-tAc` trả cell thô, nhiều hàng
 * ngăn bằng `\n`; suite parse. KHÔNG BAO GIỜ chạy SQL ghi từ suite.
 */
export function psqlQuery(database: string, sql: string): string {
  return runOrThrow('docker', [
    'exec',
    postgresContainer(),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    database,
    '-tAc',
    sql,
  ]).trimEnd();
}

/** Đếm số hàng của một SELECT — helper đếm dòng ledger/logic request. */
export function psqlCount(database: string, sql: string): number {
  const raw = psqlQuery(database, sql);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new LaneCommandError(
      `count query returned a non-integer (${raw}); the SQL contract is broken`,
    );
  }
  return value;
}

/** docker logs của một container lane (mock hoặc worker) — stdout+stderr gộp. */
export function containerLogs(container: string): string {
  const result = spawnSync('docker', ['logs', container], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined && result.error !== null) {
    throw new LaneCommandError(`reading logs of ${container} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new LaneCommandError(`docker logs ${container} exited with ${String(result.status)}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Readiness gate probe MỘT lần — container ephemeral trong network probe
 * /health rồi /ready của worker. Suite gọi từ global-setup trong retry budget.
 * Verdict là exit code (script im lặng): `ready` = cả hai phục vụ;
 * `not-ready` = chưa xong nhưng có thể hết (worker boot, /ready 503).
 *
 * CỐT Ý KHÔNG probe mock ở gate: mock chỉ nhận credential UPSTREAM
 * (`llmUpstreamCredentialPlaintext` của stack — worker gửi nó cho mock, đúng
 * contract bước 8b), suite không bao giờ giữ secret đó; readiness CÓ credential
 * đúng đã được gate bởi `test-lane-up` (waiter trong network) — dependency
 * target của `system-test`. Việc mock phục vụ kèm `auth=ok` được chứng minh
 * lại ở kịch bản (f) qua đường serving thật (log mock).
 */
export function probeReadinessOnce(): 'ready' | 'not-ready' {
  const script =
    `(async()=>{` +
    `const probe=async(url)=>{const r=await fetch(url);` +
    `if(!r.ok)throw new Error('status '+r.status);await r.text();};` +
    `await probe('${WORKER_BASE_URL}/health');` +
    `await probe('${WORKER_BASE_URL}/ready');` +
    `process.exit(0);})().catch(()=>process.exit(1))`;
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--network', laneNetwork(), NODE_IMAGE, 'node', '-e', script],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  // Timeout của spawnSync (container treo quá 30s) kill bằng signal — đây là
  // "chưa sẵn sàng" retry được, KHÔNG phải lỗi spawn; chỉ ENOENT/EACCES mới là
  // lỗi không chạy được (error kèm status null mà không có signal).
  if (result.signal !== undefined && result.signal !== null) return 'not-ready';
  if (result.error !== undefined && result.error !== null) {
    throw new LaneCommandError(`starting the readiness probe failed: ${result.error.message}`);
  }
  return result.status === 0 ? 'ready' : 'not-ready';
}
