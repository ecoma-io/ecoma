/**
 * Testcontainers + PostgreSQL thật cho integration test của `llm-api`
 * (slice db-migration của Issue #22): ba database `db-llm-gateway`,
 * `db-llm-tenant`, `db-llm-marketplace` trên MỘT container, đúng topology
 * production nơi cả ba cùng nằm trên một PostgreSQL instance.
 *
 * ⚠️ Docker **là** phụ thuộc cứng của suite này: thiếu Docker thì suite phải ĐỎ,
 * không được skip — một lần chạy skip với exit 0 che mất việc một suite bắt buộc
 * chưa hề chạy (06-testing.md §6). Mọi thứ Docker ở đây nằm sau dynamic import,
 * và quyết định fail được đưa ra qua {@link probeDocker}: probe thất bại là NÉM
 * từ `globalSetup` trước khi worker nào kịp báo xanh giả. Pattern
 * `apps/remote-cache-api/tests/integrations/harness.ts` — tham chiếu.
 *
 * Apply đi qua **runner production** (`db/apply.mts`) chạy bằng `tsx` qua
 * `child_process` với `DATABASE_URL` của credential migrator từng target —
 * đúng lệnh mà `db:migrate` chạy trong CI, gồm assert `current_database()` và
 * advisory lock. Viết vòng apply riêng ở đây là tạo runner thứ hai.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type Client = import('pg').Client;

/** Khóa database của deploy unit — mỗi khóa một DB, một cặp role migrator/runtime. */
export type LlmDatabaseKey = 'gateway' | 'tenant' | 'marketplace';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 *
 * Ba migration `0001` của slice này không cài extension nào (chỉ DDL catalog
 * + default privileges) nên không cần image đặc biệt nào.
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Cổng PostgreSQL **trong container**. Không phải cổng host: testcontainers ánh
 * xạ sang một cổng host ngẫu nhiên và `getMappedPort` đọc cổng đó.
 *
 * ⚠️ Truyền nó vào `withExposedPorts` bằng **varargs** — truyền một mảng đẩy
 * chính cái mảng vào vị trí `port` và container chết trước khi kịp chạy với
 * `invalid port 'undefined'`.
 */
const POSTGRES_PORT = 5_432;

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
/** Mật khẩu chung cho các role test — secret giả, database ném đi sau mỗi run. */
export const ROLE_PASSWORD = 'ecoma_test_role_pw';

/** Owner chung của cả ba database — pattern `auth-deploy`: một stack sở hữu password. */
const OWNER_ROLE = 'ecoma_owner';

const DATABASES: Readonly<Record<LlmDatabaseKey, string>> = {
  gateway: 'db-llm-gateway',
  tenant: 'db-llm-tenant',
  marketplace: 'db-llm-marketplace',
};

/** Role migrator của một DB — credential mà runner CLI `db/apply.mts` dùng. */
export function migratorRole(key: LlmDatabaseKey): string {
  return `ecoma_llm_${key}_migrator`;
}

/** Role runtime của một DB — chỉ CONNECT trên DB của mình, không DDL. */
export function runtimeRole(key: LlmDatabaseKey): string {
  return `ecoma_llm_${key}_runtime`;
}

/** Tên database của một khóa. */
export function databaseName(key: LlmDatabaseKey): string {
  return DATABASES[key];
}

/**
 * Chuỗi kết nối PostgreSQL cho một role test. Dùng để xây `DATABASE_URL` cho
 * runner CLI và để mở client bằng credential thật.
 */
export function roleConnectionString(
  role: string,
  database: string,
  host: string,
  port: number,
): string {
  return `postgresql://${role}:${ROLE_PASSWORD}@${host}:${port}/${database}`;
}

/** URL migrator canonical của một khóa — đúng hình `DATABASE_URL` mà CI runner giữ. */
export function migratorUrl(key: LlmDatabaseKey, host: string, port: number): string {
  return roleConnectionString(migratorRole(key), DATABASES[key], host, port);
}

export interface LlmApiDatabase {
  readonly host: string;
  readonly port: number;
  readonly superuserPassword: string;
  readonly rolePassword: string;
  /** Client superuser cho các assertion về grant, ACL và catalog. */
  connect(dbKey?: LlmDatabaseKey): Promise<Client>;
  /** Client đã `SET ROLE` runtime của một DB — đúng hình vai Worker. */
  asRuntime(dbKey: LlmDatabaseKey): Promise<Client>;
  /** Client đã `SET ROLE` migrator của một DB. */
  asMigrator(dbKey: LlmDatabaseKey): Promise<Client>;
  /** Client bằng **credential thật** của migrator — đúng credential runner CLI dùng. */
  connectAsMigrator(dbKey: LlmDatabaseKey): Promise<Client>;
  /**
   * Mở một client mới bằng **credential thật** của role (không `SET ROLE`), để
   * kiểm chứng ranh giới ở tầng kết nối chứ không chỉ ở catalog.
   */
  connectAsRuntime(dbKey: LlmDatabaseKey): Promise<Client>;
  /** Mở client bằng một (role, database) bất kỳ — kênh cho test ranh giới chéo-DB. */
  openWithCredentials(options: {
    user: string;
    password: string;
    database: string;
  }): Promise<Client>;
  stop(): Promise<void>;
}

async function pgModule(): Promise<typeof import('pg')> {
  // `pg` là CJS nên namespace (`typeof import('pg')`) là chữ ký đúng ở cả Node
  // lẫn ESM — kiểu của `default` thiếu `PG` (cùng chú thích harness remote-cache).
  return import('pg');
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker — mỗi
 * spec file chạy trong worker fork riêng nên cache module scope không vượt qua
 * được ranh giới worker; `process.env` là kênh kế thừa duy nhất đáng tin.
 */
const DOCKER_PROBE_ENV = 'ECOMA_LLM_API_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest.
 *
 * Probe bằng **chính** container PostgreSQL mà test sẽ dùng: `docker info` vẫn
 * có thể trả 0 trên runner thiếu socket, và probe rẻ tiền đó cho một `describe`
 * rỗng rồi đỏ ở `beforeAll`. Probe thất bại là NÉM — suite phải ĐỎ, không skip
 * với exit 0 (06-testing.md §6).
 */
export function probeDocker(): Promise<void> {
  const flag = process.env[DOCKER_PROBE_ENV];
  if (flag === 'available') {
    return Promise.resolve();
  }
  if (flag === 'unavailable') {
    throw new Error(
      'Docker is unavailable: PostgreSQL integration suites require a running Docker daemon; refusing to skip.',
    );
  }
  // Fallback khi được gọi ngoài pipeline vitest có `globalSetup` (chạy tay,
  // vitest khác config): probe tại chỗ và cache trên globalThis cho caller sau.
  const cache = globalThis as DockerProbeCache;
  cache.ecomaLlmApiDockerProbe ??= runDockerProbe();
  return cache.ecomaLlmApiDockerProbe;
}

interface DockerProbeCache {
  ecomaLlmApiDockerProbe?: Promise<void>;
}

async function runDockerProbe(): Promise<void> {
  let container: { stop(): Promise<unknown> } | undefined;
  let available = false;
  try {
    container = await startPostgresContainer((c) => c.withExposedPorts(POSTGRES_PORT));
    available = true;
  } catch {
    available = false;
  } finally {
    // `.catch(() => undefined)` chứ không phải block rỗng: `stop()` là cleanup
    // và có thể tự nó ném, nuốt lỗi ở đây để lỗi **thật** của probe không bị che.
    await container?.stop().catch(() => undefined);
  }

  process.env[DOCKER_PROBE_ENV] = available ? 'available' : 'unavailable';
  if (!available) {
    throw new Error(
      'Docker is unavailable: PostgreSQL integration suites require a running Docker daemon; refusing to skip.',
    );
  }
}

/**
 * Số lần thử lại khi start một container thất bại, và khoảng nghỉ giữa hai lần.
 *
 * ⚠️ Thất bại start **thường là tạm thời**: dưới rootless Docker, nhiều container
 * start song song thi nhau chiếm port host qua RootlessKit và người thua nhận
 * `bind: address already in use` — lỗi biến mất ở lần thử sau.
 */
const CONTAINER_START_ATTEMPTS = 3;
const CONTAINER_START_BACKOFF_MS = 1_000;

async function startPostgresContainer(
  builder: (
    c: import('@testcontainers/postgresql').PostgreSqlContainer,
  ) => import('@testcontainers/postgresql').PostgreSqlContainer,
): Promise<import('@testcontainers/postgresql').StartedPostgreSqlContainer> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONTAINER_START_ATTEMPTS; attempt++) {
    try {
      return await builder(new PostgreSqlContainer(POSTGRES_IMAGE))
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      lastError = error;
      // Lỗi trước khi container kịp chạy không để lại gì để dọn; lỗi sau start
      // thì ryuk dọn theo label của testcontainers. Nuốt ở đây để vòng retry
      // không ném giữa chừng.
    }
    await new Promise<void>((done) => {
      setTimeout(done, CONTAINER_START_BACKOFF_MS * attempt);
    });
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Runner production qua CLI — `db/apply.mts` chạy bằng tsx, một tiến trình riêng
// ---------------------------------------------------------------------------

/** Thư mục gốc của app, tính từ file harness này (`tests/integrations/` — đi lên hai cấp). */
const APP_DIR = dirname(dirname(import.meta.dirname));

const requireFromHere = createRequire(import.meta.url);

export interface ApplyCliResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Chạy **đúng lệnh** mà target `db:migrate` chạy trong CI: `npx tsx
 * --tsconfig tsconfig.db.json db/apply.mts <target>` với `DATABASE_URL`
 * migrator. Exit khác 0 là NÉM kèm stderr — provisioning/test phải đỏ, không
 * nuốt im lặng.
 */
export function runApplyCli(target: LlmDatabaseKey, databaseUrl: string): Promise<ApplyCliResult> {
  // `tsx` tự nó resolve sang `dist/loader.mjs` (API programmatic); CLI thật là
  // subpath `tsx/cli` — đúng binary mà `npx tsx` chạy.
  const tsxCli = requireFromHere.resolve('tsx/cli');
  return new Promise<ApplyCliResult>((resolve, reject) => {
    execFile(
      process.execPath,
      [tsxCli, '--tsconfig', 'tsconfig.db.json', join('db', 'apply.mts'), target],
      {
        cwd: APP_DIR,
        encoding: 'utf8',
        timeout: 120_000,
        // DATABASE_URL chỉ đi qua env của tiến trình con — không argv, không log.
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `db/apply.mts ${target} exited non-zero: ${(error as Error).message}\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export interface BootstrapCliOptions {
  /** Đường dẫn script bootstrap relative tới `apps/llm-api` (vd `db/bootstrap-seller-governance.mts`). */
  readonly script: string;
  readonly databaseUrl: string;
  /** Env bổ sung của run — credential chỉ đi qua env của tiến trình con, không argv. */
  readonly env: Record<string, string>;
}

/**
 * Chạy **đúng lệnh** mà bootstrap command chạy trên lane local: `tsx
 * --tsconfig tsconfig.db.json <script>` với DATABASE_URL + env cấu hình.
 * Exit khác 0 là NÉM kèm stderr — fail-closed của runner phải làm test đỏ.
 * Stdout của run giữ nguyên cho caller parse các dòng máy đọc.
 */
export function runBootstrapCli(options: BootstrapCliOptions): Promise<ApplyCliResult> {
  const tsxCli = requireFromHere.resolve('tsx/cli');
  return new Promise<ApplyCliResult>((resolve, reject) => {
    execFile(
      process.execPath,
      [tsxCli, '--tsconfig', 'tsconfig.db.json', options.script],
      {
        cwd: APP_DIR,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_URL: options.databaseUrl, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `${options.script} exited non-zero: ${(error as Error).message}\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Provisioning **step 1**, làm bằng superuser — đúng vai trò admin/owner.
 *
 * ⚠️ Các việc này **không** nằm trong `db/migrations/` và migration không thể
 * tự làm: `NOCREATEROLE` của migrator nghĩa là nó không tự tạo được chính mình,
 * và `CREATE SCHEMA` cần `CREATE` ở tầng database mà `PUBLIC` không có.
 * Bỏ bước này thì apply dừng ở `0001` với `permission denied` — lỗi provisioning
 * chứ không phải lỗi migration.
 */
async function provision(superuser: Client): Promise<void> {
  await superuser.query(
    `CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  for (const database of Object.values(DATABASES)) {
    await superuser.query(`CREATE DATABASE "${database}" OWNER ${OWNER_ROLE}`);
  }
  for (const key of Object.keys(DATABASES) as LlmDatabaseKey[]) {
    const database = DATABASES[key];
    await superuser.query(
      `CREATE ROLE ${migratorRole(key)} LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await superuser.query(
      `CREATE ROLE ${runtimeRole(key)} LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    // Migrator: CONNECT + CREATE (tạo schema) + TEMP trên DB của chính nó.
    await superuser.query(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${database}" TO ${migratorRole(key)}`,
    );
    // Runtime: chỉ CONNECT. Chặn chéo CONNECT của PUBLIC (kể cả các DB khác của unit).
    await superuser.query(`GRANT CONNECT ON DATABASE "${database}" TO ${runtimeRole(key)}`);
    await superuser.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);
  }
}

/**
 * Tùy chọn dựng database test. Cổng host được Docker cấp **ngẫu nhiên** mặc
 * định; `pinnedPort` ghim cổng host tường minh cho suite cần stop/start lại
 * container: dưới rootless Docker, RootlessKit chỉ giữ/re-bind đúng cổng
 * ghim tường minh khi container start lại — cổng ngẫu nhiên bị mất vĩnh viễn
 * (đo: `NetworkSettings.Ports` sau restart đổi sang cổng khác, cổng cũ refused
 * mãi; đo đạc của suite resilience, 2026-11).
 */
export interface LlmApiDatabaseOptions {
  readonly pinnedPort?: number;
}

/**
 * Dựng container PostgreSQL, provision ba database + role matrix theo pattern
 * ba role, rồi apply migration **ba target** bằng runner production qua tsx
 * với credential migrator thật của từng DB.
 *
 * ⚠️ `reuse` **không** bật: các test assert trên trạng thái database (catalog,
 * grant, số hàng) chứ không chỉ trên dữ liệu mình tạo, và container tái sử dụng
 * mang theo trạng thái run trước.
 *
 * ⚠️ Apply **bằng credential migrator thật** qua tiến trình `tsx` riêng (không
 * phải `SET ROLE` từ superuser): `SET ROLE` không kiểm chứng quyền **kết nối
 * thật**; chạy qua CLI còn kiểm chứng đúng đường code mà `db:migrate` chạy.
 */
export async function startLlmApiDatabase(
  databaseOptions: LlmApiDatabaseOptions = {},
): Promise<LlmApiDatabase> {
  const pinnedPort = databaseOptions.pinnedPort;
  if (
    pinnedPort !== undefined &&
    (!Number.isInteger(pinnedPort) || pinnedPort < 1 || pinnedPort > 65_535)
  ) {
    throw new Error(
      `pinnedPort must be an integer within 1-65535, received: ${String(pinnedPort)}`,
    );
  }
  const container = await startPostgresContainer((c) =>
    c
      // `postgres` là DB built-in của image: testcontainers không tự tạo DB nào
      // thêm, còn cả ba database LLM do `provision()` tạo với owner `ecoma_owner`
      // — đúng pattern ba-role, owner của DB không phải superuser test.
      .withDatabase('postgres')
      .withUsername(SUPERUSER)
      .withPassword(SUPERUSER_PASSWORD)
      .withExposedPorts(
        pinnedPort === undefined ? POSTGRES_PORT : { container: POSTGRES_PORT, host: pinnedPort },
      ),
  );

  try {
    const host = container.getHost();
    const port = pinnedPort ?? container.getMappedPort(POSTGRES_PORT);

    const openWithCredentials = async (options: {
      user: string;
      password: string;
      database: string;
    }): Promise<Client> => {
      const { Client: PgClient } = await pgModule();
      // host/port/database nối vào đây, KHÔNG để pg tự default về localhost:5432
      // — thiếu nó là ECONNREFUSED trên cổng máy host, không phải lỗi container.
      const client = new PgClient({
        host,
        port,
        database: options.database,
        user: options.user,
        password: options.password,
        application_name: 'ecoma-llm-api-itest',
      });
      // Client giữ mở cả đời suite (ít nhất superuser ở dưới) phải có listener
      // `error`: container bị stop giữa chừng (suite resilience) gửi FATAL
      // 57P01 rồi socket đứt — không listener là uncaught exception giết tiến
      // trình vitest. Lỗi của query vẫn đi qua rejection của promise như thường.
      // Ghi log message lỗi (KHÔNG object đầy đủ — tránh rò credential qua
      // serialization) để container chết giữa chừng không câm lặng khi debug.
      client.on('error', (error) => {
        console.error(
          '[llm-api-test-harness] pg client error:',
          error instanceof Error ? error.message : String(error),
        );
      });
      await client.connect();
      return client;
    };

    const connectAsSuperuser = (database: string): Promise<Client> =>
      openWithCredentials({ user: SUPERUSER, password: SUPERUSER_PASSWORD, database });

    const connect = (dbKey: LlmDatabaseKey = 'gateway'): Promise<Client> =>
      connectAsSuperuser(DATABASES[dbKey]);

    const superuser = await connectAsSuperuser('postgres');
    try {
      await provision(superuser);
    } catch (error) {
      await superuser.end().catch(() => undefined);
      throw error;
    }

    // Apply ba target qua runner production — đúng lệnh `db:migrate` chạy trong CI.
    for (const key of Object.keys(DATABASES) as LlmDatabaseKey[]) {
      await runApplyCli(key, migratorUrl(key, host, port));
    }

    const asRole = async (role: string, dbKey: LlmDatabaseKey): Promise<Client> => {
      const client = await connect(dbKey);
      await client.query(`SET ROLE ${role}`);
      return client;
    };

    return {
      host,
      port,
      superuserPassword: SUPERUSER_PASSWORD,
      rolePassword: ROLE_PASSWORD,
      connect,
      asRuntime: (dbKey) => asRole(runtimeRole(dbKey), dbKey),
      asMigrator: (dbKey) => asRole(migratorRole(dbKey), dbKey),
      connectAsRuntime: (dbKey) =>
        openWithCredentials({
          user: runtimeRole(dbKey),
          password: ROLE_PASSWORD,
          database: DATABASES[dbKey],
        }),
      connectAsMigrator: (dbKey) =>
        openWithCredentials({
          user: migratorRole(dbKey),
          password: ROLE_PASSWORD,
          database: DATABASES[dbKey],
        }),
      openWithCredentials,
      stop: async () => {
        await superuser.end().catch(() => undefined);
        await container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: `afterAll` chỉ thấy `db` đã gán hay chưa,
    // exception giữa chừng nếu không dọn để lại container chạy mãi.
    await container.stop().catch(() => undefined);
    throw error;
  }
}
