/**
 * Testcontainers + PostgreSQL thật cho integration test của `db-staff-access`.
 *
 * ⚠️ Docker **là** phụ thuộc cứng của suite này: thiếu Docker thì suite phải ĐỎ,
 * không được skip — một lần chạy skip với exit 0 che mất việc một suite bắt buộc
 * chưa hề chạy (06-testing.md §6). Mọi thứ Docker ở đây nằm sau dynamic import,
 * và quyết định fail được đưa ra qua {@link probeDocker}: probe thất bại là NÉM
 * từ `globalSetup` trước khi worker nào kịp báo xanh giả. Cùng luật với
 * `apps/account/tests/integrations/harness.ts` — pattern tham chiếu.
 *
 * Apply đi qua **runner production** (`db/apply.mts` `applyAllMigrations`) —
 * đúng hàm mà CLI `db:migrate` chạy, gồm advisory lock và assert
 * `current_database()`. Viết vòng apply riêng ở đây là tạo runner thứ hai:
 * "repeatable" sẽ chỉ chứng minh cho bản sao trong khi runner production hỏng —
 * lỗi đã từng xảy ra ở `apps/account` và được ghi trong JSDoc của runner.
 */

import { applyAllMigrations } from '../../db/apply.mts';
import { STAFF_ACCESS_DATABASE } from '../../db/migrate.mts';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 *
 * `gen_random_uuid()` là core từ PostgreSQL 13 nên image này có sẵn — schema
 * `staff_access` không cài extension nào (0001 chỉ dùng plpgsql có sẵn).
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Cổng PostgreSQL **trong container**. Không phải cổng host: testcontainers ánh
 * xạ sang một cổng host ngẫu nhiên và `getMappedPort` đọc cổng đó.
 *
 * ⚠️ Truyền nó vào `withExposedPorts` bằng **varargs** — truyền một mảng đẩy
 * chính cái mảng vào vị trí `port` và container chết trước khi kịp chạy với
 * `invalid port 'undefined'` (đã ghi ở harness của account/auth).
 */
const POSTGRES_PORT = 5_432;

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
/** Mật khẩu chung cho hai role test — secret giả, database ném đi sau mỗi run. */
const ROLE_PASSWORD = 'ecoma_test_role_pw';

type Client = import('pg').Client;

export interface StaffAccessDatabase {
  readonly host: string;
  readonly port: number;
  readonly superuserPassword: string;
  readonly rolePassword: string;
  /** Client superuser cho các assertion về grant và ACL. */
  connect(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_staff_access_runtime` — đúng credential Worker dùng. */
  asRuntime(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_staff_access_migrator`. */
  asMigrator(): Promise<Client>;
  /** Client bằng **credential thật** của migrator — đúng vai trò runner CLI dùng. */
  connectAsMigrator(): Promise<Client>;
  /**
   * Mở một client mới bằng **credential thật** của role (không `SET ROLE`), để
   * kiểm chứng ranh giới ở tầng kết nối chứ không chỉ ở catalog.
   */
  connectAsRuntime(): Promise<Client>;
  /** Xoá sạch dữ liệu giữa các test mà không đụng DDL, grant hay trigger. */
  truncateData(): Promise<void>;
  stop(): Promise<void>;
}

async function pgModule(): Promise<typeof import('pg')> {
  // `pg` là CJS nên namespace (`typeof import('pg')`) là chữ ký đúng ở cả Node
  // lẫn ESM — kiểu của `default` thiếu `PG` (cùng chú thích harness account).
  return import('pg');
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker — mỗi
 * spec file chạy trong worker fork riêng nên cache module scope không vượt qua
 * được ranh giới worker; `process.env` là kênh kế thừa duy nhất đáng tin.
 */
const DOCKER_PROBE_ENV = 'ECOMA_STAFF_ACCESS_DOCKER_PROBE';

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
  cache.ecomaStaffAccessDockerProbe ??= runDockerProbe();
  return cache.ecomaStaffAccessDockerProbe;
}

interface DockerProbeCache {
  ecomaStaffAccessDockerProbe?: Promise<void>;
}

/**
 * Số lần thử lại khi start một container thất bại, và khoảng nghỉ giữa hai lần.
 *
 * ⚠️ Thất bại start **thường là tạm thời**: dưới rootless Docker, nhiều container
 * start song song thi nhau chiếm port host qua RootlessKit và người thua nhận
 * `bind: address already in use` — lỗi biến mất ở lần thử sau (đo được ở harness
 * account/auth; retry với khoảng nghỉ tăng dần là cách rẻ nhất).
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
 * Provisioning **step 1** (`db/README.md` §"Provisioning step 1", pattern
 * `03-operations.md` §3.2), làm bằng superuser — đúng vai trò admin/owner.
 *
 * ⚠️ Các việc này **không** nằm trong `db/migrations/` và migration không thể
 * tự làm: `NOCREATEROLE` của migrator nghĩa là nó không tự tạo được chính mình,
 * và `CREATE SCHEMA` cần `CREATE` ở tầng database mà `PUBLIC` không có.
 * Bỏ bước này thì apply dừng ở `0001` với `permission denied` — lỗi provisioning
 * chứ không phải lỗi migration.
 */
async function provision(superuser: Client): Promise<void> {
  await superuser.query(
    `CREATE ROLE ecoma_staff_access_migrator LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `CREATE ROLE ecoma_staff_access_runtime LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${STAFF_ACCESS_DATABASE}" TO ecoma_staff_access_migrator`,
  );
  await superuser.query(
    `GRANT CONNECT ON DATABASE "${STAFF_ACCESS_DATABASE}" TO ecoma_staff_access_runtime`,
  );
}

/** Bảng data của schema `staff_access` — thứ tự không quan trọng trong MỘT câu TRUNCATE. */
const DATA_TABLES = [
  'staff',
  'permissions',
  'roles',
  'role_permissions',
  'role_assignments',
  'authorization_audit',
  'entitlements',
  'entitlement_outbox_events',
] as const;

/**
 * Dựng container PostgreSQL, provision hai role theo runbook, apply migration
 * bằng runner production với credential migrator thật, rồi trả về handle.
 *
 * ⚠️ `reuse` **không** bật: các test assert trên trạng thái database (catalog,
 * grant, số hàng) chứ không chỉ trên dữ liệu mình tạo, và container tái sử dụng
 * mang theo trạng thái run trước.
 *
 * ⚠️ Apply **bằng credential migrator thật**, không phải `SET ROLE` từ
 * superuser: `SET ROLE` không kiểm chứng quyền **kết nối thật** và giấu đúng
 * lỗi mà `provision()` chú ý — migrator thiếu `CREATE` sẽ chết ngay ở
 * `CREATE SCHEMA`, nhưng `SET ROLE` thì không.
 */
export async function startStaffAccessDatabase(): Promise<StaffAccessDatabase> {
  const container = await startPostgresContainer((c) =>
    c
      .withDatabase(STAFF_ACCESS_DATABASE)
      .withUsername(SUPERUSER)
      .withPassword(SUPERUSER_PASSWORD)
      .withExposedPorts(POSTGRES_PORT),
  );

  try {
    const host = container.getHost();
    const port = container.getMappedPort(POSTGRES_PORT);

    const open = async (options: { user: string; password: string }): Promise<Client> => {
      const { Client: PgClient } = await pgModule();
      // host/port/database nối vào đây, KHÔNG để pg tự default về localhost:5432
      // — thiếu nó là ECONNREFUSED trên cổng máy host, không phải lỗi container.
      const client = new PgClient({
        host,
        port,
        database: STAFF_ACCESS_DATABASE,
        ...options,
        application_name: 'ecoma-staff-access-itest',
      });
      await client.connect();
      return client;
    };

    const connect = (): Promise<Client> => open({ user: SUPERUSER, password: SUPERUSER_PASSWORD });

    const superuser = await connect();
    try {
      await provision(superuser);
    } catch (error) {
      await superuser.end().catch(() => undefined);
      throw error;
    }

    const connectAsMigrator = (): Promise<Client> =>
      open({ user: 'ecoma_staff_access_migrator', password: ROLE_PASSWORD });

    // Apply bằng credential migrator thật qua runner production — xem JSDoc
    // của hàm này và của `applyAllMigrations`.
    const migrator = await connectAsMigrator();
    try {
      await applyAllMigrations(migrator);
    } finally {
      await migrator.end().catch(() => undefined);
    }

    const asRole = async (
      role: 'ecoma_staff_access_runtime' | 'ecoma_staff_access_migrator',
    ): Promise<Client> => {
      const client = await connect();
      await client.query(`SET ROLE ${role}`);
      return client;
    };

    return {
      host,
      port,
      superuserPassword: SUPERUSER_PASSWORD,
      rolePassword: ROLE_PASSWORD,
      connect,
      asRuntime: () => asRole('ecoma_staff_access_runtime'),
      asMigrator: () => asRole('ecoma_staff_access_migrator'),
      connectAsRuntime: () => open({ user: 'ecoma_staff_access_runtime', password: ROLE_PASSWORD }),
      connectAsMigrator: () =>
        open({ user: 'ecoma_staff_access_migrator', password: ROLE_PASSWORD }),
      truncateData: async () => {
        // `TRUNCATE` do superuser chạy: giữ nó ngoài credential runtime để test
        // về grant không bị nhiễu bởi nhu cầu dọn dữ liệu. FK nội bộ schema
        // liệt kê đủ bảng trong MỘT câu TRUNCATE (PostgreSQL khoá tất cả bảng
        // của câu, thứ tự liệt kê không quan trọng).
        const client = await connect();
        try {
          await client.query(`TRUNCATE staff_access.${DATA_TABLES.join(', staff_access.')}`);
        } finally {
          await client.end();
        }
      },
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
