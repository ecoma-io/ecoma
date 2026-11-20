/**
 * Testcontainers + PostgreSQL thật cho integration suite của `remote-cache-app-db`.
 *
 * ⚠️ Docker **là** phụ thuộc cứng của suite: thiếu Docker thì suite phải ĐỎ,
 * không được skip — một lần chạy skip với exit 0 che mất việc một suite bắt
 * buộc chưa hề chạy (06-testing.md §6). Quyết định fail được đưa ra qua
 * {@link probeDocker}: probe thất bại là NÉM từ `globalSetup` trước khi worker
 * nào kịp báo xanh giả. Cùng luật với `apps/account/tests/integrations/harness.ts`
 * — pattern tham chiếu.
 */

import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { pgIdentifier } from '../../runner.mts';

/**
 * Image PostgreSQL: 17 là major hiện hành; alpine để pull nhanh trên CI.
 * Cùng image với harness của `apps/account` — một chuẩn container cho toàn bộ
 * suite PostgreSQL của repo.
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Cổng trong container — testcontainers ánh xạ sang cổng host ngẫu nhiên. */
const POSTGRES_PORT = 5_432;

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';

/**
 * Tên database hợp đồng mà runner guard (`current_database()`, fail closed).
 * Suite recreate database NÀY giữa các test — chỉ một database mang đúng tên
 * hợp đồng tồn tại trong container tại mọi thời điểm.
 */
export const CONTRACT_DATABASE = 'db-remote-cache-app';

export interface ContractDatabase {
  readonly container: StartedPostgreSqlContainer;
  /** URL superuser trờ vào `postgres` — để recreate database hợp đồng. */
  readonly adminUrl: string;
  /** URL superuser trờ vào database hợp đồng — `DATABASE_URL` cho runner. */
  readonly databaseUrl: string;
}

export async function startContractDatabase(): Promise<ContractDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .withExposedPorts(POSTGRES_PORT)
    .start();
  const adminUrl = `postgresql://${SUPERUSER}:${SUPERUSER_PASSWORD}@${container.getHost()}:${container.getMappedPort(POSTGRES_PORT)}/postgres`;
  const databaseUrl = adminUrl.replace(/\/postgres$/u, `/${CONTRACT_DATABASE}`);
  return { container, adminUrl, databaseUrl };
}

/**
 * Drop + tạo lại database hợp đồng — mỗi test bắt đầu từ state trắng, đúng
 * nghĩa "environment chưa từng migrate" của §3a.3 mục D.
 */
export async function recreateContractDatabase(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${pgIdentifier(CONTRACT_DATABASE)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${pgIdentifier(CONTRACT_DATABASE)}`);
  } finally {
    await client.end();
  }
}

/**
 * Đếm hàng history — cửa sổ duy nhất vào state migration của suite. History
 * table chưa tồn tại (runner bị chặn trước khi kịp tạo, database trắng) là
 * 0 hàng, không phải lỗi: "chưa có ledger" là một state hợp lệ của §3a.3.
 */
export async function historyRows(databaseUrl: string, schema: string): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from ${pgIdentifier(schema)}.__drizzle_migrations`,
    );
    return Number(rows[0]?.n ?? '0');
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '42P01'
    ) {
      return 0;
    }
    throw error;
  } finally {
    await client.end();
  }
}

/** Bảng có tồn tại trong schema không — chứng minh SQL đã/bị bỏ qua. */
export async function tableExists(
  databaseUrl: string,
  schema: string,
  table: string,
): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ found: boolean }>(
      `select exists (
        select 1 from information_schema.tables
        where table_schema = $1 and table_name = $2
      ) as found`,
      [schema, table],
    );
    return rows[0]?.found === true;
  } finally {
    await client.end();
  }
}

const DOCKER_PROBE_ENV = 'ECOMA_REMOTE_CACHE_APP_DB_DOCKER_PROBE';

/**
 * Docker có dùng được không — probe một lần mỗi lần chạy vitest, bằng **chính**
 * container PostgreSQL mà suite sẽ dùng (một runner thiếu Docker daemon vẫn có
 * thể `docker info` exit 0 — probe rẻ tiền cho kết quả skip giả). Thất bại là
 * NÉM: suite phải ĐỎ, không được skip với exit 0 (06-testing.md §6).
 */
export async function probeDocker(): Promise<void> {
  const flag = process.env[DOCKER_PROBE_ENV];
  if (flag === 'available') return;
  if (flag === 'unavailable') {
    throw new Error(
      'Docker is unavailable: the migration-runner integration suite requires a running Docker daemon; refusing to skip.',
    );
  }
  let container: StartedPostgreSqlContainer | undefined;
  let available = false;
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withUsername(SUPERUSER)
      .withPassword(SUPERUSER_PASSWORD)
      .withExposedPorts(POSTGRES_PORT)
      .start();
    available = true;
  } catch {
    available = false;
  } finally {
    // `.catch(() => undefined)` chứ không phải block rỗng: `stop()` là cleanup
    // và có thể tự nó ném — nuốt để không để lại container mồ côi và không che
    // lỗi thật của probe (cùng pattern apps/account runDockerProbe).
    await container?.stop().catch(() => undefined);
  }

  process.env[DOCKER_PROBE_ENV] = available ? 'available' : 'unavailable';
  if (!available) {
    throw new Error(
      'Docker is unavailable: the migration-runner integration suite requires a running Docker daemon; refusing to skip.',
    );
  }
}
