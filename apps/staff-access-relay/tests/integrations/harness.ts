/**
 * Testcontainers + PostgreSQL thật cho integration test của `staff-access-relay`.
 *
 * ⚠️ Copy có chủ đích của harness `apps/staff-access/tests/integrations/harness.ts`
 * — relay là một deploy unit RIÊNG, và database nó đọc (`db-staff-access`) thuộc
 * sở hữu của `apps/staff-access`. 06-testing.md §6 cấm chia sẻ test-support qua
 * ranh giới deploy unit, nên hai harness giống nhau là **có chủ đích**, không
 * phải nợ kỹ thuật. Khác biệt bắt buộc bởi chủ thể của suite này:
 *
 *  1. Apply migration bằng cách **đọc file** trong `apps/staff-access/db/migrations`
 *     (đường dẫn FILE, không phải import code app→app): runner `db/apply.mts` của
 *     staff-access không import chéo được qua ranh giới deploy unit.
 *  2. Client là driver `pg` — đúng driver mà relay chạy production (`src/main.ts`
 *     dựng `pg.Pool` qua Hyperdrive binding).
 *
 * ⚠️ Docker là phụ thuộc cứng: vắng Docker, suite phải ĐỎ fail-loud, không skip
 * với exit 0 (06-testing.md §6).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

/**
 * Image PostgreSQL 17 (major hiện hành; `gen_random_uuid()` là core từ PG13).
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Cổng PostgreSQL trong container — testcontainers ánh xạ sang cổng host ngẫu nhiên. */
const POSTGRES_PORT = 5_432;

/**
 * Database production — tên database là đối tượng của grant/REVOKE ở tầng cluster,
 * nên phải khớp tên thật (`db-staff-access`).
 */
export const STAFF_ACCESS_DATABASE = 'db-staff-access';

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
/** Mật khẩu chung cho hai role test — secret giả, database ném đi sau mỗi run. */
const ROLE_PASSWORD = 'ecoma_test_role_pw';

/**
 * Thư mục migration thật của `db-staff-access` — sống ở app sở hữu database
 * (`apps/staff-access`), không ở relay. Đường dẫn file để harness ĐỌC.
 */
export const MIGRATIONS_DIR = join(
  import.meta.dirname,
  '../../../../apps/staff-access/db/migrations',
);

export interface RelayDatabase {
  readonly host: string;
  readonly port: number;
  readonly rolePassword: string;
  /** Client bằng credential runtime thật — đúng principal relay dùng production. */
  connectAsRuntime(): Promise<Client>;
  /** Client bằng credential migrator thật — seed/dọn dữ liệu giữa các test. */
  connectAsMigrator(): Promise<Client>;
  /** Xoá sạch outbox giữa các test. */
  truncateOutbox(): Promise<void>;
  stop(): Promise<void>;
}

/** Biến môi trường mang kết quả probe từ `globalSetup` sang từng worker. */
const DOCKER_PROBE_ENV = 'ECOMA_STAFF_ACCESS_RELAY_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest. Probe dùng
 * **chính** container PostgreSQL mà test sẽ dùng; probe thất bại là NÉM (suite
 * ĐỎ, không skip với exit 0).
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
  const cache = globalThis as DockerProbeCache;
  cache.ecomaStaffAccessRelayDockerProbe ??= runDockerProbe();
  return cache.ecomaStaffAccessRelayDockerProbe;
}

interface DockerProbeCache {
  ecomaStaffAccessRelayDockerProbe?: Promise<void>;
}

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
  return import('pg');
}

/**
 * Provisioning step 1 làm bằng superuser — đúng vai trò admin/owner. Các việc
 * này không nằm trong `db/migrations/` và migration không tự làm được
 * (`NOCREATEROLE` của migrator + `CREATE SCHEMA` cần `CREATE` ở tầng database).
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

/** Áp mọi file migration theo thứ tự tên file, bằng credential migrator thật. */
async function applyMigrations(migrator: Client): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  for (const file of files) {
    await migrator.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

/**
 * Dựng container PostgreSQL, provision hai role, apply migration thật của
 * `apps/staff-access/db/migrations` bằng credential migrator thật.
 */
export async function startRelayDatabase(): Promise<RelayDatabase> {
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

    const open = async (user: string, password: string): Promise<Client> => {
      const { Client: PgClient } = await pgModule();
      const client = new PgClient({
        host,
        port,
        database: STAFF_ACCESS_DATABASE,
        user,
        password,
        application_name: 'ecoma-staff-access-relay-itest',
      });
      await client.connect();
      return client;
    };

    const superuser = await open(SUPERUSER, SUPERUSER_PASSWORD);
    try {
      await provision(superuser);
    } finally {
      await superuser.end().catch(() => undefined);
    }

    const migrator = await open('ecoma_staff_access_migrator', ROLE_PASSWORD);
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end().catch(() => undefined);
    }

    return {
      host,
      port,
      rolePassword: ROLE_PASSWORD,
      connectAsRuntime: () => open('ecoma_staff_access_runtime', ROLE_PASSWORD),
      connectAsMigrator: () => open('ecoma_staff_access_migrator', ROLE_PASSWORD),
      truncateOutbox: async () => {
        const client = await open(SUPERUSER, SUPERUSER_PASSWORD);
        try {
          await client.query('TRUNCATE staff_access.entitlement_outbox_events');
        } finally {
          await client.end().catch(() => undefined);
        }
      },
      stop: async () => {
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop().catch(() => undefined);
    throw error;
  }
}
