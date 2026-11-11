/**
 * `node db/bootstrap-tenant.mts` — bootstrap tenant canonical `ecoma` (hàng
 * tenant + membership owner) trong `db-pact-broker`.
 *
 * Triển khai bước 5a của hợp đồng bootstrap/seed: ADR-0020
 * (`docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md`) qua
 * `docs/architecture/02-delivery.md` §3.2. Tên tenant canonical là hằng
 * `ecoma` ở mọi environment và mọi database sản phẩm chạy bootstrap này
 * (ADR-0020 Quyết định 9); cấu hình environment cung cấp đầu vào kết nối và
 * chủ sở hữu tenant, không bao giờ là danh tính tenant.
 *
 * Script độc lập với deploy pipeline: chạy trực tiếp từ CI runner / ops box
 * bằng PostgreSQL client với credential hợp lệ (runtime role), không bao giờ
 * chạy từ Worker — cùng lý do `db/apply.mts` (HD6: Hyperdrive không hỗ trợ
 * advisory lock; script này chỉ DML nên không cần lock, nhưng ranh giới
 * runner/Worker vẫn giữ nguyên).
 *
 * Hành vi (Quyết định ADR-0020 5, 6, 9, 13; domain model §2.6), tất cả nằm
 * trong MỘT transaction do caller quản lý:
 *  - INSERT `pact.tenants (name 'ecoma', status 'active', classification
 *    'first_party', plan NULL, owner_sub)`, idempotent `ON CONFLICT (name)
 *    DO NOTHING`.
 *  - Khi conflict, hàng hiện có được đọc lại và lần chạy fail-closed trừ khi
 *    nó chính xác là no-op bootstrap hợp lệ: `status = 'active'`, `owner_sub`
 *    bằng sub cung cấp (sở hữu không bao giờ bị ghi đè),
 *    `classification = 'first_party'`, `plan IS NULL`. Mỗi sai khớp là một
 *    lỗi riêng, cụ thể: một hàng chỉ trùng tên không được âm thầm nhận vào.
 *  - INSERT membership owner `pact.tenant_members (tenant_id, sub,
 *    role 'member', source 'bootstrap')`, idempotent `ON CONFLICT
 *    (tenant_id, sub) DO NOTHING`; hàng đã lưu phải đọc lại đúng
 *    `role = 'member' AND source = 'bootstrap'` — role hoặc provenance xung
 *    đột thì fail-closed. `staff_id` giữ NULL: cột này chỉ dành cho ánh xạ
 *    entitlement.
 *  - Đúng MỘT audit event mỗi lần chạy trong `pact.audit_events` (action
 *    `tenant.bootstrap`, outcome `success`), ở cả đường created lẫn đường
 *    no-op, để mọi lần chạy đều để lại dấu vết append-only.
 *
 * Race-safety không cần advisory lock: mọi mục tiêu ghi được bảo vệ bằng
 * natural key — `tenants.name` (unique) và primary key `(tenant_id, sub)` của
 * `tenant_members`. Với READ COMMITTED, bên thua `INSERT ... ON CONFLICT DO
 * NOTHING` chờ INSERT đang dang dở của bên thắng commit rồi skip; bên thua đi
 * theo đường đọc-và-verify đối chiếu trạng thái đã commit của bên thắng và
 * ghi audit row riêng của mình. Hai lần chạy đồng thời do đó hội tụ về một
 * tenant và một membership owner với một audit event mỗi lần — không cần lock
 * vì không có state ngoài database và không có read-modify-write thiếu bộ
 * chặn conflict (Quyết định ADR-0020 5).
 *
 * Fail-closed khi tenant đang ở trạng thái `suspended`/`deleted` (Quyết định
 * ADR-0020 6): bootstrap không bao giờ hồi sinh — hồi sinh là hành động có
 * chủ đích của owner.
 *
 * Biến môi trường:
 *
 * | Biến                         | Bắt buộc | Ý nghĩa                                                       |
 * | ---------------------------- | -------- | ------------------------------------------------------------- |
 * | `DATABASE_URL`               | có       | chuỗi kết nối PostgreSQL (runtime role của db-pact-broker) |
 * | `CANONICAL_TENANT_OWNER_SUB` | có       | opaque `sub` của owner tenant canonical                       |
 *
 * Mật khẩu chỉ nằm trong `DATABASE_URL` (secret qua env/stdin, không bao giờ
 * qua argv — argv hiện trong `ps` + shell history, trái invariant Secrets).
 * Thiếu config thì exit khác 0 kèm hướng dẫn: coi im lặng là "tenant đã được
 * bootstrap" là cách làm một lần bootstrap biến mất. Ngoài ra script tự assert
 * database trong URL đúng là `db-pact-broker` — trỏ nhầm database khác thì
 * chết ngay thay vì tạo tenant ở nhà người khác.
 */

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';
import { isOpaqueId, MAX_OPAQUE_ID_LENGTH } from '@ecoma-io/tenant-kernel-domain';

/** Tenant canonical first-party duy nhất mà script này được phép bootstrap. */
export const CANONICAL_TENANT_NAME = 'ecoma';

/** Tên database mà service này sở hữu; URL trỏ database khác là lỗi config. */
export const PACT_BROKER_DATABASE = 'db-pact-broker';

/** Tên database parse từ connection string — đầu vào của assert CLI. */
export interface BootstrapDatabaseTarget {
  readonly database: string;
}

/** Kết quả một lần bootstrap — CLI in ra, test assert. */
export interface BootstrapTenantResult {
  /** Tenant đã tồn tại trước khi chạy (`true` = lần này là no-op). */
  readonly alreadyExisted: boolean;
  /** Id tenant (uuid) — có ở cả hai nhánh created/no-op. */
  readonly tenantId: string;
  /** Tên tenant — hằng `CANONICAL_TENANT_NAME`, trả về để test assert. */
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

/** Biến môi trường chứa owner (opaque `sub`) của tenant canonical. Bắt buộc. */
export const CANONICAL_TENANT_OWNER_SUB_ENV = 'CANONICAL_TENANT_OWNER_SUB';

/** Kết quả của bước owner-membership trong một lần chạy — nuôi `detail` audit. */
type MembershipOutcome = 'created' | 'verified';

/**
 * Bootstrap tenant canonical — core logic dùng chung bởi CLI và integration
 * test (một đường code duy nhất, đúng pattern runner-canonical của
 * `db/apply.mts`: vòng apply viết riêng trong test là test bản sao, không
 * test runner).
 *
 * Client truyền vào phải có quyền INSERT/SELECT trên `pact.tenants`,
 * `pact.tenant_members` và `pact.audit_events` (runtime role). Hàm KHÔNG tự
 * mở/đóng connection: caller quản lý vòng đời connection (CLI bên dưới) và
 * transaction (test). Các câu DML của một lần bootstrap chạy trong transaction
 * duy nhất của caller để tenant, membership và audit event cùng tồn tại hoặc
 * cùng không.
 *
 * `ownerSub` là định danh opaque của owner tenant, được persistence trên cột
 * `pact.tenants.owner_sub`. `ownerSub` phải vượt qua guard của kernel
 * (`isOpaqueId`) — thiếu hoặc không hợp lệ thì ném lỗi, KHÔNG fallback và
 * KHÔNG tạo tenant mà thiếu owner.
 *
 * Trên đường conflict, mọi trường đã lưu của hàng hiện có được xác minh so
 * với trạng thái bootstrap kỳ vọng và lần chạy fail-closed tại sai khớp đầu
 * tiên, trước khi ghi bất kỳ gì của lần chạy này: tenant `suspended`/`deleted`
 * không bao giờ được hồi sinh, owner khác không bao giờ bị ghi đè, và một
 * hàng không phải `first_party` kèm plan không được nhận vào làm tenant
 * canonical.
 */
export async function bootstrapCanonicalTenant(
  client: Client,
  ownerSub: string,
): Promise<BootstrapTenantResult> {
  if (!isOpaqueId(ownerSub)) {
    throw new Error(
      `owner_sub is required and must be a non-empty opaque id of at most ${MAX_OPAQUE_ID_LENGTH} characters`,
    );
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
     VALUES ($1, 'active', 'first_party', NULL, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [CANONICAL_TENANT_NAME, ownerSub],
  );

  if (inserted.rows.length === 1) {
    const firstRow = inserted.rows[0];
    if (firstRow === undefined) {
      throw new Error('INSERT RETURNING produced a row count without a row');
    }
    const membership = await upsertOwnerMembership(client, firstRow.id, ownerSub);
    await insertBootstrapAuditEvent(client, firstRow.id, 'created', membership);
    return { alreadyExisted: false, tenantId: firstRow.id, tenantName: CANONICAL_TENANT_NAME };
  }

  // ON CONFLICT không trả row → tenant đã tồn tại: đọc trạng thái đã lưu và
  // xác minh trước khi coi lần chạy này là no-op.
  const existing = await client.query<{
    id: string;
    status: string;
    owner_sub: string;
    classification: string;
    plan: string | null;
  }>(`SELECT id, status, owner_sub, classification, plan FROM pact.tenants WHERE name = $1`, [
    CANONICAL_TENANT_NAME,
  ]);
  const row = existing.rows[0];
  if (row === undefined) {
    // Không thể xảy ra với ON CONFLICT + UNIQUE(name) trên cùng một bảng,
    // nhưng không được ước lượng: fail-loud thay vì giả định đã an toàn.
    throw new Error(`tenant ${CANONICAL_TENANT_NAME} missing after ON CONFLICT (unexpected state)`);
  }
  if (row.status !== 'active') {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with status ${row.status}; refusing to resurrect (owner action required)`,
    );
  }
  if (row.owner_sub !== ownerSub) {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with a different owner_sub; ownership is never overwritten — bootstrap refused for the supplied owner`,
    );
  }
  if (row.classification !== 'first_party') {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with classification ${row.classification}; expected 'first_party' — classification is immutable after provisioning and never overwritten by bootstrap`,
    );
  }
  if (row.plan !== null) {
    // Defense in depth: schema cấm first_party có plan
    // (tenants_plan_only_when_customer_check), nên trạng thái này không thể
    // chạm tới qua SQL hợp lệ; phép kiểm giữ đường verify tự chứa đầy đủ.
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with plan ${row.plan}; a first_party tenant must have no plan (NULL)`,
    );
  }

  const membership = await upsertOwnerMembership(client, row.id, ownerSub);
  await insertBootstrapAuditEvent(client, row.id, 'already_existed', membership);
  return { alreadyExisted: true, tenantId: row.id, tenantName: CANONICAL_TENANT_NAME };
}

/**
 * Chèn membership owner của tenant canonical (role `member`, source
 * `bootstrap`) idempotent, rồi đọc hàng đã lưu và fail-closed trừ khi nó giữ
 * đúng role và provenance đó: một hàng membership trùng natural key nhưng
 * mang role hoặc source khác là trạng thái xung đột, không phải no-op, và
 * không bao giờ bị ghi đè.
 *
 * `staff_id` không được ghi: giữ NULL vì nó chỉ dành cho ánh xạ entitlement,
 * còn membership này do bootstrap tạo.
 */
async function upsertOwnerMembership(
  client: Client,
  tenantId: string,
  ownerSub: string,
): Promise<MembershipOutcome> {
  const inserted = await client.query<{ sub: string }>(
    `INSERT INTO pact.tenant_members (tenant_id, sub, role, source)
     VALUES ($1, $2, 'member', 'bootstrap')
     ON CONFLICT (tenant_id, sub) DO NOTHING
     RETURNING sub`,
    [tenantId, ownerSub],
  );
  if (inserted.rows.length === 1) {
    return 'created';
  }

  const existing = await client.query<{ role: string; source: string | null }>(
    `SELECT role, source FROM pact.tenant_members WHERE tenant_id = $1 AND sub = $2`,
    [tenantId, ownerSub],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(
      `owner membership on tenant ${CANONICAL_TENANT_NAME} missing after ON CONFLICT (unexpected state)`,
    );
  }
  if (row.role !== 'member' || row.source !== 'bootstrap') {
    throw new Error(
      `owner membership on tenant ${CANONICAL_TENANT_NAME} exists with role ${row.role}, source ${row.source ?? 'NULL'}; expected role 'member' with source 'bootstrap' — refusing to overwrite role or provenance`,
    );
  }
  return 'verified';
}

/**
 * Ghi audit entry cho đợt bootstrap (created hoặc no-op) vào
 * `pact.audit_events` — bảng append-only có sẵn từ migration `0001`, shape
 * khớp `insertAuditEvent` của infrastructure (không phát minh bảng mới).
 *
 * Actor là script ops, không phải người dùng hay machine token nên
 * `actor_sub`/`actor_token_id` đều NULL; `detail` ghi kết quả đợt chạy để
 * phân biệt created với no-op khi tra audit. Action đặt tên theo quy ước
 * `object.verb` của broker (`machine_token.create`, `environment.create`).
 * Đúng một event mỗi lần chạy thành công; lần chạy fail-closed không ghi gì,
 * vì mọi đường fail ném lỗi trước câu INSERT này.
 */
async function insertBootstrapAuditEvent(
  client: Client,
  tenantId: string,
  bootstrapOutcome: 'created' | 'already_existed',
  membershipOutcome: MembershipOutcome,
): Promise<void> {
  await client.query(
    `INSERT INTO pact.audit_events (tenant_id, actor_sub, actor_token_id, action, outcome, detail)
     VALUES ($1, NULL, NULL, 'tenant.bootstrap', 'success', $2::jsonb)`,
    [
      tenantId,
      JSON.stringify({
        bootstrap: bootstrapOutcome,
        tenant: CANONICAL_TENANT_NAME,
        membership: membershipOutcome,
      }),
    ],
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

  const ownerSub = process.env[CANONICAL_TENANT_OWNER_SUB_ENV];
  if (typeof ownerSub !== 'string' || ownerSub === '') {
    console.error(
      `CANONICAL_TENANT_OWNER_SUB is not set. Set it to the opaque 'sub' of the canonical tenant owner (non-empty, max ${MAX_OPAQUE_ID_LENGTH} chars).`,
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-pact-broker-bootstrap-tenant',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to database:', (error as Error).message);
    process.exit(1);
  }

  try {
    await client.query('BEGIN');
    const result = await bootstrapCanonicalTenant(client, ownerSub);
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
