/**
 * Cấp machine credential cho canonical tenant `ecoma` trên PostgreSQL thật
 * (ADR-0020, 02-delivery.md §3.2 bước 6).
 *
 * Gọi đúng {@link provisionMachineToken} lõi mà CLI chạy (runner-canonical,
 * không viết vòng apply riêng) và đo trạng thái database sau mỗi lần chạy.
 * Tenant được seed qua chính helper bootstrap ({@link bootstrapCanonicalTenant})
 * — một đường code duy nhất, không dựng tenant tay bằng SQL. Kết nối đến từ
 * harness với credential runtime thật (`db.asRuntime()` — production CLI nhận
 * đúng hình dạng này qua biến env `DATABASE_URL`).
 *
 * ⚠️ Bộ kiểm yêu cầu Docker: probe hỏng khiến `globalSetup` throw và cả
 * người chạy đỏ (fail-loud, 06-testing.md §6) — skip với exit 0 không phải
 * kết quả được chấp nhận.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapCanonicalTenant, CANONICAL_TENANT_NAME } from '../../db/bootstrap-tenant.mts';
import {
  hashMachineToken,
  MACHINE_TOKEN_NAME_ENV,
  MACHINE_TOKEN_PLAINTEXT_ENV,
  MACHINE_TOKEN_PROVISION_AUDIT_ACTION,
  MACHINE_TOKEN_SCOPES_ENV,
  parseMachineTokenEnv,
  provisionMachineToken,
} from '../../db/provision-machine-token.mts';
import {
  type PactBrokerDatabase,
  PACT_BROKER_DATABASE as HARNESS_DATABASE,
  startPactBrokerDatabase,
} from '../integrations/harness';

const TOKEN_NAME = 'pact-broker-app-bff';
const TOKEN_SCOPES = 'admin';
const TOKEN_PLAINTEXT = 'pt-local-token-0123456789abcdef';

interface TokenRow {
  id: string;
  token_hash: string;
  tenant_id: string;
  name: string;
  scopes: string;
  created_by_sub: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

async function queryTokens(db: PactBrokerDatabase): Promise<TokenRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<TokenRow>(
      `SELECT id, token_hash, tenant_id, name, scopes, created_by_sub, created_at, revoked_at
         FROM pact.machine_tokens ORDER BY created_at, id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface AuditRow {
  tenant_id: string | null;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
  actor_sub: string | null;
  actor_token_id: string | null;
}

async function queryProvisionAuditEvents(db: PactBrokerDatabase): Promise<AuditRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<AuditRow>(
      `SELECT tenant_id, action, outcome, detail, actor_sub, actor_token_id
         FROM pact.audit_events
        WHERE action = $1 ORDER BY occurred_at, event_id`,
      [MACHINE_TOKEN_PROVISION_AUDIT_ACTION],
    );
    return rows;
  } finally {
    await client.end();
  }
}

/**
 * Chi tiết audit sắp theo kết quả — hai lần chạy commit theo thứ tự bất kỳ,
 * nên phép so sánh chạy trên object đã parse với khóa sắp xác định.
 */
function auditDetailsSorted(rows: AuditRow[]): Array<Record<string, string>> {
  return rows
    .map((row) => row.detail as Record<string, string>)
    .toSorted((a, b) => (a['result'] ?? '').localeCompare(b['result'] ?? ''));
}

/** Seed tenant canonical qua chính helper bootstrap — một đường code duy nhất. */
async function seedCanonicalTenant(db: PactBrokerDatabase): Promise<string> {
  const client = await db.asRuntime();
  try {
    await client.query('BEGIN');
    try {
      const result = await bootstrapCanonicalTenant(client, 'sub-owner-bootstrap');
      await client.query('COMMIT');
      return result.tenantId;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

/**
 * Một lần provision bọc trong đúng transaction CLI thực hiện
 * (BEGIN → provision → COMMIT, ROLLBACK khi fail), trên credential runtime thật.
 */
async function runProvisioned(
  db: PactBrokerDatabase,
  input: { tokenName: string; scopes: string; plaintext: string },
): Promise<Awaited<ReturnType<typeof provisionMachineToken>>> {
  const client = await db.asRuntime();
  try {
    await client.query('BEGIN');
    try {
      const result = await provisionMachineToken(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** Đầu vào mặc định của bộ kiểm — mỗi test tự ghi đè phần nó cần. */
function defaultInput(): { tokenName: string; scopes: string; plaintext: string } {
  return { tokenName: TOKEN_NAME, scopes: TOKEN_SCOPES, plaintext: TOKEN_PLAINTEXT };
}

describe(`machine token provisioning for the canonical ${CANONICAL_TENANT_NAME} tenant on ${HARNESS_DATABASE}`, () => {
  let db: PactBrokerDatabase;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('creates the token bound to the ecoma tenant with the configured name and scopes on the first run', async () => {
    await db.truncateData();
    const tenantId = await seedCanonicalTenant(db);

    const result = await runProvisioned(db, defaultInput());
    expect(result.result).toBe('created');
    expect(result.revokedCount).toBe(0);
    expect(result.tenantId).toBe(tenantId);
    expect(result.tenantName).toBe(CANONICAL_TENANT_NAME);
    expect(result.tokenName).toBe(TOKEN_NAME);

    // Token: đúng một row active, gắn tenant ecoma, mang hash (không plaintext),
    // name và scopes đã cấu hình.
    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.id).toBe(result.tokenId);
    expect(tokens[0]?.tenant_id).toBe(tenantId);
    expect(tokens[0]?.name).toBe(TOKEN_NAME);
    expect(tokens[0]?.scopes).toBe(TOKEN_SCOPES);
    expect(tokens[0]?.token_hash).toBe(hashMachineToken(TOKEN_PLAINTEXT));
    expect(tokens[0]?.revoked_at).toBeNull();
    expect(tokens[0]?.created_by_sub).toBeNull();

    // Audit: đúng một event cho lần created, actor NULL (script vận hành).
    const audit = await queryProvisionAuditEvents(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tenant_id).toBe(tenantId);
    expect(audit[0]?.outcome).toBe('success');
    expect(audit[0]?.detail).toEqual({ name: TOKEN_NAME, result: 'created' });
    expect(audit[0]?.actor_sub).toBeNull();
    expect(audit[0]?.actor_token_id).toBeNull();
  });

  it('is a no-op on a repeated run with the same plaintext and keeps exactly one active row', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    const first = await runProvisioned(db, defaultInput());
    expect(first.result).toBe('created');

    const second = await runProvisioned(db, defaultInput());
    expect(second.result).toBe('no-op');
    expect(second.tokenId).toBe(first.tokenId);
    expect(second.revokedCount).toBe(0);

    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.id).toBe(first.tokenId);
    expect(tokens[0]?.token_hash).toBe(hashMachineToken(TOKEN_PLAINTEXT));
    expect(tokens[0]?.revoked_at).toBeNull();

    // Hai lần chạy, hai event: created rồi no-op — không stack thêm row.
    const audit = await queryProvisionAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual([
      { name: TOKEN_NAME, result: 'created' },
      { name: TOKEN_NAME, result: 'no-op' },
    ]);
  });

  it('rotates by revoking the old active row first when the plaintext changes', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    const oldPlaintext = `${TOKEN_PLAINTEXT}-old`;
    const first = await runProvisioned(db, { ...defaultInput(), plaintext: oldPlaintext });
    expect(first.result).toBe('created');

    const rotated = await runProvisioned(db, defaultInput());
    expect(rotated.result).toBe('rotated');
    expect(rotated.revokedCount).toBe(1);
    expect(rotated.tokenId).not.toBe(first.tokenId);

    // Đúng một row active, mang hash plaintext mới; row cũ đã revoked.
    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(2);
    const activeRows = tokens.filter((row) => row.revoked_at === null);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe(rotated.tokenId);
    expect(activeRows[0]?.token_hash).toBe(hashMachineToken(TOKEN_PLAINTEXT));

    const oldRow = tokens.find((row) => row.id === first.tokenId);
    expect(oldRow?.revoked_at).not.toBeNull();
    // revoked_at > created_at theo CHECK constraint — và đúng là old row.
    expect(oldRow?.token_hash).toBe(hashMachineToken(oldPlaintext));

    // created + rotated, đúng thứ tự sắp.
    const audit = await queryProvisionAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual([
      { name: TOKEN_NAME, result: 'created' },
      { name: TOKEN_NAME, result: 'rotated' },
    ]);
  });

  it('keeps tokens of different names independent under the same tenant', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    // Mỗi token name một plaintext riêng: token_hash UNIQUE trên toàn bảng,
    // nên hai credential thật không bao giờ dùng chung một plaintext.
    const otherName = 'other-consumer';
    const otherPlaintext = `${TOKEN_PLAINTEXT}-other`;
    await runProvisioned(db, defaultInput());
    const other = await runProvisioned(db, {
      ...defaultInput(),
      tokenName: otherName,
      plaintext: otherPlaintext,
    });
    expect(other.result).toBe('created');

    // Rotation của token A không chạm token B: natural key là (tenant, name).
    await runProvisioned(db, { ...defaultInput(), plaintext: `${TOKEN_PLAINTEXT}-rotated` });

    const tokens = await queryTokens(db);
    const activeRows = tokens.filter((row) => row.revoked_at === null);
    expect(activeRows).toHaveLength(2);

    const mainRow = activeRows.find((row) => row.name === TOKEN_NAME);
    const otherRow = activeRows.find((row) => row.name === otherName);
    expect(mainRow?.token_hash).toBe(hashMachineToken(`${TOKEN_PLAINTEXT}-rotated`));
    expect(otherRow?.id).toBe(other.tokenId);
    expect(otherRow?.token_hash).toBe(hashMachineToken(otherPlaintext));
    expect(otherRow?.revoked_at).toBeNull();
  });

  it('fails closed when a plaintext is reused across two token names', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    await runProvisioned(db, defaultInput());

    // Cùng plaintext, name khác: token_hash UNIQUE chỉ cho phép một row sở hữu
    // plaintext — lần cấp thứ hai phải fail-closed với chẩn đoán đúng, không
    // âm thầm no-op và không đè row của name đầu.
    await expect(
      runProvisioned(db, { ...defaultInput(), tokenName: 'other-consumer' }),
    ).rejects.toThrow(/a plaintext owns exactly one row/u);

    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.name).toBe(TOKEN_NAME);
    expect(tokens[0]?.revoked_at).toBeNull();
    expect(await queryProvisionAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed when the ecoma tenant does not exist and writes no row', async () => {
    await db.truncateData();

    await expect(runProvisioned(db, defaultInput())).rejects.toThrow(
      /provisioning never creates a tenant/u,
    );

    expect(await queryTokens(db)).toEqual([]);
    expect(await queryProvisionAuditEvents(db)).toEqual([]);
  });

  it('fails closed when the tenant is suspended', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    const client = await db.connect();
    try {
      await client.query(`UPDATE pact.tenants SET status = 'suspended' WHERE name = $1`, [
        CANONICAL_TENANT_NAME,
      ]);
    } finally {
      await client.end();
    }

    await expect(runProvisioned(db, defaultInput())).rejects.toThrow(/non-active tenant/u);

    expect(await queryTokens(db)).toEqual([]);
    expect(await queryProvisionAuditEvents(db)).toEqual([]);
  });

  it('fails closed when the tenant is deleted', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    const client = await db.connect();
    try {
      await client.query(`UPDATE pact.tenants SET status = 'deleted' WHERE name = $1`, [
        CANONICAL_TENANT_NAME,
      ]);
    } finally {
      await client.end();
    }

    await expect(runProvisioned(db, defaultInput())).rejects.toThrow(/non-active tenant/u);

    expect(await queryTokens(db)).toEqual([]);
    expect(await queryProvisionAuditEvents(db)).toEqual([]);
  });

  it('never stores the plaintext anywhere in the token or audit tables', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);
    await runProvisioned(db, defaultInput());

    const tokens = await queryTokens(db);
    expect(JSON.stringify(tokens)).not.toContain(TOKEN_PLAINTEXT);

    const audit = await queryProvisionAuditEvents(db);
    expect(JSON.stringify(audit)).not.toContain(TOKEN_PLAINTEXT);
  });

  it('refuses to resurrect a manually revoked token on a re-run of the same plaintext', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);
    const first = await runProvisioned(db, defaultInput());

    // Revoke thủ công — quyết định người vận hành, ngoài tầm với của script.
    const client = await db.connect();
    try {
      await client.query(`UPDATE pact.machine_tokens SET revoked_at = now() WHERE id = $1`, [
        first.tokenId,
      ]);
    } finally {
      await client.end();
    }

    await expect(runProvisioned(db, defaultInput())).rejects.toThrow(
      /never resurrected by provisioning/u,
    );

    // Row vẫn revoked, không row active mới, lần fail không viết audit.
    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.id).toBe(first.tokenId);
    expect(tokens[0]?.revoked_at).not.toBeNull();
    expect(await queryProvisionAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed when the active row carries different scopes than configured', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);
    await runProvisioned(db, defaultInput());

    // Cùng plaintext, đổi scopes: row lưu không được ghi đè âm thầm — rotate
    // plaintext mới là đường áp tập scope mới.
    await expect(runProvisioned(db, { ...defaultInput(), scopes: 'read write' })).rejects.toThrow(
      /never silently rewritten/u,
    );

    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.scopes).toBe(TOKEN_SCOPES);
    expect(tokens[0]?.revoked_at).toBeNull();
    expect(await queryProvisionAuditEvents(db)).toHaveLength(1);
  });

  it('converges when two connections provision the same plaintext concurrently', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    // Mỗi phía bọc BEGIN/COMMIT quanh một lần provision — đúng transaction CLI
    // thực hiện. ⚠️ COMMIT phải nằm BÊN TRONG promise của mỗi phía: nếu commit
    // diễn ra sau Promise.all, phía thua sẽ chờ khóa của bên thắng trong khi
    // bên thắng đợi Promise.all — một deadlock tự chế mà khóa còn giữ của nó
    // sẽ cascade timeout vào các test sau.
    const runOne = async (client: Awaited<ReturnType<typeof db.asRuntime>>) => {
      await client.query('BEGIN');
      try {
        const result = await provisionMachineToken(client, defaultInput());
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    };

    const clientA = await db.asRuntime();
    const clientB = await db.asRuntime();
    try {
      const [resultA, resultB] = await Promise.all([runOne(clientA), runOne(clientB)]);

      // Không fatal error nào: một phía created, một phía no-op, hội tụ trên
      // cùng row token (Quyết định 5 của ADR-0020).
      expect([resultA.result, resultB.result].toSorted()).toEqual(['created', 'no-op']);
      expect(resultA.tokenId).toBe(resultB.tokenId);
    } finally {
      await clientA.end();
      await clientB.end();
    }

    const tokens = await queryTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revoked_at).toBeNull();

    // Dọn audit trail để các assert đếm của test sau không thừa entry từ race này.
    await db.truncateData();
  });

  it('hashes with the same SHA-256 digest the app runtime computes via WebCrypto', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN_PLAINTEXT));
    const webCryptoHex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(hashMachineToken(TOKEN_PLAINTEXT)).toBe(webCryptoHex);
    expect(hashMachineToken(TOKEN_PLAINTEXT)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects empty inputs before touching the database', async () => {
    // Client giả: mọi lần query là một lỗi test — lõi phải chặn input rỗng
    // trước cả câu SQL đầu tiên.
    const fakeClient = {
      query: async () => {
        throw new Error('the core must validate inputs before any SQL');
      },
    } as unknown as import('pg').Client;

    await expect(
      provisionMachineToken(fakeClient, { ...defaultInput(), tokenName: '' }),
    ).rejects.toThrow(/token name is required/u);
    await expect(
      provisionMachineToken(fakeClient, { ...defaultInput(), scopes: '' }),
    ).rejects.toThrow(/token scopes are required/u);
    await expect(
      provisionMachineToken(fakeClient, { ...defaultInput(), plaintext: '' }),
    ).rejects.toThrow(/token plaintext is required/u);
  });

  it('fails closed on any missing env variable and passes through complete configuration', () => {
    const complete: NodeJS.ProcessEnv = {
      DATABASE_URL: `postgres://ecoma_pact_broker_runtime:pw@host:5432/${HARNESS_DATABASE}`,
      [MACHINE_TOKEN_NAME_ENV]: TOKEN_NAME,
      [MACHINE_TOKEN_SCOPES_ENV]: TOKEN_SCOPES,
      [MACHINE_TOKEN_PLAINTEXT_ENV]: TOKEN_PLAINTEXT,
    };
    expect(parseMachineTokenEnv(complete)).toEqual({
      tokenName: TOKEN_NAME,
      scopes: TOKEN_SCOPES,
      plaintext: TOKEN_PLAINTEXT,
    });

    for (const missing of [
      'DATABASE_URL',
      MACHINE_TOKEN_NAME_ENV,
      MACHINE_TOKEN_SCOPES_ENV,
      MACHINE_TOKEN_PLAINTEXT_ENV,
    ]) {
      // Dựng bản ghi thiếu biến bằng filter thay vì `delete` — key động không
      // xoá được theo rule lint, và filter giữ đúng hình ProcessEnv của test.
      const broken = Object.fromEntries(
        Object.entries(complete).filter(([key]) => key !== missing),
      ) as NodeJS.ProcessEnv;
      expect(() => parseMachineTokenEnv(broken)).toThrow(new RegExp(missing, 'u'));
      const empty = { ...complete, [missing]: '' };
      expect(() => parseMachineTokenEnv(empty)).toThrow(new RegExp(missing, 'u'));
    }
  });
});
