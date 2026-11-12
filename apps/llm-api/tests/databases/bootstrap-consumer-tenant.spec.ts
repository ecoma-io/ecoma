/**
 * Bootstrap runner bước 9 (`db/bootstrap-consumer-tenant.mts`) trên PostgreSQL
 * thật, qua **runner production** chạy bằng `tsx` — đúng lệnh mà bootstrap
 * command chạy trên lane local (ADR-0020 Quyết định 12, Issue #24).
 *
 * Phủ các tiêu chí của slice P2 #24: seed tenant `ecoma` (`first_party`,
 * owner = `sub` Superadmin) + owner membership (ADR-0025 §3, domain-model §1)
 * + API key đầu tiên hash-only (natural key = `sha256(plaintext)`); re-run là
 * no-op và KHÔNG in lại plaintext (show-once); divergence owner fail-closed;
 * sai database đích fail-closed (guard `current_database()`); biến thể tên
 * `ecoma-internal` không bao giờ tồn tại và bị chặn khi được trồng vào DB;
 * key đã revoke hết không được phát lại qua bootstrap.
 *
 * Credential plaintext trong suite này là giá trị random do runner sinh —
 * fence kiểm chứng nó chỉ xuất hiện ĐÚNG MỘT LẦN trên stdout của run tạo key,
 * không bao giờ trên stderr hay trong result JSON, và DB chỉ lưu hash.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  migratorUrl,
  runBootstrapCli,
  startLlmApiDatabase,
  type ApplyCliResult,
  type LlmApiDatabase,
} from '../integrations/harness.ts';
import { resetConsumerTenant } from './bootstrap-database-reset.ts';
import {
  CANONICAL_CONSUMER_TENANT_NAME,
  CONSUMER_OWNER_MEMBERSHIP_ID,
  CONSUMER_TENANT_ID,
} from '../../db/bootstrap-shared.mts';

const OWNER_SUB = 'bootstrap-superadmin-sub';
const ACTOR = 'ecoma-bootstrap';

/** Dòng máy đọc mang plaintext key trên stdout — xuất hiện ĐÚNG MỘT LẦN khi key được tạo. */
const API_KEY_LINE_KEY = 'ECOMA_CONSUMER_API_KEY';

let db: LlmApiDatabase;

beforeAll(async () => {
  db = await startLlmApiDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  // Mỗi test tự seed fresh trên cả hai database mà runner bước 9 ghi —
  // không dựa vào thứ tự chạy giữa các test.
  await resetConsumerTenant(db);
});

/** Env đầy đủ cho một run bước 9: hai URL migrator + owner sub + actor. */
function consumerEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ECOMA_TENANT_DATABASE_URL: migratorUrl('tenant', db.host, db.port),
    ECOMA_GATEWAY_DATABASE_URL: migratorUrl('gateway', db.host, db.port),
    ECOMA_CONSUMER_TENANT_OWNER_SUB: OWNER_SUB,
    ECOMA_GOVERNANCE_ACTOR: ACTOR,
    ...overrides,
  };
}

function runConsumerTenant(env: Record<string, string>): Promise<ApplyCliResult> {
  return runBootstrapCli({
    script: 'db/bootstrap-consumer-tenant.mts',
    // DATABASE_URL không nằm trong hợp đồng env của runner bước 9 (hai URL
    // đi bằng ECOMA_*); harness bắt buộc một giá trị — truyền URL tenant.
    databaseUrl: migratorUrl('tenant', db.host, db.port),
    env,
  });
}

/** Trích dòng máy đọc `KEY=value` từ stdout (mỗi key in đúng một dòng). */
function stdoutLine(stdout: string, key: string): string {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  if (line === undefined) {
    throw new Error(`stdout must carry a ${key}= line; got: ${stdout}`);
  }
  return line.slice(key.length + 1);
}

interface ConsumerTenantTableRow {
  id: string;
  name: string;
  classification: string;
  owner_sub: string;
}

interface ApiKeyTableRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  revoked_at: string | null;
}

async function fetchTenantRow(): Promise<ConsumerTenantTableRow | undefined> {
  const client = await db.connectAsMigrator('tenant');
  try {
    const result = await client.query<ConsumerTenantTableRow>(
      'SELECT id, name, classification, owner_sub FROM llm_tenant.tenants WHERE name = $1',
      [CANONICAL_CONSUMER_TENANT_NAME],
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function countTenantRows(): Promise<number> {
  const client = await db.connectAsMigrator('tenant');
  try {
    const result = await client.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM llm_tenant.tenants',
    );
    return Number(result.rows[0]?.c ?? '0');
  } finally {
    await client.end();
  }
}

async function fetchMemberships(): Promise<{ id: string; actor: string; status: string }[]> {
  const client = await db.connectAsMigrator('tenant');
  try {
    const result = await client.query<{ id: string; actor: string; status: string }>(
      'SELECT id, actor, status FROM llm_tenant.memberships WHERE tenant_id = $1',
      [CONSUMER_TENANT_ID],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchApiKeys(): Promise<ApiKeyTableRow[]> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query<ApiKeyTableRow>(
      'SELECT id, tenant_id, key_hash, revoked_at::text AS revoked_at FROM llm_gateway.api_keys WHERE tenant_id = $1',
      [CONSUMER_TENANT_ID],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

/** Số dòng `ECOMA_CONSUMER_API_KEY=` trên một stdout — fence "plaintext đúng một lần". */
function countApiKeyLines(stdout: string): number {
  return stdout.split('\n').filter((line) => line.startsWith(`${API_KEY_LINE_KEY}=`)).length;
}

describe('bootstrap runner step 9 (consumer tenant) on real PostgreSQL', () => {
  it('seeds tenant, owner membership and one hash-only API key, emitting the plaintext exactly once', async () => {
    const result = await runConsumerTenant(consumerEnv());
    const resultLine = stdoutLine(result.stdout, 'CONSUMER_TENANT_RESULT');
    expect(resultLine).toContain('"outcome":"created"');
    expect(resultLine).toContain(`"tenantId":"${CONSUMER_TENANT_ID}"`);
    expect(resultLine).toContain('"tenant":"created"');
    expect(resultLine).toContain('"membership":"created"');
    expect(resultLine).toContain('"apiKey":"created"');

    // Plaintext-once: ĐÚNG MỘT dòng key trên stdout của run tạo; stderr và
    // result JSON KHÔNG chứa plaintext (so sánh qua boolean — assertion đỏ
    // không in lại giá trị vào test report).
    expect(countApiKeyLines(result.stdout)).toBe(1);
    const plaintext = stdoutLine(result.stdout, API_KEY_LINE_KEY);
    expect(plaintext).not.toBe('');
    expect(result.stderr.includes(plaintext)).toBe(false);
    expect(resultLine.includes(plaintext)).toBe(false);

    // Tenant đọc lại được: đúng một row `ecoma`, `first_party`, owner = sub.
    expect(await countTenantRows()).toBe(1);
    const tenant = await fetchTenantRow();
    expect(tenant).toEqual({
      id: CONSUMER_TENANT_ID,
      name: CANONICAL_CONSUMER_TENANT_NAME,
      classification: 'first_party',
      owner_sub: OWNER_SUB,
    });

    // Owner membership đọc lại được: đúng một row active cho sub.
    const memberships = await fetchMemberships();
    expect(memberships).toEqual([
      { id: CONSUMER_OWNER_MEMBERSHIP_ID, actor: OWNER_SUB, status: 'active' },
    ]);

    // API key hash-only: đúng một row, hash == sha256(plaintext), tenant trỏ
    // đúng tenant canonical, còn active.
    const keys = await fetchApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe(`consumer-api-key-${keys[0].key_hash.slice(0, 24)}`);
    expect(keys[0].key_hash).toBe(createHash('sha256').update(plaintext, 'utf8').digest('hex'));
    expect(keys[0].revoked_at).toBeNull();

    // Audit hai database: một row `created` mỗi nơi, đúng thứ tự chạy.
    const tenantAudit = await (
      await db.connectAsMigrator('tenant')
    ).query<{ outcome: string }>('SELECT outcome FROM llm_tenant.bootstrap_audit ORDER BY id');
    expect(tenantAudit.rows.map((row) => row.outcome)).toEqual(['created']);
    const gatewayAudit = await (
      await db.connectAsMigrator('gateway')
    ).query<{ outcome: string }>('SELECT outcome FROM llm_gateway.bootstrap_audit ORDER BY id');
    expect(gatewayAudit.rows.map((row) => row.outcome)).toEqual(['created']);
  });

  it('keeps no tenant named ecoma-internal and rejects the name as divergent provisioning state', async () => {
    // Sau một run sạch: không tồn tại tenant nào tên `ecoma-internal`
    // (ADR-0020 Quyết định 9 — biến thể đó không bao giờ được tồn tại).
    await runConsumerTenant(consumerEnv());
    const client = await db.connectAsMigrator('tenant');
    const planted = await client.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM llm_tenant.tenants WHERE name = $1',
      ['ecoma-internal'],
    );
    await client.end();
    expect(Number(planted.rows[0]?.c ?? '0')).toBe(0);

    // Trồng row `ecoma-internal` vào DB là divergence thật: runner từ chối
    // chạy và để nguyên durable state (fail-closed, không tự dọn).
    const planter = await db.connectAsMigrator('tenant');
    try {
      await planter.query(
        'INSERT INTO llm_tenant.tenants (id, name, classification, owner_sub, created_at) VALUES ($1, $2, $3, $4, $5)',
        ['consumer-tenant-ecoma-internal', 'ecoma-internal', 'customer', 'stray-actor', Date.now()],
      );
    } finally {
      await planter.end();
    }
    await expect(runConsumerTenant(consumerEnv())).rejects.toThrow(/ecoma-internal/u);
  });

  it('reruns as a no-op without new rows and without emitting any plaintext', async () => {
    const first = await runConsumerTenant(consumerEnv());
    const plaintext = stdoutLine(first.stdout, API_KEY_LINE_KEY);
    const keysBefore = await fetchApiKeys();
    const tenantCountBefore = await countTenantRows();
    const membershipsBefore = await fetchMemberships();

    const second = await runConsumerTenant(consumerEnv());
    const resultLine = stdoutLine(second.stdout, 'CONSUMER_TENANT_RESULT');
    expect(resultLine).toContain('"outcome":"no-op"');
    expect(resultLine).toContain('"tenant":"existing"');
    expect(resultLine).toContain('"membership":"existing"');
    expect(resultLine).toContain('"apiKey":"existing"');

    // Fence rerun: stdout run thứ hai KHÔNG mang dòng key nào, stderr cũng
    // không (so sánh qua boolean — không in lại output vào report).
    expect(countApiKeyLines(second.stdout)).toBe(0);
    expect(second.stderr.includes(plaintext)).toBe(false);

    // Không row mới nào ở cả hai database.
    expect(await countTenantRows()).toBe(tenantCountBefore);
    expect(await fetchMemberships()).toEqual(membershipsBefore);
    expect(await fetchApiKeys()).toEqual(keysBefore);

    // Audit phản ánh đúng: 'created' rồi 'no-op' trên cả hai database.
    const tenantAudit = await (
      await db.connectAsMigrator('tenant')
    ).query<{ outcome: string }>('SELECT outcome FROM llm_tenant.bootstrap_audit ORDER BY id');
    expect(tenantAudit.rows.map((row) => row.outcome)).toEqual(['created', 'no-op']);
    const gatewayAudit = await (
      await db.connectAsMigrator('gateway')
    ).query<{ outcome: string }>('SELECT outcome FROM llm_gateway.bootstrap_audit ORDER BY id');
    expect(gatewayAudit.rows.map((row) => row.outcome)).toEqual(['created', 'no-op']);
  });

  it('rejects a divergent owner sub fail-closed on rerun (ownership is immutable)', async () => {
    await runConsumerTenant(consumerEnv());
    await expect(
      runConsumerTenant(consumerEnv({ ECOMA_CONSUMER_TENANT_OWNER_SUB: 'bootstrap-someone-else' })),
    ).rejects.toThrow(/owner differs/u);
    // Fail-closed để nguyên durable state: tenant/membership/key không đổi.
    const keys = await fetchApiKeys();
    expect(keys).toHaveLength(1);
    const memberships = await fetchMemberships();
    expect(memberships).toEqual([
      { id: CONSUMER_OWNER_MEMBERSHIP_ID, actor: OWNER_SUB, status: 'active' },
    ]);
  });

  it('rejects a tenant database URL pointing at another database (current_database guard)', async () => {
    await expect(
      runConsumerTenant(
        consumerEnv({ ECOMA_TENANT_DATABASE_URL: migratorUrl('marketplace', db.host, db.port) }),
      ),
    ).rejects.toThrow(/DATABASE_URL points to database/u);
  });

  it('rejects a gateway database URL pointing at another database (current_database guard)', async () => {
    await expect(
      runConsumerTenant(
        consumerEnv({ ECOMA_GATEWAY_DATABASE_URL: migratorUrl('tenant', db.host, db.port) }),
      ),
    ).rejects.toThrow(/DATABASE_URL points to database/u);
  });

  it('fails closed when every stored key was revoked outside the provisioning surface', async () => {
    await runConsumerTenant(consumerEnv());
    const revoker = await db.connectAsMigrator('gateway');
    try {
      await revoker.query(
        'UPDATE llm_gateway.api_keys SET revoked_at = $2, revoked_by = $3 WHERE tenant_id = $1',
        [CONSUMER_TENANT_ID, Date.now(), 'control-plane-out-of-band'],
      );
    } finally {
      await revoker.end();
    }
    // Revoke là quyết định ngoài bề mặt provisioning: bootstrap không phát
    // key mới vượt qua nó, và fail-closed phải lặp lại đúng lỗi đó.
    await expect(runConsumerTenant(consumerEnv())).rejects.toThrow(/none is active/u);
    const keys = await fetchApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].revoked_at).not.toBeNull();
  });

  it('converges on an empty key surface when the tenant predates the API key contract', async () => {
    // DB được seed bởi runner bước 9 cũ hơn hợp đồng key: tenant + membership
    // còn nguyên, bảng key rỗng. Trạng thái này không phân biệt được với
    // "chưa từng chạy bước 9b" ở mức row data — runner converge bằng cách
    // phát hành key lần đầu.
    const seeder = await db.connectAsMigrator('tenant');
    try {
      const now = Date.now();
      await seeder.query(
        'INSERT INTO llm_tenant.tenants (id, name, classification, owner_sub, created_at) VALUES ($1, $2, $3, $4, $5)',
        [CONSUMER_TENANT_ID, CANONICAL_CONSUMER_TENANT_NAME, 'first_party', OWNER_SUB, now],
      );
      await seeder.query(
        'INSERT INTO llm_tenant.memberships (tenant_id, id, actor, status, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, NULL)',
        [CONSUMER_TENANT_ID, CONSUMER_OWNER_MEMBERSHIP_ID, OWNER_SUB, 'active', now],
      );
    } finally {
      await seeder.end();
    }

    const result = await runConsumerTenant(consumerEnv());
    const resultLine = stdoutLine(result.stdout, 'CONSUMER_TENANT_RESULT');
    expect(resultLine).toContain('"tenant":"existing"');
    expect(resultLine).toContain('"membership":"existing"');
    expect(resultLine).toContain('"apiKey":"created"');
    const keys = await fetchApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].tenant_id).toBe(CONSUMER_TENANT_ID);
  });
});
