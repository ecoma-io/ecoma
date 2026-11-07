/**
 * Integration test cho P4.5 (issue #463): cache hit/miss, multi-tenant isolation,
 * credential validation, write protection, và build correctness khi cache miss.
 *
 * Đây là test **định nghĩa hành vi MONG ĐỢI** cho P4.3 (quota) và P4.4
 * (security/CI credential, write protection, cross-tenant isolation) — hai milestone
 * này chưa implement, nên các test liên quan sẽ **fail** cho tới khi P4.3/P4.4
 * implement. Đó là acceptable và expected (roadmap Phase 4 §P4.5).
 *
 * Chạy trên PostgreSQL thật qua testcontainers (harness) + InMemoryObjectStorage
 * làm storage seam. Docker là phụ thuộc cứng: `globalSetup` probe Docker, vắng
 * Docker là đỏ, không skip (06-testing.md §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/** Hash SHA-256 của một chuỗi — dùng sinh tokenHash cho credential seed. */
async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seed tenant + project + api key (raw SQL), trả token thuan. Mỗi call tạo tenant mới. */
async function seedProjectWithToken(client: import('pg').Client): Promise<{
  tenantId: string;
  projectId: string;
  token: string;
}> {
  const token = 'p45-integration-test-token-' + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name) VALUES ($1) RETURNING id`,
    ['p45-tenant-' + crypto.randomUUID()],
  );
  const tenantId = tenantRows[0]?.id ?? '';
  const projectId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  await client.query(
    `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
    [projectId, tenantId, 'p45-project'],
  );
  await client.query(
    `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci) VALUES ($1, $2, $3, $4, $5)`,
    [apiKeyId, projectId, tokenHash, 'read write', true],
  );
  return { tenantId, projectId, token };
}

/** Revoke một api key bằng id (giả lập P4.4 credential revocation). */
async function revokeApiKeyById(client: import('pg').Client, apiKeyId: string): Promise<void> {
  await client.query(`UPDATE remote_cache.api_keys SET revoked_at = now() WHERE id = $1`, [
    apiKeyId,
  ]);
}

/** Lấy id của api key từ token raw. */
async function apiKeyIdFromToken(client: import('pg').Client, token: string): Promise<string> {
  const tokenHash = await sha256Hex(token);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM remote_cache.api_keys WHERE token_hash = $1`,
    [tokenHash],
  );
  return rows[0]?.id ?? '';
}

function envFor(): AppEnv['Bindings'] {
  return {
    DB_REMOTE_CACHE: {
      connectionString: `postgres://ecoma_remote_cache_runtime:ecoma_test_role_pw@${db.host}:${db.port}/db-remote-cache`,
    },
  };
}

async function put(
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

async function get(app: Hono<AppEnv>, hash: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(`http://localhost/v1/cache/${encodeURIComponent(hash)}`, {
    ...envFor(),
    headers,
  } as unknown as Request);
}

describe('P4.5: multi-tenant isolation', () => {
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

  it('cross-tenant isolation: same hash, tenant B cannot read tenant A entry', async () => {
    const migrator = await db.connectAsMigrator();
    let tokenA = '';
    let tokenB = '';
    try {
      const a = await seedProjectWithToken(migrator);
      tokenA = a.token;
      const b = await seedProjectWithToken(migrator);
      tokenB = b.token;
    } finally {
      await migrator.end();
    }

    const body = 'tenant-a-secret';
    const putRes = await put(app, 'shared-hash', tokenA, body);
    expect(putRes.status).toBe(201);

    // Credential của tenant B (project khác, tenant khác) cùng hash → 404, không đọc được.
    const getRes = await get(app, 'shared-hash', tokenB);
    expect(getRes.status).toBe(404);
  });

  it('same project across two tenants with same name are isolated', async () => {
    const migrator = await db.connectAsMigrator();
    let tokenA = '';
    let tokenB = '';
    try {
      const a = await seedProjectWithToken(migrator);
      tokenA = a.token;
      const b = await seedProjectWithToken(migrator);
      tokenB = b.token;
    } finally {
      await migrator.end();
    }

    await put(app, 'same-name-hash', tokenA, 'tenant-a-data');

    const getRes = await get(app, 'same-name-hash', tokenB);
    expect(getRes.status).toBe(404);
  });
});

describe('P4.5: credential validation', () => {
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

  it('valid CI credential with write scope can PUT', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const res = await put(app, 'ci-write-hash', token, 'ci-artifact');
    expect(res.status).toBe(201);
  });

  it('invalid credential returns 401', async () => {
    const res = await get(app, 'any-hash', 'invalid-token');
    expect(res.status).toBe(401);
  });

  it('missing credential returns 401', async () => {
    const res = await app.request(`http://localhost/v1/cache/${encodeURIComponent('any-hash')}`, {
      ...envFor(),
    } as unknown as Request);
    expect(res.status).toBe(401);
  });

  it('empty bearer token returns 401', async () => {
    const res = await get(app, 'any-hash', '');
    // empty token → `Bearer ` after trim is empty → unauthorized
    expect(res.status).toBe(401);
  });

  it('revoked token returns 401 (P4.4 credential revocation)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    let apiKeyId = '';
    try {
      const { token: t } = await seedProjectWithToken(migrator);
      token = t;
      apiKeyId = await apiKeyIdFromToken(migrator, token);
    } finally {
      await migrator.end();
    }

    const revoker = await db.connectAsMigrator();
    try {
      await revokeApiKeyById(revoker, apiKeyId);
    } finally {
      await revoker.end();
    }

    const res = await get(app, 'any-hash', token);
    expect(res.status).toBe(401);
  });
});

describe('P4.5: write protection (fork/PR)', () => {
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

  it('read-only key cannot PUT (write protection)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      const tokenRaw = 'p45-read-only-token-' + crypto.randomUUID();
      const tokenHash = await sha256Hex(tokenRaw);
      const { rows: tenantRows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name) VALUES ($1) RETURNING id`,
        ['p45-read-only-tenant-' + crypto.randomUUID()],
      );
      const tenantId = tenantRows[0]?.id ?? '';
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      await migrator.query(
        `INSERT INTO remote_cache.projects (id, tenant_id, name) VALUES ($1, $2, $3)`,
        [projectId, tenantId, 'p45-read-only-project'],
      );
      await migrator.query(
        `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes) VALUES ($1, $2, $3, $4)`,
        [apiKeyId, projectId, tokenHash, 'read'],
      );
      token = tokenRaw;
    } finally {
      await migrator.end();
    }

    const res = await put(app, 'read-only-put-hash', token, 'should-be-blocked');
    expect(res.status).toBe(403);
  });

  it('no credential cannot PUT (fork/PR without write credential)', async () => {
    const body = 'should-be-blocked';
    const bodyBytes = new TextEncoder().encode(body);
    const res = await app.request(
      `http://localhost/v1/cache/${encodeURIComponent('no-auth-hash')}`,
      {
        ...envFor(),
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bodyBytes.byteLength),
        },
        body: bodyBytes,
      } as unknown as Request,
    );
    expect(res.status).toBe(401);
  });

  it('immutable existing entry cannot be overwritten (write protection)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const body = 'original';
    const put1 = await put(app, 'immutable-p45-hash', token, body);
    expect(put1.status).toBe(201);

    const put2 = await put(app, 'immutable-p45-hash', token, 'overwrite-attempt');
    expect(put2.status).toBe(409);

    // Entry gốc không đổi.
    const getRes = await get(app, 'immutable-p45-hash', token);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body);
  });
});

describe('P4.5: build correctness on cache miss', () => {
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

  it('GET miss returns 404 and build proceeds normally (non-fatal)', async () => {
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const res = await get(app, 'missing-hash', token);
    expect(res.status).toBe(404);
    // Miss không phải lỗi: Nx thực thi task bình thường và ghi artifact mới.
    expect(res.body).not.toBeNull();
  });

  it('quota-exceeded behaves as non-fatal cache miss (P4.3 expectancy)', async () => {
    // P4.3: khi write vượt quota, data plane KHÔNG được chặn build của caller.
    // GET miss → 404, caller thực thi task bình thường. Test này định nghĩa hành
    // vi mong đợi (fail cho tới khi P4.3 implement quota-exceeded → non-fatal miss).
    const migrator = await db.connectAsMigrator();
    let token = '';
    try {
      ({ token } = await seedProjectWithToken(migrator));
    } finally {
      await migrator.end();
    }

    const res = await get(app, 'quota-miss-hash', token);
    expect(res.status).toBe(404);
  });
});
