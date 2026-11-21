/**
 * PostgreSQL thật cho suite roles của `db-remote-cache-app` — **docker CLI**,
 * không `@testcontainers/*`: cùng kỹ thuật với `tests/browser/stack.ts` của
 * chính project này (bản sao chữ-số-chữ của harness pact). Thiếu Docker thì
 * `docker run` thất bại và `beforeAll` NÉM — suite ĐỎ, không skip với exit 0
 * (06-testing.md §6); target `test-integration` đã có probe fail-loud riêng ở
 * `globalSetup` (`tests/browser/docker-probe.global-setup.ts`) nên harness
 * không probe lại.
 *
 * Apply đi qua **runner thật của migration authority** — spawn CLI
 * `deploys/remote-cache-app-db/runner.mts migrate` (cutover #377) bằng
 * credential migrator thật, không `SET ROLE`: advisory lock + guard
 * `current_database()` là một phần của điều được kiểm, còn `SET ROLE` không
 * chứng minh được quyền kết nối thật. Viết vòng apply riêng ở đây là tạo runner
 * thứ hai không có lock.
 *
 * Deliberate duplication của `apps/remote-cache-api/tests/integrations/harness.ts`
 * — hai deploy unit, import chéo bị cấm (06-testing.md §6, 05-code-architecture.md §7).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

import { Client } from 'pg';

const APP_DIR = resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const APP_DB_PROJECT = resolve(REPO_ROOT, 'deploys', 'remote-cache-app-db');
/** Tsx của repo — chạy runner của authority mà không cần dep nào ở project này. */
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

/** Image PostgreSQL — một chuẩn container cho toàn bộ suite PostgreSQL của repo. */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Database hợp đồng — cùng tên với guard `current_database()` của runner. */
const APP_DATABASE = 'db-remote-cache-app';

const SUPERUSER = 'ecoma_test_superuser';
/** Mật khẩu giả sinh mỗi run — container ném đi sau mỗi lần chạy. */
const SUPERUSER_PASSWORD = randomBytes(16).toString('hex');
const ROLE_PASSWORD = randomBytes(16).toString('hex');

const MIGRATOR_ROLE = 'ecoma_remote_cache_app_migrator';
const RUNTIME_ROLE = 'ecoma_remote_cache_app_runtime';
/** Role không được grant gì — chứng minh `REVOKE CONNECT FROM PUBLIC` có tác dụng thật. */
const CONNECT_PROBE_ROLE = 'ecoma_remote_cache_app_connect_probe';

export interface RemoteCacheAppDatabase {
  readonly host: string;
  readonly port: number;
  /** Client superuser cho các assertion về grant và ACL. */
  connect(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_remote_cache_app_runtime`. */
  asRuntime(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_remote_cache_app_migrator`. */
  asMigrator(): Promise<Client>;
  /**
   * Client bằng **credential thật** của runtime role (không `SET ROLE`) —
   * kiểm chứng ranh giới ở tầng kết nối chứ không chỉ ở catalog.
   */
  connectAsRuntime(): Promise<Client>;
  /** Credential thật của migrator — đúng vai trò runner CLI dùng. */
  connectAsMigrator(): Promise<Client>;
  /** Credential của role KHÔNG có grant CONNECT — kết nối phải bị từ chối. */
  connectUngrantedRole(): Promise<Client>;
  stop(): Promise<void>;
}

/** Thoát nháy đơn cho literal SQL — mật khẩu test chỉ gồm ký tự hex. */
function sqlQuote(value: string): string {
  return value.split("'").join("''");
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

interface PostgresContainer {
  readonly name: string;
  /** Cổng host map thật — gán sau khi `docker port` trả kết quả. */
  port: number;
  stop(): void;
}

/**
 * Số lần thử `docker run` và khoảng nghỉ tăng dần giữa hai lần.
 *
 * Thất bại start **thường là tạm thời**, không phải Docker hỏng: dưới rootless
 * Docker, nhiều container start song song thi nhau chiếm port host qua
 * RootlessKit, và người thua nhận
 * `RootlessKit PortManager.AddPort(): bind: address already in use` — lỗi biến
 * mất ở lần thử sau. Đã đo được ở các harness testcontainers: run song song ba
 * project đỏ 3/5 lần vì lỗi này, trong khi từng project riêng lẻ xanh 100%
 * (pattern `CONTAINER_START_ATTEMPTS` — import chéo deploy unit bị cấm nên
 * copy nguyên tắc, không copy code).
 */
const DOCKER_RUN_ATTEMPTS = 3;
const DOCKER_RUN_BACKOFF_MS = 1_000;

/** `spawnSync` bọc timeout — sync call chặn event loop nên Vitest hookTimeout không interrupt được. */
function spawnSyncBounded(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, { encoding: 'utf8', timeout: options.timeoutMs });
}

async function startPostgresContainer(): Promise<PostgresContainer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOCKER_RUN_ATTEMPTS; attempt++) {
    try {
      return await startPostgresContainerOnce();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Chỉ retry lỗi tạm thời của daemon (RootlessKit port-bind); lỗi cấu hình
      // hay lỗi parse port không tự khỏi ở lần sau.
      if (!message.includes('address already in use')) {
        throw error;
      }
    }
    await new Promise<void>((done) => {
      setTimeout(done, DOCKER_RUN_BACKOFF_MS * attempt);
    });
  }
  throw lastError;
}

async function startPostgresContainerOnce(): Promise<PostgresContainer> {
  const name = `remote-cache-app-roles-it-${String(process.pid)}-${String(Date.now())}`;
  const run = spawnSyncBounded(
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      name,
      '-e',
      `POSTGRES_DB=${APP_DATABASE}`,
      '-e',
      `POSTGRES_USER=${SUPERUSER}`,
      '-e',
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '--publish-all',
      POSTGRES_IMAGE,
    ],
    { timeoutMs: 60_000 },
  );
  if (run.status !== 0 || (run.stdout ?? '').trim() === '') {
    throw new Error(
      `docker run for the PostgreSQL container failed (exit ${String(run.status)}):\n${run.stderr ?? ''}`.slice(
        -1000,
      ),
    );
  }
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    ACTIVE_CONTAINERS.delete(handle);
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 60_000 });
  };
  const handle: PostgresContainer = { name, port: 0, stop };
  ACTIVE_CONTAINERS.add(handle);
  try {
    const portOutput = spawnSyncBounded('docker', ['port', name, '5432'], { timeoutMs: 30_000 });
    if (portOutput.status !== 0) {
      throw new Error(`docker port failed for ${name}:\n${portOutput.stderr ?? ''}`.slice(-500));
    }
    const lastLine = (portOutput.stdout ?? '').trim().split('\n').at(-1) ?? '';
    const match = /:(\d+)\s*$/u.exec(lastLine);
    if (match === null) {
      throw new Error(`Cannot parse the mapped host port for ${name}: ${lastLine}`);
    }
    const port = Number(match[1]);
    handle.port = port;

    // Đợi readiness THẬT bằng tín hiệu deterministic của chính PostgreSQL: log
    // "database system is ready to accept connections" xuất hiện LẦN THỨ HAI —
    // lần thứ nhất là temp server của initdb tắt đi. Double-probe pg_isready
    // cách quãng 1.5s (bản cũ) là heuristic: dưới tải, cửa sổ temp server có
    // thể dài hơn 1.5s và cả hai probe đều pass vào server tạm → provision
    // chết "the database system is shutting down".
    const readLogs = (): string => {
      const logs = spawnSyncBounded('docker', ['logs', name], { timeoutMs: 30_000 });
      // PostgreSQL ghi log ra STDERR — `docker logs` tách stream, đọc cả hai.
      return `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
    };
    const deadline = Date.now() + 120_000;
    for (;;) {
      const readyLines =
        readLogs().split('database system is ready to accept connections').length - 1;
      if (readyLines >= 2) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the second "ready to accept connections" line in docker logs of ${name}`,
        );
      }
      await new Promise<void>((done) => {
        setTimeout(done, 500);
      });
    }
    return handle;
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Container đang sống của process — handler tín hiệu (cài một lần duy nhất)
 * dọn tất cả best-effort khi test process bị kill: `--rm` của docker chỉ dọn
 * trên exit hoàn toàn, một SIGINT/SIGTERM giữa chừng nếu không dọn sẽ để lại
 * container mồ côi chiếm port host cho các lần chạy sau.
 */
const ACTIVE_CONTAINERS = new Set<PostgresContainer>();

/** Dọn TẤT CẢ container đang sống — best-effort, dùng cho handler tín hiệu. */
function stopAllActiveContainers(): void {
  for (const active of ACTIVE_CONTAINERS) {
    active.stop();
  }
}

let exitHandlersInstalled = false;

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  // Dọn xong phải trả lại signal mặc định (`process.kill` chính nó) để exit
  // code của process giữ nguyên ngữ nghĩa — handler chỉ dọn, không nuốt tín hiệu.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopAllActiveContainers();
      process.kill(process.pid, signal);
    });
  }
}

function psqlSync(containerName: string, sql: string): void {
  const result = spawnSync(
    'docker',
    [
      'exec',
      containerName,
      'psql',
      '-U',
      SUPERUSER,
      '-d',
      APP_DATABASE,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql failed (exit ${String(result.status)}):\n` +
        redact(result.stderr ?? '', [SUPERUSER_PASSWORD, ROLE_PASSWORD]).slice(-1000),
    );
  }
}

/**
 * Provisioning làm bằng superuser — đúng vai admin/owner, những thứ migration
 * KHÔNG tự làm được: `CREATE ROLE … LOGIN` (0001 guard-create role NON-LOGIN;
 * `NOCREATEROLE` nghĩa là migrator không thể tự cấp), `GRANT … ON DATABASE`
 * (provisioning step của deploy script, `scripts.ts` của `remote-cache-app-deploy`).
 * Bỏ bước này thì runner chết ngay ở 0001 với `permission denied` — lỗi
 * provisioning, không phải lỗi migration.
 */
function provision(containerName: string): void {
  const roles = [MIGRATOR_ROLE, RUNTIME_ROLE, CONNECT_PROBE_ROLE];
  for (const role of roles) {
    psqlSync(
      containerName,
      `CREATE ROLE ${role} LOGIN PASSWORD '${sqlQuote(ROLE_PASSWORD)}' ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
  }
  psqlSync(
    containerName,
    `REVOKE CONNECT ON DATABASE "${APP_DATABASE}" FROM PUBLIC;
     GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${APP_DATABASE}" TO ${MIGRATOR_ROLE};
     GRANT CONNECT ON DATABASE "${APP_DATABASE}" TO ${RUNTIME_ROLE};
     REVOKE ALL ON SCHEMA public FROM PUBLIC;`.replaceAll('\n', ' '),
  );
}

/**
 * Apply qua runner thật của authority bằng credential migrator thật — cùng
 * đường production đi. History đã phủ journal thì runner no-op nên gọi lại an toàn.
 *
 * ⚠️ Environ của subprocess là **tập tối thiểu** + DATABASE_URL, KHÔNG spread
 * `process.env`: spread sẽ rò secret môi trường của CI/host (API token, cloud
 * credential…) vào process migration. Runner spawn `drizzle-kit` bằng
 * `process.execPath` (đường tuyệt đối) nên chuỗi child không cần gì ngoài
 * PATH (shim `node_modules/.bin/tsx` resolve `node` từ PATH) + HOME/LANG/TZ.
 */
function applyMigrations(host: string, port: number): void {
  const databaseUrl =
    `postgresql://${MIGRATOR_ROLE}:${encodeURIComponent(ROLE_PASSWORD)}` +
    `@${host}:${String(port)}/${APP_DATABASE}`;
  const result = spawnSync(
    TSX_BIN,
    ['--tsconfig', 'tsconfig.db.json', resolve(APP_DB_PROJECT, 'runner.mts'), 'migrate'],
    {
      cwd: APP_DB_PROJECT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TZ: process.env.TZ,
        DATABASE_URL: databaseUrl,
      },
      encoding: 'utf8',
      // tsx cold start + resolve drizzle-kit trên CI lạnh từng vượt 120s —
      // cùng convention `ECOMA_MIGRATION_TIMEOUT_MS` với harness remote-cache-api.
      timeout: Number(process.env.ECOMA_MIGRATION_TIMEOUT_MS ?? 300_000),
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `migration runner failed (exit ${String(result.status ?? result.signal ?? 'spawn-error')}` +
        `${result.error ? `: ${result.error.message}` : ''}):\n` +
        redact(`${result.stderr ?? ''}\n${result.stdout ?? ''}`.slice(-2000), [
          ROLE_PASSWORD,
          SUPERUSER_PASSWORD,
        ]),
    );
  }
}

/**
 * Dựng container PostgreSQL, provision hai role app + một role probe, apply
 * migration bằng runner production với credential migrator thật, rồi trả handle.
 *
 * ⚠️ Không tái sử dụng container: các test assert trên trạng thái database
 * (catalog, grant) chứ không chỉ trên dữ liệu mình tạo.
 */
export async function startRemoteCacheAppDatabase(): Promise<RemoteCacheAppDatabase> {
  const container = await startPostgresContainer();
  installExitHandlers();
  try {
    const host = '127.0.0.1';
    const port = container.port;

    provision(container.name);
    applyMigrations(host, port);

    const open = async (user: string, password: string): Promise<Client> => {
      // host/port/database nối vào đây, KHÔNG để pg tự default về localhost:5432
      // — thiếu nó là ECONNREFUSED trên cổng máy host, không phải lỗi container.
      const client = new Client({
        host,
        port,
        database: APP_DATABASE,
        user,
        password,
        application_name: 'ecoma-remote-cache-app-roles-itest',
      });
      await client.connect();
      return client;
    };

    const connect = (): Promise<Client> => open(SUPERUSER, SUPERUSER_PASSWORD);

    const asRole = async (role: string): Promise<Client> => {
      const client = await connect();
      try {
        await client.query(`SET ROLE ${role}`);
        return client;
      } catch (error) {
        // SET ROLE chết thì kết nối phải được đóng ngay — trả client lộ session
        // chưa set role và rò connection pool của suite.
        await client.end().catch(() => undefined);
        throw error;
      }
    };

    return {
      host,
      port,
      connect,
      asRuntime: () => asRole(RUNTIME_ROLE),
      asMigrator: () => asRole(MIGRATOR_ROLE),
      connectAsRuntime: () => open(RUNTIME_ROLE, ROLE_PASSWORD),
      connectAsMigrator: () => open(MIGRATOR_ROLE, ROLE_PASSWORD),
      connectUngrantedRole: () => open(CONNECT_PROBE_ROLE, ROLE_PASSWORD),
      stop: async () => {
        container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: afterAll chỉ thấy handle đã gán hay chưa,
    // exception giữa chừng nếu không dọn để lại container chạy mãi.
    container.stop();
    throw error;
  }
}
