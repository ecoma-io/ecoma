/**
 * Testcontainers + PostgreSQL thật cho integration test của `db-backoffice`.
 *
 * ⚠️ Docker **là** phụ thuộc cứng của suite này: thiếu Docker thì suite phải ĐỎ,
 * không được skip - một lần chạy skip với exit 0 che mất việc một suite bắt buộc
 * chưa hề chạy (06-testing.md §6). Mọi thứ Docker ở đây nằm sau dynamic import,
 * và quyết định fail được đưa ra qua {@link probeDocker}: probe thất bại là NÉM
 * từ `globalSetup` trước khi worker nào kịp báo xanh giả. Cùng luật với
 * `apps/auth/tests/integrations/harness.ts` và `apps/account/tests/integrations/harness.ts`
 * — pattern tham chiếu.
 */

import { applyAllMigrations } from '../../db/apply.mts';
import { BACKOFFICE_DATABASE } from '../../db/migrate.mts';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 *
 * `gen_random_uuid()` là core từ PostgreSQL 13 nên image này có sẵn — không
 * cần extension nào cho mặc định của `authorization_audit.id`, và `0001`
 * không cài extension nào. `dblink` và `postgres_fdw` thì **không** được cài
 * ở đây dưới bất kỳ hình thức nào (ranh giới None-DB).
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Cổng PostgreSQL **trong container**. Không phải cổng host: testcontainers
 * ánh xạ sang một cổng host ngẫu nhiên và `getMappedPort` đọc cổng đó.
 *
 * ⚠️ Truyền nó vào `withExposedPorts` bằng **varargs**. `withExposedPorts` nhận
 * `...ports`, nên truyền một mảng (`[POSTGRES_PORT]`) đẩy chính cái mảng vào vị
 * trí `port` — lỗi của Docker daemon là `invalid port 'undefined'`, trông như
 * "Docker hỏng" thay vì "sai API".
 */
const POSTGRES_PORT = 5_432;

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
const ROLE_PASSWORD = 'ecoma_test_role_pw';

type Client = import('pg').Client;

export interface BackofficeDatabase {
  readonly host: string;
  readonly port: number;
  readonly superuserPassword: string;
  readonly rolePassword: string;
  /** Client superuser cho các assertion về grant và ACL. */
  connect(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_backoffice_runtime` — đúng credential Worker dùng. */
  asRuntime(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_backoffice_migrator`. */
  asMigrator(): Promise<Client>;
  /**
   * Mở một client mới bằng **credential thật** của runtime role (không
   * `SET ROLE`), để kiểm chứng ranh giới ở tầng kết nối chứ không chỉ ở
   * `has_*_privilege`.
   */
  connectAsRuntime(): Promise<Client>;
  /** Xoá sạch dữ liệu giữa các test mà không đụng DDL, grant hay extension. */
  truncateData(): Promise<void>;
  stop(): Promise<void>;
}

async function pgModule(): Promise<typeof import('pg')> {
  // `pg` là CJS nên default interop là đường lấy `Client` đúng ở cả Node lẫn
  // ESM. Trả về namespace (typeof import('pg')) chứ không phải `module.default`.
  const module = await import('pg');
  return module;
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker.
 *
 * Vitest chạy mỗi spec file trong một worker riêng với globalThis/module graph
 * riêng (pool forks, isolate) — cache ở module scope hay globalThis vì thế
 * vẫn probe **một lần mỗi file**. `globalSetup` chạy **một lần** trong main
 * process trước khi worker khởi động, và worker kế thừa `process.env` khi được
 * fork — nên biến môi trường là kênh duy nhất đáng tin để "một probe cho cả
 * lần chạy".
 */
const DOCKER_PROBE_ENV = 'ECOMA_BACKOFFICE_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest.
 *
 * Probe bằng **chính** container PostgreSQL mà test sẽ dùng, chứ không bằng
 * một lệnh Docker rẻ tiền: một runner không có Docker daemon thì `docker info`
 * vẫn có thể trả 0 (chỉ thiếu socket), và probe đó sẽ cho một describe
 * "N skipped" rồi đỏ ở `beforeAll`.
 *
 * ⚠️ Probe thất bại là **ném lỗi**, không trả `false`: suite bắt buộc Docker
 * phải đỏ khi Docker không có — skip với exit 0 không phải kết quả chấp nhận
 * được (06-testing.md §6). Lỗi nổi từ `globalSetup` làm toàn bộ lần chạy đỏ
 * trước khi worker nào kịp báo xanh giả.
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
  cache.ecomaBackofficeDockerProbe ??= runDockerProbe();
  return cache.ecomaBackofficeDockerProbe;
}

interface DockerProbeCache {
  ecomaBackofficeDockerProbe?: Promise<void>;
}

/**
 * Số lần thử lại khi start một container thất bại, và khoảng nghỉ giữa hai
 * lần.
 *
 * ⚠️ Thất bại start **thường là tạm thời**, không phải Docker hỏng: dưới
 * rootless Docker, nhiều container start song song thi nhau chiếm port host,
 * và người thua nhận `bind: address already in use` — HTTP 500 từ daemon, lỗi
 * biến mất ở lần thử sau. Retry với khoảng nghỉ tăng dần là cách rẻ nhất để
 * hai tầng này không bị nhầm với nhau.
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
      // Lỗi xảy ra trước khi container kịp chạy (port-bind) không để lại gì
      // để dọn; lỗi sau start thì ryuk dọn container theo label của
      // testcontainers. Nuốt ở đây để vòng retry không ném giữa chừng.
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
    // `.catch(() => {})` chứ không phải block rỗng: `stop()` là cleanup và có
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

/**
 * Apply mọi file migration, theo thứ tự tên file, vào database đã có sẵn.
 *
 * Tách riêng khỏi `startBackofficeDatabase` để test "apply lại là no-op" gọi
 * lại được đúng hàm mà lần apply đầu đã gọi — chỉ một đường code duy nhất qua
 * {@link applyAllMigrations}, gồm cả advisory lock.
 *
 * ⚠️ Client truyền vào đây phải là **migrator**, không phải superuser. Xem
 * `provision()` để biết vì sao đó là điều kiện để test có ý nghĩa.
 */
export async function applyMigrations(client: Client): Promise<void> {
  await applyAllMigrations(client);
}

/**
 * Provisioning **step 1-partial** làm bằng superuser — đúng vai admin/owner,
 * những thứ migration **không** tự làm được:
 *
 *  1. `CREATE ROLE … LOGIN` — `0001`/`0002` có guard tạo role NON-LOGIN, nhưng
 *     test cần role LOGIN để kết nối bằng credential thật, và các attribute
 *     LOGIN không thể tự cấp (`NOCREATEROLE` của role là điều đó).
 *  2. `GRANT CREATE ON DATABASE` — `CREATE SCHEMA` cần `CREATE` trên database,
 *     `PUBLIC` không có.
 *
 * ⚠️ Bỏ bước 1 hoặc 2 thì `apply.mts` chết ngay ở `0001` với
 * `permission denied` — đó là case các test "provisioning step 1" kiểm chứng,
 * không phải việc harness len lỏi đi qua. Test có ý nghĩa vì apply chạy bằng
 * **credential migrator thật** ngay sau đây, không phải `SET ROLE` từ
 * superuser.
 */
async function provision(superuser: Client): Promise<void> {
  // Hai role đều là CREATE (không ALTER): guard trong `0001`/`0002` chỉ tạo
  // role NON-LOGIN, còn test cần role LOGIN để kết nối bằng credential thật.
  // Cả hai đều do admin tạo — cùng lý do `apps/account` ghi chú: migrator
  // `NOCREATEROLE` nên không thể tự cấp LOGIN cho role mình tạo.
  await superuser.query(
    `CREATE ROLE ecoma_backoffice_migrator LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `CREATE ROLE ecoma_backoffice_runtime LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${BACKOFFICE_DATABASE}" TO ecoma_backoffice_migrator`,
  );
}

/**
 * Dựng container PostgreSQL, provision hai role, apply migration, rồi trả về
 * handle.
 *
 * ⚠️ `reuse` **không** bật. Mỗi run cần một container sạch: các test assert
 * trên trạng thái database (số bảng, ACL, extension đã cài) chứ không chỉ
 * trên dữ liệu mình tạo, và container bị tái sử dụng mang theo trạng thái của
 * run trước.
 *
 * ⚠️ Apply **ở đây**, không để mỗi spec tự apply: `0002` có REVOKE ở tầng
 * schema, nhiều container song song sẽ chặn lẫn nhau. Một container cho cả
 * suite thì các spec chỉ lo việc của mình.
 */
export async function startBackofficeDatabase(): Promise<BackofficeDatabase> {
  const container = await startPostgresContainer((c) =>
    c
      .withDatabase(BACKOFFICE_DATABASE)
      .withUsername(SUPERUSER)
      .withPassword(SUPERUSER_PASSWORD)
      .withExposedPorts(POSTGRES_PORT),
  );

  try {
    const host = container.getHost();
    const port = container.getMappedPort(POSTGRES_PORT);

    const open = async (options: {
      user: string;
      password: string;
      database: string;
    }): Promise<Client> => {
      const { Client: PgClient } = await pgModule();
      const client = new PgClient({ host, port, ...options });
      await client.connect();
      return client;
    };

    const connect = (): Promise<Client> =>
      open({ user: SUPERUSER, password: SUPERUSER_PASSWORD, database: BACKOFFICE_DATABASE });

    const connectAsMigrator = (): Promise<Client> =>
      open({
        user: 'ecoma_backoffice_migrator',
        password: ROLE_PASSWORD,
        database: BACKOFFICE_DATABASE,
      });

    const superuser = await connect();

    await provision(superuser);

    // Apply bằng **credential migrator thật**, không phải `SET ROLE` từ
    // superuser: `SET ROLE` không kiểm chứng được quyền **kết nối thật**, và nó
    // giấu đúng loại lỗi mà `provision()` ở trên phục vụ để bắt.
    const migrator = await connectAsMigrator();
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }
    await superuser.end();

    const asRole = async (
      role: 'ecoma_backoffice_runtime' | 'ecoma_backoffice_migrator',
    ): Promise<Client> => {
      const client = await connect();
      await client.query(`SET ROLE ${role}`);
      return client;
    };

    const truncateData = async (): Promise<void> => {
      // `TRUNCATE` của `db-backoffice`, không đụng DDL, grant hay extension.
      // Thứ tự liệt kê không quan trọng trong MỘT câu TRUNCATE (PostgreSQL
      // khoá tất cả bảng của câu), nhưng bảng con PHẢI có mặt — bỏ sót một
      // bảng có FK là lỗi "cannot truncate a table referenced in a foreign
      // key constraint". `authorization_audit` cỡ `security_events` cũng nên
      const client = await connect();
      try {
        await client.query(
          `TRUNCATE backoffice.bff_login_flows, backoffice.bff_sessions,
                  backoffice.authorization_audit, backoffice.role_assignments,
                  backoffice.role_permissions, backoffice.roles, backoffice.permissions,
                  backoffice.staff`,
        );
      } finally {
        await client.end();
      }
    };

    return {
      host,
      port,
      superuserPassword: SUPERUSER_PASSWORD,
      rolePassword: ROLE_PASSWORD,
      connect,
      asRuntime: () => asRole('ecoma_backoffice_runtime'),
      asMigrator: () => asRole('ecoma_backoffice_migrator'),
      connectAsRuntime: () =>
        open({
          user: 'ecoma_backoffice_runtime',
          password: ROLE_PASSWORD,
          database: BACKOFFICE_DATABASE,
        }),
      truncateData,
      // `stop()` trả về container đã dừng, còn interface khai báo `Promise<void>` —
      // bọc lại để không lộ chi tiết của testcontainers ra ngoài.
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: afterAll chỉ gọi db?.stop() khi db đã được
    // gán, nên exception ở giữa để lại container chạy mãi và tích luỹ qua các
    // lần chạy lại.
    await container.stop().catch(() => undefined);
    throw error;
  }
}

export { BACKOFFICE_DATABASE, POSTGRES_IMAGE, SUPERUSER };
