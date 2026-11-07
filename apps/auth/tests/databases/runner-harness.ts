/**
 * Testcontainers + PostgreSQL thật cho **runner migration** (`db/apply.mts`).
 *
 * ⚠️ Tách khỏi `harness.ts` có chủ ý: harness suite PG của app tự nạp file
 * migration bằng `postgres()` (không qua runner) để dựng schema cho các suite
 * nghiệp vụ — nó là đường setup, không phải runner production. Suite runner thì
 * cần đối tượng ngược lại: provision role rồi để **runner chính là đường apply
 * duy nhất**, để mọi test dưới đây kiểm đúng protocol mà CLI `db:migrate`
 * chạy. Dựng lại database qua harness cũ xong test runner là test chứng minh
 * bản sao, không chứng minh đường production (chính phản-pattern mà JSDoc của
 * `db/apply.mts` ghi).
 *
 * ⚠️ Docker probe: `globalSetup` đã probe một lần mỗi lần chạy và fail-loud
 * (không có Docker ⇒ lỗi thật, không phải skip — commit d96c40de). Hàm start ở
 * đây chạy sau probe nên có thể giả định Docker sẵn sàng.
 *
 * Provisioning theo runbook operator (`migrations/README.md` §"Vai trò của
 * operator", auth 03-operations.md §3.2), làm bằng superuser — đúng vai trò
 * admin: tạo role (migrator `NOCREATEROLE` không tự tạo được chính mình), grant
 * `CONNECT, CREATE, TEMPORARY` (điều kiện để runner tạo history table và để
 * `0001` chạy). Phần chặn chéo REVOKE không cần ở đây: các test dưới đây kiểm
 * protocol apply của runner, không kiểm ranh giới database.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 * `gen_random_uuid()` là core từ PostgreSQL 13 — schema `auth` không cài
 * extension nào.
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Cổng PostgreSQL **trong container**; host port do testcontainers cấp động. */
const POSTGRES_PORT = 5_432;

/** Database mà migration chạy vào — đúng tên production (tên là đối tượng của lock/grant). */
export const DATABASE_NAME = 'db-auth';

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
/** Mật khẩu chung cho các role test — secret giả, database ném đi sau mỗi run. */
const ROLE_PASSWORD = 'ecoma_test_role_pw';

/** Thư mục migration thật của app — runner mặc định đọc đúng nơi này. */
export const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations');

export interface RunnerDatabase {
  readonly host: string;
  readonly port: number;
  /** Thư mục migration thật — test drift copy ra tmp từ đây. */
  readonly migrationsDir: string;
  /** Client superuser cho các assertion về catalog/ACL. */
  connectSuperuser(): Promise<Client>;
  /** Client credential migrator thật — đúng vai trò mà runner CLI dùng. */
  connectMigrator(): Promise<Client>;
  stop(): Promise<void>;
}

async function pgModule(): Promise<typeof import('pg')> {
  // `pg` là CJS nên default interop là đường lấy `Client` đúng ở cả Node lẫn
  // ESM. Trả về namespace (`typeof import('pg')`) chứ không phải `module.default`:
  // kiểu của `default` thiếu `PG`, nên `typeof import('pg')` là chữ ký đúng.
  return import('pg');
}

async function openClient(options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Promise<Client> {
  const { Client } = await pgModule();
  const client = new Client({ ...options, application_name: 'ecoma-auth-runner-test' });
  await client.connect();
  return client;
}

/** Số lần thử lại khi start container thất bại (rootless Docker port race — xem harness.ts). */
const CONTAINER_START_ATTEMPTS = 3;
const CONTAINER_START_BACKOFF_MS = 1_000;

async function startRunnerDatabase(): Promise<RunnerDatabase> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

  let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONTAINER_START_ATTEMPTS; attempt++) {
    try {
      container = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase(DATABASE_NAME)
        .withUsername(SUPERUSER)
        .withPassword(SUPERUSER_PASSWORD)
        .withStartupTimeout(120_000)
        .withExposedPorts(POSTGRES_PORT)
        .start();
      break;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((done) => {
      setTimeout(done, CONTAINER_START_BACKOFF_MS * attempt);
    });
  }
  if (container === undefined) {
    throw lastError;
  }

  const host = container.getHost();
  const port = container.getMappedPort(POSTGRES_PORT);
  const base = { host, port, database: DATABASE_NAME } as const;

  try {
    const superuser = await openClient({ ...base, user: SUPERUSER, password: SUPERUSER_PASSWORD });

    // Provisioning theo runbook: role trước (migrator NOCREATEROLE không tự
    // tạo được mình), grant sau (CREATE trên database là điều kiện để runner
    // tạo schema/history và để `0001` chạy).
    await superuser.query(
      `CREATE ROLE ecoma_auth_migrator LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await superuser.query(
      `CREATE ROLE ecoma_auth_runtime LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    // Pruner phải có TRƯỚC khi runner áp `0014`: guard `DO $$` trong file chỉ
    // là lưới an toàn, còn migrator `NOCREATEROLE` thì không thể để guard tự
    // tạo role (`README.md` §"Vai trò của operator" — chính mục này cảnh báo
    // ngoại lệ `0014`). Thiếu role, apply chết ở `0014` với
    // `permission denied to create role` — đúng hành vi fail-loud mong muốn,
    // nhưng là lỗi provisioning chứ không phải lỗi runner.
    await superuser.query(
      `CREATE ROLE ecoma_auth_nonce_pruner LOGIN PASSWORD '${ROLE_PASSWORD}' ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await superuser.query(
      `GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO ecoma_auth_nonce_pruner`,
    );
    await superuser.query(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${DATABASE_NAME}" TO ecoma_auth_migrator`,
    );
    await superuser.query(`GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO ecoma_auth_runtime`);

    // Mọi shell sau đó mở client riêng; superuser giữ cho `connectSuperuser`.
    return {
      host,
      port,
      migrationsDir: MIGRATIONS_DIR,
      connectSuperuser: () =>
        openClient({ ...base, user: SUPERUSER, password: SUPERUSER_PASSWORD }),
      connectMigrator: () =>
        openClient({ ...base, user: 'ecoma_auth_migrator', password: ROLE_PASSWORD }),
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

let cached: Promise<RunnerDatabase> | undefined;

/**
 * Dựng database cho suite runner — cache Promise ở module scope: các test của
 * MỘT file chia sẻ đúng một container vì suite này test runner trên một lịch
 * sử apply (apply → re-apply → drift), không phải các test độc lập vô trạng
 * thái. Test có thứ tự nên chạy tuần tự trong file (mặc định vitest).
 */
export function startAuthRunnerDatabase(): Promise<RunnerDatabase> {
  cached ??= startRunnerDatabase();
  return cached;
}

/** Đảm bảo import `readdirSync` không bị chọn lười vô dụng — dùng ở test khác khi cần. */
export function migrationFileNames(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
}
