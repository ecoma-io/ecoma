/**
 * Integration test cho data plane `PUT/GET /v1/cache/:hash` (P4.2, issue #454).
 *
 * Chạy trên PostgreSQL thật qua testcontainers (harness) + InMemoryObjectStorage
 * làm storage seam — không cần S3 thật. DB là nguồn sự thật cho metadata;
 * storage là in-memory cho data round-trip.
 *
 * ⚠️ Docker là phụ thuộc cứng: `globalSetup` probe Docker, vắng Docker là đỏ,
 * không skip (06-testing.md §6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { InMemoryObjectStorage } from '../../src/storage';
import { remoteCacheDataRoutes } from '../../src/cache-routes';
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
  app.route('/', remoteCacheDataRoutes(storage));
  return app;
}

/** Hash SHA-256 cua mot chuoi — de sinh tokenHash + token client gui trung nhau. */
async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seed tenant + project + api key (raw SQL, credential migrator), tra token thuan. */
async function seedProjectWithToken(client: import('pg').Client): Promise<{
  tenantId: string;
  projectId: string;
  token: string;
}> {
  const token = 'p42-integration-test-token-' + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name, status) VALUES ($1, 'active') RETURNING id`,
    ['integration-tenant-' + crypto.randomUUID()],
  );
  const tenantId = tenantRows[0]?.id ?? '';
  const projectId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  await client.query(
    `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
    [projectId, tenantId, 'integration-project'],
  );
  await client.query(
    `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
    [apiKeyId, projectId, tokenHash, 'read write', true],
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

describe('data plane cache PUT/GET', () => {
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
    app = buildApp();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  // ⚠️ Test isolation: các case dùng hash hardcoded ('abc123', 'immutable-hash',
  // 'isolated-hash', 'any-hash'). Neu thao tu test thay hoac chay lai, hash da
  // ton tai tu case truoc se nhan 409 thay 201 -> flaky. Truncate DB truoc moi
  // case de tranh data lech giua cac test. (Storage in-memory cung moi instance
  // cho buildApp(), nhung DB la cung database — truncate la bat buoc.)
  beforeEach(async () => {
    // ⚠️ Test isolation: các case dùng hash hardcoded ('abc123', 'immutable-hash',
    // 'isolated-hash', 'any-hash'). Nếu thứ tự test thay đổi hoặc chạy lại, hash đã
    // tồn tại từ test trước sẽ nhận 409 thay 201 -> flaky. truncateData() xóa
    // sạch data tables giữa các case (không đụng DDL/grant/trigger).
    await db.truncateData();
  });

  it('PUT then GET round-trip returns the same body and metadata', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const body = 'integration-test-artifact-body';
    const bodyBytes = new TextEncoder().encode(body);
    const put = await app.request(`http://localhost/v1/cache/${encodeURIComponent('abc123')}`, {
      ...envFor(),
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(bodyBytes.byteLength),
      },
      body: bodyBytes,
    } as unknown as Request);
    expect(put.status).toBe(201);
    const putJson = (await put.json()) as { hash: string; size: number };
    expect(putJson.hash).toBe('abc123');
    expect(putJson.size).toBe(bodyBytes.byteLength);

    const get = await app.request(`http://localhost/v1/cache/${encodeURIComponent('abc123')}`, {
      ...envFor(),
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    const getBody = await get.text();
    expect(getBody).toBe(body);
  });

  it('GET miss returns 404', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const res = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('does-not-exist')}`,
      { ...envFor(), headers: { authorization: `Bearer ${token}` } } as unknown as Request,
    );
    expect(res.status).toBe(404);
  });

  it('re-PUT same hash returns 409 (immutability)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const body = 'immutable-body';
    const bodyBytes = new TextEncoder().encode(body);
    const put1 = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('immutable-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(put1.status).toBe(201);

    const put2 = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('immutable-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(put2.status).toBe(409);
  });

  it('cross-project isolation: project B cannot read project A entry', async () => {
    const migrator = await db.connectAsMigrator();
    let tokenA = '';
    let tokenB = '';
    try {
      const { token: ta } = await seedProjectWithToken(migrator);
      tokenA = ta;
      const { token: tb } = await seedProjectWithToken(migrator);
      tokenB = tb;
    } finally {
      await migrator.end();
    }

    const body = 'project-a-secret';
    const bodyBytes = new TextEncoder().encode(body);
    const put = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('isolated-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(put.status).toBe(201);

    const get = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('isolated-hash')}`,
      { ...envFor(), headers: { authorization: `Bearer ${tokenB}` } } as unknown as Request,
    );
    expect(get.status).toBe(404);
  });

  it('read scope required: write-only key cannot GET', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'write-only-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name) VALUES ($1) RETURNING id`,
        ['write-only-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'write-only-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes) VALUES ($1, $2, $3, $4)`,
        [apiKeyId, projectId, tokenHash, 'write'],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const res = await app.request(`http://localhost/v1/cache/${encodeURIComponent('any-hash')}`, {
      ...envFor(),
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request);
    expect(res.status).toBe(403);
  });

  it('missing/invalid auth returns 401', async () => {
    const noAuth = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('any-hash')}`,
      envFor() as unknown as Request,
    );
    expect(noAuth.status).toBe(401);

    const bad = await app.request(`http://localhost/v1/cache/${encodeURIComponent('any-hash')}`, {
      ...envFor(),
      headers: { authorization: 'Bearer ' },
    } as unknown as Request);
    expect(bad.status).toBe(401);
  });

  // ---- P4.4: CI credential write protection ----

  it('untrusted CI key cannot PUT (fork/PR write protection)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'untrusted-ci-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name) VALUES ($1) RETURNING id`,
        ['untrusted-ci-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'untrusted-ci-project'],
      );
      // trusted_ci defaults to false — key not trusted for write.
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes) VALUES ($1, $2, $3, $4)`,
        [apiKeyId, projectId, tokenHash, 'read write'],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const bodyBytes = new TextEncoder().encode('ci-artifact');
    const put = await app.request(`http://localhost/v1/cache/${encodeURIComponent('ci-hash')}`, {
      ...envFor(),
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(bodyBytes.byteLength),
      },
      body: bodyBytes,
    } as unknown as Request);
    expect(put.status).toBe(403);
  });

  it('trusted CI key with write scope can PUT', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'trusted-ci-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name) VALUES ($1) RETURNING id`,
        ['trusted-ci-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'trusted-ci-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
        [apiKeyId, projectId, tokenHash, 'read write', true],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const bodyBytes = new TextEncoder().encode('ci-artifact');
    const put = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('ci-trusted-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(put.status).toBe(201);
  });

  // ---- P4.4: fail-closed when lifecycle state stale/unknown ----

  it('suspended tenant cannot GET (fail-closed)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'suspended-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, status) VALUES ($1, 'suspended') RETURNING id`,
        ['suspended-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'suspended-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
        [apiKeyId, projectId, tokenHash, 'read', true],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const res = await app.request(`http://localhost/v1/cache/${encodeURIComponent('any-hash')}`, {
      ...envFor(),
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request);
    expect(res.status).toBe(409);
  });

  it('deleted tenant cannot GET (fail-closed)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'deleted-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, status) VALUES ($1, 'deleted') RETURNING id`,
        ['deleted-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'deleted-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
        [apiKeyId, projectId, tokenHash, 'read', true],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const res = await app.request(`http://localhost/v1/cache/${encodeURIComponent('any-hash')}`, {
      ...envFor(),
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request);
    expect(res.status).toBe(409);
  });

  // ---- P4.4: write-path fail-closed on tenant lifecycle ----

  it('suspended tenant cannot PUT (fail-closed)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'suspended-put-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, status) VALUES ($1, 'suspended') RETURNING id`,
        ['suspended-put-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'suspended-put-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
        [apiKeyId, projectId, tokenHash, 'read write', true],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const bodyBytes = new TextEncoder().encode('fail-closed-put');
    const put = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('suspended-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(put.status).toBe(409);
  });

  it('deleted tenant cannot PUT (fail-closed)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'deleted-put-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, status) VALUES ($1, 'deleted') RETURNING id`,
        ['deleted-put-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'deleted-put-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
        [apiKeyId, projectId, tokenHash, 'read write', true],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const bodyBytes = new TextEncoder().encode('fail-closed-put');
    const put = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('deleted-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(put.status).toBe(409);
  });
});
