/**
 * `node db/bootstrap-internal-tenant.mts` — bootstrap tenant nội bộ
 * `ecoma-internal` trong `db-pact-broker` (roadmap P3.1).
 *
 * Script độc lập với deploy pipeline (pipeline chưa tồn tại,
 * `02-delivery.md` §12): chạy trực tiếp từ CI runner/ops box bằng PostgreSQL
 * client với credential hợp lệ (runtime role), không bao giờ chạy từ Worker —
 * cùng lý do `db/apply.mts` chạy ở runner (HD6: Hyperdrive không hỗ trợ
 * advisory lock; script này chỉ DML nên không cần lock, nhưng ranh giới
 * runner/Worker vẫn giữ nguyên).
 *
 * Hành vi (01-architecture.md §4):
 *  - INSERT `pact.tenants (name 'ecoma-internal', status 'active')`,
 *    idempotent `ON CONFLICT (name) DO NOTHING`.
 *  - Chạy lại là no-op an toàn: KHÔNG update name/status đang có; tenant
 *    `suspended`/`deleted` giữ nguyên, KHÔNG tự hồi sinh (fail-closed §4
 *    bước 2) — hồi sinh là hành động có chủ đích của owner.
 *  - KHÔNG tạo membership row nào (P3.2 lo), KHÔNG tạo machine token —
 *    bootstrap tenant rỗng.
 *  - Ghi audit entry vào `pact.audit_events` (bảng có sẵn từ migration
 *    `0001`) cho cả lần tạo mới lẫn lần no-op, để mọi lần chạy đều để lại
 *    dấu vết append-only.
 *
 * Biến môi trường:
 *
 * | Biến           | Bắt buộc | Ý nghĩa                                                    |
 * | -------------- | -------- | ---------------------------------------------------------- |
 * | `DATABASE_URL` | có       | chuỗi kết nối PostgreSQL (runtime role của db-pact-broker) |
 *
 * Mật khẩu chỉ nằm trong `DATABASE_URL` (env/stdin secret, không bao giờ
 * argv — argv hiện trong `ps` + shell history, trái invariant Secrets).
 * Thiếu config thì exit khác 0 với hướng dẫn: coi im lặng là tenant đã được
 * bootstrap là cách làm một lần bootstrap biến mất. Ngoài ra script tự assert
 * database trong URL đúng là `db-pact-broker` — trỏ nhầm database khác thì
 * chết ngay thay vì tạo tenant ở nhà người khác.
 */

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/** Tenant nội bộ duy nhất mà script này được phép bootstrap. */
export const INTERNAL_TENANT_NAME = 'ecoma-internal';

/** Tên database mà service này sở hữu; URL trỏ database khác là lỗi config. */
export const PACT_BROKER_DATABASE = 'db-pact-broker';

/** Database name parse từ connection string — đầu vào của assert CLI. */
export interface BootstrapDatabaseTarget {
  readonly database: string;
}

/** Kết quả một lần bootstrap — CLI in ra, test assert. */
export interface BootstrapTenantResult {
  /** Tenant đã tồn tại trước khi chạy (`true` = lần này là no-op). */
  readonly alreadyExisted: boolean;
  /** Id tenant (uuid) — có ở cả hai nhánh created/no-op. */
  readonly tenantId: string;
  /** Tên tenant — hằng `INTERNAL_TENANT_NAME`, trả về để test assert. */
  readonly tenantName: string;
}

/**
 * Parse tên database từ chuỗi kết nối PostgreSQL.
 *
 * Đi bằng string slicing thay vì `new URL()`: postgres URL cho phép user/
 * password không encode theo chuẩn URL generic (`pg` chấp nhận), `new URL()`
 * ném lỗi trên password chứa ký tự như `%` hay `/` chưa encode — parser này
 * chỉ cần database path nên không đụng phần đó.
 */
export function parseDatabaseUrl(databaseUrl: string): BootstrapDatabaseTarget {
  if (
    databaseUrl.startsWith('postgres://') === false &&
    databaseUrl.startsWith('postgresql://') === false
  ) {
    throw new Error('must start with postgres:// or postgresql://');
  }
  const withoutScheme = databaseUrl.slice(databaseUrl.indexOf('://') + 3);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex === -1) {
    throw new Error('must include a database name path (postgres://host:port/db)');
  }
  const pathAndQuery = withoutScheme.slice(slashIndex + 1);
  const questionIndex = pathAndQuery.indexOf('?');
  const database = questionIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, questionIndex);
  if (database === '') {
    throw new Error('must include a non-empty database name path');
  }
  return { database };
}

/**
 * Bootstrap tenant nội bộ — core logic dùng chung bởi CLI và integration
 * test (một đường code duy nhất, đúng pattern runner-canonical của
 * `db/apply.mts`: vòng apply viết riêng trong test là test bản sao, không
 * test runner).
 *
 * Client truyền vào phải có quyền INSERT/SELECT trên `pact.tenants` và
 * `pact.audit_events` (runtime role). Hàm KHÔNG tự mở/đóng connection:
 * caller quản lý vòng đời connection (CLI bên dưới) và transaction (test
 * race). Hai câu DML của một lần bootstrap chạy trong một transaction do
 * caller mở để tenant và audit event cùng tồn tại hoặc cùng không.
 *
 * Race-safety: `INSERT … ON CONFLICT (name) DO NOTHING RETURNING id` —
 * hai connection chạy đồng thời thì đúng một tenant được tạo, bên thua
 * đọc row của bên thắng rồi đi tiếp nhánh no-op; không lỗi chết, đúng
 * §4 bước 1.
 *
 * Fail-closed khi tenant tồn tại với status khác `active`: không tự hồi
 * sinh tenant `suspended`/`deleted` (§4 bước 2) — đó là hành động có chủ
 * đích của owner, không phải của script bootstrap.
 */
export async function bootstrapInternalTenant(client: Client): Promise<BootstrapTenantResult> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pact.tenants (name, status)
     VALUES ($1, 'active')
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [INTERNAL_TENANT_NAME],
  );

  if (inserted.rows.length === 1) {
    const firstRow = inserted.rows[0];
    if (firstRow === undefined) {
      throw new Error('INSERT RETURNING produced a row count without a row');
    }
    await insertBootstrapAuditEvent(client, firstRow.id, 'created');
    return { alreadyExisted: false, tenantId: firstRow.id, tenantName: INTERNAL_TENANT_NAME };
  }

  // ON CONFLICT không trả row → tenant đã tồn tại: đọc trạng thái hiện có.
  const existing = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM pact.tenants WHERE name = $1`,
    [INTERNAL_TENANT_NAME],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // Không thể xảy ra với ON CONFLICT + UNIQUE(name) trên cùng một bảng,
    // nhưng không được ước lượng: fail-loud thay vì giả định đã an toàn.
    throw new Error(`tenant ${INTERNAL_TENANT_NAME} missing after ON CONFLICT (unexpected state)`);
  }
  if (row.status !== 'active') {
    throw new Error(
      `tenant ${INTERNAL_TENANT_NAME} exists with status ${row.status}; refusing to resurrect (owner action required)`,
    );
  }

  await insertBootstrapAuditEvent(client, row.id, 'already_existed');
  return { alreadyExisted: true, tenantId: row.id, tenantName: INTERNAL_TENANT_NAME };
}

/**
 * Ghi audit entry cho đợt bootstrap (tạo mới hoặc no-op) vào
 * `pact.audit_events` — bảng append-only có sẵn từ migration `0001`, shape
 * khớp `insertAuditEvent` của infrastructure (không phát minh bảng mới).
 *
 * Actor là script ops, không phải người dùng hay machine token nên
 * `actor_sub`/`actor_token_id` đều NULL; `detail` ghi kết quả đợt chạy để
 * phân biệt created với no-op khi tra audit. Action đặt tên theo quy ước
 * `object.verb` của broker (`machine_token.create`, `environment.create`).
 */
async function insertBootstrapAuditEvent(
  client: Client,
  tenantId: string,
  outcome: 'created' | 'already_existed',
): Promise<void> {
  await client.query(
    `INSERT INTO pact.audit_events (tenant_id, actor_sub, actor_token_id, action, outcome, detail)
     VALUES ($1, NULL, NULL, 'tenant.bootstrap', 'success', $2::jsonb)`,
    [tenantId, JSON.stringify({ bootstrap: outcome, tenant: INTERNAL_TENANT_NAME })],
  );
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Run this script from a CI runner or ops box with the runtime role credentials; the password goes in the connection string (env/stdin), never in argv.',
    );
    process.exit(1);
  }

  let target: BootstrapDatabaseTarget;
  try {
    target = parseDatabaseUrl(databaseUrl);
  } catch (error) {
    console.error('DATABASE_URL is invalid:', (error as Error).message);
    process.exit(1);
  }
  if (target.database !== PACT_BROKER_DATABASE) {
    console.error(
      `DATABASE_URL points at database ${target.database}; this script only bootstraps ${PACT_BROKER_DATABASE}.`,
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-pact-broker-bootstrap-internal-tenant',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to database:', (error as Error).message);
    process.exit(1);
  }

  try {
    await client.query('BEGIN');
    const result = await bootstrapInternalTenant(client);
    await client.query('COMMIT');
    if (result.alreadyExisted) {
      console.log(
        `tenant ${result.tenantName} already exists (id ${result.tenantId}); no-op, state preserved`,
      );
    } else {
      console.log(`tenant ${result.tenantName} created (id ${result.tenantId})`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('bootstrap failed:', (error as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
