/**
 * Testcontainers + PostgreSQL thật cho integration test PG của `apps/auth`.
 *
 * ⚠️ Docker là phụ thuộc cứng: vắng Docker, suite phải ĐỎ fail-loud, không
 * được skip với exit 0 (docs/architecture/06-testing.md §6) — skip im lặng chính
 * là thứ che mất test. Mọi thứ Docker ở đây nằm sau dynamic import, và
 * {@link probeDocker} ném lỗi thay vì skip khi probe thất bại.
 *
 * ⚠️ Mỗi spec file PG tự dựng **một container riêng** (`startAuthDatabase`), khác
 * với hình thức cũ chia sẻ một database qua biến `AUTH_TEST_PG_*`: các suite của
 * app (`internal-auth`, `internal-handlers`, `oidc-fullflow`, `oidc/adapter`) đều
 * viết test như thể chúng sở hữu schema — xoá theo marker riêng, đếm toàn bảng —
 * nên một database chung là nguồn xung đột lịch chạy (`relation "…" already
 * exists`, `count(*)` dính hàng của suite khác). Container riêng biến các khoá
 * advisory chia sẻ (`SCHEMA_SETUP_LOCK_KEY`, `NONCE_SUITE_LOCK_KEY`) thành thừa —
 * và chúng đã bị xoá cùng lý do.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 *
 * `gen_random_uuid()` là core từ PostgreSQL 13 nên image này có sẵn — schema
 * `auth` (0001–0013) không cài extension nào.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

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

/**
 * Database mà migration chạy vào — đúng tên production (`db-auth`), vì tên
 * database là đối tượng của grant/REVOKE ở tầng cluster.
 */
export const AUTH_DATABASE = 'db-auth';

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
/** Mật khẩu chung cho hai role test — secret giả, database ném đi sau mỗi run. */
const ROLE_PASSWORD = 'ecoma_test_role_pw';

/** Thư mục migration — trong chính app này, đường dẫn ngắn. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations');

type Sql = import('postgres').Sql;

/**
 * Thông tin kết nối cho một database `db-auth` đã provision và đã migrate.
 *
 * Đây là dữ liệu thô, không phải pool: mỗi spec tự dựng `postgres()` theo cấu
 * hình `max` của nó (pool runtime `max: 3`/`max: 10`, session đơn `max: 1`) —
 * cùng hình dạng mà các suite đã dùng với `AUTH_TEST_PG_*`.
 */
export interface AuthDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly runtimeUser: string;
  readonly runtimePassword: string;
  readonly migratorUser: string;
  readonly migratorPassword: string;
  stop(): Promise<void>;
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker.
 *
 * Vitest chạy mỗi spec file trong một worker riêng với module graph riêng
 * (pool `forks`, isolate) — cache ở module scope hay `globalThis` vẫn probe
 * **một lần mỗi file**. `globalSetup` chạy **một lần** trong main process
 * trước khi worker khởi động, và worker kế thừa `process.env` khi được fork —
 * nên biến môi trường là kênh duy nhất đáng tin để "một probe cho cả lần chạy".
 */
const DOCKER_PROBE_ENV = 'ECOMA_AUTH_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest.
 *
 * Probe bằng **chính** container PostgreSQL mà test sẽ dùng, chứ không bằng một
 * lệnh Docker rẻ tiền: một runner không có Docker daemon thì `docker info` vẫn
 * có thể trả 0 (chỉ thiếu socket), và probe đó sẽ cho một describe rỗng rồi đỏ
 * ở `beforeAll`. Tốn vài giây cho lần đầu, nhưng nó loại được đúng cái nguy
 * hiểm nhất: một suite báo skip vì hạ tầng, không phải vì hành vi.
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
  // vitest khác config): probe tại chỗ và cache trên globalThis cho caller sau.
  const cache = globalThis as DockerProbeCache;
  cache.ecomaAuthDockerProbe ??= runDockerProbe();
  return cache.ecomaAuthDockerProbe;
}

interface DockerProbeCache {
  ecomaAuthDockerProbe?: Promise<void>;
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
 * Áp mọi file migration, theo thứ tự tên file, vào database vừa provision.
 *
 * ⚠️ **Không kiểm "schema đã có" trước khi áp** — khác với hình thức cũ của các
 * suite. Container là của riêng spec file này, sinh ra từ `docker create` nên
 * chắc chắn chưa có schema `auth`; một nhánh "nếu đã có thì bỏ qua" ở đây chỉ
 * có thể chạy đúng một lần trong đời container và không còn gì để bỏ qua.
 * Migration không dùng `CREATE TABLE IF NOT EXISTS` (README giải thích vì sao),
 * nên re-runnable thật nằm ở runner nhớ lịch sử — điều mà container một lần
 * làm bằng cách sống đúng một lần chạy test.
 *
 * ⚠️ Client truyền vào đây phải là **migrator**, không phải superuser, và phải
 * là session đơn (`max: 1`). Đó là điều kiện để các test về grant có ý nghĩa:
 * migration phải chạy được bằng đúng credential production được cấp quyền.
 */
async function applyMigrations(migrator: Sql): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    // Thứ tự số trong tên file là thứ tự áp dụng; so chuỗi là đủ vì tất cả
    // đều gốc 4 chữ số.
    .toSorted();

  for (const file of files) {
    await migrator.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

/**
 * Provisioning theo runbook operator (`migrations/README.md` §"Vai trò của
 * operator", auth 03-operations.md §3.2), làm bằng superuser — đúng vai trò
 * admin, không phải migration.
 *
 * ⚠️ Các việc này **không** nằm trong file migration `0001`–`0013`:
 *
 *  1. `CREATE ROLE … LOGIN` — migration không tạo role: `NOCREATEROLE` của
 *     migrator nghĩa là nó không tự tạo được chính mình. Role phải do admin tạo.
 *  2. `GRANT CREATE ON DATABASE` — `CREATE SCHEMA` cần nó, PostgreSQL không cấp
 *     cho `PUBLIC`, và migrator không sở hữu database nên không tự cấp được.
 *  3. `REVOKE CONNECT … FROM PUBLIC` — chặn chéo là việc của owner: migrator
 *     thiếu quyền sở hữu database, chạy `REVOKE` chỉ in
 *     `WARNING: no privileges could be revoked` rồi để `CONNECT` nguyên.
 *
 * Bỏ bước 1 hoặc 2 thì `0001` dừng ở `CREATE SCHEMA` với `permission denied`;
 * bỏ bước 3 thì các test về ranh giới database pass vì lý do sai.
 */
async function provision(superuser: Sql): Promise<void> {
  await superuser.unsafe(
    `CREATE ROLE ecoma_auth_migrator LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.unsafe(
    `CREATE ROLE ecoma_auth_runtime LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.unsafe(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${AUTH_DATABASE}" TO ecoma_auth_migrator`,
  );
  // Runtime chỉ DML — không `CREATE` trên bất kỳ schema nào (NFR-002a).
  await superuser.unsafe(`GRANT CONNECT ON DATABASE "${AUTH_DATABASE}" TO ecoma_auth_runtime`);
  await superuser.unsafe(`REVOKE CONNECT ON DATABASE "${AUTH_DATABASE}" FROM PUBLIC`);
  // Role pruner của cron Worker `apps/auth-nonce-prune-job` (`0014`): cùng lí do
  // hai role trên — migrator `NOCREATEROLE` không tự tạo được, guard của `0014`
  // chỉ là lưới an toàn nên role phải do admin tạo trước khi migration chạy.
  await superuser.unsafe(
    `CREATE ROLE ecoma_auth_nonce_pruner LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
      `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await superuser.unsafe(`GRANT CONNECT ON DATABASE "${AUTH_DATABASE}" TO ecoma_auth_nonce_pruner`);
}

/**
 * Dựng container PostgreSQL, provision hai role theo runbook, apply migration
 * bằng credential migrator thật, rồi trả về handle.
 *
 * ⚠️ `reuse` **không** bật. Mỗi spec file cần một container sạch: các test
 * assert trên trạng thái database (catalog, grant, số hàng) chứ không chỉ trên
 * dữ liệu mình tạo, và container bị tái sử dụng mang theo trạng thái run trước.
 *
 * ⚠️ Apply **bằng credential migrator thật**, không phải `SET ROLE` từ
 * superuser: `SET ROLE` không kiểm chứng quyền **kết nối thật** và giấu đúng
 * lỗi mà `provision()` chú ý — migrator thiếu `CREATE` sẽ chết ngay ở
 * `CREATE SCHEMA`, nhưng `SET ROLE` thì không.
 */
export async function startAuthDatabase(): Promise<AuthDatabase> {
  const postgres = (await import('postgres')).default;

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
    const base = {
      host,
      port,
      database: AUTH_DATABASE,
      prepare: false,
    } as const;

    const superuser = postgres({ ...base, user: SUPERUSER, password: SUPERUSER_PASSWORD, max: 1 });
    try {
      await provision(superuser);
    } finally {
      await superuser.end({ timeout: 1 });
    }

    const migrator = postgres({
      ...base,
      user: 'ecoma_auth_migrator',
      password: ROLE_PASSWORD,
      max: 1,
    });
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end({ timeout: 1 });
    }

    return {
      host,
      port,
      database: AUTH_DATABASE,
      runtimeUser: 'ecoma_auth_runtime',
      runtimePassword: ROLE_PASSWORD,
      migratorUser: 'ecoma_auth_migrator',
      migratorPassword: ROLE_PASSWORD,
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: `afterAll` chỉ gọi `db?.stop()` khi `db`
    // đã được gán, nên exception ở giữa để lại container chạy mãi và tích
    // luỹ qua các lần chạy lại — cùng kiểu rò mà harness của `apps/account`
    // đã ghi.
    await container.stop().catch(() => undefined);
    throw error;
  }
}
