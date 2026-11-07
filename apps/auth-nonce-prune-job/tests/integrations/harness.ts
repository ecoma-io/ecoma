/**
 * Testcontainers + PostgreSQL thật cho integration test của `auth-nonce-prune-job`.
 *
 * ⚠️ Copy có chủ đích của `apps/auth/tests/integrations/harness.ts` — job này là một
 * deploy unit RIÊNG, và database mà nó prune (`db-auth`) thuộc sở hữu của `apps/auth`.
 * 06-testing.md §6 cấm chia sẻ test-support qua ranh giới deploy unit (module-boundary,
 * 05-code-architecture.md §7), nên hai harness giống hệt nhau là **có chủ đích**, không
 * phải nợ kỹ thuật. Hai khác biệt so với bản gốc, cả hai đều bắt buộc bởi chủ thể của
 * suite này:
 *
 *  1. `MIGRATIONS_DIR` trỏ sang `apps/auth/migrations` — migrations của `db-auth` sống
 *     ở app sở hữu database, KHÔNG ở job; đây là đường dẫn FILE (harness đọc và áp nội
 *     dung), không phải import code app→app, nên không tạo cạnh dependency trên project
 *     graph (cùng pattern mà harness PG của `apps/auth/tests/integrations/harness.ts`
 *     dùng cho cùng một thư mục migration).
 *  2. Client là driver `pg` — đúng driver mà job chạy trong production
 *     (`src/main.ts` dựng `pg.Pool` qua Hyperdrive binding), thay vì `postgres` của
 *     harness gốc: suite phải đo ranh quyền và lease bằng chính driver của chủ thể.
 *
 * ⚠️ Docker là phụ thuộc cứng: vắng Docker, suite phải ĐỎ fail-loud, không được skip
 * với exit 0 (docs/architecture/06-testing.md §6). Mọi thứ Docker ở đây nằm sau dynamic
 * import, và {@link probeDocker} ném lỗi thay vì skip khi probe thất bại.
 *
 * Provisioning theo runbook operator (`apps/auth/migrations/README.md` §"Vai trò của
 * operator", auth 03-operations.md §3.2), làm bằng superuser — đúng vai trò admin:
 * tạo role (migrator `NOCREATEROLE` không tự tạo được chính mình), grant `CONNECT,
 * CREATE, TEMPORARY` cho migrator, `CONNECT` cho runtime và pruner, rồi `REVOKE
 * CONNECT … FROM PUBLIC`. Thiếu bước nào, `0001` chết ở `CREATE SCHEMA` với
 * `permission denied` — đó là lỗi provisioning, không phải lỗi migration.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';

import type { Client } from 'pg';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 * `gen_random_uuid()` là core từ PostgreSQL 13 — schema `auth` không cài extension nào.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Cổng PostgreSQL **trong container**. Không phải cổng host: testcontainers ánh xạ
 * sang một cổng host ngẫu nhiên và `getMappedPort` đọc cổng đó.
 *
 * ⚠️ Truyền nó vào `withExposedPorts` bằng **varargs**. `withExposedPorts` nhận
 * `...ports`, nên truyền một mảng đẩy chính cái mảng vào vị trí `port` và daemon
 * trả `invalid port 'undefined'` — hỏng trước khi container kịp chạy, và trông như
 * "Docker hỏng" thay vì "sai API".
 */
const POSTGRES_PORT = 5_432;

/**
 * Database mà migration chạy vào — đúng tên production (`db-auth`), vì tên database
 * là đối tượng của grant/REVOKE ở tầng cluster.
 */
export const AUTH_DATABASE = 'db-auth';

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
/** Mật khẩu chung cho các role test — secret giả, database ném đi sau mỗi run. */
const ROLE_PASSWORD = 'ecoma_test_role_pw';

/**
 * Thư mục migration thật của `db-auth` — sống ở app sở hữu database (`apps/auth`),
 * không ở job. Đường dẫn file để harness ĐỌC, không phải import (xem JSDoc đầu file).
 */
export const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../apps/auth/migrations');

/**
 * Thông tin kết nối cho một database `db-auth` đã provision và đã migrate.
 *
 * `pg.Pool` của role pruner do spec tự dựng qua {@link createPrunerPool} — đúng object
 * mà production nhận vào `PruneTarget.pool`.
 */
export interface PruneJobDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Credential của role pruner — principal thật của job (migration `0014`). */
  readonly prunerUser: string;
  readonly prunerPassword: string;
  /** Credential migrator — DDL/DML cho seed và dọn dữ liệu giữa các test. */
  readonly migratorUser: string;
  readonly migratorPassword: string;
  /** Client `pg` đơn bằng credential migrator — caller tự `end()`. */
  connectMigrator(): Promise<Client>;
  stop(): Promise<void>;
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker.
 *
 * Vitest chạy mỗi spec file trong một worker riêng với module graph riêng (pool
 * `forks`, isolate) — cache ở module scope hay `globalThis` vẫn probe **một lần mỗi
 * file**. `globalSetup` chạy **một lần** trong main process trước khi worker khởi động,
 * và worker kế thừa `process.env` khi được fork — nên biến môi trường là kênh duy nhất
 * đáng tin để "một probe cho cả lần chạy".
 */
const DOCKER_PROBE_ENV = 'ECOMA_NONCE_PRUNE_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest.
 *
 * Probe bằng **chính** container PostgreSQL mà test sẽ dùng, chứ không bằng một lệnh
 * Docker rẻ tiền: một runner không có Docker daemon thì `docker info` vẫn có thể trả 0
 * (chỉ thiếu socket), và probe đó sẽ cho một describe rỗng rồi đỏ ở `beforeAll`.
 *
 * Khi probe thất bại: **ném lỗi** làm toàn bộ lần chạy đỏ ngay lập tức — Docker là phụ
 * thuộc cứng của suite PostgreSQL, vắng Docker là sự cố hạ tầng; suite phải ĐỎ, không
 * được skip với exit 0 (06-testing.md §6 — skip im lặng chính là thứ che mất test).
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
  // Fallback khi được gọi ngoài pipeline vitest có `globalSetup` (chạy tay, vitest
  // khác config): probe tại chỗ và cache trên globalThis cho caller sau.
  const cache = globalThis as DockerProbeCache;
  cache.ecomaNoncePruneDockerProbe ??= runDockerProbe();
  return cache.ecomaNoncePruneDockerProbe;
}

interface DockerProbeCache {
  ecomaNoncePruneDockerProbe?: Promise<void>;
}

/**
 * Số lần thử lại khi start một container thất bại, và khoảng nghỉ giữa hai lần.
 *
 * ⚠️ Thất bại start **thường là tạm thời**, không phải Docker hỏng: dưới rootless
 * Docker, nhiều container start song song thi nhau chiếm port host qua RootlessKit và
 * người thua nhận `bind: address already in use` — HTTP 500 từ daemon, lỗi biến mất ở
 * lần thử sau. Retry với khoảng nghỉ tăng dần là cách rẻ nhất để hai tầng này không
 * nhầm với nhau (đo được ở harness của `apps/auth`).
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
      // Lỗi xảy ra trước khi container kịp chạy (ví dụ port-bind) không để lại gì để
      // dọn; lỗi sau start thì ryuk dọn container theo label của testcontainers. Nuốt
      // ở đây để vòng retry không ném giữa chừng.
    }
    await new Promise<void>((done) => {
      setTimeout(done, CONTAINER_START_BACKOFF_MS * attempt);
    });
  }
  throw lastError;
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
    // `.catch(() => undefined)` chứ không phải block rỗng: `stop()` là cleanup và có
    // thể tự nó ném, nuốt lỗi ở đây để lỗi **thật** của probe không bị che.
    await container?.stop().catch(() => undefined);
  }

  process.env[DOCKER_PROBE_ENV] = available ? 'available' : 'unavailable';
  if (!available) {
    throw new Error(
      'Docker is unavailable: PostgreSQL integration suites require a running Docker daemon; refusing to skip.',
    );
  }
}

async function pgModule(): Promise<typeof import('pg')> {
  // `pg` là CJS nên default interop là đường lấy `Client` đúng ở cả Node lẫn ESM.
  // Trả về namespace chứ không phải `module.default`: kiểu của `default` thiếu `PG`,
  // nên `typeof import('pg')` là chữ ký đúng (pattern runner-harness của `apps/auth`).
  return import('pg');
}

/**
 * Áp mọi file migration, theo thứ tự tên file, vào database vừa provision.
 *
 * ⚠️ **Không kiểm "schema đã có" trước khi áp** — container là của riêng spec file
 * này, chắc chắn chưa có schema `auth`. `pg` với một chuỗi không tham số đi simple
 * query protocol, chạy được chuỗi nhiều statement (gồm khối `DO $$…$$` của `0014`)
 * trong một lần gọi — cùng ngữ nghĩa với `unsafe()` mà harness gốc dùng.
 *
 * ⚠️ Client truyền vào đây phải là **migrator**, không phải superuser. Đó là điều kiện
 * để suite có ý nghĩa: migration phải chạy được bằng đúng credential production được
 * cấp quyền.
 */
async function applyMigrations(migrator: Client): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    // Thứ tự số trong tên file là thứ tự áp dụng; so chuỗi là đủ vì tất cả gốc 4 chữ số.
    .toSorted();

  for (const file of files) {
    await migrator.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

/**
 * Provisioning theo runbook operator (`apps/auth/migrations/README.md` §"Vai trò của
 * operator"), làm bằng superuser — đúng vai trò admin, không phải migration.
 *
 * ⚠️ Các việc này **không** nằm trong file migration `0001`–`0014`:
 *
 *  1. `CREATE ROLE … LOGIN` — migration không tạo role: `NOCREATEROLE` của migrator
 *     nghĩa là nó không tự tạo được chính mình. Role phải do admin tạo; guard `DO $$`
 *     của `0014` chỉ là lưới an toàn.
 *  2. `GRANT CREATE ON DATABASE` — `CREATE SCHEMA` cần nó, PostgreSQL không cấp cho
 *     `PUBLIC`, và migrator không sở hữu database nên không tự cấp được.
 *  3. `REVOKE CONNECT … FROM PUBLIC` — chặn chéo là việc của owner: migrator thiếu
 *     quyền sở hữu database, chạy `REVOKE` chỉ in
 *     `WARNING: no privileges could be revoked` rồi để `CONNECT` nguyên.
 *
 * Bỏ bước 1 hoặc 2 thì `0001` dừng ở `CREATE SCHEMA` với `permission denied`; bỏ
 * bước 3 thì các test về ranh giới database pass vì lý do sai.
 */
async function provision(superuser: Client): Promise<void> {
  await superuser.query(
    `CREATE ROLE ecoma_auth_migrator LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `CREATE ROLE ecoma_auth_runtime LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  // Role pruner của chính job này (`0014`): cùng lý do hai role trên — migrator
  // `NOCREATEROLE` không tự tạo được, guard của `0014` chỉ là lưới an toàn nên role
  // phải do admin tạo trước khi migration chạy.
  await superuser.query(
    `CREATE ROLE ecoma_auth_nonce_pruner LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${AUTH_DATABASE}" TO ecoma_auth_migrator`,
  );
  // Runtime chỉ DML — không `CREATE` trên bất kỳ schema nào (NFR-002a).
  await superuser.query(`GRANT CONNECT ON DATABASE "${AUTH_DATABASE}" TO ecoma_auth_runtime`);
  // Pruner không cần `CREATE` hay `TEMPORARY`: ba câu SQL của job chỉ đọc catalog và
  // DML đúng một bảng — grant thật nằm trong `0014`, đây chỉ là quyền kết nối.
  await superuser.query(`GRANT CONNECT ON DATABASE "${AUTH_DATABASE}" TO ecoma_auth_nonce_pruner`);
  await superuser.query(`REVOKE CONNECT ON DATABASE "${AUTH_DATABASE}" FROM PUBLIC`);
}

/**
 * Dựng container PostgreSQL, provision ba role theo runbook, apply 14 migration thật
 * của `apps/auth/migrations` bằng credential migrator thật, rồi trả về handle.
 *
 * ⚠️ `reuse` **không** bật. Mỗi spec file cần một container sạch: các test assert trên
 * trạng thái database (grant, số hàng) chứ không chỉ trên dữ liệu mình tạo, và
 * container bị tái sử dụng mang theo trạng thái run trước.
 *
 * ⚠️ Apply **bằng credential migrator thật**, không phải `SET ROLE` từ superuser:
 * `SET ROLE` không kiểm chứng quyền **kết nối thật** và giấu đúng lỗi mà
 * {@link provision} chú ý — migrator thiếu `CREATE` sẽ chết ngay ở `CREATE SCHEMA`,
 * nhưng `SET ROLE` thì không.
 */
export async function startPruneJobDatabase(): Promise<PruneJobDatabase> {
  const container = await startPostgresContainer((c) =>
    c
      .withDatabase(AUTH_DATABASE)
      .withUsername(SUPERUSER)
      .withPassword(SUPERUSER_PASSWORD)
      .withExposedPorts(POSTGRES_PORT),
  );

  try {
    const host = container.getHost();
    const port = container.getMappedPort(POSTGRES_PORT);
    const base = { host, port, database: AUTH_DATABASE } as const;

    const openClient = async (user: string, password: string): Promise<Client> => {
      const { Client: PgClient } = await pgModule();
      const client = new PgClient({
        ...base,
        user,
        password,
        application_name: 'ecoma-nonce-prune-job-test',
      });
      await client.connect();
      return client;
    };

    const superuser = await openClient(SUPERUSER, SUPERUSER_PASSWORD);
    try {
      await provision(superuser);
    } finally {
      await superuser.end().catch(() => undefined);
    }

    const migrator = await openClient('ecoma_auth_migrator', ROLE_PASSWORD);
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end().catch(() => undefined);
    }

    return {
      host,
      port,
      database: AUTH_DATABASE,
      prunerUser: 'ecoma_auth_nonce_pruner',
      prunerPassword: ROLE_PASSWORD,
      migratorUser: 'ecoma_auth_migrator',
      migratorPassword: ROLE_PASSWORD,
      connectMigrator: () => openClient('ecoma_auth_migrator', ROLE_PASSWORD),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: `afterAll` chỉ thấy `db` đã gán hay chưa, exception
    // giữa chừng nếu không dọn để lại container chạy mãi (cùng kiểu rò mà harness của
    // `apps/account` đã ghi).
    await container.stop().catch(() => undefined);
    throw error;
  }
}

/**
 * `pg.Pool` của role pruner — đúng object mà production nhận vào `PruneTarget.pool`.
 *
 * Các con số giữ nguyên mốc của `createPoolFor` trong `src/main.ts` (`max: 4`,
 * `idleTimeoutMillis: 600_000`, `connectionTimeoutMillis: 15_000`): chỉ thay Hyperdrive
 * binding bằng host/port của container, mọi thuộc tính khác của pool phải giống hệt để
 * test đo đúng hành vi mà production chạy.
 */
export function createPrunerPool(db: PruneJobDatabase): Pool {
  return new Pool({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.prunerUser,
    password: db.prunerPassword,
    max: 4,
    idleTimeoutMillis: 600_000,
    connectionTimeoutMillis: 15_000,
  });
}
