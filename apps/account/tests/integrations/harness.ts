/**
 * Testcontainers + PostgreSQL thật cho integration test của `db-account`.
 *
 * ⚠️ Docker **là** phụ thuộc cứng của suite này: thiếu Docker thì suite phải ĐỎ,
 * không được skip - một lần chạy skip với exit 0 che mất việc một suite bắt buộc
 * chưa hề chạy (06-testing.md §6). Mọi thứ Docker ở đây nằm sau dynamic import,
 * và quyết định fail được đưa ra qua {@link probeDocker}: probe thất bại là NÉM
 * từ `globalSetup` trước khi worker nào kịp báo xanh giả. Cùng luật với
 * `apps/auth/tests/integrations/harness.ts` — pattern tham chiếu.
 */

import { createHash } from 'node:crypto';

import { applyAllMigrations } from '../../db/apply.mts';
import { ACCOUNT_DATABASE, AUTH_DATABASE } from '../../db/migrate.mts';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 *
 * `gen_random_uuid()` là core từ PostgreSQL 13 nên image này có sẵn — không
 * cần extension nào cho mặc định của `security_events.event_id`, và `0001`
 * không cài thêm gì. `dblink` và `postgres_fdw` thì **không** được cài ở đây
 * dưới bất kỳ hình thức nào (NFR-002b).
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Cổng PostgreSQL **trong container**. Không phải cổng host: testcontainers ánh
 * xạ sang một cổng host ngẫu nhiên và `getMappedPort` đọc cổng đó. Con số này
 * chỉ cần khác `5432` để không lẫn với một PostgreSQL local.
 *
 * ⚠️ Truyền nó vào `withExposedPorts` bằng **varargs**. `withExposedPorts` nhận
 * `...ports`, nên truyền một mảng (`[POSTGRES_PORT]`) đẩy chính cái mảng vào vị
 * trí `port`, và `getContainerPort` trả `port.container` là `undefined` — lỗi
 * của Docker daemon là `invalid port 'undefined'`, tức là hỏng **trước** khi
 * container kịp chạy, và trông như "Docker hỏng" thay vì "sai API".
 */
const POSTGRES_PORT = 5_432;

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
const ROLE_PASSWORD = 'ecoma_test_role_pw';

type Client = import('pg').Client;
type Pool = import('pg').Pool;

export interface AccountDatabase {
  readonly host: string;
  readonly port: number;
  readonly superuserPassword: string;
  readonly rolePassword: string;
  /** Client superuser cho các assertion về grant và ACL. */
  connect(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_account_runtime` — đúng credential Worker dùng. */
  asRuntime(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_account_migrator`. */
  asMigrator(): Promise<Client>;
  /**
   * Mở một client mới bằng **credential thật** của role (không `SET ROLE`), để
   * kiểm chứng ranh giới ở tầng kết nối chứ không chỉ ở `has_database_privilege`.
   */
  connectAsRuntime(): Promise<Client>;
  /**
   * `pg.Pool` bằng credential thật của runtime role — đúng kiểu mà
   * `server/utils/db.ts` nhận (`selectAccountStatus`, `recordNonce`). Caller
   * tự `end()` pool sau khi dùng.
   */
  createRuntimePool(): Promise<Pool>;
  /** Xoá sạch dữ liệu giữa các test mà không đụng DDL, grant hay extension. */
  truncateData(): Promise<void>;
  stop(): Promise<void>;
}

async function pgModule(): Promise<typeof import('pg')> {
  // `pg` là CJS nên default interop là đường lấy `Client` đúng ở cả Node lẫn
  // ESM. Trả về namespace (`typeof import('pg')`) chứ không phải `module.default`:
  // kiểu của `default` thiếu `PG`, nên `typeof import('pg')` là chữ ký đúng.
  const module = await import('pg');
  return module;
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker.
 *
 * Vitest chạy mỗi spec file trong một worker riêng với globalThis/module graph
 * riêng (pool `forks`, isolate) — cache ở module scope hay `globalThis` vì thế
 * vẫn probe **một lần mỗi file**, đúng cái đo được trước đây (2 file ⇒ 2 probe).
 * `globalSetup` chạy **một lần** trong main process trước khi worker khởi động,
 * và worker kế thừa `process.env` khi được fork — nên biến môi trường là kênh
 * duy nhất đáng tin để "một probe cho cả lần chạy".
 */
const DOCKER_PROBE_ENV = 'ECOMA_ACCOUNT_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest.
 *
 * Probe bằng **chính** container PostgreSQL mà test sẽ dùng, chứ không bằng một
 * lệnh Docker rẻ tiền: một runner không có Docker daemon thì `docker info` vẫn
 * có thể trả 0 (chỉ thiếu socket), và probe đó sẽ cho một `describe` "3 skipped"
 * rồi đỏ ở `beforeAll`. Tốn vài giây cho lần đầu, nhưng nó loại được đúng cái
 * nguy hiểm nhất: một suite báo skip vì hạ tầng, không phải vì hành vi.
 *
 * Khi probe thất bại:
 * - **Ném lỗi** làm toàn bộ lần chạy đỏ ngay lập tức: Docker là phụ thuộc cứng
 *   của suite PostgreSQL, vắng Docker là sự cố hạ tầng — suite phải ĐỎ, không
 *   được skip với exit 0 (skip im lặng chính là thứ che mất test).
 *   docs/architecture/06-testing.md §6 chốt chính sách fail-loud này.
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
  // vitest khác config): probe tại chỗ và vẫn đăng ký kết quả cho caller sau.
  const cache = globalThis as DockerProbeCache;
  cache.ecomaAccountDockerProbe ??= runDockerProbe();
  return cache.ecomaAccountDockerProbe;
}

interface DockerProbeCache {
  ecomaAccountDockerProbe?: Promise<void>;
}

/**
 * Số lần thử lại khi start một container thất bại, và khoảng nghỉ giữa hai lần.
 *
 * ⚠️ Thất bại start **thường là tạm thời**, không phải Docker hỏng: dưới rootless
 * Docker, nhiều container start song song (mỗi spec một container, cộng probe —
 * ~12 khi `nx run-many -t test` chạy ba project) thi nhau chiếm port host qua
 * RootlessKit, và người thua nhận
 * `RootlessKit PortManager.AddPort(): bind: address already in use` — HTTP 500
 * từ daemon, lỗi biến mất ở lần thử sau. Đã đo được: run song song ba project
 * đỏ 3/5 lần vì lỗi này, trong khi từng project riêng lẻ thì xanh 100%. Retry
 * với khoảng nghỉ tăng dần là cách rẻ nhất để hai tầng này không nhầm với nhau.
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
      // Lỗi xảy ra trước khi container kịp chạy (ví dụ port-bind) không để lại
      // gì để dọn; lỗi sau start thì ryuk dọn container theo label của
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
 * Tách riêng khỏi `startAccountDatabase` để test "apply lại là no-op" gọi lại
 * được đúng hàm mà lần apply đầu đã gọi — nếu có hai đường code cho cùng một việc
 * thì "repeatable" chỉ chứng minh cho một trong hai.
 *
 * ⚠️ Đây chỉ là **dải băng** gọi {@link applyAllMigrations} (`db/apply.mts`) —
 * đúng hàm mà CLI `db:migrate` chạy, gồm cả advisory lock và GUC. Viết lại vòng
 * apply ở đây (điều đã từng xảy ra) là tạo một runner thứ hai không có lock:
 * test "repeatable" xanh với bản sao trong khi runner production hỏng.
 *
 * ⚠️ Client truyền vào đây phải là **migrator**, không phải superuser. Xem
 * `provision()` để biết vì sao đó là điều kiện để test có ý nghĩa.
 */
export async function applyMigrations(client: Client): Promise<void> {
  await applyAllMigrations(client);
}

/**
 * Provisioning **step 1** (`03-operations.md` §3.2), làm bằng superuser —
 * đúng vai trò admin/owner, không phải migration.
 *
 * ⚠️ Ba việc này **không** nằm trong `db/migrations/`, và đó là phát hiện từ
 * chạy thật chứ không phải suy ra:
 *
 *  1. `CREATE ROLE … LOGIN` — `0001` có guard tạo role, nhưng `NOCREATEROLE` có
 *     nghĩa là migrator **không** tự tạo được chính nó. Role phải do admin tạo.
 *  2. `GRANT CREATE ON DATABASE` — `CREATE SCHEMA` cần nó, PostgreSQL không cấp
 *     cho `PUBLIC`, và migrator không sở hữu database nên không tự cấp được.
 *  3. `CREATE DATABASE db-auth` — để `REVOKE CONNECT` trong `0002` có đối tượng
 *     thật.
 *
 * Bỏ bước 1 hoặc 2 thì `apply.ts` dừng ở `0001` với `permission denied`; bỏ bước
 * 3 thì AC-012 pass vì lý do sai (guard bỏ qua chứ không phải chặn thật).
 */
async function provision(superuser: Client): Promise<void> {
  await superuser.query(`CREATE DATABASE "${AUTH_DATABASE}"`);
  await superuser.query(
    `CREATE ROLE ecoma_account_migrator LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  // Runtime role có thể để `0002` tạo vì `0002` chạy bởi migrator… mà migrator
  // `NOCREATEROLE`. Nên nó cũng phải do admin tạo — xem `roles.spec.ts`.
  await superuser.query(
    `CREATE ROLE ecoma_account_runtime LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${ACCOUNT_DATABASE}" TO ecoma_account_migrator`,
  );
  // ⚠️ Chặn chéo **phải** do owner làm, không phải bởi migration: `REVOKE CONNECT
  // ON DATABASE db-auth` cần quyền sở hữu `db-auth`, mà migrator không có và
  // không được có. Chạy nó bằng migrator chỉ in `WARNING: no privileges could be
  // revoked` rồi để `CONNECT` nguyên — xem giải thích dài trong
  // `0002_roles_and_grants.sql`.
  await superuser.query(`REVOKE CONNECT ON DATABASE "${AUTH_DATABASE}" FROM PUBLIC`);
  await superuser.query(`REVOKE CONNECT ON DATABASE "${AUTH_DATABASE}" FROM ecoma_account_runtime`);
  // Role pruner của cron Worker `apps/auth-nonce-prune-job` (`0007`): cùng lí do
  // hai role trên — migrator `NOCREATEROLE` không tự tạo được, guard của `0007`
  // chỉ là lưới an toàn nên role phải do admin tạo trước khi migration chạy.
  await superuser.query(
    `CREATE ROLE ecoma_account_nonce_pruner LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
}

/**
 * Dựng container PostgreSQL, tạo `db-auth`, apply migration, rồi trả về handle.
 *
 * ⚠️ `reuse` **không** bật. Mỗi run cần một container sạch: các test assert trên
 * trạng thái database (số bảng, ACL, extension đã cài) chứ không chỉ trên dữ liệu
 * mình tạo, và container bị tái sử dụng mang theo trạng thái của run trước.
 *
 * `db-auth` được tạo **trước** khi apply. Đó không phải chi tiết trang trí: nếu
 * database đích chưa tồn tại thì guard trong `0002` bỏ qua, và AC-012 sẽ pass vì
 * lý do sai.
 *
 * ⚠️ Apply **ở đây**, không để mỗi spec tự apply: `0002` có `REVOKE` ở tầng
 * cluster, nên nhiều container song song sẽ chặn lẫn nhau. Một container cho cả
 * suite thì các spec chỉ lo việc của mình.
 */
export async function startAccountDatabase(): Promise<AccountDatabase> {
  const container = await startPostgresContainer((c) =>
    c
      .withDatabase(ACCOUNT_DATABASE)
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
      open({ user: SUPERUSER, password: SUPERUSER_PASSWORD, database: ACCOUNT_DATABASE });

    const connectAsMigrator = (): Promise<Client> =>
      open({
        user: 'ecoma_account_migrator',
        password: ROLE_PASSWORD,
        database: ACCOUNT_DATABASE,
      });

    const superuser = await connect();

    await provision(superuser);

    // Apply bằng **credential migrator thật**, không phải `SET ROLE` từ superuser:
    // `SET ROLE` không kiểm chứng được quyền **kết nối thật**, và nó giấu đúng cái
    // lỗi mà `provision()` ở trên chú ý — migrator thiếu `CREATE` sẽ chết ngay ở
    // `CREATE SCHEMA`, nhưng `SET ROLE` thì không.
    //
    // GUC `ecoma.auth_database` do `applyMigrations` tự `SET` trên chính connection
    // đó, nên không cần `ALTER ROLE … IN DATABASE … SET` (và đặt ở connection
    // superuser cũng vô nghĩa: nó không áp dụng sang connection của migrator).
    const migrator = await connectAsMigrator();
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }
    await superuser.end();

    const asRole = async (
      role: 'ecoma_account_runtime' | 'ecoma_account_migrator',
    ): Promise<Client> => {
      const client = await connect();
      await client.query(`SET ROLE ${role}`);
      return client;
    };

    const createRuntimePool = async (): Promise<Pool> => {
      // Pool bằng credential **thật** của runtime role (không `SET ROLE`): các
      // hàm trong `server/utils/db.ts` nhận `Pool` và Worker cũng kết nối bằng
      // credential thật qua Hyperdrive — `SET ROLE` sẽ giấu đúng lỗi thiếu quyền
      // ở tầng kết nối.
      const { Pool: PgPool } = await pgModule();
      return new PgPool({
        host,
        port,
        user: 'ecoma_account_runtime',
        password: ROLE_PASSWORD,
        database: ACCOUNT_DATABASE,
      });
    };

    const truncateData = async (): Promise<void> => {
      // `TRUNCATE` của `db-account`, không đụng DDL, grant hay extension.
      //
      // Thứ tự liệt kê không quan trọng trong MỘT câu TRUNCATE (PostgreSQL khoá
      // tất cả bảng của câu), nhưng `email_addresses` và ba bảng data domain
      // PHẢI có mặt: chúng giữ FK tới `users`, và TRUNCATE `users` mà bỏ qua
      // bảng con là lỗi "cannot truncate a table referenced in a foreign key
      // constraint" — bỏ sót một bảng mới ở đây làm MỌI suite dùng
      // `truncateData` đỏ cùng một lỗi.
      const client = await connect();
      try {
        await client.query(
          `TRUNCATE account.login_handoffs, account.security_events,
                  account.account_outbox_events, account.account_sessions, account.users,
                  account.email_addresses, account.otp_challenges,
                  account.user_profiles, account.user_preferences,
                  account.notification_preferences`,
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
      asRuntime: () => asRole('ecoma_account_runtime'),
      asMigrator: () => asRole('ecoma_account_migrator'),
      connectAsRuntime: () =>
        open({
          user: 'ecoma_account_runtime',
          password: ROLE_PASSWORD,
          database: ACCOUNT_DATABASE,
        }),
      createRuntimePool,
      truncateData,
      // `stop()` trả về container đã dừng, còn interface khai báo `Promise<void>` —
      // bọc lại để không lộ chi tiết của testcontainers ra ngoài.
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: `afterAll` chỉ gọi `db?.stop()` khi `db`
    // đã được gán, nên exception ở giữa để lại container chạy mãi và tích
    // luỹ qua các lần chạy lại — đúng kiểu rò mà review chỉ ra.
    await container.stop().catch(() => undefined);
    throw error;
  }
}

/**
 * Hash một chuỗi bằng SHA-256 ở tầng ứng dụng.
 *
 * Test chỉ cần chứng minh *cột lưu trữ khác giá trị cookie*, nên thuật toán nào
 * không quan trọng. Cột trong schema không ràng buộc thuật toán — đó là lựa chọn
 * của tầng ứng dụng, và đổi thuật toán không được phá dữ liệu cũ.
 */
export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Vòng hết hạn lệch vài phút, đủ để không đụng ràng buộc `expires_at > created_at`. */
export function futureInstant(): Date {
  return new Date(Date.now() + 300_000);
}

export { ACCOUNT_DATABASE, AUTH_DATABASE, POSTGRES_IMAGE, SUPERUSER };
