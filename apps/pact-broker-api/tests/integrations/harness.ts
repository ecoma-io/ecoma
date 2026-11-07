/**
 * Testcontainers + PostgreSQL thật cho integration test của `pact-broker-api`.
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

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 * `gen_random_uuid()` là core từ PostgreSQL 13 nên có sẵn — migration `0001`
 * không cài extension nào.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Cổng PostgreSQL **trong container**. Không phải cổng host: testcontainers ánh
 * xạ sang một cổng host ngẫu nhiên và `getMappedPort` đọc cổng đó. Truyền vào
 * `withExposedPorts` bằng varargs, không phải mảng (mảng đẩy chính nó vào vị
 * trí `port` — lỗi `invalid port 'undefined'` trông như "Docker hỏng").
 */
const POSTGRES_PORT = 5_432;

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
const ROLE_PASSWORD = 'ecoma_test_role_pw';

/** Tên database mà service này sở hữu — phải khớp `PACT_BROKER_DATABASE`. */
export const PACT_BROKER_DATABASE = 'db-pact-broker';

/** Role migrator/runtime mà migration `0001` tạo guard và GRANT cho. */
const MIGRATOR_ROLE = 'ecoma_pact_broker_migrator';
const RUNTIME_ROLE = 'ecoma_pact_broker_runtime';

type Client = import('pg').Client;
type Pool = import('pg').Pool;

export interface PactBrokerDatabase {
  readonly host: string;
  readonly port: number;
  /** Chuỗi kết nối của migrator — đúng shape mà CLI `db:migrate` nhận. */
  readonly migratorUrl: string;
  /** Client superuser cho assertion về grant/ACL. */
  connect(): Promise<Client>;
  /** Client đã `SET ROLE ecoma_pact_broker_runtime` — đúng vai Worker dùng. */
  asRuntime(): Promise<Client>;
  /** Client dùng credential thật của migrator (không SET ROLE). */
  connectAsMigrator(): Promise<Client>;
  /**
   * `pg.Pool` bằng credential thật của runtime role — đúng thứ `createPool`
   * nhận qua Hyperdrive. Caller tự `end()`.
   */
  createRuntimePool(): Promise<Pool>;
  /** Xoá sạch dữ liệu giữa các test mà không đụng DDL, grant hay trigger. */
  truncateData(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker.
 *
 * Vitest chạy mỗi spec file trong một worker riêng (pool `forks`) — cache ở
 * module scope không vượt qua ranh giới worker; `globalSetup` chạy một lần
 * trong main process và worker kế thừa `process.env` khi fork.
 */
const DOCKER_PROBE_ENV = 'ECOMA_PACT_BROKER_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy, bằng chính container
 * PostgreSQL mà test sẽ dùng (một runner thiếu Docker socket vẫn có thể làm
 * `docker info` thoát 0 — probe đó loại được đúng nguy hiểm này).
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
  // Fallback khi chạy ngoài pipeline có globalSetup: probe tại chỗ.
  const cache = globalThis as DockerProbeCache;
  cache.ecomaPactBrokerDockerProbe ??= runDockerProbe();
  return cache.ecomaPactBrokerDockerProbe;
}

interface DockerProbeCache {
  ecomaPactBrokerDockerProbe?: Promise<void>;
}

async function runDockerProbe(): Promise<void> {
  let container: { stop(): Promise<unknown> } | undefined;
  let available = false;
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withExposedPorts(POSTGRES_PORT)
      .withStartupTimeout(120_000)
      .start();
    available = true;
  } catch {
    available = false;
  } finally {
    // `.catch(() => {})`: `stop()` là cleanup và có thể tự ném, nuốt để không
    // che lỗi thật của probe.
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
 * ⚠️ Đây là dải băng gọi {@link applyAllMigrations} — đúng hàm mà CLI
 * `db:migrate` chạy, gồm cả advisory lock. Viết vòng apply riêng ở đây là tạo
 * runner thứ hai không có lock: test "repeatable" xanh với bản sao trong khi
 * runner production hỏng (lỗi đã từng xảy ra ở `apps/account`).
 *
 * ⚠️ Client truyền vào phải là **migrator** bằng credential thật (không
 * `SET ROLE`): quyền `CREATE` trên database là điều kiện để `0001` chạy, và
 * `SET ROLE` không kiểm chứng được quyền kết nối thật.
 */
export async function applyMigrations(client: Client): Promise<void> {
  await applyAllMigrations(client);
}

/**
 * Provisioning step 1 — làm bằng superuser, đúng vai admin/owner.
 *
 * ⚠️ Ba việc này **không** nằm trong `db/migrations/`:
 *
 *  1. `CREATE ROLE … LOGIN` — migration `0001` chỉ tạo role **không LOGIN**
 *     (guard lưới an toàn); kết nối thật cần role LOGIN với password, và
 *     `NOCREATEROLE` của migrator nghĩa là nó không tự tạo được chính nó.
 *  2. `GRANT CREATE ON DATABASE` — `CREATE SCHEMA` cần nó, PostgreSQL không
 *     cấp cho `PUBLIC`, migrator không sở hữu database nên không tự cấp.
 *  3. Password cho role LOGIN — không thể `ALTER ROLE … PASSWORD` từ trong
 *     migration vì role chưa có password nghĩa là không connect được.
 */
async function provision(superuser: Client): Promise<void> {
  // Tạo role LOGIN với password tại đây (superuser); guard DO-block của
  // migration `0001` thấy role đã có sẽ bỏ qua — đúng pattern `provision()`
  // của account. `ALTER ROLE` không dùng được: migration chưa chạy nên role
  // chưa tồn tại ở lần setup đầu.
  await superuser.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
         CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}'
           NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       END IF;
     END $$;`,
  );
  await superuser.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
         CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}'
           NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       END IF;
     END $$;`,
  );
  await superuser.query(
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${PACT_BROKER_DATABASE}" TO ${MIGRATOR_ROLE}`,
  );
  await superuser.query(`GRANT CONNECT ON DATABASE "${PACT_BROKER_DATABASE}" TO ${RUNTIME_ROLE}`);
}

/**
 * Dựng container PostgreSQL, provision role, apply migration, trả về handle.
 *
 * ⚠️ `reuse` **không** bật: các test assert trên trạng thái database, container
 * tái sử dụng mang theo trạng thái run trước.
 *
 * ⚠️ Apply **một lần ở đây**: advisory lock của migration là session-scoped
 * trên connection; nhiều container song song chặn lẫn nhau không có ở đây vì
 * mỗi suite một container — nhưng apply một lần vẫn là điều kiện để spec
 * "repeatable" đo đúng lần apply thứ hai.
 */
export async function startPactBrokerDatabase(): Promise<PactBrokerDatabase> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(PACT_BROKER_DATABASE)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .withExposedPorts(POSTGRES_PORT)
    .withStartupTimeout(120_000)
    .start();

  try {
    const host = container.getHost();
    const port = container.getMappedPort(POSTGRES_PORT);

    const open = async (options: {
      user: string;
      password: string;
      database: string;
    }): Promise<Client> => {
      // `pg` là CJS; default interop là đường lấy `Client` đúng ở cả Node và ESM.
      const { Client: PgClient } = await import('pg');
      const client = new PgClient({ host, port, ...options });
      await client.connect();
      return client;
    };

    const connect = (): Promise<Client> =>
      open({ user: SUPERUSER, password: SUPERUSER_PASSWORD, database: PACT_BROKER_DATABASE });

    const superuser = await connect();
    await provision(superuser);
    await superuser.end();

    // Apply bằng credential migrator thật (không SET ROLE) — provision() ở
    // trên cấp CONNECT+CREATE cho đúng role đó; thiếu quyền thì chết ngay ở
    // CREATE SCHEMA, và test phải thấy nó chết chứ không phải giấu đi.
    const migrator = await open({
      user: MIGRATOR_ROLE,
      password: ROLE_PASSWORD,
      database: PACT_BROKER_DATABASE,
    });
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }

    const connectAsMigrator = (): Promise<Client> =>
      open({ user: MIGRATOR_ROLE, password: ROLE_PASSWORD, database: PACT_BROKER_DATABASE });

    const asRuntime = async (): Promise<Client> => {
      const client = await connect();
      await client.query(`SET ROLE ${RUNTIME_ROLE}`);
      return client;
    };

    const createRuntimePool = async (): Promise<Pool> => {
      // Credential **thật** của runtime role — đúng thứ Worker nhận qua
      // Hyperdrive; `SET ROLE` sẽ giấu lỗi thiếu quyền ở tầng kết nối.
      const { Pool: PgPool } = await import('pg');
      return new PgPool({
        host,
        port,
        user: RUNTIME_ROLE,
        password: ROLE_PASSWORD,
        database: PACT_BROKER_DATABASE,
      });
    };

    const truncateData = async (): Promise<void> => {
      // MỌI bảng của schema `pact` phải có mặt: bảng quên ở đây làm MỌI suite
      // dùng `truncateData` đỏ cùng lỗi "cannot truncate a table referenced in
      // a foreign key constraint". `audit_events` và `webhook_executions` cũng
      // phải truncate — append-only là trigger UPDATE, không chặn TRUNCATE.
      const client = await connect();
      try {
        await client.query(
          `TRUNCATE pact.webhook_executions, pact.audit_events,
                  pact.deployed_versions, pact.webhooks, pact.environments,
                  pact.verifications, pact.pacts, pact.tags, pact.versions,
                  pact.pacticipants, pact.machine_tokens, pact.tenant_members,
                  pact.tenants, pact.internal_nonces`,
        );
      } finally {
        await client.end();
      }
    };

    return {
      host,
      port,
      migratorUrl: `postgres://${MIGRATOR_ROLE}:${ROLE_PASSWORD}@${host}:${port}/${PACT_BROKER_DATABASE}`,
      connect,
      asRuntime,
      connectAsMigrator,
      createRuntimePool,
      truncateData,
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    // Dọn container khi setup ném: `afterAll` chỉ gọi `db?.stop()` khi `db`
    // đã gán — exception giữa chừng để container chạy mãi và tích luỹ.
    await container.stop().catch(() => undefined);
    throw error;
  }
}
