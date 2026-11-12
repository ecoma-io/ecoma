/**
 * Integration test cho control-plane routes (P4.1/P4.4, issue #20): POST/GET
 * `/projects` và vòng đời credential mà #20 ghim — show-once token, gate
 * trusted_ci, revocation, tenant lifecycle — chạy trên PostgreSQL thật qua
 * harness + `InMemoryObjectStorage` làm storage seam.
 *
 * Khác các spec data plane: router control plane (`src/routes.ts`) được mount
 * CÙNG router data plane (`src/cache-routes.ts`) đúng như composition root
 * `src/main.ts`, để chứng minh token show-once của POST /projects authenticate
 * được data plane thật (không phải đường seed riêng của test).
 *
 * ⚠️ Docker là phụ thuộc cứng: `globalSetup` probe Docker, vắng Docker là đỏ,
 * không skip (06-testing.md §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { InMemoryObjectStorage } from '../../src/storage';
import { remoteCacheDataRoutes } from '../../src/cache-routes';
import { remoteCacheRoutes } from '../../src/routes';
import { loadRemoteCacheConfig } from '../../src/config';
import type { AppEnv } from '../../src/types';
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
      }),
    );
    c.set('requestId', 'test-request-id');
    await next();
  });
  // Cùng thứ tự mount với src/main.ts: control plane trước, data plane sau.
  app.route('/', remoteCacheRoutes());
  app.route('/', remoteCacheDataRoutes(storage));
  return app;
}

/** Hash SHA-256 của một chuỗi — đường auth lưu/tra `token_hash` theo dạng này. */
async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Seed tenant customer/paid + project cha + key trusted_ci (scopes read write)
 * bằng credential migrator — đúng shape mà bootstrap (#20) dựng cho credential
 * CI. Trả token thô để test dùng như credential caller.
 */
async function seedTenantProjectAndTrustedKey(
  client: import('pg').Client,
  options: { trustedCi?: boolean } = {},
): Promise<{ tenantId: string; projectId: string; token: string }> {
  const token = 'cp-integration-token-' + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
     VALUES ($1, 'customer', 'paid', 'sub-owner-control-plane') RETURNING id`,
    ['cp-tenant-' + crypto.randomUUID()],
  );
  const tenantId = tenantRows[0]?.id ?? '';
  const { rows: projectRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, 'cp-host-project') RETURNING id`,
    [tenantId],
  );
  const projectId = projectRows[0]?.id ?? '';
  await client.query(
    `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes, trusted_ci)
     VALUES ($1, $2, 'read write', $3)`,
    [projectId, tokenHash, options.trustedCi ?? true],
  );
  return { tenantId, projectId, token };
}

function envFor(): AppEnv['Bindings'] {
  return {
    DB_REMOTE_CACHE: {
      connectionString: `postgres://ecoma_remote_cache_runtime:ecoma_test_role_pw@${db.host}:${db.port}/db-remote-cache`,
    },
  };
}

async function postProject(
  app: Hono<AppEnv>,
  body: Record<string, unknown>,
  token: string,
): Promise<Response> {
  return app.request('http://localhost/projects', {
    ...envFor(),
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  } as unknown as Request);
}

async function listProjects(app: Hono<AppEnv>, token: string): Promise<Response> {
  return app.request('http://localhost/projects', {
    ...envFor(),
    headers: { authorization: `Bearer ${token}` },
  } as unknown as Request);
}

async function putCache(
  app: Hono<AppEnv>,
  hash: string,
  token: string,
  body: string,
): Promise<Response> {
  const bodyBytes = new TextEncoder().encode(body);
  return app.request(`http://localhost/v1/cache/${encodeURIComponent(hash)}`, {
    ...envFor(),
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(bodyBytes.byteLength),
    },
    body: bodyBytes,
  } as unknown as Request);
}

async function getCache(app: Hono<AppEnv>, hash: string, token: string): Promise<Response> {
  return app.request(`http://localhost/v1/cache/${encodeURIComponent(hash)}`, {
    ...envFor(),
    headers: { authorization: `Bearer ${token}` },
  } as unknown as Request);
}

/** Đếm hàng theo bảng — chứng minh nhánh từ chối không để lại trạng thái mới. */
async function countRows(table: 'projects' | 'api_keys'): Promise<number> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM remote_cache.${table}`,
    );
    return Number(rows[0]?.count);
  } finally {
    await client.end();
  }
}

describe('control plane routes (integration)', () => {
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
    app = buildApp();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncateData();
  });

  it('POST /projects creates the project under the caller tenant and returns a show-once token', async () => {
    let tenantId = '';
    let token = '';
    const migrator = await db.connectAsMigrator();
    try {
      ({ tenantId, token } = await seedTenantProjectAndTrustedKey(migrator));
    } finally {
      await migrator.end();
    }

    const res = await postProject(
      app,
      { name: 'cp-created-project', api_key_scopes: ['read', 'write'], trusted_ci: false },
      token,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { id: string; tenant_id: string; name: string; created_at: string };
      api_key: { token: string };
    };
    expect(body.project.tenant_id).toBe(tenantId);
    expect(body.project.name).toBe('cp-created-project');
    expect(body.project.created_at).toBeTruthy();
    expect(body.api_key.token.length).toBeGreaterThan(0);

    // Show-once ở phía DB: chỉ hash của token được lưu, plaintext không nằm
    // ở bất kỳ cột nào.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{
        token_hash: string;
        scopes: string;
        trusted_ci: boolean;
      }>(
        `SELECT k.token_hash, k.scopes, k.trusted_ci FROM remote_cache.api_keys k
          JOIN remote_cache.projects p ON p.id = k.project_id
          WHERE p.name = 'cp-created-project'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toBe(await sha256Hex(body.api_key.token));
      expect(rows[0]?.scopes).toBe('read write');
      expect(rows[0]?.trusted_ci).toBe(false);
    } finally {
      await client.end();
    }

    // GET /projects của cùng credential liệt kê project vừa tạo, chưa có trang kế.
    const listRes = await listProjects(app, token);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      projects: Array<{ name: string }>;
      next_cursor: string | null;
    };
    expect(listBody.projects.map((p) => p.name)).toContain('cp-created-project');
    expect(listBody.next_cursor).toBeNull();
  });

  it('show-once token authenticates the data plane: PUT then GET round-trip on /v1/cache/:hash', async () => {
    let token = '';
    const migrator = await db.connectAsMigrator();
    try {
      ({ token } = await seedTenantProjectAndTrustedKey(migrator));
    } finally {
      await migrator.end();
    }

    const created = await postProject(
      app,
      // trusted_ci: true — data plane chỉ cho key tin cậy ghi (P4.4); gate
      // "chỉ key tin cậy tạo key tin cậy" cho phép vì credential seed là trusted.
      { name: 'cp-roundtrip-project', api_key_scopes: ['read', 'write'], trusted_ci: true },
      token,
    );
    expect(created.status).toBe(201);
    const { api_key } = (await created.json()) as { api_key: { token: string } };

    const body = 'control-plane-roundtrip-artifact';
    const hash = await sha256Hex('cp-roundtrip-hash');
    const putRes = await putCache(app, hash, api_key.token, body);
    expect(putRes.status).toBe(201);

    const getRes = await getCache(app, hash, api_key.token);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body);
  });

  it('duplicate project name returns 409 and creates no second project or key', async () => {
    let token = '';
    const migrator = await db.connectAsMigrator();
    try {
      ({ token } = await seedTenantProjectAndTrustedKey(migrator));
    } finally {
      await migrator.end();
    }

    const first = await postProject(
      app,
      { name: 'cp-dup-project', api_key_scopes: ['read'], trusted_ci: false },
      token,
    );
    expect(first.status).toBe(201);

    const before = { projects: await countRows('projects'), keys: await countRows('api_keys') };

    const dup = await postProject(
      app,
      { name: 'cp-dup-project', api_key_scopes: ['read'], trusted_ci: false },
      token,
    );
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { error?: string };
    expect(body.error).toBe('Conflict');

    // Nhánh conflict trả về trước khi chạm ghi: không project mới, không key mới.
    expect(await countRows('projects')).toBe(before.projects);
    expect(await countRows('api_keys')).toBe(before.keys);
  });

  it('untrusted key (trusted_ci=false) is refused on POST /projects with 403', async () => {
    let token = '';
    const migrator = await db.connectAsMigrator();
    try {
      ({ token } = await seedTenantProjectAndTrustedKey(migrator, { trustedCi: false }));
    } finally {
      await migrator.end();
    }

    const res = await postProject(
      app,
      { name: 'cp-untrusted-project', api_key_scopes: ['read'], trusted_ci: false },
      token,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Forbidden');
    // Fork/PR key không được ghi gì cả — dù có scope write.
    expect(await countRows('projects')).toBe(1);
  });

  it('revoked key is refused with 401 like an unknown key', async () => {
    let token = '';
    const migrator = await db.connectAsMigrator();
    try {
      ({ token } = await seedTenantProjectAndTrustedKey(migrator));
      await migrator.query(
        `UPDATE remote_cache.api_keys SET revoked_at = now() WHERE token_hash = $1`,
        [await sha256Hex(token)],
      );
    } finally {
      await migrator.end();
    }

    const res = await postProject(
      app,
      { name: 'cp-revoked-project', api_key_scopes: ['read'], trusted_ci: false },
      token,
    );
    expect(res.status).toBe(401);
    // Thông điệp không phân biệt revoked với không tồn tại — không leak tồn tại.
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe('A valid API key is required.');
    expect(await countRows('projects')).toBe(1);
  });

  it('suspended tenant is refused on POST /projects with 409 (lifecycle re-check from DB)', async () => {
    const migrator = await db.connectAsMigrator();
    const seeded = await seedTenantProjectAndTrustedKey(migrator);
    try {
      // Suspend qua credential migrator — hành vi của operator, không qua path serving.
      await migrator.query(`UPDATE remote_cache.tenants SET status = 'suspended' WHERE id = $1`, [
        seeded.tenantId,
      ]);
    } finally {
      await migrator.end();
    }

    const res = await postProject(
      app,
      { name: 'cp-suspended-project', api_key_scopes: ['read'], trusted_ci: false },
      seeded.token,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('Conflict');
    expect(body.message).toContain('Tenant lifecycle rejected');
    // Tenant suspended không nhận project mới.
    expect(await countRows('projects')).toBe(1);
  });
});
