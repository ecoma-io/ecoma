/**
 * Apply migration `db-llm-gateway`, `db-llm-tenant`, `db-llm-marketplace` qua
 * **runner canonical** (`db/apply.mts` được gọi bằng `tsx` qua `child_process`)
 * trên PostgreSQL thật.
 *
 * ⚠️ Đường code được test là đúng hàm mà CLI `db:migrate` chạy: assert
 * `current_database()`, advisory lock, apply theo thứ tự tên file, DDL
 * idempotent, không ledger, không down-migration (ADR-0025 §6,
 * `02-delivery.md` §3). Tất cả invocation đều đi qua credential migrator thật
 * (proxy `DATABASE_URL`), không `SET ROLE` — đúng hình CI runner.
 *
 * Suite này chạy MỘT migration hiện tại (`0001`) trên ba database, nên không
 * có bảng nghiệp vụ nào sau khi apply xong: catalog PostgreSQL là nguồn sự thật.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type LlmApiDatabase,
  type LlmDatabaseKey,
  migratorUrl,
  runApplyCli,
  startLlmApiDatabase,
} from '../integrations/harness.ts';

const ALL_KEYS: readonly LlmDatabaseKey[] = ['gateway', 'tenant', 'marketplace'];

let db: LlmApiDatabase;

beforeAll(async () => {
  db = await startLlmApiDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

/**
 * Số hàng `information_schema.tables` của một DB — snapshot idempotency.
 *
 * ⚠️ `information_schema.tables` là catalog per-database: phải kết nối ĐÚNG DB
 * đang hỏi, không phải DB mặc định của harness.
 */
async function countUserTables(key: LlmDatabaseKey): Promise<number> {
  const client = await db.connect(key);
  try {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    return Number(rows[0]?.count ?? '0');
  } finally {
    await client.end();
  }
}

/** Schema do service tạo (ngoài pg_catalog/information_schema/public) của một DB. */
async function listNonSystemSchemas(key: LlmDatabaseKey): Promise<string[]> {
  const client = await db.connect(key);
  try {
    const { rows } = await client.query<{ nspname: string }>(
      `SELECT n.nspname
         FROM pg_namespace n
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'pg_toast')
        ORDER BY n.nspname`,
    );
    return rows.map((row) => row.nspname);
  } finally {
    await client.end();
  }
}

/** Schema có tồn tại trên DB của khóa này không — `pg_namespace` cũng per-database. */
async function schemaExists(key: LlmDatabaseKey, name: string): Promise<boolean> {
  const client = await db.connect(key);
  try {
    const { rows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pg_namespace WHERE nspname = $1`,
      [name],
    );
    return rows[0]?.c === '1';
  } finally {
    await client.end();
  }
}

describe('llm-api migration runner on real PostgreSQL', () => {
  it('rejects a DATABASE_URL pointing at another database (current_database guard, non-zero exit)', async () => {
    // Guard #101 (pattern remote-cache): runner pin tên database — `DATABASE_URL`
    // trỏ nhầm `postgres` database phải fail-loud trước khi một DDL nào chạm đích.
    // `postgres` có sẵn trong mọi image PostgreSQL và migrator có CONNECT mặc định
    // PUBLIC ở đó — nên kết nối thành công mà `current_database()` khác, chạy được
    // cho đến khi guard từ chối.
    const { host, port, rolePassword } = db;
    const url = `postgresql://ecoma_llm_gateway_migrator:${rolePassword}@${host}:${port}/postgres`;
    await expect(runApplyCli('gateway', url)).rejects.toThrow(
      /expected database "db-llm-gateway"/u,
    );
  });

  it('applies 0001 again as a no-op (idempotent DDL, no ledger)', async () => {
    // Runner không có ledger — nó chạy LẠI mỗi file. Tính idempotent của DDL
    // (`IF NOT EXISTS`, `CREATE SCHEMA IF NOT EXISTS`) là thứ làm lần chạy thứ
    // hai thành công mà không đổi catalog: snapshot `information_schema.tables`
    // trước và sau phải bằng nhau.
    const before = await countUserTables('gateway');
    const result = await runApplyCli('gateway', migratorUrl('gateway', db.host, db.port));
    expect(result.stdout).toContain('done     1 file(s) applied');
    const after = await countUserTables('gateway');
    expect(after).toBe(before);
  });

  it('serializes two concurrent apply runs on the advisory lock (both exit 0)', async () => {
    // Cùng advisory lock `hashtext('db-llm-gateway')` — hai tiến trình chồng
    // nhau phải hoàn thành mà không deadlock; mỗi run vẫn là 1 file apply,
    // catalog không đổi.
    const url = migratorUrl('gateway', db.host, db.port);
    const [first, second] = await Promise.all([
      runApplyCli('gateway', url),
      runApplyCli('gateway', url),
    ]);
    expect(first.stdout).toContain('done     1 file(s) applied');
    expect(second.stdout).toContain('done     1 file(s) applied');
    expect(await countUserTables('gateway')).toBe(0);
  });

  it('leaves no user table on any of the three databases after 0001 (namespace only)', async () => {
    for (const key of ALL_KEYS) {
      expect(await countUserTables(key)).toBe(0);
    }
  });

  it('creates the named schemas llm_financial and llm_seller on db-llm-gateway', async () => {
    expect(await schemaExists('gateway', 'llm_financial')).toBe(true);
    expect(await schemaExists('gateway', 'llm_seller')).toBe(true);
  });

  it('creates the named schema llm_tenant on db-llm-tenant', async () => {
    expect(await schemaExists('tenant', 'llm_tenant')).toBe(true);
  });

  it('leaves db-llm-marketplace without a user schema (privileges only)', async () => {
    expect(await schemaExists('marketplace', 'llm_marketplace')).toBe(false);
    // Không schema do service tạo: chỉ pg_catalog, information_schema, public.
    expect(await listNonSystemSchemas('marketplace')).toEqual([]);
  });

  it('keeps the per-database advisory lock distinct from other databases', async () => {
    // Khóa là `hashtext('<ten database>')` phía server — giữ khóa db-llm-gateway
    // ở session này, chạy apply db-llm-tenant từ một tiến trình khác vẫn thành công:
    // hai database không tranh cùng một khóa.
    const client = await db.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['db-llm-gateway']);
      const result = await runApplyCli('tenant', migratorUrl('tenant', db.host, db.port));
      expect(result.stdout).toContain('done     1 file(s) applied');
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['db-llm-gateway']);
      await client.end();
    }
  });
});
