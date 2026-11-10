/**
 * Unit test for P4.3 data plane quota/retention behavior — `PUT/GET /v1/cache/:hash`
 * (issue #461).
 *
 * Chạy tách biệt DB thật: mock toàn bộ `@ecoma-io/remote-cache-infrastructure` và
 * dùng `InMemoryObjectStorage` làm storage seam. Verify logic routing (quota
 * enforcement → 429 non-fatal, retention TTL → 404 miss, audit log appended)
 * mà không cần PostgreSQL (06-testing.md §4: `test` = colocated unit/component,
 * dependency ngoài thay bằng giả lập).
 *
 * Mô hình giả lập DB:
 * - `tokensByHash`: SHA-256(token) → { projectId, tenantId, scopes }.
 * - `entriesByKey`: object_key → metadata + body.
 * - `quotaLimitsByProject`: project_id → { maxStorageBytes, maxEntryCount }.
 * - `usageCountersByProject`: project_id → { storageBytesUsed, entryCount }.
 * - `auditLog`: mảng các ghi nhat ky (actor, action, target, outcome, details, projectId).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { InMemoryObjectStorage } from './storage';
import { remoteCacheDataRoutes } from './cache-routes';
import { loadRemoteCacheConfig } from './config';
import type { AppEnv } from './types';
import type {
  RemoteCacheClient,
  RemoteCacheQueryable,
} from '@ecoma-io/remote-cache-infrastructure';

const config = loadRemoteCacheConfig({
  DB_REMOTE_CACHE: { connectionString: 'postgres://localhost/db-remote-cache' },
  DEFAULT_MAX_STORAGE_BYTES: '1000',
  DEFAULT_MAX_ENTRY_COUNT: '10',
  DEFAULT_RETENTION_TTL_SECONDS: '3600',
});

const tokensByHash = new Map<
  string,
  { projectId: string; tenantId: string; scopes: readonly string[] }
>();
const tenantsById = new Map<string, { id: string; name: string; status: string }>();
const entriesByKey = new Map<
  string,
  { body: Uint8Array; contentType: string | null; expiresAt: string | null }
>();
const quotaLimitsByProject = new Map<string, { maxStorageBytes: number; maxEntryCount: number }>();
const usageCountersByProject = new Map<string, { storageBytesUsed: number; entryCount: number }>();
const auditLog: Array<{
  actor: string;
  action: string;
  target: string;
  outcome: string;
  details?: string | null;
  projectId?: string | null;
}> = [];

async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function registerToken(
  token: string,
  projectId: string,
  tenantId: string,
  scopes: readonly string[],
): Promise<void> {
  const hash = await sha256Hex(token);
  tokensByHash.set(hash, { projectId, tenantId, scopes });
  tenantsById.set(tenantId, { id: tenantId, name: `tenant-${tenantId}`, status: 'active' });
}

function resetState(): void {
  tokensByHash.clear();
  tenantsById.clear();
  entriesByKey.clear();
  quotaLimitsByProject.clear();
  usageCountersByProject.clear();
  auditLog.length = 0;
}

function setQuotaLimit(projectId: string, maxStorageBytes: number, maxEntryCount: number): void {
  quotaLimitsByProject.set(projectId, { maxStorageBytes, maxEntryCount });
}

function setUsageCounter(projectId: string, storageBytesUsed: number, entryCount: number): void {
  usageCountersByProject.set(projectId, { storageBytesUsed, entryCount });
}

vi.mock('@ecoma-io/remote-cache-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/remote-cache-infrastructure')>();
  return {
    ...actual,
    withRemoteCacheClient: vi.fn<
      (_config: unknown, fn: (db: RemoteCacheClient) => Promise<unknown>) => Promise<unknown>
    >(async (_config: unknown, fn: (db: RemoteCacheClient) => Promise<unknown>) => {
      const fake = {
        unsafe: async () => [],
        begin: async (txFn: (tx: RemoteCacheQueryable) => Promise<unknown>) => {
          const fakeTx = { unsafe: async () => [] } as unknown as RemoteCacheQueryable;
          return txFn(fakeTx);
        },
      } as unknown as RemoteCacheClient;
      return fn(fake);
    }),
    getApiKeyByTokenHash: vi.fn<
      (
        _db: unknown,
        tokenHash: string,
      ) => Promise<{
        project_id: string;
        scopes: string;
        revoked_at: null;
        trusted_ci: boolean;
      } | null>
    >(async (_db: unknown, tokenHash: string) => {
      const row = tokensByHash.get(tokenHash);
      if (!row) return null;
      return {
        project_id: row.projectId,
        scopes: row.scopes.join(' '),
        revoked_at: null,
        trusted_ci: true,
      };
    }),
    getProjectById: vi.fn<
      (_db: unknown, projectId: string) => Promise<{ id: string; tenant_id: string } | null>
    >(async (_db: unknown, projectId: string) => {
      for (const row of tokensByHash.values()) {
        if (row.projectId === projectId) {
          return { id: projectId, tenant_id: row.tenantId };
        }
      }
      return null;
    }),
    getTenantById: vi.fn<
      (
        _db: unknown,
        tenantId: string,
      ) => Promise<{ id: string; name: string; status: string } | null>
    >(async (_db: unknown, tenantId: string) => {
      const row = tenantsById.get(tenantId);
      return row ?? null;
    }),
    getCacheEntryByProjectAndHash: vi.fn<
      (
        _db: unknown,
        projectId: string,
        hash: string,
      ) => Promise<{
        id: string;
        project_id: string;
        hash: string;
        object_key: string;
        size_bytes: string;
        content_type: string | null;
        created_at: string;
        expires_at: string | null;
      } | null>
    >(async (_db: unknown, projectId: string, hash: string) => {
      for (const row of tokensByHash.values()) {
        if (row.projectId === projectId) {
          const key = `${row.tenantId}/${projectId}/${hash}`;
          const entry = entriesByKey.get(key);
          if (entry) {
            return {
              id: 'entry-id',
              project_id: projectId,
              hash,
              object_key: key,
              size_bytes: String(entry.body.byteLength),
              content_type: entry.contentType,
              created_at: new Date().toISOString(),
              expires_at: entry.expiresAt,
            };
          }
          return null;
        }
      }
      return null;
    }),
    insertCacheEntry: vi.fn<
      (
        _db: unknown,
        entry: {
          objectKey: string;
          sizeBytes: number;
          contentType?: string | null;
          expiresAt?: string | null;
        },
      ) => Promise<{ wasInsert: boolean }>
    >(
      async (
        _db: unknown,
        entry: {
          objectKey: string;
          sizeBytes: number;
          contentType?: string | null;
          expiresAt?: string | null;
        },
      ) => {
        const key = entry.objectKey;
        const existing = entriesByKey.get(key);
        entriesByKey.set(key, {
          body: existing?.body ?? new Uint8Array(0),
          contentType: entry.contentType ?? null,
          expiresAt: entry.expiresAt ?? null,
        });
        // Simulate DB trigger `cache_entries_after_insert_sync` (migration 0006):
        // increment usage_counters storage_bytes_used + entry_count for the project.
        // project_id lay tu key: tenantId/projectId/hash
        const parts = key.split('/');
        if (parts.length >= 2) {
          const projectId = parts[1];
          const cur = usageCountersByProject.get(projectId) ?? {
            storageBytesUsed: 0,
            entryCount: 0,
          };
          usageCountersByProject.set(projectId, {
            storageBytesUsed: cur.storageBytesUsed + entry.sizeBytes,
            entryCount: cur.entryCount + 1,
          });
        }
        return { wasInsert: true };
      },
    ),
    getQuotaLimitByProject: vi.fn<
      (
        _db: unknown,
        projectId: string,
      ) => Promise<{ max_storage_bytes: string; max_entry_count: string } | null>
    >(async (_db: unknown, projectId: string) => {
      const q = quotaLimitsByProject.get(projectId);
      if (!q) return null;
      return {
        max_storage_bytes: String(q.maxStorageBytes),
        max_entry_count: String(q.maxEntryCount),
      };
    }),
    getUsageCounterByProject: vi.fn<
      (
        _db: unknown,
        projectId: string,
      ) => Promise<{ storage_bytes_used: string; entry_count: string } | null>
    >(async (_db: unknown, projectId: string) => {
      const u = usageCountersByProject.get(projectId);
      if (!u) return null;
      return { storage_bytes_used: String(u.storageBytesUsed), entry_count: String(u.entryCount) };
    }),
    insertAuditLog: vi.fn<
      (
        _db: unknown,
        entry: {
          actor: string;
          action: string;
          target: string;
          outcome: string;
          details?: string | null;
          projectId?: string | null;
        },
      ) => Promise<string>
    >(
      async (
        _db: unknown,
        entry: {
          actor: string;
          action: string;
          target: string;
          outcome: string;
          details?: string | null;
          projectId?: string | null;
        },
      ) => {
        auditLog.push(entry);
        return 'audit-id';
      },
    ),
  };
});

function buildApp(storage: InMemoryObjectStorage): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('config', config);
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.route('/', remoteCacheDataRoutes(storage));
  return app;
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
  } as unknown as Request);
}

async function get(app: Hono<AppEnv>, hash: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(`http://localhost/v1/cache/${encodeURIComponent(hash)}`, {
    headers,
  } as unknown as Request);
}

describe('P4.3: quota enforcement (unit)', () => {
  let app: Hono<AppEnv>;
  let storage: InMemoryObjectStorage;

  beforeEach(async () => {
    resetState();
    storage = new InMemoryObjectStorage();
    app = buildApp(storage);
  });

  it('PUT under quota returns 201 and increments usage', async () => {
    const token = 'token-write-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);
    setQuotaLimit('project-a', 1000, 10);
    setUsageCounter('project-a', 0, 0);

    const putRes = await put(app, 'abc123', token, 'artifact-body-under-quota');
    expect(putRes.status).toBe(201);
    expect(usageCountersByProject.get('project-a')?.storageBytesUsed).toBe(
      'artifact-body-under-quota'.length,
    );
    expect(usageCountersByProject.get('project-a')?.entryCount).toBe(1);

    // Audit log co mot ghi cache_put voi outcome allowed.
    const putAudit = auditLog.filter((e) => e.action === 'cache_put' && e.outcome === 'allowed');
    expect(putAudit.length).toBe(1);
    expect(putAudit[0]?.projectId).toBe('project-a');
  });

  it('PUT exceeding storage quota returns 429 (non-fatal miss)', async () => {
    const token = 'token-write-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);
    // Quota 100 bytes, usage already 90 bytes → PUT of 20 bytes exceeds.
    setQuotaLimit('project-a', 100, 10);
    setUsageCounter('project-a', 90, 0);

    const putRes = await put(app, 'big-hash', token, 'x'.repeat(20));
    expect(putRes.status).toBe(429);
    const body = (await putRes.json()) as { error?: string };
    expect(body.error).toBe('Too Many Requests');

    // Usage khong duoc cap nhat (write bi chuan).
    expect(usageCountersByProject.get('project-a')?.storageBytesUsed).toBe(90);
    expect(entriesByKey.has(`tenant-a/project-a/big-hash`)).toBe(false);

    // Audit log co ghi quota_exceeded voi outcome denied.
    const quotaAudit = auditLog.filter(
      (e) => e.action === 'quota_exceeded' && e.outcome === 'denied',
    );
    expect(quotaAudit.length).toBe(1);
    expect(quotaAudit[0]?.projectId).toBe('project-a');
  });

  it('PUT exceeding entry count quota returns 429', async () => {
    const token = 'token-write-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);
    // Quota 1 entry, usage already 1 entry → new entry exceeds.
    setQuotaLimit('project-a', 1000, 1);
    setUsageCounter('project-a', 0, 1);

    const putRes = await put(app, 'new-hash', token, 'small');
    expect(putRes.status).toBe(429);

    const quotaAudit = auditLog.filter((e) => e.action === 'quota_exceeded');
    expect(quotaAudit.length).toBe(1);
  });

  it('PUT without quota limit row uses default from config', async () => {
    const token = 'token-write-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);
    // Chua set quota limit → fallback DEFAULT_MAX_STORAGE_BYTES=1000, DEFAULT_MAX_ENTRY_COUNT=10.
    setUsageCounter('project-a', 0, 0);

    const putRes = await put(app, 'default-quota-hash', token, 'small-body');
    expect(putRes.status).toBe(201);
  });

  it('GET miss returns 404 (non-fatal: build proceeds normally)', async () => {
    const token = 'token-read-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read']);

    const res = await get(app, 'does-not-exist', token);
    expect(res.status).toBe(404);
  });

  it('expired entry (retention TTL) returns 404 on GET', async () => {
    const token = 'token-read-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);

    // PUT vao storage (co body), sau do dua expires_at ve qua han trong entriesByKey.
    await put(app, 'expired-hash', token, 'expired-body');
    const key = 'tenant-a/project-a/expired-hash';
    const existing = entriesByKey.get(key);
    entriesByKey.set(key, {
      body: existing?.body ?? new Uint8Array(0),
      contentType: existing?.contentType ?? null,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // het han 1 giay truoc
    });

    const res = await get(app, 'expired-hash', token);
    expect(res.status).toBe(404);
  });

  it('valid entry within TTL returns 200 on GET', async () => {
    const token = 'token-read-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);

    await put(app, 'valid-hash', token, 'valid-body');

    const res = await get(app, 'valid-hash', token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('valid-body');
  });

  it('audit log appends quota_exceeded for denied write', async () => {
    const token = 'token-write-project-a';
    await registerToken(token, 'project-a', 'tenant-a', ['read', 'write']);
    setQuotaLimit('project-a', 10, 10); // chi 10 bytes
    setUsageCounter('project-a', 0, 0);

    await put(app, 'over-quota-hash', token, 'x'.repeat(20));

    const denied = auditLog.filter((e) => e.action === 'quota_exceeded' && e.outcome === 'denied');
    expect(denied.length).toBe(1);
    expect(denied[0]?.projectId).toBe('project-a');
    expect(denied[0]?.actor).toContain('project-a');
    // details khong chua secret/token.
    expect(denied[0]?.details ?? '').not.toContain(token);
  });
});
