/**
 * Container PostgreSQL dùng-đi qua **docker CLI** cho integration suite của
 * `release-validation` — không phụ thuộc `@testcontainers`: container được
 * `docker run` trực tiếp và pg_dump/psql chạy **bên trong container** qua
 * `docker exec` (dùng lại chính `hostPgTools` docker-mode của cơ chế), nên
 * binary luôn khớp phiên bản server và host không cần cài PostgreSQL client.
 *
 * ⚠️ Docker **là** phụ thuộc cứng của suite: thiếu Docker thì suite phải ĐỎ,
 * không được skip — một lần chạy skip với exit 0 che mất việc một suite bắt
 * buộc chưa hề chạy (06-testing.md §6). Quyết định fail được đưa ra qua
 * {@link probeDocker}: probe thất bại là NÉM từ `globalSetup` trước khi
 * worker nào kịp báo xanh giả. Pattern `apps/remote-cache-api/tests/
 * integrations/harness.ts` — tham chiếu.
 *
 * ⚠️ Không có ryuk: container rò rỉ sau một lần kill -9 worker vitest chỉ
 * được dọn ở lần chạy SAU — `startPostgres` xoá mọi container mang prefix
 * `rvl-it-` trước khi dựng cái mới.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

import { hostPgTools, type ExecResult, type PgTools } from '../../src/pg.ts';

/** Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI. */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Tên database hợp đồng mà cơ chế recreate trên target và runner guard
 * `current_database()` — cơ chế hoạt động theo đúng tên hợp đồng, không tên
 * tự đặt.
 */
export const CONTRACT_DATABASE = 'db-remote-cache';

const SUPERUSER = 'ecoma_rv_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';

/** Secret giả — container ném đi sau mỗi run. */
export const MIGRATOR_ROLE = 'ecoma_remote_cache_migrator';
const MIGRATOR_PASSWORD = 'ecoma_test_role_pw';

/** Prefix tên container của suite — cleanup theo prefix, không đụng container khác. */
const CONTAINER_PREFIX = 'rvl-it-';

/** Cổng PostgreSQL **trong container** — host port đọc qua `docker port`. */
const POSTGRES_PORT = 5_432;

function docker(args: readonly string[], input?: string): ExecResult {
  const result = spawnSync('docker', args, { input, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export interface PgContainer {
  readonly name: string;
  /** Cổng mapped trên host — runner migration chạy trên host cần nó. */
  readonly hostPort: number;
  /** URL nhìn TỪ TRONG container — mọi psql/pg_dump qua `docker exec` dùng URL này. */
  internalUrl(database: string): string;
  /** URL migrator nhìn từ HOST — spawn `deploys/remote-cache-db` runner dùng nó. */
  hostMigratorUrl(): string;
  /** URL migrator nhìn TỪ TRONG container — restore psql qua `docker exec` dùng nó. */
  internalMigratorUrl(): string;
  /** PgTools bọc docker exec vào chính container này. */
  tools(): PgTools;
  /** psql admin tiện dụng cho provisioning và assert trong test. */
  runSql(sql: string, database?: string): ExecResult;
  stop(): Promise<void>;
}

/** Thất bại start thường là tạm thời (giành cổng rootless) — thử lại với backoff. */
const START_ATTEMPTS = 3;

export async function startPostgres(): Promise<PgContainer> {
  let name: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const candidate = `${CONTAINER_PREFIX}${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const run = docker([
      'run',
      '-d',
      '--rm',
      // -P: publish mọi port EXPOSE của image sang cổng host ngẫu nhiên —
      // `docker port` đọc cổng mapped; thiếu -P thì không có port public nào.
      '-P',
      '--name',
      candidate,
      '-e',
      `POSTGRES_USER=${SUPERUSER}`,
      '-e',
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '-e',
      'POSTGRES_DB=postgres',
      POSTGRES_IMAGE,
      // Container ném đi sau mỗi run — tắt fsync cho suite nhanh, không phải
      // cấu hình production (production backup là 03 §3.1, ngoài scope slice).
      '-c',
      'fsync=off',
      '-c',
      'full_page_writes=off',
    ]);
    if (run.status === 0) {
      name = candidate;
      break;
    }
    lastError = new Error(`docker run failed: ${run.stderr.trim()}`);
    await new Promise<void>((done) => {
      setTimeout(done, 1_000 * attempt);
    });
  }
  if (name === undefined) throw lastError;

  const portOutput = docker(['port', name, String(POSTGRES_PORT)]);
  if (portOutput.status !== 0) {
    docker(['rm', '-f', name]);
    throw new Error(`docker port failed: ${portOutput.stderr.trim()}`);
  }
  const portLine = portOutput.stdout.trim().split('\n').at(-1) ?? '';
  // Cổng nằm sau `:` cuối, có hoặc không có đuôi `->5432/tcp` (dạng `docker
  // ps`); `[::]:32768` (IPv6) cũng khớp — số sai là NaN, throw ngay dưới.
  const hostPort = Number(portLine.match(/:(\d+)(?:->\S+)?$/u)?.[1]);
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    docker(['rm', '-f', name]);
    throw new Error(`cannot parse the mapped host port from ${JSON.stringify(portOutput.stdout)}`);
  }

  // Chờ PostgreSQL thật sự nhận kết nối — container sống chưa đủ.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = docker(['exec', name, 'pg_isready', '-U', SUPERUSER, '-d', 'postgres']).status === 0;
    if (!ready)
      await new Promise<void>((done) => {
        setTimeout(done, 500);
      });
  }
  if (!ready) {
    docker(['rm', '-f', name]);
    throw new Error('PostgreSQL container did not become ready in time');
  }

  const internalUrl = (database: string): string =>
    `postgresql://${SUPERUSER}:${SUPERUSER_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${database}`;
  const tools = hostPgTools(name);
  const runSql = (sql: string, database = 'postgres'): ExecResult =>
    tools.psql(
      // tuples-only + no-align: assert trong test đọc giá trị thuần ('1', 't'),
      // không phải bảng trang trí của psql.
      [
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--tuples-only',
        '--no-align',
        '--dbname',
        internalUrl(database),
        '--command',
        sql,
      ],
    );

  return {
    name,
    hostPort,
    internalUrl,
    hostMigratorUrl: () =>
      `postgresql://${MIGRATOR_ROLE}:${MIGRATOR_PASSWORD}@127.0.0.1:${hostPort}/${CONTRACT_DATABASE}`,
    internalMigratorUrl: () =>
      `postgresql://${MIGRATOR_ROLE}:${MIGRATOR_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${CONTRACT_DATABASE}`,
    tools: () => tools,
    runSql,
    stop: async () => {
      docker(['rm', '-f', name]);
    },
  };
}

/**
 * Provisioning tối thiểu của disposable target — đúng vai trò admin: tạo
 * database hợp đồng + role migrator với đúng quyền mà runner cần (pattern
 * `provision()` của harness `apps/*`: `NOCREATEROLE` nghĩa là runner không
 * tự tạo được chính mình). Cơ chế chỉ re-grant ACL cấp database sau khi nó
 * recreate — role cấp cluster là việc của slot provisioning.
 */
export function prepareAuthority(pg: PgContainer): void {
  const createDb = pg.runSql(`CREATE DATABASE "${CONTRACT_DATABASE}"`);
  if (createDb.status !== 0) {
    throw new Error(`cannot create the contract database: ${createDb.stderr.trim()}`);
  }
  const createRole = pg.runSql(
    `CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${MIGRATOR_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
  );
  if (createRole.status !== 0) {
    throw new Error(`cannot create the migrator role: ${createRole.stderr.trim()}`);
  }
  const grant = pg.runSql(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${CONTRACT_DATABASE}" TO ${MIGRATOR_ROLE}`,
    CONTRACT_DATABASE,
  );
  if (grant.status !== 0) {
    throw new Error(`cannot grant the migrator role: ${grant.stderr.trim()}`);
  }
}

/**
 * Apply journal fixture bằng **runner thật** của migration authority
 * `deploys/remote-cache-db` (spawn tsx với `--config` fixture) — viết vòng
 * apply riêng ở đây là tạo runner thứ hai không có advisory lock, lỗi repo đã
 * từng gặp. Dùng để dựng state "previous release" trên source trước khi capture.
 */
export function applyFixtureMigrations(pg: PgContainer, configName: string): ExecResult {
  const repoRoot = resolve(import.meta.dirname, '../../../..');
  const dbProjectRoot = resolve(repoRoot, 'deploys/remote-cache-db');
  const configPath = resolve(import.meta.dirname, 'fixtures', configName);
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli');
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--tsconfig', 'tsconfig.db.json', 'runner.mts', 'migrate', '--config', configPath],
    {
      cwd: dbProjectRoot,
      env: { ...process.env, DATABASE_URL: pg.hostMigratorUrl() },
      encoding: 'utf-8',
      timeout: 120_000,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const DOCKER_PROBE_ENV = 'ECOMA_RELEASE_VALIDATION_DOCKER_PROBE';

/**
 * Dọn container mồ côi của lần chạy trước (không ryuk để dọn hộ). Chỉ gọi từ
 * `probeDocker` (globalSetup) — TRƯỚC khi suite dựng container nào: filter
 * theo prefix bắt cả container còn sống của run này, gọi giữa chừng là xoá
 * container của chính mình.
 */
function cleanupStale(): void {
  const stale = docker(['ps', '-aq', '--filter', `name=${CONTAINER_PREFIX}`]);
  const staleIds = stale.status === 0 ? stale.stdout.split('\n').filter((id) => id !== '') : [];
  if (staleIds.length > 0) {
    docker(['rm', '-f', ...staleIds]);
  }
}

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest bằng **chính**
 * container PostgreSQL mà suite sẽ dùng (một runner thiếu daemon vẫn có thể
 * `docker info` exit 0). Thất bại là NÉM: suite phải ĐỎ, không được skip với
 * exit 0 (06-testing.md §6).
 */
export async function probeDocker(): Promise<void> {
  cleanupStale();
  const flag = process.env[DOCKER_PROBE_ENV];
  if (flag === 'available') return;
  if (flag === 'unavailable') {
    throw new Error(
      'Docker is unavailable: the release-validation integration suite requires a running Docker daemon; refusing to skip.',
    );
  }
  let available = false;
  let probe: PgContainer | undefined;
  try {
    probe = await startPostgres();
    available = true;
  } catch {
    available = false;
  } finally {
    await probe?.stop().catch(() => undefined);
  }
  process.env[DOCKER_PROBE_ENV] = available ? 'available' : 'unavailable';
  if (!available) {
    throw new Error(
      'Docker is unavailable: the release-validation integration suite requires a running Docker daemon; refusing to skip.',
    );
  }
}
