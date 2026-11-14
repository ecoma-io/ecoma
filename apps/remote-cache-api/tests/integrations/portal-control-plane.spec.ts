/**
 * Integration test cho portal control plane (issue #202 — Internal Developer
 * Portal, quyet dinh pham vi #177): authorization human principal (envelope
 * HMAC noi bo mang actor sub da verify + membership resolve tu DB), vong doi
 * project/API-key (show-once, metadata khong lo secret, revoke hieu luc ngay
 * tai data plane), audit cho moi mutation (R15), va R20 — developer credential
 * khong ghi duoc cache, trusted CI write semantics khong doi.
 *
 * Cung thu tu mount voi src/main.ts: machine control plane truoc, portal
 * sau, data plane cuoi — chung minh cac token show-once cua portal
 * authenticate duoc data plane that (khong phai duong seed rieng cua test).
 *
 * Envelope trong test duoc ky THAT bang `signRequest` cua
 * `@ecoma-io/internal-auth-contracts` — cung primitive voi portal BFF.
 *
 * ⚠️ Docker la phu thuoc cung: `globalSetup` probe Docker, vang Docker la do,
 * khong skip (06-testing.md §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { signRequest, type InternalAuthHeaders } from '@ecoma-io/internal-auth-contracts';

import { InMemoryObjectStorage } from '../../src/storage';
import { remoteCacheDataRoutes } from '../../src/cache-routes';
import { remoteCacheRoutes } from '../../src/routes';
import { portalRoutes } from '../../src/portal-routes';
import { loadRemoteCacheConfig } from '../../src/config';
import type { AppEnv } from '../../src/types';
import { type RemoteCacheDatabase, startRemoteCacheDatabase } from './harness.ts';

const INTERNAL_SECRET = 'portal-integration-secret';

/** Audit row de assert — time chi dung de ORDER BY, khong assert gia tri. */
interface AuditRow {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly details: string | null;
  readonly project_id: string | null;
}

let db: RemoteCacheDatabase;
let storage: InMemoryObjectStorage;

function runtimeConnectionString(): string {
  return `postgres://ecoma_remote_cache_runtime:ecoma_test_role_pw@${db.host}:${db.port}/db-remote-cache`;
}

function buildApp(options: { withSecret?: boolean } = {}): Hono<AppEnv> {
  storage = new InMemoryObjectStorage();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set(
      'config',
      loadRemoteCacheConfig({
        DB_REMOTE_CACHE: { connectionString: runtimeConnectionString() },
        ...(options.withSecret === false ? {} : { INTERNAL_AUTH_SECRET: INTERNAL_SECRET }),
      }),
    );
    c.set('requestId', 'test-request-id');
    await next();
  });
  // Cung thu tu mount voi src/main.ts: machine control plane, portal, data plane.
  app.route('/', remoteCacheRoutes());
  app.route('/', portalRoutes());
  app.route('/', remoteCacheDataRoutes(storage));
  return app;
}

/** Hash SHA-256 cua mot chuoi — duong auth luu/tra token_hash theo dang nay. */
async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function envFor(): AppEnv['Bindings'] {
  return {
    DB_REMOTE_CACHE: { connectionString: runtimeConnectionString() },
  };
}

/**
 * Gui mot request portal voi envelope HMAC THAT: ky dung byte body, path
 * chinh xac pathname cua URL. `actorSub` bo trong = envelope khong mang
 * human principal; `overrideSecret` = ky bang secret khac (chu ky sai).
 */
async function portalRequest(
  app: Hono<AppEnv>,
  options: {
    method: string;
    path: string;
    body?: string;
    actorSub?: string;
    overrideSecret?: string;
  },
): Promise<Response> {
  const bodyBytes = options.body === undefined ? null : new TextEncoder().encode(options.body);
  const now = String(Math.floor(Date.now() / 1000));
  const headers = await signRequest({
    method: options.method,
    path: options.path,
    body: bodyBytes,
    actorSub: options.actorSub,
    secret: options.overrideSecret ?? INTERNAL_SECRET,
    timestamp: now,
  });
  return app.request(`http://localhost${options.path}`, {
    ...envFor(),
    method: options.method,
    headers,
    ...(bodyBytes === null ? {} : { body: bodyBytes }),
  } as unknown as Request);
}

/** Gui lai DUNG mot bo header da ky — dung cho test replay nonce. */
async function sendWithHeaders(
  app: Hono<AppEnv>,
  options: { method: string; path: string; body?: string; headers: InternalAuthHeaders },
): Promise<Response> {
  const bodyBytes = options.body === undefined ? null : new TextEncoder().encode(options.body);
  return app.request(`http://localhost${options.path}`, {
    ...envFor(),
    method: options.method,
    headers: options.headers,
    ...(bodyBytes === null ? {} : { body: bodyBytes }),
  } as unknown as Request);
}

/** Tach DUNG mot bo header da ky de dung cho hai request (replay). */
async function signedHeadersFor(options: {
  method: string;
  path: string;
  body?: string;
  actorSub: string;
}): Promise<InternalAuthHeaders> {
  const bodyBytes = options.body === undefined ? null : new TextEncoder().encode(options.body);
  return signRequest({
    method: options.method,
    path: options.path,
    body: bodyBytes,
    actorSub: options.actorSub,
    secret: INTERNAL_SECRET,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
}

/** Seed tenant customer/paid + membership `member` cho mot sub — duong bootstrap provisioning. */
async function seedTenantWithMember(
  client: import('pg').Client,
  options: {
    tenantName?: string;
    memberSub?: string;
    status?: 'active' | 'suspended';
  } = {},
): Promise<{ tenantId: string; tenantName: string; memberSub: string }> {
  const tenantName = options.tenantName ?? 'tenant-' + crypto.randomUUID();
  const memberSub = options.memberSub ?? 'portal-member-' + crypto.randomUUID();
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub, status)
     VALUES ($1, 'customer', 'paid', $2, $3) RETURNING id`,
    [tenantName, 'owner-' + tenantName, options.status ?? 'active'],
  );
  const tenantId = tenantRows[0]?.id ?? '';
  await client.query(
    `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub, role) VALUES ($1, $2, 'member')`,
    [tenantId, memberSub],
  );
  return { tenantId, tenantName, memberSub };
}

/**
 * Seed project + key machine trong tenant — dung credential migrator. Tra
 * token tho de test dung nhu credential caller (pattern spec control plane).
 */
async function seedProjectWithKey(
  client: import('pg').Client,
  tenantId: string,
  options: { projectName?: string; trustedCi?: boolean; scopes?: string } = {},
): Promise<{ projectId: string; keyId: string; token: string }> {
  const token = 'seed-token-' + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const projectName = options.projectName ?? 'seeded-project';
  const { rows: projectRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, projectName],
  );
  const projectId = projectRows[0]?.id ?? '';
  const { rows: keyRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes, trusted_ci)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, tokenHash, options.scopes ?? 'read write', options.trustedCi ?? true],
  );
  return { projectId, keyId: keyRows[0]?.id ?? '', token };
}

/** Dem hang theo bang — chung minh nhanh tu choi khong de lai trang thai moi. */
async function countRows(
  table: 'projects' | 'api_keys' | 'audit_log' | 'tenant_members',
): Promise<number> {
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

/** Doc toan bo audit_log — assert actor/action/target/outcome cua mutation. */
async function readAuditLog(): Promise<readonly AuditRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<AuditRow>(
      `SELECT actor, action, target, outcome, details, project_id
         FROM remote_cache.audit_log
        ORDER BY time, id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

/**
 * Cho toi khi backend cua app THAT SU dung lai tren unique index cua
 * `remote_cache.projects` (`wait_event_type = 'Lock'`) — bien mot cuoc dua
 * timing thanh mot diem hen xac dinh: chi commit sau khi request da nam trong
 * `INSERT`, nen nhanh 23505 chac chan duoc chay.
 *
 * Khong co backend dung lai sau ~5s thi nem: im lang bo qua se bien test
 * thanh mot lan assert 409 vo nghia (co the di qua nhanh pre-check).
 */
async function waitForBlockedProjectInsert(client: import('pg').Client): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await client.query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO remote_cache.projects%'`,
    );
    if (Number(rows[0]?.blocked ?? '0') > 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  // Doi tuong cua buoc cho la "request khong the xong", khong phai mot con so
  // thoi gian: khong thay backend nao bi khoa thi dung la co gi do sai — nem
  // kem anh chup de doc duoc, thay vi im lang cho tiep.
  const snapshot = await client.query<{ pid: number; state: string | null; q: string | null }>(
    `SELECT pid, state, left(query, 70) AS q FROM pg_stat_activity ORDER BY pid`,
  );
  throw new Error(
    `the portal project insert never blocked on the projects unique index: ${JSON.stringify(
      snapshot.rows,
    )}`,
  );
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

async function machinePostProject(
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

describe('portal control plane (integration)', () => {
  let app: Hono<AppEnv>;
  let appWithoutSecret: Hono<AppEnv>;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
    app = buildApp();
    appWithoutSecret = buildApp({ withSecret: false });
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncateData();
  });

  it('a member creates the first project and key with no machine key beforehand (R18)', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
    } finally {
      await migrator.end();
    }

    const res = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects`,
      body: JSON.stringify({ name: 'first-project' }),
      actorSub: seed.memberSub,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { id: string; tenant_id: string; name: string; created_at: string };
      api_key: { id: string; scopes: string[]; credential_class: string; token: string };
    };
    expect(body.project.name).toBe('first-project');
    expect(body.project.tenant_id).toBe(seed.tenantId);
    // R20: portal-cap developer credential — read-only, khong bao gio trusted.
    expect(body.api_key.scopes).toEqual(['read']);
    expect(body.api_key.credential_class).toBe('developer');
    expect(body.api_key.token).toBeTruthy();

    // Hash-only: DB giu dung SHA-256 cua token show-once, trusted_ci = false.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{
        token_hash: string;
        trusted_ci: boolean;
        scopes: string;
      }>('SELECT token_hash, trusted_ci, scopes FROM remote_cache.api_keys WHERE id = $1', [
        body.api_key.id,
      ]);
      expect(rows[0]?.token_hash).toBe(await sha256Hex(body.api_key.token));
      expect(rows[0]?.trusted_ci).toBe(false);
      expect(rows[0]?.scopes).toBe('read');
    } finally {
      await client.end();
    }
    // R15: audit entry ghi nhan nguoi dung khoi tao mutation; details mang ten
    // project — danh tinh con nguoi khong nam trong target (chi co UUID).
    const audit = await readAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe(`user:${seed.memberSub}`);
    expect(audit[0]?.action).toBe('project_created');
    expect(audit[0]?.outcome).toBe('allowed');
    expect(audit[0]?.project_id).toBe(body.project.id);
    expect(audit[0]?.target).toBe(`tenant:${seed.tenantName}/project:${body.project.id}`);
    expect(audit[0]?.details).toBe('project name: first-project');
  });

  it('a concurrent creator that wins the UNIQUE race yields 409 with a denied audit entry, not 500', async () => {
    // Pre-check cua route chi thay du lieu DA COMMIT, con UNIQUE thi thay ca
    // hang chua commit — dung khoang trong do de dung lai cuoc dua that: mot
    // transaction khac giu hang trung ten nhung chua commit, request portal
    // di qua pre-check (khong thay gi) roi dung lai o INSERT.
    const holder = await db.connect();
    const seed = await seedTenantWithMember(holder);
    let pending: Promise<Response> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query(`INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, $2)`, [
        seed.tenantId,
        'raced-project',
      ]);
      pending = portalRequest(app, {
        method: 'POST',
        path: `/tenants/${seed.tenantName}/projects`,
        body: JSON.stringify({ name: 'raced-project' }),
        actorSub: seed.memberSub,
      });
      // Giu promise duoc handled ke ca khi buoc cho khoa that bai, de mot loi
      // o day khong bi che thanh unhandled rejection.
      void pending.catch(() => undefined);
      // Cho request di qua pre-check va cham vao INSERT. No KHONG THE commit
      // duoc vi hang cua holder dang giu unique index, nen day khong phai
      // "doan thoi gian cho xong" — chi de no kip bat dau.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
      // Commit chi sau khi request that su bi khoa: luc do no nhan 23505 tu
      // `projects_tenant_name_unique` thay vi mot loi 500 khong ten.
      await waitForBlockedProjectInsert(holder);
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await holder.end();
    }
    if (pending === null) throw new Error('the portal request was never sent');

    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Conflict',
      message: 'A project with this name already exists in the tenant.',
    });
    // Transaction cua request da rollback: khong co project nua vo, va chi con
    // hang cua nguoi thang cuoc dua.
    expect(await countRows('projects')).toBe(1);
    // Audit `denied` — cung shape voi nhanh pre-check, khong phai khong co audit.
    const denied = await readAuditLog();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actor: `user:${seed.memberSub}`,
      action: 'project_created',
      target: `tenant:${seed.tenantName}/project:raced-project`,
      outcome: 'denied',
    });
  }, 30_000);

  it('the show-once token never appears in any later portal response', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
    } finally {
      await migrator.end();
    }
    const created = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects`,
      body: JSON.stringify({ name: 'show-once-project' }),
      actorSub: seed.memberSub,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      api_key: { id: string; token: string };
    };
    const token = createdBody.api_key.token;

    const listRes = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
      actorSub: seed.memberSub,
    });
    const detailRes = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects/show-once-project`,
      actorSub: seed.memberSub,
    });
    const keysRes = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects/show-once-project/api-keys`,
      actorSub: seed.memberSub,
    });
    expect(listRes.status).toBe(200);
    expect(detailRes.status).toBe(200);
    expect(keysRes.status).toBe(200);
    const allBodies = JSON.stringify([
      await listRes.json(),
      await detailRes.json(),
      await keysRes.json(),
    ]);
    expect(allBodies.includes(token)).toBe(false);
    expect(allBodies.toLowerCase()).not.toContain('token_hash');
  });

  it('replaying the exact same envelope is rejected with 401 while the first call succeeds', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
    } finally {
      await migrator.end();
    }
    const headers = await signedHeadersFor({
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
      actorSub: seed.memberSub,
    });
    const first = await sendWithHeaders(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
      headers,
    });
    expect(first.status).toBe(200);
    const replay = await sendWithHeaders(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
      headers,
    });
    expect(replay.status).toBe(401);
  });

  it('an envelope with a wrong signature is rejected with 401 before any state change', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
    } finally {
      await migrator.end();
    }
    const res = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects`,
      body: JSON.stringify({ name: 'evil-project' }),
      actorSub: seed.memberSub,
      overrideSecret: 'wrong-secret-entirely',
    });
    expect(res.status).toBe(401);
    expect(await countRows('projects')).toBe(0);
    expect(await countRows('audit_log')).toBe(0);
  });

  it('an envelope without an actor sub is rejected with 401 — the portal surface serves human principals only', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
    } finally {
      await migrator.end();
    }
    const res = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
    });
    expect(res.status).toBe(401);
  });

  it('a non-member is rejected on every portal operation with no state change (R17)', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    let project: { projectId: string; keyId: string };
    try {
      seed = await seedTenantWithMember(migrator);
      project = await seedProjectWithKey(migrator, seed.tenantId, { projectName: 'existing' });
    } finally {
      await migrator.end();
    }
    const outsider = 'outsider-sub-' + crypto.randomUUID();

    const listRes = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
      actorSub: outsider,
    });
    expect(listRes.status).toBe(403);

    const createRes = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects`,
      body: JSON.stringify({ name: 'nope-project' }),
      actorSub: outsider,
    });
    expect(createRes.status).toBe(403);

    const createKeyRes = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects/existing/api-keys`,
      body: '',
      actorSub: outsider,
    });
    expect(createKeyRes.status).toBe(403);

    const revokeRes = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects/existing/api-keys/${project.keyId}/revoke`,
      actorSub: outsider,
    });
    expect(revokeRes.status).toBe(403);

    // Khong co trang thai nao moi: project/key giu nguyen, khong co audit row.
    expect(await countRows('projects')).toBe(1);
    expect(await countRows('api_keys')).toBe(1);
    expect(await countRows('audit_log')).toBe(0);
  });

  it('a member of tenant A cannot touch tenant B — isolation holds on every path (R17)', async () => {
    const migrator = await db.connectAsMigrator();
    let tenantA: { tenantId: string; tenantName: string; memberSub: string };
    let tenantB: { tenantId: string; tenantName: string; memberSub: string };
    let bProject: { projectId: string; keyId: string };
    try {
      tenantA = await seedTenantWithMember(migrator, { tenantName: 'tenant-a' });
      tenantB = await seedTenantWithMember(migrator, { tenantName: 'tenant-b' });
      bProject = await seedProjectWithKey(migrator, tenantB.tenantId, { projectName: 'b-project' });
    } finally {
      await migrator.end();
    }
    const memberA = tenantA.memberSub;

    const listRes = await portalRequest(app, {
      method: 'GET',
      path: '/tenants/tenant-b/projects',
      actorSub: memberA,
    });
    expect(listRes.status).toBe(403);

    const createRes = await portalRequest(app, {
      method: 'POST',
      path: '/tenants/tenant-b/projects',
      body: JSON.stringify({ name: 'intruder-project' }),
      actorSub: memberA,
    });
    expect(createRes.status).toBe(403);

    const revokeRes = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/tenant-b/projects/b-project/api-keys/${bProject.keyId}/revoke`,
      actorSub: memberA,
    });
    expect(revokeRes.status).toBe(403);

    // Dia chi tenant A nhung keyId cua tenant B: key khong thuoc project nao
    // cua tenant A trong boi canh tra loi — 404, khong phan biet cho caller.
    const crossRevoke = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/tenant-a/projects/absent/api-keys/${bProject.keyId}/revoke`,
      actorSub: memberA,
    });
    expect(crossRevoke.status).toBe(404);

    // Unknown tenant: 404 cho member hop le — tenant dia chi theo NAME.
    const unknownTenant = await portalRequest(app, {
      method: 'GET',
      path: '/tenants/no-such-tenant/projects',
      actorSub: memberA,
    });
    expect(unknownTenant.status).toBe(404);

    expect(await countRows('audit_log')).toBe(0);
  });

  it('a suspended tenant rejects portal mutations with 409 and a denied audit entry', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator, { status: 'suspended' });
    } finally {
      await migrator.end();
    }
    const res = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects`,
      body: JSON.stringify({ name: 'suspended-project' }),
      actorSub: seed.memberSub,
    });
    expect(res.status).toBe(409);
    const audit = await readAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('project_created');
    expect(audit[0]?.outcome).toBe('denied');
    expect(audit[0]?.actor).toBe(`user:${seed.memberSub}`);
  });

  it('an additional key shows its secret exactly once and metadata lists every key without secrets (R19)', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
      // Project co san mot key machine (trusted CI) de list thay hai phan lop.
      await seedProjectWithKey(migrator, seed.tenantId, { projectName: 'keys-project' });
    } finally {
      await migrator.end();
    }

    const created = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects/keys-project/api-keys`,
      body: '',
      actorSub: seed.memberSub,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      api_key: { id: string; scopes: string[]; credential_class: string; token: string };
    };
    expect(createdBody.api_key.scopes).toEqual(['read']);
    expect(createdBody.api_key.credential_class).toBe('developer');

    const listRes = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects/keys-project/api-keys`,
      actorSub: seed.memberSub,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      project: { name: string };
      api_keys: readonly {
        id: string;
        scopes: string[];
        credential_class: string;
        revoked_at: string | null;
        created_at: string;
      }[];
    };
    expect(listBody.project.name).toBe('keys-project');
    expect(listBody.api_keys).toHaveLength(2);
    const classes = listBody.api_keys.map((key) => key.credential_class).toSorted();
    expect(classes).toEqual(['developer', 'trusted_ci']);
    const serialized = JSON.stringify(listBody);
    expect(serialized.includes(createdBody.api_key.token)).toBe(false);
    expect(serialized.toLowerCase()).not.toContain('token');
    expect(serialized.toLowerCase()).not.toContain('hash');

    // Trusted CI key seed giu nguyen write scope — portal khong dong cham.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ scopes: string; trusted_ci: boolean }>(
        'SELECT scopes, trusted_ci FROM remote_cache.api_keys WHERE trusted_ci = true',
      );
      expect(rows[0]?.scopes).toBe('read write');
      expect(rows[0]?.trusted_ci).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('project detail returns the project to a member (R19)', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
      await seedProjectWithKey(migrator, seed.tenantId, { projectName: 'detail-project' });
    } finally {
      await migrator.end();
    }
    const res = await portalRequest(app, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects/detail-project`,
      actorSub: seed.memberSub,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { id: string; tenant_id: string; name: string; created_at: string };
    };
    expect(body.project.name).toBe('detail-project');
    expect(body.project.tenant_id).toBe(seed.tenantId);
    expect(Number.isNaN(Date.parse(body.project.created_at))).toBe(false);
  });

  it('revoking a key takes effect at the data plane on the first request; revoking again conflicts with a denied audit entry (R19)', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    let seeded: { projectId: string; keyId: string; token: string };
    try {
      seed = await seedTenantWithMember(migrator);
      seeded = await seedProjectWithKey(migrator, seed.tenantId, {
        projectName: 'revoke-project',
        trustedCi: false,
        scopes: 'read',
      });
    } finally {
      await migrator.end();
    }
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // Truoc revoke: token con hieu luc — auth OK, cache miss tra 404.
    const before = await getCache(app, hash, seeded.token);
    expect(before.status).toBe(404);

    const revokeRes = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects/revoke-project/api-keys/${seeded.keyId}/revoke`,
      actorSub: seed.memberSub,
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { api_key: { id: string; revoked_at: string } };
    expect(revokeBody.api_key.id).toBe(seeded.keyId);
    expect(Number.isNaN(Date.parse(revokeBody.api_key.revoked_at))).toBe(false);

    // Request dau tien sau revoke o data plane phai bi tu choi (R19/A31).
    const after = await getCache(app, hash, seeded.token);
    expect(after.status).toBe(401);

    // Revoke lan hai: conflict 409 + audit denied.
    const secondRevoke = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects/revoke-project/api-keys/${seeded.keyId}/revoke`,
      actorSub: seed.memberSub,
    });
    expect(secondRevoke.status).toBe(409);

    const audit = await readAuditLog();
    expect(audit.map((row) => row.action)).toEqual(['api_key_revoked', 'api_key_revoked']);
    expect(audit.map((row) => row.outcome)).toEqual(['allowed', 'denied']);
    expect(audit.every((row) => row.actor === `user:${seed.memberSub}`)).toBe(true);
    expect(audit[0]?.project_id).toBe(seeded.projectId);
  });

  it('a developer credential cannot write cache while a trusted key still can — trusted semantics unchanged (R20)', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    let trusted: { projectId: string; keyId: string; token: string };
    try {
      seed = await seedTenantWithMember(migrator);
      trusted = await seedProjectWithKey(migrator, seed.tenantId, { projectName: 'r20-project' });
    } finally {
      await migrator.end();
    }

    // Portal tao developer credential cho cung project.
    const created = await portalRequest(app, {
      method: 'POST',
      path: `/tenants/${seed.tenantName}/projects/r20-project/api-keys`,
      body: '',
      actorSub: seed.memberSub,
    });
    expect(created.status).toBe(201);
    const developerToken = ((await created.json()) as { api_key: { token: string } }).api_key.token;

    const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const developerPut = await putCache(app, hash, developerToken, 'developer-bytes');
    expect(developerPut.status).toBe(403);

    // Trusted CI write semantics giu nguyen: key trusted scope write van ghi duoc.
    const trustedPut = await putCache(app, hash, trusted.token, 'trusted-bytes');
    expect(trustedPut.status).toBe(201);
    const trustedGet = await getCache(app, hash, trusted.token);
    expect(trustedGet.status).toBe(200);

    // Machine control plane giu nguyen: trusted key van tao duoc project + key.
    const machineRes = await machinePostProject(
      app,
      {
        name: 'machine-created',
        api_key_scopes: ['read', 'write'],
        trusted_ci: false,
      },
      trusted.token,
    );
    expect(machineRes.status).toBe(201);
  });

  it('portal routes fail closed with 503 when the internal secret is not provisioned', async () => {
    const migrator = await db.connectAsMigrator();
    let seed: { tenantId: string; tenantName: string; memberSub: string };
    try {
      seed = await seedTenantWithMember(migrator);
    } finally {
      await migrator.end();
    }
    const res = await portalRequest(appWithoutSecret, {
      method: 'GET',
      path: `/tenants/${seed.tenantName}/projects`,
      actorSub: seed.memberSub,
    });
    expect(res.status).toBe(503);
    expect(await countRows('audit_log')).toBe(0);
  });
});
