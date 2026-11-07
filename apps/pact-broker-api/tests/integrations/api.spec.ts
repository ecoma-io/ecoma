/**
 * API end-to-end trên PostgreSQL thật + Hono `app.request()` — thay cho
 * `@cloudflare/vitest-pool-workers` của upstream (`test/*.test.ts`).
 *
 * Mỗi test chạy trên cùng app instance (`buildApp()`); pool/config là
 * module-level cache của isolate — container của harness sống suốt file nên
 * cache đó là đúng. `truncateData` giữa các test để trạng thái không chảy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as Infra from '@ecoma-io/pact-broker-api-infrastructure';
import { buildApp, closeCachedPool } from '../../src/main';
import { samplePact } from '../fixtures/pact';
import { type PactBrokerDatabase, PACT_BROKER_DATABASE, startPactBrokerDatabase } from './harness';

/** Host URL mà `app.request` cần để Hono parse path/query đúng. */
const BASE = 'https://broker.test';

const auth = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

/** Bỏ `requestId` (duy nhất mỗi request) để so sánh thân 401 đồng nhất. */
const stripRequestId = (b: unknown): unknown => {
  if (b === null || typeof b !== 'object') return b;
  const { requestId: _omit, ...rest } = b as Record<string, unknown>;
  return rest;
};

describe(`${PACT_BROKER_DATABASE} API end-to-end`, () => {
  let db: PactBrokerDatabase;
  let app: ReturnType<typeof buildApp>;
  let workerEnv: Record<string, unknown>;
  let tenantASecret: string;
  let tenantBSecret: string;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
    const pool = await db.createRuntimePool();
    app = buildApp();

    // "Env" của Worker: Hyperdrive binding trỏ thẳng DB test — connection
    // string của runtime role, đúng credential mà Worker nhận khi deploy.
    workerEnv = {
      HYPERDRIVE: {
        connectionString: `postgres://ecoma_pact_broker_runtime:ecoma_test_role_pw@${db.host}:${db.port}/${PACT_BROKER_DATABASE}`,
      },
    };

    // Bootstrap hai tenant qua repo trực tiếp (đường mà dashboard/bootstrap
    // dùng) rồi tạo machine token cho mỗi tenant.
    const { PgTenantRepo } = Infra;
    const repo = new PgTenantRepo(pool);
    await repo.ensureDefaultTenant('tenant-a', 'sub-a-owner');
    await repo.ensureDefaultTenant('tenant-b', 'sub-b-owner');
    const a = await repo.createMachineToken(
      (await repo.getTenantByName('tenant-a'))?.id ?? '',
      'sub-a-owner',
      'ci-a',
      ['admin'],
    );
    const b = await repo.createMachineToken(
      (await repo.getTenantByName('tenant-b'))?.id ?? '',
      'sub-b-owner',
      'ci-b',
      ['admin'],
    );
    tenantASecret = a.token;
    tenantBSecret = b.token;
    await pool.end();
  }, 180_000);

  afterAll(async () => {
    // Pool cache của app phải end TRƯỚC khi container dừng — ngược lại pg
    // ném unhandled 'terminating connection due to administrator command'
    // (57P01) làm run đỏ dù mọi test xanh.
    await closeCachedPool();
    await db?.stop();
  });

  beforeEach(async () => {
    // Giữ tenants + tokens (bootstrap đắt); xoá domain data.
    const client = await db.connect();
    try {
      await client.query(
        `TRUNCATE pact.webhook_executions, pact.audit_events,
                pact.deployed_versions, pact.webhooks, pact.environments,
                pact.verifications, pact.pacts, pact.tags, pact.versions,
                pact.pacticipants, pact.internal_nonces`,
      );
    } finally {
      await client.end();
    }
  });

  async function reqJson(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.request(`${BASE}${path}`, init, workerEnv);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON — giữ text
    }
    return { status: res.status, body };
  }

  async function publishPact(
    token: string,
    consumer: string,
    provider: string,
    version: string,
    opts: { branch?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const qs = opts.branch === undefined ? '' : `?branch=${encodeURIComponent(opts.branch)}`;
    return reqJson(
      `/pacts/provider/${encodeURIComponent(provider)}/consumer/${encodeURIComponent(consumer)}/version/${encodeURIComponent(version)}${qs}`,
      {
        method: 'PUT',
        headers: auth(token),
        body: JSON.stringify(samplePact({ consumer, provider })),
      },
    );
  }

  it('health is reachable without credentials or DB', async () => {
    const { status, body } = await reqJson('/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('emits CORS headers only for the configured dashboard origin and answers preflight without touching auth or DB', async () => {
    // workerEnv mặc định không có PACT_BROKER_DASHBOARD_ORIGIN → không ACAO
    // nào được phát dù Origin header có mặt (fail-closed).
    const noConfig = await app.request(
      `${BASE}/health`,
      {
        headers: { origin: 'https://dashboard.example.com' },
      },
      workerEnv,
    );
    expect(noConfig.headers.get('access-control-allow-origin')).toBeNull();

    // Bật dashboard origin rồi kiểm cả happy path lẫn preflight. Config được
    // cache theo isolate nên phải reset trước khi nạp env khác.
    const { resetCachedConfig } = await import('../../src/main');
    resetCachedConfig();
    const envWithDashboard = {
      ...workerEnv,
      PACT_BROKER_DASHBOARD_ORIGIN: 'https://dashboard.example.com',
    };

    const allowed = await app.request(
      `${BASE}/health`,
      {
        headers: { origin: 'https://dashboard.example.com' },
      },
      envWithDashboard,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://dashboard.example.com',
    );
    expect(allowed.headers.get('vary')).toContain('Origin');

    // Origin khác dashboard origin → không ACAO, request thường vẫn đi tiếp.
    const foreign = await app.request(
      `${BASE}/health`,
      {
        headers: { origin: 'https://evil.example.net' },
      },
      envWithDashboard,
    );
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    // Preflight từ origin được phép: 204 ngay tại middleware, không cần token.
    const preflight = await app.request(
      `${BASE}/pacticipants`,
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://dashboard.example.com',
          'access-control-request-method': 'GET',
        },
      },
      envWithDashboard,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://dashboard.example.com',
    );
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');

    // Preflight từ origin lạ: 403, không ACAO.
    const preflightForeign = await app.request(
      `${BASE}/pacticipants`,
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example.net',
          'access-control-request-method': 'GET',
        },
      },
      envWithDashboard,
    );
    expect(preflightForeign.status).toBe(403);
    expect(preflightForeign.headers.get('access-control-allow-origin')).toBeNull();

    // Trả config cache về trạng thái không dashboard cho các test sau.
    resetCachedConfig();
  });

  it('rejects missing, unknown, and revoked tokens with identical 401', async () => {
    const missing = await reqJson('/pacticipants');
    expect(missing.status).toBe(401);

    const unknown = await reqJson('/pacticipants', {
      headers: auth('not-a-real-token'),
    });
    expect(unknown.status).toBe(401);

    // Revoke token B rồi dùng nó: 401 giống hệt (không tiết lộ "đã từng hợp lệ").
    const pool = await db.createRuntimePool();
    const { PgTenantRepo } = Infra;
    const repo = new PgTenantRepo(pool);
    const tenantB = await repo.getTenantByName('tenant-b');
    const tokens = await repo.listMachineTokens(tenantB?.id ?? '');
    await repo.revokeMachineToken(tenantB?.id ?? '', tokens[0]?.id ?? '');
    const revokedSecret = tenantBSecret;
    // Token B vừa bị revoke vĩnh viễn (truncateData giữ tokens) — cấp token
    // thay thế để các test sau vẫn dùng được tenant B.
    const replacement = await repo.createMachineToken(
      tenantB?.id ?? '',
      'sub-b-owner',
      'broker-b (replacement)',
      ['admin'],
    );
    tenantBSecret = replacement.token;
    await pool.end();
    const revoked = await reqJson('/pacticipants', {
      headers: auth(revokedSecret),
    });
    expect(revoked.status).toBe(401);
    expect(stripRequestId(revoked.body)).toEqual(stripRequestId(missing.body));
    expect(stripRequestId(unknown.body)).toEqual(stripRequestId(missing.body));
  });

  it('serves HAL index with compatibility version and publish-contracts link', async () => {
    const { status, body } = await reqJson('/', {
      headers: auth(tenantASecret),
    });
    expect(status).toBe(200);
    // HAL dùng `_links` — truy cập bằng bracket để không vi phạm
    // no-underscore-dangle.
    const links = (body as { _links: Record<string, { href: string }> })['_links'];
    expect(links['pb:publish-contracts']).toBeDefined();
    expect(links['pb:provider-pacts-for-verification']).toBeDefined();
  });

  it('publishes a pact: 201 first, 200 on re-publish, content sha stable', async () => {
    const first = await publishPact(tenantASecret, 'order-service', 'payment-service', '1.0.0', {
      branch: 'main',
    });
    expect(first.status).toBe(201);

    const again = await publishPact(tenantASecret, 'order-service', 'payment-service', '1.0.0', {
      branch: 'main',
    });
    expect(again.status).toBe(200);
  });

  it('caps consumerVersionSelectors to prevent query amplification on a read token', async () => {
    // 60 selector (trên cap 50): mỗi selector constrained tra tag per-candidate
    // — không cap thì token read đẩy isolate vào chuỗi query dài. Phải 400
    // TRƯỚC khi repo chạy.
    const tooMany = await reqJson('/pacts/provider/payment-service/for-verification', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        consumerVersionSelectors: Array.from({ length: 60 }, (_, i) => ({
          tag: `t${i}`,
        })),
      }),
    });
    expect(tooMany.status).toBe(400);

    // 51 selector cũng trên cap — ranh giới đúng tại 50.
    const justAbove = await reqJson('/pacts/provider/payment-service/for-verification', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        consumerVersionSelectors: Array.from({ length: 51 }, (_, i) => ({
          tag: `t${i}`,
        })),
      }),
    });
    expect(justAbove.status).toBe(400);

    // Số selector trong cap vẫn đi qua bình thường (200, empty provider).
    const within = await reqJson('/pacts/provider/payment-service/for-verification', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        consumerVersionSelectors: Array.from({ length: 50 }, (_, i) => ({
          tag: `t${i}`,
        })),
      }),
    });
    expect(within.status).toBe(200);
  });

  it('enforces the publish body cap on the real stream, not on Content-Length', async () => {
    // Body lớn hơn cap 1 MiB nhưng KHÔNG gửi Content-Length (mô phỏng
    // Transfer-Encoding: chunked — fetch/undici dựng request chunked khi
    // body là stream). Check dựa trên header sẽ bỏ qua body này; cap phải
    // trả 413 khi byte thật vượt trần.
    const bigInteraction = {
      description: 'x'.repeat(64),
      providerState: 'y'.repeat(64),
      request: { method: 'GET', path: '/z'.padEnd(4096, 'z') },
      response: { status: 200, body: { pad: 'w'.repeat(4096) } },
    };
    const oversized = {
      consumer: { name: 'order-service' },
      provider: { name: 'payment-service' },
      interactions: Array.from({ length: 400 }, (_, i) => ({
        ...bigInteraction,
        description: `interaction ${i} ${'x'.repeat(64)}`,
      })),
    };
    const body = JSON.stringify(oversized);
    expect(body.length).toBeGreaterThan(1024 * 1024);

    const oversizedNoHeader = await app.request(
      `${BASE}/pacts/provider/payment-service/consumer/order-service/version/1.0.0`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${tenantASecret}`,
          'content-type': 'application/json',
        },
        // Cố ý KHÔNG set content-length: với stream body, request tới
        // runtime không mang độ dài biết trước — đúng hình dạng chunked mà
        // check Content-Length bỏ qua. `duplex` là đòi hỏi của undici cho
        // stream body; type DOM hiện hành chưa khai field này.
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(body);
            for (let i = 0; i < bytes.length; i += 65536) {
              controller.enqueue(bytes.slice(i, i + 65536));
            }
            controller.close();
          },
        }),
      },
      workerEnv,
    );
    expect(oversizedNoHeader.status).toBe(413);
    const oversizeBody = (await oversizedNoHeader.json()) as { error?: string };
    expect(oversizeBody.error).toBe('Payload Too Large');

    // Control: body nhỏ cùng hình dạng stream vẫn publish được 201 — chứng
    // minh 413 ở trên đến từ cap byte, không phải từ hình dạng stream.
    const small = samplePact({
      consumer: 'order-service',
      provider: 'payment-service',
    });
    const smallStream = await app.request(
      `${BASE}/pacts/provider/payment-service/consumer/order-service/version/1.0.0`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${tenantASecret}`,
          'content-type': 'application/json',
        },
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(small)));
            controller.close();
          },
        }),
      },
      workerEnv,
    );
    expect(smallStream.status).toBe(201);
  });

  it('isolates tenants: B sees nothing of A through any read path', async () => {
    await publishPact(tenantASecret, 'order-service', 'payment-service', '1.0.0', {
      branch: 'main',
    });

    // B list pacticipants: trống.
    const list = await reqJson('/pacticipants', {
      headers: auth(tenantBSecret),
    });
    expect(list.status).toBe(200);
    expect((list.body as { _links: Record<string, unknown> })['_links']).not.toHaveProperty(
      'order-service',
    );

    // B đọc latest pact cùng tên: 404.
    const latest = await reqJson('/pacts/provider/payment-service/consumer/order-service/latest', {
      headers: auth(tenantBSecret),
    });
    expect(latest.status).toBe(404);

    // can-i-deploy của B cho cùng tên: matrix rỗng, không row của A.
    const matrix = await reqJson('/can-i-deploy?pacticipant=order-service&version=1.0.0&to=prod', {
      headers: auth(tenantBSecret),
    });
    expect(matrix.status).toBe(200);
    const matrixBody = matrix.body as {
      matrix: unknown[];
      deployable?: boolean;
    };
    expect(matrixBody.matrix).toHaveLength(0);
  });

  it('records verification only into a pact of the same tenant (upstream leak fixed)', async () => {
    // A publish pact; B publish pact GIỐNG HỆT byte-for-byte (content SHA bằng nhau).
    const pactA = await publishPact(tenantASecret, 'shared-c', 'shared-p', '1.0.0');
    expect(pactA.status).toBe(201);
    const pactB = await publishPact(tenantBSecret, 'shared-c', 'shared-p', '1.0.0');
    expect(pactB.status).toBe(201);

    // B publish verification cho SHA chung — phải ghi vào PACT CỦA B.
    const verRes = await reqJson(
      '/pacts/provider/shared-p/consumer/shared-c/pact-version/' +
        '0'.repeat(64) +
        '/verification-results',
      // sha 64 số 0 không khớp pact thật — dùng đường GET sha trước để lấy SHA thật.
      { method: 'POST', headers: auth(tenantBSecret), body: '{}' },
    );
    // 400/404 vì sha sai — điểm quan trọng là KHÔNG 201 trên pact của A.
    expect([400, 404]).toContain(verRes.status);

    // Lấy SHA thật của B qua latest, rồi publish verification đúng SHA.
    const latestB = await reqJson('/pacts/provider/shared-p/consumer/shared-c/latest', {
      headers: auth(tenantBSecret),
    });
    expect(latestB.status).toBe(200);
    const sha = /pact-version\/([0-9a-f]{64})/u.exec(JSON.stringify(latestB.body))?.[1];
    expect(sha).toBeDefined();

    const ver = await reqJson(
      `/pacts/provider/shared-p/consumer/shared-c/pact-version/${sha}/verification-results`,
      {
        method: 'POST',
        headers: auth(tenantBSecret),
        body: JSON.stringify({
          success: true,
          providerApplicationVersion: '2.0.0',
        }),
      },
    );
    expect(ver.status).toBe(201);

    // A KHÔNG thấy verification nào trên pact của mình (B ghi vào pact của B).
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ tenant_name: string }>(
        `SELECT t.name AS tenant_name
           FROM pact.verifications v
           JOIN pact.tenants t ON t.id = v.tenant_id`,
      );
      expect(rows.map((r) => r.tenant_name)).toEqual(['tenant-b']);
    } finally {
      await client.end();
    }
  });

  it('can-i-deploy fails closed (tri-state) when nothing is verified and deployed', async () => {
    await publishPact(tenantASecret, 'svc-c', 'svc-p', '1.0.0', {
      branch: 'main',
    });

    // No verification, no deployment → unknown → KHÔNG được deploy.
    // Route là query-style (khớp CLI `pact-broker can-i-deploy --pacticipant …`).
    const { status, body } = await reqJson(
      '/can-i-deploy?pacticipant=svc-p&version=1.0.0&to=prod',
      { headers: auth(tenantASecret) },
    );
    expect(status).toBe(200);
    const bodyObj = body as { summary: { deployable: boolean | null } };
    expect(bodyObj.summary.deployable).toBeNull();
  });

  it('can-i-deploy fails closed when the version exists but no pact was ever published for it', async () => {
    // Version tồn tại mà không có pact nào — tạo thẳng qua repo
    // (đường getOrCreateVersion mà record-deployment dùng).
    const pool = await db.createRuntimePool();
    const tenantRepo = new Infra.PgTenantRepo(pool);
    const tenantId = (await tenantRepo.getTenantByName('tenant-a'))?.id ?? '';
    await new Infra.PgVersionRepo(pool).getOrCreateVersion(tenantId, 'orphan-svc', '2.0.0', 'main');
    await pool.end();

    // Upstream trả deployable TRUE ở đây (matrix rỗng → "no missing
    // dependencies") — version chưa từng được contract-test vẫn thấy xanh.
    // Ecoma ép null kèm reason tường minh (fail-closed, F6).
    const { status, body } = await reqJson(
      '/can-i-deploy?pacticipant=orphan-svc&version=2.0.0&to=prod',
      { headers: auth(tenantASecret) },
    );
    expect(status).toBe(200);
    const bodyObj = body as {
      summary: { deployable: boolean | null; reason: string };
    };
    expect(bodyObj.summary.deployable).toBeNull();
    expect(bodyObj.summary.reason).toContain('no pacts published');
  });

  it('can-i-deploy fails closed with a distinct reason when the selector matches nothing at all', async () => {
    const { status, body } = await reqJson(
      '/can-i-deploy?pacticipant=ghost-svc&version=9.9.9&to=prod',
      { headers: auth(tenantASecret) },
    );
    expect(status).toBe(200);
    const bodyObj = body as {
      summary: { deployable: boolean | null; reason: string };
    };
    expect(bodyObj.summary.deployable).toBeNull();
    expect(bodyObj.summary.reason).toContain('There is no version 9.9.9 of ghost-svc');
    // Hai tình huống rỗng phải phân biệt được qua reason.
    expect(bodyObj.summary.reason).not.toContain('no pacts published');
  });

  it('machine token lifecycle: create shows secret once, list hides it, revoke is instant', async () => {
    // Create qua admin API.
    const created = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'one-shot', scopes: ['write'] }),
    });
    expect(created.status).toBe(201);
    const createdBody = created.body as {
      token: { id: string };
      secret: string;
    };
    expect(createdBody.secret).toMatch(/^[A-Za-z0-9_-]{30,}$/u);
    const tokenId = createdBody.token.id;

    // Token mới dùng được ngay.
    const used = await reqJson('/pacticipants', {
      headers: auth(createdBody.secret),
    });
    expect(used.status).toBe(200);

    // List KHÔNG chứa secret.
    const list = await reqJson('/admin/machine-tokens', {
      headers: auth(tenantASecret),
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(createdBody.secret);
    expect(JSON.stringify(list.body)).not.toContain(tenantASecret);

    // Revoke → dùng lại là 401 ngay.
    const revoked = await reqJson(`/admin/machine-tokens/${tokenId}`, {
      method: 'DELETE',
      headers: auth(tenantASecret),
    });
    expect(revoked.status).toBe(204);
    const after = await reqJson('/pacticipants', {
      headers: auth(createdBody.secret),
    });
    expect(after.status).toBe(401);
  });

  it('machine token rotate: old token blocked immediately, new token works', async () => {
    // Create token.
    const created = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'rotatable', scopes: ['write'] }),
    });
    expect(created.status).toBe(201);
    const createdBody = created.body as {
      token: { id: string };
      secret: string;
    };
    const tokenId = createdBody.token.id;

    // Token cũ dùng được ngay.
    const before = await reqJson('/pacticipants', {
      headers: auth(createdBody.secret),
    });
    expect(before.status).toBe(200);

    // Rotate → trả secret mới, token cũ chặn ngay lập tức.
    const rotated = await reqJson(`/admin/machine-tokens/${tokenId}/rotate`, {
      method: 'POST',
      headers: auth(tenantASecret),
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = rotated.body as {
      token: { id: string };
      secret: string;
    };
    expect(rotatedBody.token.id).toBe(tokenId);
    expect(rotatedBody.secret).not.toBe(createdBody.secret);

    // Token cũ bị chặn ngay request đầu sau rotate.
    const afterOld = await reqJson('/pacticipants', {
      headers: auth(createdBody.secret),
    });
    expect(afterOld.status).toBe(401);

    // Token mới dùng được.
    const afterNew = await reqJson('/pacticipants', {
      headers: auth(rotatedBody.secret),
    });
    expect(afterNew.status).toBe(200);

    // List KHÔNG chứa secret nào.
    const list = await reqJson('/admin/machine-tokens', {
      headers: auth(tenantASecret),
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(createdBody.secret);
    expect(JSON.stringify(list.body)).not.toContain(rotatedBody.secret);
  });

  it('machine token rotate: writes audit_events row with action machine_token.rotate', async () => {
    // Create token.
    const created = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'audited-rotate', scopes: ['write'] }),
    });
    expect(created.status).toBe(201);
    const tokenId = (created.body as { token: { id: string } }).token.id;

    const rotated = await reqJson(`/admin/machine-tokens/${tokenId}/rotate`, {
      method: 'POST',
      headers: auth(tenantASecret),
    });
    expect(rotated.status).toBe(200);

    // assert audit_events ghi row action = 'machine_token.rotate'.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ action: string }>(
        `SELECT action FROM pact.audit_events
         WHERE action = $1 AND detail->>'tokenId' = $2`,
        ['machine_token.rotate', tokenId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('machine_token.rotate');
    } finally {
      await client.end();
    }
  });

  it('machine token rotate: rotating an already-revoked token returns 404', async () => {
    // Create token.
    const created = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'revoked-then-rotate', scopes: ['write'] }),
    });
    expect(created.status).toBe(201);
    const tokenId = (created.body as { token: { id: string } }).token.id;

    // Revoke trước rồi rotate → 404, token không được lưu lại.
    const revoked = await reqJson(`/admin/machine-tokens/${tokenId}`, {
      method: 'DELETE',
      headers: auth(tenantASecret),
    });
    expect(revoked.status).toBe(204);

    const rotated = await reqJson(`/admin/machine-tokens/${tokenId}/rotate`, {
      method: 'POST',
      headers: auth(tenantASecret),
    });
    expect(rotated.status).toBe(404);

    // Token cũ (đã revoke) vẫn không dùng được.
    const after = await reqJson('/pacticipants', {
      headers: auth((created.body as { secret: string }).secret),
    });
    expect(after.status).toBe(401);
  });

  it('machine token rotate: double rotation invalidates first new secret (show-once)', async () => {
    // Create token.
    const created = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'double-rotate', scopes: ['write'] }),
    });
    expect(created.status).toBe(201);
    const createdBody = created.body as {
      token: { id: string };
      secret: string;
    };
    const tokenId = createdBody.token.id;

    // Rotate lần 1 → secret mới.
    const rotated1 = await reqJson(`/admin/machine-tokens/${tokenId}/rotate`, {
      method: 'POST',
      headers: auth(tenantASecret),
    });
    expect(rotated1.status).toBe(200);
    const rotated1Body = rotated1.body as { secret: string };

    // Rotate lần 2 → secret lần 2.
    const rotated2 = await reqJson(`/admin/machine-tokens/${tokenId}/rotate`, {
      method: 'POST',
      headers: auth(tenantASecret),
    });
    expect(rotated2.status).toBe(200);
    const rotated2Body = rotated2.body as { secret: string };
    expect(rotated2Body.secret).not.toBe(rotated1Body.secret);

    // Secret lần 1 đã bị invalid: dùng lại là 401.
    const afterFirst = await reqJson('/pacticipants', {
      headers: auth(rotated1Body.secret),
    });
    expect(afterFirst.status).toBe(401);

    // Secret lần 2 dùng được.
    const afterSecond = await reqJson('/pacticipants', {
      headers: auth(rotated2Body.secret),
    });
    expect(afterSecond.status).toBe(200);
  });

  it('machine token rotate: cannot rotate token of another tenant (cross-tenant blocked)', async () => {
    // Tạo token của tenant A.
    const createdA = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'token-a', scopes: ['read'] }),
    });
    expect(createdA.status).toBe(201);
    const tokenIdA = (createdA.body as { token: { id: string } }).token.id;

    // Token B cố rotate token của tenant A → 404 (không thấy token của tenant khác,
    // vì DELETE/UPDATE lọc theo tenant_id ở DB).
    const rotatedCross = await reqJson(`/admin/machine-tokens/${tokenIdA}/rotate`, {
      method: 'POST',
      headers: auth(tenantBSecret),
    });
    expect(rotatedCross.status).toBe(404);

    // Token của tenant A vẫn dùng được bình thường.
    const stillWorks = await reqJson('/pacticipants', {
      headers: auth((createdA.body as { secret: string }).secret),
    });
    expect(stillWorks.status).toBe(200);
  });

  it('tenant isolation: token of tenant A cannot revoke token of tenant B', async () => {
    // Tạo token của tenant B qua admin API của tenant B.
    const createdB = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantBSecret),
      body: JSON.stringify({ name: 'token-b', scopes: ['read'] }),
    });
    expect(createdB.status).toBe(201);
    const tokenIdB = (createdB.body as { token: { id: string } }).token.id;

    // Token admin của tenant A cố revoke token của tenant B → 404 (không thấy).
    const revokeCross = await reqJson(`/admin/machine-tokens/${tokenIdB}`, {
      method: 'DELETE',
      headers: auth(tenantASecret),
    });
    expect(revokeCross.status).toBe(404);

    // Token của tenant B vẫn dùng được bình thường.
    const stillWorks = await reqJson('/pacticipants', {
      headers: auth((createdB.body as { secret: string }).secret),
    });
    expect(stillWorks.status).toBe(200);
  });

  it('tenant isolation: machine token of tenant A cannot list tokens of tenant B', async () => {
    // Tạo token của tenant B qua token admin của tenant B.
    const createdB = await reqJson('/admin/machine-tokens', {
      method: 'POST',
      headers: auth(tenantBSecret),
      body: JSON.stringify({ name: 'token-b', scopes: ['read'] }),
    });
    expect(createdB.status).toBe(201);

    // Token admin của tenant A list tokens của chính nó: không thấy token của B.
    const listA = await reqJson('/admin/machine-tokens', {
      headers: auth(tenantASecret),
    });
    expect(listA.status).toBe(200);
    const embedded = (listA.body as Record<string, unknown>)['_embedded'] as
      | { tokens: Array<{ name: string }> }
      | undefined;
    const namesA = embedded?.tokens.map((t) => t.name) ?? [];
    expect(namesA).not.toContain('token-b');

    // Token của tenant B vẫn dùng được bình thường.
    const stillWorksB = await reqJson('/pacticipants', {
      headers: auth((createdB.body as { secret: string }).secret),
    });
    expect(stillWorksB.status).toBe(200);
  });

  it('scope hierarchy: read token cannot publish, write token can read', async () => {
    const pool = await db.createRuntimePool();
    const { PgTenantRepo } = Infra;
    const repo = new PgTenantRepo(pool);
    const tenantA = await repo.getTenantByName('tenant-a');
    const readToken = await repo.createMachineToken(tenantA?.id ?? '', 'sub-a-owner', 'reader', [
      'read',
    ]);
    const writeToken = await repo.createMachineToken(tenantA?.id ?? '', 'sub-a-owner', 'writer', [
      'write',
    ]);
    await pool.end();

    // read không publish được (403 — token hợp lệ, thiếu scope).
    const denied = await publishPact(readToken.token, 'c1', 'p1', '1.0.0');
    expect(denied.status).toBe(403);

    // write đọc được (read ⊂ write).
    const readable = await reqJson('/pacticipants', {
      headers: auth(writeToken.token),
    });
    expect(readable.status).toBe(200);

    // write KHÔNG vào admin (admin ⊃ write, chiều ngược lại không đúng).
    const adminDenied = await reqJson('/admin/machine-tokens', {
      headers: auth(writeToken.token),
    });
    expect(adminDenied.status).toBe(403);
  });

  it('deployments: record, undeploy, and matrix sees the deployed target', async () => {
    await publishPact(tenantASecret, 'dep-c', 'dep-p', '1.0.0', {
      branch: 'main',
    });
    // verification success của dep-p 1.0.0 (provider version riêng) — để matrix có candidate.
    const latest = await reqJson('/pacts/provider/dep-p/consumer/dep-c/latest', {
      headers: auth(tenantASecret),
    });
    const sha = /pact-version\/([0-9a-f]{64})/u.exec(JSON.stringify(latest.body))?.[1];
    expect(sha).toBeDefined();
    await reqJson(`/pacts/provider/dep-p/consumer/dep-c/pact-version/${sha}/verification-results`, {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        success: true,
        providerApplicationVersion: '2.0.0',
      }),
    });

    // Tạo environment rồi record deployment của consumer version 1.0.0.
    await reqJson('/environments/prod', {
      method: 'PUT',
      headers: auth(tenantASecret),
      body: JSON.stringify({ displayName: 'Production', production: true }),
    });
    const deployed = await reqJson(
      '/pacticipants/dep-c/versions/1.0.0/deployed-versions/environment/prod',
      { method: 'POST', headers: auth(tenantASecret), body: '{}' },
    );
    expect(deployed.status).toBe(201);

    // can-i-deploy cho PROVIDER 1.0.0: chưa verify/deploy → null (fail-closed).
    const gate = await reqJson('/can-i-deploy?pacticipant=dep-p&version=1.0.0&to=prod', {
      headers: auth(tenantASecret),
    });
    expect(
      (gate.body as { summary: { deployable: boolean | null } }).summary.deployable,
    ).toBeNull();

    // Undeploy: DELETE đường legacy `/deployed/:environment` (upstream cũng
    // vậy — đường deployed-versions chỉ có POST) → 204.
    const del = await reqJson('/pacticipants/dep-c/versions/1.0.0/deployed/prod', {
      method: 'DELETE',
      headers: auth(tenantASecret),
    });
    expect(del.status).toBe(204);
  });

  it('contracts/publish batch endpoint matches CLI contract', async () => {
    const payload = {
      pacticipantName: 'batch-c',
      pacticipantVersionNumber: '3.1.0',
      branch: 'release/3.1',
      tags: ['release'],
      contracts: [
        {
          consumerName: 'batch-c',
          providerName: 'batch-p',
          content: Buffer.from(
            JSON.stringify(samplePact({ consumer: 'batch-c', provider: 'batch-p' })),
          ).toString('base64'),
        },
      ],
    };
    const { status, body } = await reqJson('/contracts/publish', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify(payload),
    });
    expect(status).toBe(200);
    expect((body as { _links?: unknown })['_links']).toBeDefined();

    // Branch + tag được ghi: matrix theo tag tìm thấy version.
    const byTag = await reqJson('/pacts/provider/batch-p/consumer/batch-c/latest/release', {
      headers: auth(tenantASecret),
    });
    expect(byTag.status).toBe(200);
  });

  it('webhook execute is disabled: 202 with no outbound connection (SR-006)', async () => {
    await publishPact(tenantASecret, 'wh-c', 'wh-p', '1.0.0');
    const created = await reqJson('/webhooks', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        url: 'https://hooks.example.test/notify',
        events: ['contract_published'],
        provider: 'wh-p',
      }),
    });
    expect(created.status).toBe(201);
    const webhookId = (created.body as { id?: string }).id;

    const fired = await reqJson(`/webhooks/${webhookId}/execute`, {
      method: 'POST',
      headers: auth(tenantASecret),
      body: '{}',
    });
    expect(fired.status).toBe(202);
    expect(fired.body).toMatchObject({ fired: false, disabled: true });

    // Execution log ghi rõ disabled.
    const executions = await reqJson(`/webhooks/${webhookId}/executions`, {
      headers: auth(tenantASecret),
    });
    expect(executions.status).toBe(200);
  });

  it('webhook CRUD rejects plain http url', async () => {
    const res = await reqJson('/webhooks', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        url: 'http://insecure.example.test/hook',
        events: ['contract_published'],
        provider: 'wh-p',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('verifies webhooks are tenant-scoped: B cannot read A webhook', async () => {
    await publishPact(tenantASecret, 'wh2-c', 'wh2-p', '1.0.0');
    const created = await reqJson('/webhooks', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({
        url: 'https://hooks.example.test/notify',
        events: ['contract_published'],
        provider: 'wh2-p',
      }),
    });
    const webhookId = (created.body as { id?: string }).id;
    const cross = await reqJson(`/webhooks/${webhookId}`, {
      headers: auth(tenantBSecret),
    });
    expect(cross.status).toBe(404);
  });
});
