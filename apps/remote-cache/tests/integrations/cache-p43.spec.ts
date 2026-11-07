/**
 * Integration test cho P4.3 (quota, retention, usage metering, audit — issue #461)
 * chay tren PostgreSQL that qua testcontainers (harness) + InMemoryObjectStorage
 * lam storage seam.
 *
 * Verify:
 * - Quota: PUT vuot quota_limits tra 429, usage_counters khong tang, audit_log co
 *   ghi `quota_exceeded` (outcome denied). PUT duoi quota tra 201, usage tang,
 *   audit_log co ghi `cache_put` (outcome allowed).
 * - Retention: GET entry het expires_at tra 404 (miss, khong leak).
 * - Usage metering tai xay lai tu cache_entries (rebuildUsageCounter).
 * - Audit log: append-only, chi INSERT, khong UPDATE/DELETE.
 *
 * ⚠️ Docker la phu dependency cung: `globalSetup` probe Docker, vang Docker la do,
 * khong skip (06-testing.md §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { InMemoryObjectStorage } from '../../src/storage';
import { remoteCacheDataRoutes } from '../../src/cache-routes';
import { loadRemoteCacheConfig } from '../../src/config';
import type { AppEnv } from '../../src/types';
import {
  insertAuditLog,
  getUsageCounterByProject,
  rebuildUsageCounter,
  type RemoteCacheQueryable,
} from '@ecoma-io/remote-cache-infrastructure';
import { type RemoteCacheDatabase, startRemoteCacheDatabase } from './harness.ts';

let db: RemoteCacheDatabase;
let storage: InMemoryObjectStorage;

function buildApp(): Hono<AppEnv> {
  storage = new InMemoryObjectStorage();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set(
      'config',
      loadRemoteCacheConfig({
        DB_REMOTE_CACHE: {
          connectionString: `postgres://ecoma_remote_cache_runtime:ecoma_test_role_pw@${db.host}:${db.port}/db-remote-cache`,
        },
        DEFAULT_MAX_STORAGE_BYTES: '1000',
        DEFAULT_MAX_ENTRY_COUNT: '10',
        DEFAULT_RETENTION_TTL_SECONDS: '3600',
      }),
    );
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.route('/', remoteCacheDataRoutes(storage));
  return app;
}

/** Hash SHA-256 cua mot chuoi — dung sinh tokenHash cho credential seed. */
async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seed tenant + project + api key (raw SQL), tra token thuan. */
async function seedProjectWithToken(client: import('pg').Client): Promise<{
  tenantId: string;
  projectId: string;
  token: string;
}> {
  const token = 'p43-integration-test-token-' + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name) VALUES ($1) RETURNING id`,
    ['p43-tenant-' + crypto.randomUUID()],
  );
  const tenantId = tenantRows[0]?.id ?? '';
  const projectId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  await client.query(
    `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
    [projectId, tenantId, 'p43-project'],
  );
  await client.query(
    `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
    [apiKeyId, projectId, tokenHash, 'read write', true],
  );
  return { tenantId, projectId, token };
}

async function put(
  app: Hono<AppEnv>,
  hash: string,
  token: string,
  body: string,
): Promise<Response> {
  const bodyBytes = new TextEncoder().encode(body);
  return app.request(`http://localhost/v1/cache/${encodeURIComponent(hash)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(bodyBytes.byteLength),
    },
    body: bodyBytes,
  } as unknown as RequestInit);
}

async function get(app: Hono<AppEnv>, hash: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(`http://localhost/v1/cache/${encodeURIComponent(hash)}`, {
    headers,
  } as unknown as RequestInit);
}

/** Tao mot moi ket noi migrator (client moi, khong su dung client da end). */
async function withMigrator<T>(fn: (client: import('pg').Client) => Promise<T>): Promise<T> {
  const migrator = await db.connectAsMigrator();
  try {
    return await fn(migrator);
  } finally {
    await migrator.end();
  }
}

/** Seed quota_limit bang migrator. */
async function seedQuotaLimit(
  projectId: string,
  maxStorageBytes: number,
  maxEntryCount: number,
): Promise<void> {
  await withMigrator(async (client) => {
    await client.query(
      `INSERT INTO remote_cache.quota_limits (project_id, max_storage_bytes, max_entry_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO UPDATE
         SET max_storage_bytes = EXCLUDED.max_storage_bytes,
             max_entry_count = EXCLUDED.max_entry_count`,
      [projectId, maxStorageBytes, maxEntryCount],
    );
  });
}

/** Seed usage_counter bang migrator. */
async function seedUsageCounter(
  projectId: string,
  storageBytesUsed: number,
  entryCount: number,
): Promise<void> {
  await withMigrator(async (client) => {
    await client.query(
      `INSERT INTO remote_cache.usage_counters (project_id, storage_bytes_used, entry_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO UPDATE
         SET storage_bytes_used = EXCLUDED.storage_bytes_used,
             entry_count = EXCLUDED.entry_count`,
      [projectId, storageBytesUsed, entryCount],
    );
  });
}

/** Lay mot token hop lu cho project (tao api key moi bang migrator). */
async function createTokenForProject(projectId: string): Promise<string> {
  const token = 'p43-token-helper-' + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  await withMigrator(async (client) => {
    await client.query(
      `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), projectId, tokenHash, 'read write', true],
    );
  });
  return token;
}

function toQueryable(client: import('pg').Client): RemoteCacheQueryable {
  return {
    unsafe: async (sql: string, params?: readonly unknown[]) => {
      const { rows } = await client.query(sql, params as unknown[]);
      return rows;
    },
  } as RemoteCacheQueryable;
}

async function readAuditRows(): Promise<
  Array<{
    action: string;
    outcome: string;
    project_id: string | null;
  }>
> {
  const client = await db.connectAsRuntime();
  try {
    const { rows } = await client.query<{
      action: string;
      outcome: string;
      project_id: string | null;
    }>(`SELECT action, outcome, project_id FROM remote_cache.audit_log ORDER BY time`);
    return rows;
  } finally {
    await client.end();
  }
}

describe('P4.3: quota enforcement (integration)', () => {
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
    app = buildApp();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    app = buildApp();
    await db.truncateData();
  });

  it('PUT under quota returns 201 and increments usage_counters + audit cache_put', async () => {
    let token = '';
    let projectId = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      token = seeded.token;
      projectId = seeded.projectId;
    });

    await seedQuotaLimit(projectId, 1000, 10);

    const putRes = await put(app, 'under-quota-hash', token, 'small-body');
    expect(putRes.status).toBe(201);

    // usage_counters da tang.
    const runtime = await db.connectAsRuntime();
    try {
      const queryable = toQueryable(runtime);
      const usage = await getUsageCounterByProject(queryable, projectId);
      expect(usage).not.toBeNull();
      expect(Number(usage?.storage_bytes_used)).toBe('small-body'.length);
      expect(Number(usage?.entry_count)).toBe(1);
    } finally {
      await runtime.end();
    }

    // Audit log co ghi cache_put (outcome allowed).
    const auditRows = await readAuditRows();
    const cachePut = auditRows.filter((r) => r.action === 'cache_put' && r.outcome === 'allowed');
    expect(cachePut.length).toBeGreaterThanOrEqual(1);
    expect(cachePut[0]?.project_id).toBe(projectId);
  });

  it('PUT exceeding storage quota returns 429, usage unchanged, audit quota_exceeded', async () => {
    let token = '';
    let projectId = '';
    let tenantId = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      token = seeded.token;
      projectId = seeded.projectId;
      tenantId = seeded.tenantId;
    });

    // Quota 100 bytes, usage da 90 bytes → PUT 20 bytes vuot han.
    await seedQuotaLimit(projectId, 100, 10);
    await seedUsageCounter(projectId, 90, 0);

    const putRes = await put(app, 'over-quota-hash', token, 'x'.repeat(20));
    expect(putRes.status).toBe(429);
    const body = (await putRes.json()) as { error?: string };
    expect(body.error).toBe('Too Many Requests');

    // usage khong thay doi.
    const runtime = await db.connectAsRuntime();
    try {
      const queryable = toQueryable(runtime);
      const usage = await getUsageCounterByProject(queryable, projectId);
      expect(Number(usage?.storage_bytes_used)).toBe(90);
      expect(Number(usage?.entry_count)).toBe(0);
    } finally {
      await runtime.end();
    }

    // Object storage khong co entry (dung public get API, khoa duoc lay tu tenant_id thuc).
    const stored = await storage.get(`${tenantId}/${projectId}/over-quota-hash`);
    expect(stored).toBeNull();

    // Audit log co ghi quota_exceeded (outcome denied).
    const auditRows = await readAuditRows();
    const quotaExceeded = auditRows.filter(
      (r) => r.action === 'quota_exceeded' && r.outcome === 'denied',
    );
    expect(quotaExceeded.length).toBeGreaterThanOrEqual(1);
    expect(quotaExceeded[0]?.project_id).toBe(projectId);
  });

  it('PUT exceeding entry count quota returns 429', async () => {
    let token = '';
    let projectId = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      token = seeded.token;
      projectId = seeded.projectId;
    });

    // Quota 1 entry, usage da 1 entry.
    await seedQuotaLimit(projectId, 1000, 1);
    await seedUsageCounter(projectId, 0, 1);

    const putRes = await put(app, 'over-count-hash', token, 'tiny');
    expect(putRes.status).toBe(429);
  });

  it('GET expired entry (retention TTL) returns 404', async () => {
    let token = '';
    let projectId = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      token = seeded.token;
      projectId = seeded.projectId;
    });

    // PUT mot entry, sau do set expires_at qua han qua raw SQL.
    await put(app, 'expired-hash', token, 'expired-body');
    const past = new Date(Date.now() - 1000).toISOString();
    await withMigrator(async (client) => {
      await client.query(
        `UPDATE remote_cache.cache_entries SET expires_at = $1 WHERE hash = $2 AND project_id = $3`,
        [past, 'expired-hash', projectId],
      );
    });

    const res = await get(app, 'expired-hash', token);
    expect(res.status).toBe(404);
  });

  it('GET valid entry within TTL returns 200', async () => {
    let token = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      token = seeded.token;
    });

    await put(app, 'valid-hash', token, 'valid-body');

    const res = await get(app, 'valid-hash', token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('valid-body');
  });

  it('rebuildUsageCounter tai xay lai tu cache_entries', async () => {
    let projectId = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      projectId = seeded.projectId;
    });

    // Put hai entry qua data plane (usage se duoc cap nhat bo intermediary, nhung
    // minh se tai xay lai tu cache_entries).
    await put(app, 'rebuild-hash-1', await createTokenForProject(projectId), 'body-one');
    await put(app, 'rebuild-hash-2', await createTokenForProject(projectId), 'body-two-longer');

    const runtime = await db.connectAsRuntime();
    try {
      const queryable = toQueryable(runtime);
      const rebuilt = await rebuildUsageCounter(queryable, projectId);
      expect(Number(rebuilt.entryCount)).toBe(2);
      expect(Number(rebuilt.storageBytesUsed)).toBe('body-one'.length + 'body-two-longer'.length);

      const usage = await getUsageCounterByProject(queryable, projectId);
      expect(Number(usage?.entry_count)).toBe(2);
      expect(Number(usage?.storage_bytes_used)).toBe('body-one'.length + 'body-two-longer'.length);
    } finally {
      await runtime.end();
    }
  });

  it('audit log append-only: SELECT/INSERT chay, UPDATE/DELETE bi chuan o runtime', async () => {
    let projectId = '';
    await withMigrator(async (client) => {
      const seeded = await seedProjectWithToken(client);
      projectId = seeded.projectId;
    });

    // INSERT qua repo thuc.
    const runtime = await db.connectAsRuntime();
    try {
      const queryable = toQueryable(runtime);
      const id = await insertAuditLog(queryable, {
        actor: 'test-actor',
        action: 'cache_put',
        target: `project:${projectId}`,
        outcome: 'allowed',
        details: 'test detail',
        projectId,
      });
      expect(id).not.toBe('');

      // UPDATE/DELETE phai bi chuan (runtime khong co grant).
      await expect(
        runtime.query(`UPDATE remote_cache.audit_log SET outcome = 'denied' WHERE id = $1`, [id]),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query(`DELETE FROM remote_cache.audit_log WHERE id = $1`, [id]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });
});
