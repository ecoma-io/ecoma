/**
 * Apply migration `db-llm-gateway`, `db-llm-tenant`, `db-llm-marketplace` qua
 * **runner canonical của migration authority** (`deploys/llm-<target>-db`
 * `runner.mts migrate` — cutover #376, được gọi bằng `tsx` qua
 * `child_process`) trên PostgreSQL thật.
 *
 * ⚠️ Đường code được test là đúng lệnh mà target `db-migrate` của project db
 * chạy: guard `current_database()`, advisory lock
 * `pg_advisory_lock(hashtext('<database>'))`, engine `drizzle-kit migrate` với
 * history `__drizzle_migrations` (checkpoint per-run — chạy lại là no-op,
 * không replay). Tất cả invocation đều đi qua credential migrator thật (proxy
 * `DATABASE_URL`), không `SET ROLE` — đúng hình CI runner.
 *
 * Suite này chạy adopted journal trên ba database — gateway `0001`–`0005`
 * (schema namespace + bảng nghiệp vụ `llm_seller` của bootstrap Issue #23 +
 * schema `llm_gateway` với bảng `api_keys` của bootstrap Issue #24), tenant có
 * `0001`–`0002` (namespace + bảng nghiệp vụ `llm_tenant` của bước 9, Issue
 * #24), marketplace có `0001`–`0004` (schema `llm_marketplace`, thu hẹp default
 * privileges, bảng nghiệp vụ offering của Issue #23) — catalog PostgreSQL là
 * nguồn sự thật, history là bằng chứng adopt-đúng-số-entry.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type LlmApiDatabase,
  type LlmDatabaseKey,
  databaseName,
  migratorUrl,
  runApplyCli,
  startLlmApiDatabase,
} from '../integrations/harness.ts';

/**
 * Tập bảng user của db-llm-gateway: `llm_seller` của bootstrap Issue #23, cộng
 * schema `llm_gateway` của bước 9, schema `llm_financial` của bước 10 (Issue
 * #24), và serving slice P4 (Issue #24) thêm pricing snapshot vào `llm_seller`,
 * quota/journal vào `llm_gateway`, projection wallet/ledger vào
 * `llm_financial`. Bốn schema cùng có một bảng tên `bootstrap_audit` —
 * `information_schema.tables` trả từng row và danh sách kỳ vọng liệt kê tương
 * ứng (bốn entry trùng tên, một cho mỗi schema).
 */
const GATEWAY_TABLES: readonly string[] = [
  'seller_tenants',
  'seller_memberships',
  'legal_principals',
  'principal_legal_profiles',
  'principal_tax_profiles',
  'principal_evidence',
  'verification_cases',
  'verification_submissions',
  'restriction_records',
  'principal_associations',
  'bootstrap_audit',
  'api_keys',
  'bootstrap_audit',
  'sponsors',
  'billing_accounts',
  'sponsor_funding_authorizations',
  'sponsor_grants',
  'bootstrap_audit',
  'pricing_snapshots',
  'tenant_quota',
  'quota_reservations',
  'logical_requests',
  'attempts',
  'wallets',
  'ledger_transactions',
  'ledger_entries',
  'financial_reservations',
  'customer_charges',
];

/** Tập bảng nghiệp vụ `llm_tenant` của bước 9 (Issue #24) trên db-llm-tenant. */
const TENANT_TABLES: readonly string[] = ['tenants', 'memberships', 'bootstrap_audit'];

/** Tập bảng offering của Issue #23 trên db-llm-marketplace. */
const MARKETPLACE_TABLES: readonly string[] = [
  'model_offers',
  'endpoint_pools',
  'upstream_endpoints',
  'provider_credentials',
  'bootstrap_audit',
];

/** Số entry journal adopted của một DB — bằng chứng history đầy đủ sau migrate. */
const JOURNAL_ENTRIES: Readonly<Record<LlmDatabaseKey, number>> = {
  gateway: 5,
  tenant: 2,
  marketplace: 4,
};

/** Schema history của một DB — trùng schema runtime trỏ trong `drizzle.config.ts`. */
const HISTORY_SCHEMA: Readonly<Record<LlmDatabaseKey, string>> = {
  gateway: 'llm_gateway',
  tenant: 'llm_tenant',
  marketplace: 'llm_marketplace',
};

let db: LlmApiDatabase;

beforeAll(async () => {
  db = await startLlmApiDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

/**
 * Số hàng `information_schema.tables` của một DB — snapshot idempotency. Bảng
 * `__drizzle_migrations` (ledger của kit, cutover #376) là hạ tầng migration —
 * loại ra để đếm đúng bảng nghiệp vụ; sự tồn tại và số entry của nó được assert
 * riêng qua {@link historyRows}.
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
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_name <> '__drizzle_migrations'`,
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

/** Tên mọi bảng user (mọi schema service) của một DB, đã sort — trừ ledger của kit. */
async function listUserTables(key: LlmDatabaseKey): Promise<string[]> {
  const client = await db.connect(key);
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_name <> '__drizzle_migrations'
        ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
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

/** Số hàng history `__drizzle_migrations` của một DB — cửa sổ vào ledger của kit. */
async function historyRows(key: LlmDatabaseKey): Promise<number> {
  const client = await db.connectAsMigrator(key);
  try {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ${HISTORY_SCHEMA[key]}.__drizzle_migrations`,
    );
    return Number(rows[0]?.count ?? '0');
  } finally {
    await client.end();
  }
}

describe('llm-api migration runner on real PostgreSQL', () => {
  it('rejects a DATABASE_URL pointing at another database (current_database guard, non-zero exit)', async () => {
    // Guard fail-closed của wrapper (pattern exemplar #374): `DATABASE_URL`
    // trỏ nhầm `postgres` database phải bị từ chối TRƯỚC khi một DDL nào chạm
    // đích. `postgres` có sẵn trong mọi image PostgreSQL và migrator có CONNECT
    // mặc định PUBLIC ở đó — nên kết nối thành công mà `current_database()`
    // khác, guard phải chặn ngay.
    const { host, port, rolePassword } = db;
    const url = `postgresql://ecoma_llm_gateway_migrator:${rolePassword}@${host}:${port}/postgres`;
    await expect(runApplyCli('gateway', url)).rejects.toThrow(
      /refusing to touch the wrong database/u,
    );
  });

  it('applies the gateway set again as a no-op (kit checkpoint reads history, nothing replays)', async () => {
    // Kit đọc `max(created_at)` của history rồi chỉ apply entry mới hơn — lần
    // chạy thứ hai KHÔNG thực thi lại adopted DDL. Snapshot
    // `information_schema.tables` trước và sau phải bằng nhau, history vẫn đủ
    // 5 entry: bằng chứng "adopt, không replay" (§3a.3 mục D).
    const before = await countUserTables('gateway');
    const result = await runApplyCli('gateway', migratorUrl('gateway', db.host, db.port));
    expect(result.stdout).toContain('migrate complete');
    const after = await countUserTables('gateway');
    expect(after).toBe(before);
    expect(await historyRows('gateway')).toBe(JOURNAL_ENTRIES.gateway);
  });

  it('records the adopted journal exactly once per entry on every database (gateway 5, tenant 2, marketplace 4)', async () => {
    // History của kit là ledger mới sau cutover — sau lần migrate đầu tiên của
    // setup, mọi entry journal phải có đúng một hàng history (không mất, không
    // nhân đôi) trên cả ba database.
    for (const key of ['gateway', 'tenant', 'marketplace'] as LlmDatabaseKey[]) {
      expect(await historyRows(key), `history rows of ${databaseName(key)}`).toBe(
        JOURNAL_ENTRIES[key],
      );
    }
  });

  it('serializes two concurrent migrate runs on the advisory lock (both exit 0)', async () => {
    // Cùng advisory lock `hashtext('db-llm-gateway')` — hai tiến trình chồng
    // nhau phải hoàn thành mà không deadlock; checkpoint của kit làm lần chạy
    // thứ hai thành no-op, catalog không đổi.
    const url = migratorUrl('gateway', db.host, db.port);
    const [first, second] = await Promise.all([
      runApplyCli('gateway', url),
      runApplyCli('gateway', url),
    ]);
    expect(first.stdout).toContain('migrate complete');
    expect(second.stdout).toContain('migrate complete');
    expect(await countUserTables('gateway')).toBe(GATEWAY_TABLES.length);
    expect(await historyRows('gateway')).toBe(JOURNAL_ENTRIES.gateway);
  });

  it('creates exactly the business tables of each domain slice (gateway 11 seller + 5 gateway-runtime + 9 financial, tenant 3, marketplace 5 offering)', async () => {
    // Gateway: đúng tập bảng `llm_seller` của Issue #23 + `llm_gateway` của
    // bước 9 + `llm_financial` của bước 10 + serving slice P4 (Issue #24) —
    // không bảng lạ; ba `bootstrap_audit` là ba bảng của ba schema khác nhau
    // cùng tên.
    expect(await listUserTables('gateway')).toEqual([...GATEWAY_TABLES].toSorted());
    // Tenant: đúng tập bảng `llm_tenant` của bước 9 (Issue #24) — không bảng lạ.
    expect(await listUserTables('tenant')).toEqual([...TENANT_TABLES].toSorted());
    expect(await countUserTables('tenant')).toBe(TENANT_TABLES.length);
    // Marketplace: đúng tập bảng offering của Issue #23.
    expect(await listUserTables('marketplace')).toEqual([...MARKETPLACE_TABLES].toSorted());
  });

  it('creates the named schemas llm_financial and llm_seller on db-llm-gateway', async () => {
    expect(await schemaExists('gateway', 'llm_financial')).toBe(true);
    expect(await schemaExists('gateway', 'llm_seller')).toBe(true);
  });

  it('creates the named schema llm_tenant on db-llm-tenant', async () => {
    expect(await schemaExists('tenant', 'llm_tenant')).toBe(true);
  });

  it('creates the named schema llm_marketplace on db-llm-marketplace (migrator-owned, English comment)', async () => {
    // `0002` forward-fix tạo schema sau `0001` (privileges-only): owner là migrator
    // (credential chạy CREATE SCHEMA), comment tiếng Anh theo policy `AGENTS.md`.
    expect(await schemaExists('marketplace', 'llm_marketplace')).toBe(true);
    // Schema duy nhất do service tạo: chỉ llm_marketplace ngoài các schema hệ thống.
    expect(await listNonSystemSchemas('marketplace')).toEqual(['llm_marketplace']);

    const client = await db.connect('marketplace');
    try {
      const { rows } = await client.query<{ owner: string; comment: string | null }>(
        `SELECT r.rolname AS owner, d.description AS comment
           FROM pg_namespace n
           JOIN pg_roles r ON r.oid = n.nspowner
           LEFT JOIN pg_description d ON d.objoid = n.oid
                                     AND d.classoid = 'pg_namespace'::regclass
          WHERE n.nspname = 'llm_marketplace'`,
      );
      expect(rows[0]?.owner).toBe('ecoma_llm_marketplace_migrator');
      expect(rows[0]?.comment).toContain('Owning domain: llm-marketplace');
    } finally {
      await client.end();
    }
  });

  it('keeps the provider credential surface hash-only and tenant-scoped (no plaintext column, no provider-only index)', async () => {
    // ADR-0027 §8: credential chỉ lưu hash (show-once/hash-only), hai trục
    // scope là `provider` + `seller_tenant_id`; không tồn tại đường lookup
    // theo `provider` một mình — kiểm trên catalog: cột, constraint, index.
    const client = await db.connect('marketplace');
    try {
      const { rows: columns } = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'llm_marketplace' AND table_name = 'provider_credentials'
          ORDER BY column_name`,
      );
      const names = columns.map((row) => row.column_name);
      expect(names).toContain('credential_hash');
      expect(names).toContain('seller_tenant_id');
      expect(names).not.toContain('credential_plaintext');
      expect(names).not.toContain('plaintext');
      expect(names).not.toContain('credential_value');

      // Natural key của rotation: (seller_tenant_id, credential_hash) —
      // không có unique nào trên `provider` một mình.
      const { rows: indexes } = await client.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'llm_marketplace' AND tablename = 'provider_credentials'`,
      );
      const definitions = indexes.map((row) => row.indexdef);
      expect(
        definitions.some((definition) =>
          definition.includes('(seller_tenant_id, credential_hash)'),
        ),
      ).toBe(true);
      expect(
        definitions.some((definition) => /UNIQUE INDEX [^(]*\(\s*provider\s*\)/u.test(definition)),
      ).toBe(false);
      // Index truy vấn chính của serving path cũng mang tenant trước provider.
      expect(
        definitions.some((definition) => definition.includes('(seller_tenant_id, provider)')),
      ).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('narrows db-wide default privileges: no global tuple grants runtime table privileges, schema-scoped entry remains', async () => {
    // `0003` thu hồi default privileges toàn database mà `0001` cấp (runtime DML
    // trên MỌI bảng migrator tạo, bất kể schema). REVOKE không `IN SCHEMA` chỉ đụng
    // tuple toàn cục trong `pg_default_acl` (`defaclnamespace = 0`) — entry theo
    // schema `llm_marketplace` của `0002` phải còn nguyên với đủ bốn quyền DML.
    // Assert trên catalog, không phải hành vi: hành vi DML runtime trên bảng
    // migrator tạo đã có ở permission-boundary.spec.ts.
    const client = await db.connect('marketplace');
    try {
      // Không tuple toàn cục nào (migrator, defaclnamespace = 0, loại bảng) còn
      // cấp gì cho runtime — PostgreSQL xóa entry khi ACL rỗng sau REVOKE.
      const { rows: globalRows } = await client.query<{ acl: string }>(
        `SELECT array_to_string(d.defaclacl, ',') AS acl
           FROM pg_default_acl d
           JOIN pg_roles r ON r.oid = d.defaclrole
          WHERE r.rolname = 'ecoma_llm_marketplace_migrator'
            AND d.defaclnamespace = 0
            AND d.defaclobjtype = 'r'`,
      );
      const globalGrantsToRuntime = globalRows
        .flatMap((row) => row.acl.split(','))
        .filter((entry) => entry.startsWith('ecoma_llm_marketplace_runtime='));
      expect(globalGrantsToRuntime).toEqual([]);

      // Entry theo schema còn đúng một tuple, mang đủ SELECT/INSERT/UPDATE/DELETE
      // cho runtime (acl letter r/a/w/d — so từng chữ, không phụ thuộc thứ tự).
      const { rows: scopedRows } = await client.query<{ acl: string }>(
        `SELECT array_to_string(d.defaclacl, ',') AS acl
           FROM pg_default_acl d
           JOIN pg_roles r ON r.oid = d.defaclrole
          WHERE r.rolname = 'ecoma_llm_marketplace_migrator'
            AND d.defaclnamespace = 'llm_marketplace'::regnamespace
            AND d.defaclobjtype = 'r'`,
      );
      expect(scopedRows).toHaveLength(1);
      const scopedEntry = scopedRows[0]?.acl
        .split(',')
        .find((entry) => entry.startsWith('ecoma_llm_marketplace_runtime='));
      expect(scopedEntry).toBeDefined();
      const privileges = scopedEntry?.split('=')[1]?.split('/')[0] ?? '';
      for (const letter of ['r', 'a', 'w', 'd']) {
        expect(privileges).toContain(letter);
      }
    } finally {
      await client.end();
    }
  });

  it('keeps the per-database advisory lock distinct from other databases', async () => {
    // Khóa là `hashtext('<ten database>')` phía server — giữ khóa db-llm-gateway
    // ở session này, chạy migrate db-llm-tenant từ một tiến trình khác vẫn thành
    // công: hai database không tranh cùng một khóa (khóa hard-code của runner
    // tenant bằng đúng `hashtext('db-llm-tenant')`, khác khóa gateway).
    const client = await db.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['db-llm-gateway']);
      const result = await runApplyCli('tenant', migratorUrl('tenant', db.host, db.port));
      expect(result.stdout).toContain('migrate complete');
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['db-llm-gateway']);
      await client.end();
    }
  });
});
