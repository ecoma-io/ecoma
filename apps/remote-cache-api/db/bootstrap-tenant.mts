/**
 * `node db/bootstrap-tenant.mts` — bootstrap tenant canonical `ecoma`
 * (hàng tenant + membership owner + host project + first trusted CI key) trong
 * `db-remote-cache`.
 *
 * Triển khai bề mặt provisioning của hợp đồng bootstrap/seed: ADR-0020
 * (`docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md`) qua
 * `docs/architecture/02-delivery.md` §3.2 — bề mặt (a), chạy sau `migrate` và
 * trước container serving; KHÔNG bao giờ chạy từ Worker (cấm code path
 * bootstrap trên serving path, Quyết định 2 của ADR-0020). Tên tenant canonical
 * là hằng `ecoma` ở mọi environment (ADR-0020 Quyết định 9; ADR-0026 §6);
 * classification `first_party` chỉ được thiết lập qua đúng đường provisioning
 * này (ADR-0026 §1; domain model §2.9).
 *
 * Script độc lập với deploy pipeline: chạy trực tiếp từ CI runner / ops box
 * bằng PostgreSQL client với credential **migrator** (runtime role không có
 * INSERT trên `tenant_members` — grant trong `0002_roles_and_grants.sql` — và
 * bootstrap là đường duy nhất ghi membership), không bao giờ chạy từ Worker —
 * cùng ranh giới runner/Worker với `db/apply.mts` (HD6: Hyperdrive không hỗ trợ
 * advisory lock; script này chỉ DML nên không cần lock).
 *
 * Hành vi (ADR-0020 Quyết định 5, 6, 9, 13; domain model §2.1–§2.4, §2.9;
 * ADR-0026 §1, §4, §5), tất cả nằm trong MỘT transaction do caller quản lý:
 *  - INSERT `remote_cache.tenants (name 'ecoma', status 'active',
 *    classification 'first_party', plan NULL, owner_sub)`, idempotent
 *    `ON CONFLICT (name) DO NOTHING`. Khi conflict, hàng hiện có được đọc lại
 *    và lần chạy fail-closed trừ khi nó chính xác là no-op bootstrap hợp lệ:
 *    `status = 'active'`, `owner_sub` bằng sub cung cấp (sở hữu không bao giờ
 *    bị ghi đè), `classification = 'first_party'`, `plan IS NULL`. Tenant
 *    `suspended`/`deleted` không bao giờ được hồi sinh (Quyết định 6).
 *  - INSERT membership owner `remote_cache.tenant_members (tenant_id,
 *    member_sub, role 'member')`, idempotent `ON CONFLICT (tenant_id,
 *    member_sub) DO NOTHING`; hàng đã lưu phải đọc lại đúng `role = 'member'`.
 *  - Create-or-get host project của credential CI (ADR-0020 Quyết định 1:
 *    machine credential cho CI thuộc dữ liệu khởi tạo; `api_keys.project_id`
 *    là NOT NULL nên credential cần một project cha) theo natural key
 *    `(tenant_id, name)`.
 *  - First trusted CI key: `trusted_ci = true`, scopes đọc từ env, chỉ SHA-256
 *    hex của plaintext được lưu (hash-only, show-once thuộc đường cấp khác —
 *    plaintext do vận hành cung cấp nên không có cửa sổ show-once nào ở đây).
 *    Plaintext giống hàng active hiện có → no-op; plaintext khác → revoke mọi
 *    key active khác của host project TRƯỚC khi insert (rotation, pattern
 *    `pact` provision-machine-token); key đã revoke không bao giờ được hồi
 *    sinh — verify cuối fail-closed khi số hàng active khác một.
 *  - Đúng MỘT audit event mỗi lần chạy thành công trong `remote_cache.audit_log`
 *    (action `tenant_bootstrap`, outcome `allowed`), ở cả đường created lẫn
 *    đường no-op. Lần chạy fail-closed không ghi audit nào vì mọi đường fail
 *    ném lỗi trước câu INSERT.
 *
 * Race-safety không cần advisory lock: mọi mục tiêu ghi được bảo vệ bằng
 * natural key — `tenants.name` (unique), PK `(tenant_id, member_sub)` của
 * `tenant_members`, UNIQUE `(tenant_id, name)` của `projects`, UNIQUE
 * `token_hash` của `api_keys`. Với READ COMMITTED, bên thua
 * `INSERT ... ON CONFLICT DO NOTHING` chờ INSERT đang dang dở của bên thắng
 * commit rồi skip, rồi đi theo đường đọc-và-verify. KHÔNG tuyên bố race-freedom
 * cho rotation: hai lần chạy đồng thời với plaintext KHÁC nhau, bên thua sẽ bị
 * verify single-active từ chối (fail-loud, rollback toàn bộ) — hành vi đúng,
 * được spec assert, không phải trạng thái âm thầm.
 *
 * Biến môi trường:
 *
 * | Biến                                | Bắt buộc | Ý nghĩa
 * | ----------------------------------- | -------- | ------------------------------
 * | `DATABASE_URL`                      | có       | chuỗi kết nối PostgreSQL (migrator role của db-remote-cache) |
 * | `CANONICAL_TENANT_OWNER_SUB`        | có       | opaque `sub` của owner tenant canonical |
 * | `REMOTE_CACHE_BOOTSTRAP_PROJECT_NAME` | có     | tên host project của credential CI |
 * | `REMOTE_CACHE_BOOTSTRAP_KEY_SCOPES` | có       | danh sách scope cách nhau bởi khoảng trắng |
 * | `REMOTE_CACHE_BOOTSTRAP_KEY_PLAINTEXT` | có    | plaintext key; chỉ SHA-256 hash được lưu |
 *
 * Password chỉ nằm trong `DATABASE_URL` (secret qua env/stdin, không bao giờ
 * qua argv — argv hiện trong `ps` + shell history, trái invariant Secrets).
 * Plaintext key chỉ sống trong env của process và không bao giờ được log hay
 * nội suy vào SQL. Thiếu config thì exit khác 0 kèm hướng dẫn: coi im lặng là
 * "đã bootstrap" là cách làm một lần bootstrap biến mất. Script tự assert
 * `current_database()` đúng là `db-remote-cache` — trỏ nhầm database khác thì
 * chết ngay thay vì tạo tenant ở nhà người khác.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { REMOTE_CACHE_DATABASE } from './migrate.mts';

/** Tên database mà service này sở hữu; re-export cho assert của CLI và test. */
export { REMOTE_CACHE_DATABASE };

/** Tenant canonical first-party duy nhất mà script này được phép bootstrap. */
export const CANONICAL_TENANT_NAME = 'ecoma';

/** Audit action của một lần bootstrap — snake_case, cùng từ điển `audit_log`. */
export const BOOTSTRAP_AUDIT_ACTION = 'tenant_bootstrap';

/** Biến môi trường chứa owner (opaque `sub`) của tenant canonical. Bắt buộc. */
export const CANONICAL_TENANT_OWNER_SUB_ENV = 'CANONICAL_TENANT_OWNER_SUB';

/** Biến môi trường chứa tên host project của credential CI. Bắt buộc. */
export const BOOTSTRAP_PROJECT_NAME_ENV = 'REMOTE_CACHE_BOOTSTRAP_PROJECT_NAME';

/** Biến môi trường chứa danh sách scope của key CI. Bắt buộc. */
export const BOOTSTRAP_KEY_SCOPES_ENV = 'REMOTE_CACHE_BOOTSTRAP_KEY_SCOPES';

/** Biến môi trường chứa plaintext key CI (chỉ hash được lưu). Bắt buộc. */
export const BOOTSTRAP_KEY_PLAINTEXT_ENV = 'REMOTE_CACHE_BOOTSTRAP_KEY_PLAINTEXT';

/** Giới hạn hình dạng `owner_sub` — khớp CHECK `tenants_owner_sub_check` của 0001. */
const MAX_OWNER_SUB_LENGTH = 200;

/** Kết quả một lần bootstrap — CLI in ra, test assert. */
export interface BootstrapTenantResult {
  /** Tenant đã tồn tại trước khi chạy (`true` = nhánh no-op). */
  readonly alreadyExisted: boolean;
  /** Id tenant (uuid) — có ở cả hai nhánh created/no-op. */
  readonly tenantId: string;
  /** Tên tenant — hằng `CANONICAL_TENANT_NAME`, trả về để test assert. */
  readonly tenantName: string;
  /** Membership owner: `created` hay đã tồn tại đúng shape (`verified`). */
  readonly membership: 'created' | 'verified';
  /** Host project: `created` hay đã tồn tại (`verified`). */
  readonly project: 'created' | 'verified';
  /** Kết quả của first trusted CI key sau lần chạy này. */
  readonly key: {
    /** `created` = hàng đầu tiên; `no-op` = plaintext đó đã active; `rotated` = hàng active cũ bị revoke. */
    readonly result: 'created' | 'no-op' | 'rotated';
    /** Id (uuid) của hàng key active duy nhất sau lần chạy này. */
    readonly keyId: string;
    /** Số hàng active trước đó cùng host project mà lần chạy này đã revoke. */
    readonly revokedCount: number;
  };
}

/** Đầu vào của một lần bootstrap, được CLI (hoặc test) giải từ env. */
export interface BootstrapTenantInput {
  /** Opaque `sub` của owner tenant canonical. */
  readonly ownerSub: string;
  /** Tên host project của credential CI — natural key `(tenant_id, name)`. */
  readonly projectName: string;
  /** Danh sách scope cách nhau bởi khoảng trắng, do CHECK `api_key_scopes_check` kiểm. */
  readonly keyScopes: string;
  /** Plaintext key CI; chỉ SHA-256 hex của nó chạm tới database hay SQL. */
  readonly keyPlaintext: string;
}

/** Tên database parse từ connection string — đầu vào của assert CLI. */
export interface BootstrapDatabaseTarget {
  readonly database: string;
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
 * SHA-256 hex (chữ thường) của plaintext UTF-8 — đúng dạng lưu trữ của
 * `remote_cache.api_keys.token_hash` và đúng giá trị mà đường auth của app băm
 * (`sha256Hex` trong `src/routes.ts`). SHA-256 là hàm chuẩn, nên `node:crypto`
 * ở đây và WebCrypto của app sinh cùng digest cho cùng input.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Assert `current_database()` đúng là database của service này — server-side
 * xác nhận, mạnh hơn parse URL: URL có thể qua connection proxy/override,
 * database thật mà client đang nói chuyện mới là nguồn sự thật. Trỏ nhầm
 * database là chết ngay, trước khi một query bootstrap nào chạm đích.
 */
export async function assertBootstrapDatabase(client: Client): Promise<string> {
  const { rows } = await client.query<{ current_database: string }>(
    `SELECT current_database() AS current_database`,
  );
  const currentDatabase = rows[0]?.current_database;
  if (currentDatabase !== REMOTE_CACHE_DATABASE) {
    throw new Error(
      `DATABASE_URL points at database ${currentDatabase ?? '<unknown>'}; this script only bootstraps ${REMOTE_CACHE_DATABASE}.`,
    );
  }
  return currentDatabase;
}

/**
 * Giải đầu vào CLI từ một bản ghi dạng env — fail-closed kèm chỉ dẫn cụ thể
 * khi thiếu thứ gì đó. Hàm thuần để test ghim các nhánh fail mà không cần
 * database; `main` áp nó lên `process.env`.
 */
export function parseBootstrapEnv(env: NodeJS.ProcessEnv): BootstrapTenantInput {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'DATABASE_URL is not set. Run this script from a CI runner or ops box with the migrator role credentials; the password goes in the connection string (env/stdin), never in argv.',
    );
  }
  const ownerSub = env[CANONICAL_TENANT_OWNER_SUB_ENV];
  if (typeof ownerSub !== 'string' || ownerSub === '') {
    throw new Error(
      `${CANONICAL_TENANT_OWNER_SUB_ENV} is not set. Set it to the opaque 'sub' of the canonical tenant owner (non-empty, max ${String(MAX_OWNER_SUB_LENGTH)} chars).`,
    );
  }
  const projectName = env[BOOTSTRAP_PROJECT_NAME_ENV];
  if (projectName === undefined || projectName === '') {
    throw new Error(
      `${BOOTSTRAP_PROJECT_NAME_ENV} is not set. Set it to the host project name of the CI credential (lowercase DNS-like label).`,
    );
  }
  const keyScopes = env[BOOTSTRAP_KEY_SCOPES_ENV];
  if (keyScopes === undefined || keyScopes === '') {
    throw new Error(
      `${BOOTSTRAP_KEY_SCOPES_ENV} is not set. Set it to a space-separated scope list (read|write); a key without scopes is useless.`,
    );
  }
  const keyPlaintext = env[BOOTSTRAP_KEY_PLAINTEXT_ENV];
  if (keyPlaintext === undefined || keyPlaintext === '') {
    throw new Error(
      `${BOOTSTRAP_KEY_PLAINTEXT_ENV} is not set. Treating silence as "the key is already provisioned" is how a one-time credential disappears; pass the plaintext via env, never argv.`,
    );
  }
  return { ownerSub, projectName, keyScopes, keyPlaintext };
}

/**
 * Bootstrap tenant canonical — core logic dùng chung bởi CLI và integration
 * test (một đường code duy nhất, đúng pattern runner-canonical của
 * `db/apply.mts`: vòng apply viết riêng trong test là test bản sao, không test
 * runner).
 *
 * Client truyền vào phải là credential **migrator** (owner của schema sau khi
 * migration chạy): runtime role không có INSERT trên `tenant_members`, và
 * bootstrap là đường provisioning, không phải serving. Hàm KHÔNG tự mở/đóng
 * connection: caller quản lý vòng đời connection (CLI bên dưới) và transaction
 * (test). Các câu DML của một lần bootstrap chạy trong transaction duy nhất
 * của caller để tenant, membership, project, key và audit cùng tồn tại hoặc
 * cùng không (valid prefix semantics — ADR-0020 Quyết định 6).
 *
 * Trên đường conflict, mọi trường đã lưu của hàng hiện có được xác minh so với
 * trạng thái bootstrap kỳ vọng và lần chạy fail-closed tại sai khớp đầu tiên,
 * trước khi ghi bất kỳ gì của lần chạy này: tenant `suspended`/`deleted`
 * không bao giờ được hồi sinh, owner khác không bao giờ bị ghi đè, và một hàng
 * không phải `first_party` không được nhận vào làm tenant canonical
 * (classification bất invariant sau provisioning — ADR-0026 §1).
 */
export async function bootstrapCanonicalTenant(
  client: Client,
  input: BootstrapTenantInput,
): Promise<BootstrapTenantResult> {
  validateOwnerSub(input.ownerSub);
  validateProjectName(input.projectName);
  validateKeyScopes(input.keyScopes);
  if (input.keyPlaintext === '') {
    throw new Error('key plaintext is required');
  }

  const tenant = await upsertCanonicalTenant(client, input.ownerSub);
  const membership = await upsertOwnerMembership(client, tenant.id, input.ownerSub);
  const project = await ensureHostProject(client, tenant.id, input.projectName);
  const key = await ensureFirstTrustedCiKey(client, project, input);
  await insertBootstrapAuditEvent(client, tenant.id, {
    tenant: CANONICAL_TENANT_NAME,
    membership,
    project: project.outcome,
    key: key.result,
    revokedKeys: key.revokedCount,
  });
  return {
    alreadyExisted: !tenant.created,
    tenantId: tenant.id,
    tenantName: CANONICAL_TENANT_NAME,
    membership,
    project: project.outcome,
    key,
  };
}

/** Guard hình dạng `owner_sub` — khớp CHECK `tenants_owner_sub_check` của 0001. */
function validateOwnerSub(ownerSub: string): void {
  const trimmed = ownerSub.trim();
  if (
    trimmed === '' ||
    trimmed.length > MAX_OWNER_SUB_LENGTH ||
    trimmed !== ownerSub ||
    ownerSub.length > MAX_OWNER_SUB_LENGTH
  ) {
    throw new Error(
      `owner_sub is required and must be a non-empty opaque id of at most ${String(MAX_OWNER_SUB_LENGTH)} characters with no surrounding whitespace`,
    );
  }
}

/** Guard tên project — khớp CHECK `projects_name_check` của 0001 (fail sớm, rõ nghĩa). */
function validateProjectName(projectName: string): void {
  if (/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u.test(projectName) === false) {
    throw new Error(
      `project name ${JSON.stringify(projectName)} must be a lowercase DNS-like label matching ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`,
    );
  }
}

/** Guard danh sách scope — khớp CHECK `api_key_scopes_check` của 0001 (fail sớm). */
function validateKeyScopes(keyScopes: string): void {
  if (/^(read|write)( (read|write))*$/u.test(keyScopes) === false) {
    throw new Error(
      `key scopes ${JSON.stringify(keyScopes)} must be a space-separated list of read|write`,
    );
  }
}

/**
 * Chèn tenant canonical idempotent và trả về id cùng cờ `created` của nó.
 * Nhánh conflict đọc lại trạng thái đã lưu và
 * xác minh trước khi coi lần chạy này là no-op — sai khớp đầu tiên là throw,
 * nên không có dòng ghi nào của lần chạy xảy ra sau đó.
 */
async function upsertCanonicalTenant(
  client: Client,
  ownerSub: string,
): Promise<{ id: string; created: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name, status, classification, plan, owner_sub)
     VALUES ($1, 'active', 'first_party', NULL, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [CANONICAL_TENANT_NAME, ownerSub],
  );
  const firstRow = inserted.rows[0];
  if (firstRow !== undefined) {
    return { id: firstRow.id, created: true };
  }

  // ON CONFLICT không trả row → tenant đã tồn tại: đọc trạng thái đã lưu và
  // xác minh trước khi coi lần chạy này là no-op.
  const existing = await client.query<{
    id: string;
    status: string;
    owner_sub: string;
    classification: string;
    plan: string | null;
  }>(
    `SELECT id, status, owner_sub, classification, plan FROM remote_cache.tenants WHERE name = $1`,
    [CANONICAL_TENANT_NAME],
  );
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
    // Defense in depth: schema cấm first_party có plan (tenants_plan_check),
    // nên trạng thái này không thể chạm tới qua SQL hợp lệ; phép kiểm giữ
    // đường verify tự chứa đầy đủ.
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with plan ${row.plan}; a first_party tenant must have no plan (NULL)`,
    );
  }
  return { id: row.id, created: false };
}

/**
 * Chèn membership owner của tenant canonical (role `member`) idempotent, rồi
 * đọc hàng đã lưu và fail-closed trừ khi nó giữ đúng role đó: một hàng
 * membership trùng natural key nhưng mang role khác là trạng thái xung đột,
 * không phải no-op, và không bao giờ bị ghi đè.
 */
async function upsertOwnerMembership(
  client: Client,
  tenantId: string,
  ownerSub: string,
): Promise<'created' | 'verified'> {
  const inserted = await client.query<{ member_sub: string }>(
    `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (tenant_id, member_sub) DO NOTHING
     RETURNING member_sub`,
    [tenantId, ownerSub],
  );
  if (inserted.rows.length === 1) {
    return 'created';
  }

  const existing = await client.query<{ role: string }>(
    `SELECT role FROM remote_cache.tenant_members WHERE tenant_id = $1 AND member_sub = $2`,
    [tenantId, ownerSub],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(
      `owner membership on tenant ${CANONICAL_TENANT_NAME} missing after ON CONFLICT (unexpected state)`,
    );
  }
  if (row.role !== 'member') {
    throw new Error(
      `owner membership on tenant ${CANONICAL_TENANT_NAME} exists with role ${row.role}; expected role 'member' — refusing to overwrite role`,
    );
  }
  return 'verified';
}

/**
 * Create-or-get host project của credential CI theo natural key
 * `(tenant_id, name)` — `api_keys.project_id` là NOT NULL nên credential CI
 * cần một project cha; project này là nhà của đúng credential mà bootstrap
 * quản lý (ADR-0020 Quyết định 1: machine credential cho CI thuộc dữ liệu
 * khởi tạo do hệ thống sở hữu).
 */
async function ensureHostProject(
  client: Client,
  tenantId: string,
  projectName: string,
): Promise<{ id: string; outcome: 'created' | 'verified' }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.projects (tenant_id, name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING id`,
    [tenantId, projectName],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined) {
    return { id: insertedRow.id, outcome: 'created' };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM remote_cache.projects WHERE tenant_id = $1 AND name = $2`,
    [tenantId, projectName],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(`host project ${projectName} missing after ON CONFLICT (unexpected state)`);
  }
  return { id: row.id, outcome: 'verified' };
}

/**
 * Cấp first trusted CI key của host project — revoke-then-insert trong cùng
 * transaction (rotation), idempotent theo `token_hash` UNIQUE.
 *
 * Plaintext giống hàng active hiện có → no-op; plaintext khác → mọi hàng
 * active khác của host project bị revoke TRƯỚC khi insert hàng mới, nên không
 * bao giờ còn hai credential hợp lệ cạnh nhau; hàng với cùng hash đã bị revoke
 * không bao giờ được hồi sinh — verify single-active fail-closed. Verify cũng
 * từ chối hash trùng với hàng của project khác (một plaintext chỉ sở hữu đúng
 * một hàng) và hàng lưu scopes khác cấu hình — tất cả là quyết định của người
 * vận hành, không bao giờ tự sửa âm thầm.
 */
async function ensureFirstTrustedCiKey(
  client: Client,
  project: { id: string; outcome: 'created' | 'verified' },
  input: BootstrapTenantInput,
): Promise<BootstrapTenantResult['key']> {
  const tokenHash = hashApiKey(input.keyPlaintext);

  // Rotation: revoke mọi key active KHÁC của host project trước. Predicate
  // `revoked_at IS NULL` giữ khớp với trigger revoke-only của 0001 (hàng đã
  // revoke được bỏ qua, không bao giờ chạm lại).
  const revoked = await client.query<{ id: string }>(
    `UPDATE remote_cache.api_keys SET revoked_at = now()
      WHERE project_id = $1 AND revoked_at IS NULL AND token_hash <> $2
      RETURNING id`,
    [project.id, tokenHash],
  );
  const revokedCount = revoked.rows.length;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes, trusted_ci)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING id`,
    [project.id, tokenHash, input.keyScopes],
  );

  // Verify cuối BÊN TRONG transaction — fail-closed trước sự mơ hồ: đúng một
  // key active trong host project, mang đúng hash, scopes và trusted_ci đã
  // cấu hình. Chẩn đoán hai dạng "không hàng active nào" để thông điệp fail
  // nói đúng việc người vận hành cần làm.
  const active = await client.query<{
    id: string;
    token_hash: string;
    scopes: string;
    trusted_ci: boolean;
  }>(
    `SELECT id, token_hash, scopes, trusted_ci FROM remote_cache.api_keys
      WHERE project_id = $1 AND revoked_at IS NULL`,
    [project.id],
  );
  if (active.rows.length !== 1) {
    if (active.rows.length === 0) {
      const hashOwner = await client.query<{ project_id: string; revoked_at: Date | null }>(
        `SELECT project_id, revoked_at FROM remote_cache.api_keys WHERE token_hash = $1`,
        [tokenHash],
      );
      const owner = hashOwner.rows[0];
      if (owner !== undefined && owner.project_id !== project.id) {
        throw new Error(
          `the plaintext already belongs to a key of project ${owner.project_id}; a plaintext owns exactly one row (token_hash is unique), use a distinct plaintext for the CI key of ${CANONICAL_TENANT_NAME}`,
        );
      }
    }
    throw new Error(
      `expected exactly one active API key in the host project, found ${String(active.rows.length)}; failing closed — a revoked key is never resurrected by bootstrap (rotation is an operator action: change the plaintext)`,
    );
  }
  const activeRow = active.rows[0];
  if (activeRow === undefined) {
    throw new Error('active key row missing after verification (unexpected state)');
  }
  // Phòng thủ đa lớp: các phép kiểm giữ verify tự chứa, thay vì tin câu lệnh
  // đứng trước.
  if (activeRow.token_hash !== tokenHash) {
    throw new Error(
      'active API key carries a different hash than the configured plaintext; refusing to continue',
    );
  }
  if (activeRow.scopes !== input.keyScopes) {
    throw new Error(
      `active API key carries scopes "${activeRow.scopes}" but ${BOOTSTRAP_KEY_SCOPES_ENV} says "${input.keyScopes}"; the stored scopes are never silently rewritten — rotate the plaintext to apply the new scope set`,
    );
  }
  if (activeRow.trusted_ci !== true) {
    throw new Error('active API key is not trusted_ci; refusing to continue');
  }

  const result: BootstrapTenantResult['key']['result'] =
    revokedCount > 0 ? 'rotated' : inserted.rows.length === 1 ? 'created' : 'no-op';
  return { result, keyId: activeRow.id, revokedCount };
}

/**
 * Ghi audit entry cho đợt bootstrap (created hoặc no-op) vào
 * `remote_cache.audit_log` — bảng append-only có sẵn từ migration `0005`, shape
 * khớp vocabulary của nó (không phát minh bảng mới). `actor` là script ops
 * ('system' — đúng vocabulary của cột), `target` là tenant id, `outcome`
 * 'allowed' vì chỉ lần chạy thành công mới tới được đây, `project_id` NULL vì
 * event là tenant-scoped. `details` là cột text human-readable (comment của
 * 0005: "Human-readable details (English)") — ghi kết quả từng bước theo dạng
 * key=value để phân biệt created với no-op khi tra audit, không phải JSON.
 */
async function insertBootstrapAuditEvent(
  client: Client,
  tenantId: string,
  detail: {
    tenant: string;
    membership: 'created' | 'verified';
    project: 'created' | 'verified';
    key: 'created' | 'no-op' | 'rotated';
    revokedKeys: number;
  },
): Promise<void> {
  const details =
    `bootstrap=${detail.membership === 'created' ? 'created' : 'no-op'} tenant=${detail.tenant} ` +
    `membership=${detail.membership} project=${detail.project} key=${detail.key} ` +
    `revoked=${String(detail.revokedKeys)}`;
  await client.query(
    `INSERT INTO remote_cache.audit_log (actor, action, target, outcome, details)
     VALUES ('system', $1, $2, 'allowed', $3)`,
    [BOOTSTRAP_AUDIT_ACTION, tenantId, details],
  );
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  let input: BootstrapTenantInput;
  try {
    input = parseBootstrapEnv(process.env);
  } catch (error) {
    console.error('bootstrap-tenant refuses to run:', (error as Error).message);
    process.exit(1);
  }

  try {
    parseDatabaseUrl(process.env['DATABASE_URL'] as string);
  } catch (error) {
    console.error('DATABASE_URL is invalid:', (error as Error).message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env['DATABASE_URL'] as string,
    application_name: 'ecoma-remote-cache-bootstrap-tenant',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to database:', (error as Error).message);
    process.exit(1);
  }

  try {
    await assertBootstrapDatabase(client);
    await client.query('BEGIN');
    const result = await bootstrapCanonicalTenant(client, input);
    await client.query('COMMIT');
    console.log(
      `tenant ${result.tenantName} ${result.alreadyExisted ? 'already exists (no-op, state preserved)' : 'created'} (id ${result.tenantId}); membership ${result.membership}; project ${result.project}; key ${result.key.result} (revoked ${String(result.key.revokedCount)} other active key(s), active row ${result.key.keyId})`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('bootstrap-tenant failed:', (error as Error).message);
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
