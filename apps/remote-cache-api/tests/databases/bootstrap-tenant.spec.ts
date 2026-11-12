/**
 * Bootstrap tenant canonical `ecoma` trên PostgreSQL thật (ADR-0020 §3.2 bề mặt
 * provisioning; ADR-0026 — classification `first_party` chỉ set được qua đường
 * này; #20).
 *
 * Gọi đúng core {@link bootstrapCanonicalTenant} mà CLI chạy
 * (runner-canonical, không viết vòng provisioning riêng) và kiểm tra trạng
 * thái database sau mỗi lần chạy. Khác pact: remote-cache bootstrap chạy bằng
 * credential **migrator** (runtime không có INSERT trên `tenant_members` —
 * grant trong `0002`), nên wrapper bọc đúng credential đó. Các trạng thái lệch
 * (suspended, classification customer, scopes đổi, revoke) được dựng bằng
 * superuser — hành động của operator, tách biệt với credential bootstrap.
 *
 * ⚠️ Suite cần Docker: probe hỏng làm `globalSetup` throw và cả run đỏ
 * (fail-loud, 06-testing.md §6) — skip với exit 0 không phải kết quả được
 * chấp nhận.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertBootstrapDatabase,
  bootstrapCanonicalTenant,
  BOOTSTRAP_KEY_PLAINTEXT_ENV,
  BOOTSTRAP_KEY_SCOPES_ENV,
  BOOTSTRAP_PROJECT_NAME_ENV,
  CANONICAL_TENANT_NAME,
  CANONICAL_TENANT_OWNER_SUB_ENV,
  hashApiKey,
  parseBootstrapEnv,
  parseDatabaseUrl,
  REMOTE_CACHE_DATABASE,
} from '../../db/bootstrap-tenant.mts';
import { REMOTE_CACHE_DATABASE as HARNESS_DATABASE } from '../../db/migrate.mts';
import { type RemoteCacheDatabase, startRemoteCacheDatabase } from '../integrations/harness.ts';

const OWNER = 'sub-owner-bootstrap';
const HOST_PROJECT = 'ecoma-ci';
const SCOPES = 'read write';
const PLAINTEXT_1 = 'bootstrap-ci-plaintext-one';
const PLAINTEXT_2 = 'bootstrap-ci-plaintext-two';
const PLAINTEXT_3 = 'bootstrap-ci-plaintext-three';

/** Đầu vào bootstrap chuẩn của suite — plaintext thay được qua tham số. */
function bootstrapInput(plaintext: string = PLAINTEXT_1) {
  return { ownerSub: OWNER, projectName: HOST_PROJECT, keyScopes: SCOPES, keyPlaintext: plaintext };
}

interface TenantRow {
  id: string;
  name: string;
  status: string;
  classification: string;
  plan: string | null;
  owner_sub: string;
  created_at: Date;
}

async function queryTenant(db: RemoteCacheDatabase): Promise<TenantRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<TenantRow>(
      `SELECT id, name, status, classification, plan, owner_sub, created_at
         FROM remote_cache.tenants WHERE name = $1`,
      [CANONICAL_TENANT_NAME],
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface MembershipRow {
  tenant_id: string;
  member_sub: string;
  role: string;
}

async function queryMemberships(db: RemoteCacheDatabase): Promise<MembershipRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<MembershipRow>(
      `SELECT tenant_id, member_sub, role FROM remote_cache.tenant_members`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
}

async function queryHostProjects(db: RemoteCacheDatabase): Promise<ProjectRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<ProjectRow>(
      `SELECT id, tenant_id, name FROM remote_cache.projects WHERE name = $1`,
      [HOST_PROJECT],
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface ApiKeyRow {
  id: string;
  project_id: string;
  token_hash: string;
  scopes: string;
  trusted_ci: boolean;
  revoked_at: Date | null;
  created_at: Date;
}

async function queryKeys(db: RemoteCacheDatabase): Promise<ApiKeyRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<ApiKeyRow>(
      `SELECT id, project_id, token_hash, scopes, trusted_ci, revoked_at, created_at
         FROM remote_cache.api_keys ORDER BY created_at, id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface AuditRow {
  actor: string;
  action: string;
  target: string;
  outcome: string;
  details: string;
}

async function queryBootstrapAuditEvents(db: RemoteCacheDatabase): Promise<AuditRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<AuditRow>(
      `SELECT actor, action, target, outcome, details FROM remote_cache.audit_log
        WHERE action = 'tenant_bootstrap' ORDER BY time, id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

/** Audit detail sắp theo thứ tự xác định — jsonb/text không giữ thứ tự run. */
function auditDetailsSorted(rows: AuditRow[]): string[] {
  return rows.map((row) => row.details).toSorted((a, b) => a.localeCompare(b));
}

/** Audit detail kỳ vọng của một lần created và một lần no-op, cùng thứ tự sort. */
function expectedAuditDetailsSorted(): string[] {
  return [
    `bootstrap=created tenant=${CANONICAL_TENANT_NAME} membership=created project=created key=created revoked=0`,
    `bootstrap=no-op tenant=${CANONICAL_TENANT_NAME} membership=verified project=verified key=no-op revoked=0`,
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Type guard cho kết quả `Promise.allSettled` — tránh cast lặp ở test concurrency. */
function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled';
}

/**
 * Một lần bootstrap bọc trong đúng transaction mà CLI thực hiện
 * (BEGIN → bootstrap → COMMIT, ROLLBACK khi lỗi), trên credential migrator
 * thật — credential mà CLI sản phẩm dùng (runtime thiếu INSERT trên
 * `tenant_members`).
 */
async function runBootstrapped(
  db: RemoteCacheDatabase,
  input: ReturnType<typeof bootstrapInput>,
): Promise<Awaited<ReturnType<typeof bootstrapCanonicalTenant>>> {
  const client = await db.connectAsMigrator();
  try {
    return await runBootstrapInTransaction(client, input);
  } finally {
    await client.end();
  }
}

/**
 * Vòng BEGIN/COMMIT trên một client có sẵn — dùng chung bởi các test đồng thời
 * ở dưới. ⚠️ COMMIT phải nằm BÊN TRONG promise của từng bên: nếu commit xảy ra
 * sau Promise.all, bên thua sẽ bị chặn trên lock của bên thắng trong khi bên
 * thắng đang chờ Promise.all — một deadlock tự làm ra, lock còn giữ sẽ kéo
 * timeout lan sang các test phía sau.
 */
function runBootstrapInTransaction(
  client: import('pg').Client,
  input: ReturnType<typeof bootstrapInput>,
): Promise<Awaited<ReturnType<typeof bootstrapCanonicalTenant>>> {
  return client.query('BEGIN').then(async () => {
    try {
      const result = await bootstrapCanonicalTenant(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

describe(`bootstrap of the canonical ${CANONICAL_TENANT_NAME} tenant on ${HARNESS_DATABASE}`, () => {
  let db: RemoteCacheDatabase;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('creates the first_party tenant, owner membership, host project, trusted CI key and one audit event together on the first run', async () => {
    // Tự lập trạng thái đầu vào: truncate để không dựa vào dữ liệu còn sót
    // trong harness — test này phải tự đứng vững cả khi chạy đơn lẻ.
    await db.truncateData();

    expect(await queryTenant(db)).toEqual([]);

    const result = await runBootstrapped(db, bootstrapInput());
    expect(result.alreadyExisted).toBe(false);
    expect(result.tenantName).toBe(CANONICAL_TENANT_NAME);
    expect(result.membership).toBe('created');
    expect(result.project).toBe('created');
    expect(result.key.result).toBe('created');
    expect(result.key.revokedCount).toBe(0);

    // Tenant: active, first_party, không có plan, owner được ghi.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.id).toBe(result.tenantId);
    expect(tenants[0]?.status).toBe('active');
    expect(tenants[0]?.classification).toBe('first_party');
    expect(tenants[0]?.plan).toBeNull();
    expect(tenants[0]?.owner_sub).toBe(OWNER);

    // Membership: đúng một membership owner, role member.
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenant_id).toBe(result.tenantId);
    expect(memberships[0]?.member_sub).toBe(OWNER);
    expect(memberships[0]?.role).toBe('member');

    // Host project: đúng một project nhà của credential CI.
    const projects = await queryHostProjects(db);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBeTruthy();
    expect(projects[0]?.tenant_id).toBe(result.tenantId);
    expect(projects[0]?.name).toBe(HOST_PROJECT);

    // Key: đúng một hàng active, trusted_ci, scopes đọc từ input, chỉ hash.
    const keys = await queryKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.project_id).toBe(projects[0]?.id);
    expect(keys[0]?.trusted_ci).toBe(true);
    expect(keys[0]?.scopes).toBe(SCOPES);
    expect(keys[0]?.token_hash).toBe(hashApiKey(PLAINTEXT_1));
    expect(keys[0]?.revoked_at).toBeNull();

    // Audit: đúng một event cho lần chạy created.
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe('system');
    expect(audit[0]?.target).toBe(result.tenantId);
    expect(audit[0]?.outcome).toBe('allowed');
    expect(audit[0]?.details).toContain('bootstrap=created');
  });

  it('is a safe no-op on a re-run with the same plaintext and preserves existing state', async () => {
    await db.truncateData();
    const first = await runBootstrapped(db, bootstrapInput());
    expect(first.alreadyExisted).toBe(false);

    // Chụp trạng thái sau lần tạo để đối chiếu với trạng thái sau lần no-op.
    const before = await queryTenant(db);
    expect(before).toHaveLength(1);
    const beforeId = before[0]?.id ?? '';
    const beforeCreatedAt = before[0]?.created_at;
    const beforeKeys = await queryKeys(db);
    expect(beforeKeys).toHaveLength(1);
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);

    const result = await runBootstrapped(db, bootstrapInput());
    expect(result.alreadyExisted).toBe(true);
    expect(result.tenantId).toBe(beforeId);
    expect(result.membership).toBe('verified');
    expect(result.project).toBe('verified');
    expect(result.key.result).toBe('no-op');
    expect(result.key.keyId).toBe(beforeKeys[0]?.id);

    const after = await queryTenant(db);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(beforeId);
    expect(after[0]?.status).toBe('active');
    expect(after[0]?.classification).toBe('first_party');
    expect(after[0]?.plan).toBeNull();
    expect(after[0]?.owner_sub).toBe(OWNER);
    // created_at không đổi: no-op không cập nhật hàng đã có.
    expect(after[0]?.created_at.getTime()).toBe(beforeCreatedAt?.getTime());

    // Vẫn đúng một key active — no-op không thêm hàng nào.
    const keys = await queryKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe(beforeKeys[0]?.id);
    expect(keys[0]?.revoked_at).toBeNull();

    // Lần chạy no-op ghi audit event của riêng nó: created + no-op.
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual(expectedAuditDetailsSorted());
  });

  it('never overwrites ownership when a second bootstrap passes a different owner', async () => {
    await db.truncateData();

    const first = await runBootstrapped(db, bootstrapInput());
    expect(first.alreadyExisted).toBe(false);

    const client = await db.connectAsMigrator();
    try {
      await client.query('BEGIN');
      await expect(
        bootstrapCanonicalTenant(client, {
          ...bootstrapInput(PLAINTEXT_2),
          ownerSub: 'sub-owner-second',
        }),
      ).rejects.toThrow(/ownership is never overwritten/u);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    // Lần chạy bị từ chối không ghi gì: ownership giữ nguyên, không
    // membership cho sub thứ hai, không audit event, không key mới.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.owner_sub).toBe(OWNER);

    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.member_sub).toBe(OWNER);

    expect(await queryKeys(db)).toHaveLength(1);
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('refuses to resurrect an existing suspended tenant', async () => {
    await db.truncateData();
    await runBootstrapped(db, bootstrapInput());

    // Suspended là hành động của operator — dựng bằng superuser.
    const seeder = await db.connect();
    try {
      await seeder.query(`UPDATE remote_cache.tenants SET status = 'suspended' WHERE name = $1`, [
        CANONICAL_TENANT_NAME,
      ]);
    } finally {
      await seeder.end();
    }

    const before = await queryTenant(db);
    expect(before[0]?.id).toBeDefined();

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(/refusing to resurrect/u);

    // Lần chạy bị từ chối giữ nguyên trạng thái suspended và không ghi audit.
    const after = await queryTenant(db);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.status).toBe('suspended');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('refuses to resurrect an existing deleted tenant', async () => {
    await db.truncateData();
    await runBootstrapped(db, bootstrapInput());

    const seeder = await db.connect();
    try {
      await seeder.query(`UPDATE remote_cache.tenants SET status = 'deleted' WHERE name = $1`, [
        CANONICAL_TENANT_NAME,
      ]);
    } finally {
      await seeder.end();
    }

    const before = await queryTenant(db);
    expect(before[0]?.id).toBeDefined();

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(/refusing to resurrect/u);

    const after = await queryTenant(db);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.status).toBe('deleted');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed when the existing tenant is not first_party', async () => {
    await db.truncateData();
    await runBootstrapped(db, bootstrapInput());

    // Dựng trước một tenant shape customer: hợp lệ theo constraint của schema
    // (customer ⇒ plan free/paid), nhưng không phải trạng thái no-op hợp lệ
    // của bootstrap. (Tenant first_party CÓ plan không thể tạo qua SQL —
    // tenants_plan_check cấm — nên shape customer là mismatch classification
    // có thể lưu được.) Cập nhật bằng superuser: runtime bị chặn UPDATE cột
    // classification/plan từ migration 0007.
    const seeder = await db.connect();
    try {
      await seeder.query(
        `UPDATE remote_cache.tenants SET classification = 'customer', plan = 'free' WHERE name = $1`,
        [CANONICAL_TENANT_NAME],
      );
    } finally {
      await seeder.end();
    }

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(
      /classification customer; expected 'first_party'/u,
    );

    // Lần chạy bị từ chối không ghi đè classification hay plan, và không
    // ghi audit.
    const after = await queryTenant(db);
    expect(after[0]?.classification).toBe('customer');
    expect(after[0]?.plan).toBe('free');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed when the stored CI key carries a different scope set', async () => {
    await db.truncateData();
    await runBootstrapped(db, bootstrapInput());

    // Operator đổi scopes của hàng đã lưu: lần chạy sau phải từ chối sửa âm
    // thầm — scopes của key là quyết định của người vận hành.
    const seeder = await db.connect();
    try {
      await seeder.query(`UPDATE remote_cache.api_keys SET scopes = 'read'`);
    } finally {
      await seeder.end();
    }

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(
      /scopes are never silently rewritten/u,
    );

    // Scopes giữ nguyên, không key mới, không audit.
    const keys = await queryKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.scopes).toBe('read');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('rotates the trusted CI key when the plaintext changes (revoke-then-insert)', async () => {
    await db.truncateData();
    const first = await runBootstrapped(db, bootstrapInput(PLAINTEXT_1));
    expect(first.key.result).toBe('created');
    const firstKeyId = first.key.keyId;

    const second = await runBootstrapped(db, bootstrapInput(PLAINTEXT_2));
    expect(second.alreadyExisted).toBe(true);
    expect(second.key.result).toBe('rotated');
    expect(second.key.revokedCount).toBe(1);
    expect(second.key.keyId).not.toBe(firstKeyId);

    // Hàng cũ revoked, hàng mới active — không bao giờ hai credential song song.
    const keys = await queryKeys(db);
    expect(keys).toHaveLength(2);
    const revoked = keys.filter((k) => k.revoked_at !== null);
    const active = keys.filter((k) => k.revoked_at === null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.id).toBe(firstKeyId);
    expect(revoked[0]?.token_hash).toBe(hashApiKey(PLAINTEXT_1));
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(second.key.keyId);
    expect(active[0]?.token_hash).toBe(hashApiKey(PLAINTEXT_2));

    // Audit: hai event, event rotation ghi đúng kết quả rotated.
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)[1]).toContain('key=rotated revoked=1');
  });

  it('never resurrects a revoked key and fails closed', async () => {
    await db.truncateData();
    await runBootstrapped(db, bootstrapInput());

    // Operator revoke key: hàng rời khỏi trạng thái active — plaintext cũ
    // không còn hợp lệ và bootstrap không bao giờ hồi sinh hàng revoked.
    const seeder = await db.connect();
    try {
      await seeder.query(`UPDATE remote_cache.api_keys SET revoked_at = now()`);
    } finally {
      await seeder.end();
    }

    await expect(runBootstrapped(db, bootstrapInput())).rejects.toThrow(
      /revoked key is never resurrected|expected exactly one active/u,
    );

    // Vẫn revoked, không hàng mới, không audit.
    const keys = await queryKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.revoked_at).not.toBeNull();
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('rolls back the whole run when a step fails mid-transaction', async () => {
    await db.truncateData();

    const real = await db.connectAsMigrator();
    try {
      // Một client fail đúng bước CUỐI (audit): mọi bước ghi trước đó —
      // tenant, membership, project, key — chỉ hoàn tác được bởi ROLLBACK do
      // caller quản lý, chứng minh cả lần chạy là atomic (valid prefix
      // semantics — ADR-0020 Quyết định 6).
      const failingAudit = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('remote_cache.audit_log')) {
            throw new Error('simulated audit insert failure');
          }
          return real.query(sql, params);
        },
      } as unknown as import('pg').Client;

      await real.query('BEGIN');
      try {
        await expect(bootstrapCanonicalTenant(failingAudit, bootstrapInput())).rejects.toThrow(
          /simulated audit insert failure/u,
        );
      } finally {
        await real.query('ROLLBACK');
      }

      // Không có gì được lưu: không tenant, không membership, không project,
      // không key, không audit event.
      expect(await queryTenant(db)).toEqual([]);
      expect(await queryMemberships(db)).toEqual([]);
      expect(await queryHostProjects(db)).toEqual([]);
      expect(await queryKeys(db)).toEqual([]);
      expect(await queryBootstrapAuditEvents(db)).toEqual([]);
    } finally {
      await real.end();
    }
  });

  it('converges when two connections bootstrap concurrently', async () => {
    // Reset để lần chạy này là lần tạo đầu tiên: truncate mọi bảng domain mà
    // không đụng DDL/grants/trigger (harness cung cấp đúng vậy).
    await db.truncateData();

    // Mỗi bên bọc BEGIN/COMMIT quanh một lần bootstrap — đúng transaction
    // mà CLI thực hiện (xem warning deadlock trên `runBootstrapInTransaction`).
    const clientA = await db.connectAsMigrator();
    const clientB = await db.connectAsMigrator();
    try {
      const [resultA, resultB] = await Promise.all([
        runBootstrapInTransaction(clientA, bootstrapInput()),
        runBootstrapInTransaction(clientB, bootstrapInput()),
      ]);

      // Đúng một bên created, một bên already-existed; cả hai kết quả trỏ về
      // cùng tenant id và cùng key active — không fatal error (ADR-0020
      // quyết định 5).
      expect([resultA.alreadyExisted, resultB.alreadyExisted].toSorted()).toEqual([false, true]);
      expect(resultA.tenantId).toBe(resultB.tenantId);
      expect(resultA.key.keyId).toBe(resultB.key.keyId);
    } finally {
      await clientA.end();
      await clientB.end();
    }

    // Hội tụ: một tenant, một membership owner, một project, một key active,
    // một audit row mỗi lần chạy.
    expect(await queryTenant(db)).toHaveLength(1);
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');
    expect(await queryHostProjects(db)).toHaveLength(1);
    const keys = await queryKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.revoked_at).toBeNull();

    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual(expectedAuditDetailsSorted());
  });

  it('keeps exactly one active key when two concurrent runs rotate with different plaintexts (failures are loud)', async () => {
    // Hai transaction race trên cùng host project với hai plaintext khác nhau.
    // Hợp đồng thật của `ensureFirstTrustedCiKey` (rotate-then-insert + verify
    // fail-closed) chỉ bảo đảm KHÔNG BAO GIỜ hai key active và lần chạy thua
    // phải fail-loud — không bảo đảm "đúng một rejection với message cụ thể".
    // Dưới READ COMMITTED có BA kết cục hợp lệ, tất cả đều thoả hợp đồng:
    // 1. Cả hai fulfilled — bên sau rotate key của bên trước một cách tuần tự
    //    hoá (UPDATE revoke của bên sau thấy hàng đã commit của bên trước);
    //    key active cuối cùng là của rotation CUỐI, key của rotation trước đã
    //    bị revoke bởi lần chạy còn lại.
    // 2. Một bên bị guard denial `expected exactly one active` — UPDATE revoke
    //    của bên sau chặn trên lock của bên trước, không thấy được hàng mới
    //    chèn, nên lúc verify thấy hai hàng active → fail-closed, rollback
    //    toàn bộ.
    // 3. Một bên bị CHECK `api_key_revoked_at_after_created_check` từ chối —
    //    `revoked_at = now()` (mốc đầu transaction) của bên bắt đầu transaction
    //    sớm hơn có thể <= `created_at` (DEFAULT now()) của hàng bên kia chèn;
    //    DB vẫn giữ bất biến `revoked_at > created_at`, message khác hẳn nhưng
    //    hành vi đúng.
    // Không hợp lệ: 0 fulfilled (mỗi verify luôn thấy đúng hàng key của chính
    // nó nên ít nhất một bên phải pass), rejection với message ngoài hai dạng
    // trên, hay hai key active trong trạng thái cuối.
    await db.truncateData();
    await runBootstrapped(db, bootstrapInput(PLAINTEXT_1));

    const clientA = await db.connectAsMigrator();
    const clientB = await db.connectAsMigrator();
    let results: PromiseSettledResult<Awaited<ReturnType<typeof bootstrapCanonicalTenant>>>[];
    try {
      results = await Promise.allSettled([
        runBootstrapInTransaction(clientA, bootstrapInput(PLAINTEXT_2)),
        runBootstrapInTransaction(clientB, bootstrapInput(PLAINTEXT_3)),
      ]);
    } finally {
      await clientA.end();
      await clientB.end();
    }

    const fulfilled = results.filter(isFulfilled);
    const rejectedReasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);

    // Mọi rejection (nếu có) phải là một trong hai hình thức từ chối có chủ
    // đích của hợp đồng; lỗi khác (network, lập trình, undefined) làm test đỏ
    // ngay tại đây — không nuốt.
    for (const reason of rejectedReasons) {
      const message = reason instanceof Error ? reason.message : String(reason);
      expect(message).toMatch(
        /expected exactly one active|api_key_revoked_at_after_created_check/u,
      );
    }
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Kiểm authoritative bằng truy vấn DB — không suy từ số Promise rejection:
    // đúng MỘT key active, thuộc một trong hai plaintext race (không bao giờ
    // là plaintext P1 đã revoke ở bước setup).
    const keys = await queryKeys(db);
    const active = keys.filter((k) => k.revoked_at === null);
    expect(active).toHaveLength(1);
    const activeRow = active[0];
    expect([hashApiKey(PLAINTEXT_2), hashApiKey(PLAINTEXT_3)]).toContain(activeRow?.token_hash);
    const p1Row = keys.find((k) => k.token_hash === hashApiKey(PLAINTEXT_1));
    expect(p1Row).toBeDefined();
    expect(p1Row?.revoked_at).not.toBeNull();

    // Mỗi lần chạy fulfilled đều là rotation: bên vào lock trước revoke P1,
    // bên vào sau revoke key đã commit của bên trước — đúng ở cả ba kết cục.
    for (const run of fulfilled) {
      expect(run.value.key.result).toBe('rotated');
    }

    // Key active phải là key của một trong hai lần chạy race. Kết cục 2/3
    // (đúng một bên thắng): điều này tức là key active đúng bằng key của bên
    // thắng, hàng của bên thua đã rollback. Kết cục 1 (cả hai fulfilled): bên
    // thắng là rotation CUỐI.
    const racedKeyIds = fulfilled.map((run) => run.value.key.keyId);
    expect(racedKeyIds).toContain(activeRow?.id);

    // Key của các lần chạy race không nắm trạng thái active: kết cục 1 — hàng
    // tồn tại và đã bị revoke bởi lần chạy thắng (last rotation wins); kết cục
    // 2/3 — hàng của bên thua đã rollback nên không còn hàng nào ngoài danh
    // sách này. Cả hai đều đúng hợp đồng "không bao giờ hai key active".
    const supersededIds = racedKeyIds.filter((id) => id !== activeRow?.id);
    expect(keys.filter((k) => supersededIds.includes(k.id) && k.revoked_at !== null).length).toBe(
      supersededIds.length,
    );

    // Audit: event của lần setup + đúng một event cho mỗi lần chạy fulfilled;
    // lần chạy bị từ chối chưa kịp INSERT audit (throw tại verify hoặc trước
    // đó do constraint) và ROLLBACK xoá mọi ghi của nó.
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(1 + fulfilled.length);
  });

  it('rejects invalid owner_sub without touching the database', async () => {
    const fakeClient = { query: async () => ({}) } as unknown as import('pg').Client;
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), ownerSub: '' }),
    ).rejects.toThrow(/owner_sub is required/u);
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), ownerSub: ' has space ' }),
    ).rejects.toThrow(/owner_sub is required/u);
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), ownerSub: 'x'.repeat(201) }),
    ).rejects.toThrow(/owner_sub is required/u);
  });

  it('rejects an invalid host project name or scope list without touching the database', async () => {
    const fakeClient = { query: async () => ({}) } as unknown as import('pg').Client;
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), projectName: 'Bad Name' }),
    ).rejects.toThrow(/lowercase DNS-like label/u);
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), keyScopes: 'admin' }),
    ).rejects.toThrow(/space-separated list of read\|write/u);
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), keyScopes: '' }),
    ).rejects.toThrow(/must be a space-separated list/u);
    await expect(
      bootstrapCanonicalTenant(fakeClient, { ...bootstrapInput(), keyPlaintext: '' }),
    ).rejects.toThrow(/key plaintext is required/u);
  });

  it('rejects a connection string without a database path', () => {
    expect(() => parseDatabaseUrl('postgres://user:pw@host:5432')).toThrow(/database name path/u);
    expect(() => parseDatabaseUrl('mysql://user:pw@host:5432/db')).toThrow(/postgres/u);
    expect(() => parseDatabaseUrl('postgres://user:pw@host:5432/')).toThrow(/non-empty/u);
    expect(parseDatabaseUrl('postgresql://user:pw@host:5432/other-db?sslmode=require')).toEqual({
      database: 'other-db',
    });
  });

  it('parses the bootstrap environment fail-closed, naming the missing variable', () => {
    const valid = {
      DATABASE_URL: `postgres://ecoma_remote_cache_migrator:pw@host:5432/${HARNESS_DATABASE}`,
      [CANONICAL_TENANT_OWNER_SUB_ENV]: OWNER,
      [BOOTSTRAP_PROJECT_NAME_ENV]: HOST_PROJECT,
      [BOOTSTRAP_KEY_SCOPES_ENV]: SCOPES,
      [BOOTSTRAP_KEY_PLAINTEXT_ENV]: PLAINTEXT_1,
    };
    expect(parseBootstrapEnv(valid)).toEqual({
      ownerSub: OWNER,
      projectName: HOST_PROJECT,
      keyScopes: SCOPES,
      keyPlaintext: PLAINTEXT_1,
    });

    expect(() => parseBootstrapEnv({})).toThrow(/DATABASE_URL is not set/u);
    const { DATABASE_URL: _databaseUrl, ...withoutUrl } = valid;
    expect(() => parseBootstrapEnv(withoutUrl)).toThrow(/DATABASE_URL is not set/u);
    const { [CANONICAL_TENANT_OWNER_SUB_ENV]: _owner, ...withoutOwner } = valid;
    expect(() => parseBootstrapEnv(withoutOwner)).toThrow(
      new RegExp(`${CANONICAL_TENANT_OWNER_SUB_ENV} is not set`, 'u'),
    );
    const { [BOOTSTRAP_PROJECT_NAME_ENV]: _project, ...withoutProject } = valid;
    expect(() => parseBootstrapEnv(withoutProject)).toThrow(
      new RegExp(`${BOOTSTRAP_PROJECT_NAME_ENV} is not set`, 'u'),
    );
    const { [BOOTSTRAP_KEY_SCOPES_ENV]: _scopes, ...withoutScopes } = valid;
    expect(() => parseBootstrapEnv(withoutScopes)).toThrow(
      new RegExp(`${BOOTSTRAP_KEY_SCOPES_ENV} is not set`, 'u'),
    );
    const { [BOOTSTRAP_KEY_PLAINTEXT_ENV]: _plaintext, ...withoutPlaintext } = valid;
    expect(() => parseBootstrapEnv(withoutPlaintext)).toThrow(
      new RegExp(`${BOOTSTRAP_KEY_PLAINTEXT_ENV} is not set`, 'u'),
    );
  });

  it('hashes the key plaintext exactly like the serving-path authenticator', async () => {
    // Đường auth của app (`src/routes.ts`) băm token bằng WebCrypto SHA-256
    // hex — script bootstrap phải sinh CÙNG digest cho cùng plaintext, nếu
    // không key cấp lúc bootstrap không bao giờ khớp lúc auth.
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PLAINTEXT_1));
    const expected = [...new Uint8Array(buffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hashApiKey(PLAINTEXT_1)).toBe(expected);
    expect(hashApiKey(PLAINTEXT_1)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashApiKey(PLAINTEXT_1)).not.toBe(hashApiKey(PLAINTEXT_2));
  });

  it('refuses to run against a different database (current_database guard)', async () => {
    // Guard server-side: `postgres` database có sẵn trong mọi image PostgreSQL
    // và KHÔNG phải `db-remote-cache` — đúng hình "URL trỏ sai".
    const { Client: PgClient } = await import('pg');
    const wrongDb = new PgClient({
      host: db.host,
      port: db.port,
      user: 'ecoma_remote_cache_migrator',
      password: db.rolePassword,
      database: 'postgres',
      application_name: 'ecoma-remote-cache-api-itest-bootstrap-wrongdb',
    });
    await wrongDb.connect();
    try {
      await expect(assertBootstrapDatabase(wrongDb)).rejects.toThrow(
        /only bootstraps db-remote-cache/u,
      );
    } finally {
      await wrongDb.end();
    }

    // Đối chiếu dương: đúng database thì guard qua và trả về tên.
    const right = await db.connectAsMigrator();
    try {
      await expect(assertBootstrapDatabase(right)).resolves.toBe(REMOTE_CACHE_DATABASE);
    } finally {
      await right.end();
    }
  });
});
