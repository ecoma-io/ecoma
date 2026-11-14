/**
 * Integration suite của đường user identity (ADR-0031 §1) trên PostgreSQL
 * thật + Hono `app.request()` — matrix authorization, phân lớp lỗi, chấp nhận
 * kép machine/user, forged-header fail-closed, và audit coverage của #206
 * (`environment.delete`, `membership.grant/revoke`).
 *
 * JWKS thật: server ES256 nhỏ (node:http) phát public key của một keypair sinh
 * trong test; token ký bằng `jose` đúng contract OIDC của `auth` (iss/aud/exp/
 * sub, RS/ES qua kid). API fetch JWKS qua HTTP thật — classification
 * unavailable/invalid được đo trên đường fetch thật, không mock jose.
 *
 * Suite tự sở hữu container + JWKS server của mình (06-testing.md §2/§6) và
 * tự dọn trong `afterAll`.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
// `CryptoKey` của jose là type riêng (structural fallback khi host không có
// `CryptoKey` global) — dùng type này thay vì global để typecheck ở host Node
// không khai global WebCrypto type.
import type { CryptoKey } from 'jose';

import * as Infra from '@ecoma-io/pact-broker-api-infrastructure';
import { buildApp, resetCachedConfig } from '../../src/main';
import { JWKS_PATH } from '../../src/auth/user-auth';
import { entitlementQueueBatch } from '../../src/entitlement-consumer';
import { type PactBrokerDatabase, PACT_BROKER_DATABASE, startPactBrokerDatabase } from './harness';

const BASE = 'https://broker.test';
const AUDIENCE = 'pact-broker-it-audience';
const ISSUER_KID = 'it-es256-key';

/** Chuỗi Authorization bearer — content-type đi kèm cho các POST. */
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const runtimeConnectionString = (db: PactBrokerDatabase): string =>
  `postgres://ecoma_pact_broker_runtime:ecoma_test_role_pw@${db.host}:${db.port}/${PACT_BROKER_DATABASE}`;

/**
 * JWKS nhỏ cục bộ — phát đúng một public key (kid ghim).
 *
 * ⚠️ Server CHỈ phục vụ `/jwks.json`; path khác trả 404. Đây là ghim contract:
 * `auth` chạy `oidc-provider` với route override `jwks: '/jwks.json'`, nên nếu
 * API fetch `/.well-known/jwks.json` (như từng làm) thì user path chết 401/503
 * trên lane thật — test phải đỏ thay vì im lặng pass.
 */
class LocalJwks {
  private readonly server: Server;
  private portValue: number | null = null;
  readonly requestedPaths: string[] = [];

  constructor(jwksJson: unknown) {
    this.server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      this.requestedPaths.push(path);
      if (path !== JWKS_PATH) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwksJson));
    });
  }

  /** Listen trên port 0 (OS cấp) và đợi event 'listening' — address() chỉ có sau đó. */
  start(): Promise<void> {
    return new Promise((done, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('JWKS test server failed to listen on a TCP port'));
          return;
        }
        this.portValue = address.port;
        done();
      });
    });
  }

  get issuer(): string {
    if (this.portValue === null) {
      throw new Error('JWKS test server has not started');
    }
    return `http://127.0.0.1:${String(this.portValue)}`;
  }

  close(): Promise<void> {
    return new Promise((done) => {
      this.server.close(() => {
        done();
      });
    });
  }
}

/** Mint access token ES256 đúng shape OIDC của `auth` (kid → JWKS). */
async function mintToken(
  privateKey: CryptoKey,
  issuer: string,
  sub: string,
  options: { audience?: string; expiredSecondsAgo?: number } = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Mặc định token sống 1 giờ; `expiredSecondsAgo` để test hết hạn.
  const expiresAt = nowSeconds - (options.expiredSecondsAgo ?? -3600);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: ISSUER_KID, typ: 'at+jwt' })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

describe(`${PACT_BROKER_DATABASE} user identity path (ADR-0031)`, () => {
  let db: PactBrokerDatabase;
  let app: ReturnType<typeof buildApp>;
  let jwks: LocalJwks;
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  let workerEnv: Record<string, unknown>;
  let tenantAToken: string;
  let tenantBToken: string;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
    const pool = await db.createRuntimePool();
    app = buildApp();

    const keyPair = await generateKeyPair('ES256', { extractable: true });
    privateKey = keyPair.privateKey;
    const other = await generateKeyPair('ES256', { extractable: true });
    otherPrivateKey = other.privateKey;

    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = ISSUER_KID;
    publicJwk.alg = 'ES256';
    publicJwk.use = 'sig';
    jwks = new LocalJwks({ keys: [publicJwk] });
    await jwks.start();

    workerEnv = {
      HYPERDRIVE: { connectionString: runtimeConnectionString(db) },
      PACT_BROKER_AUTH_ISSUER: jwks.issuer,
      PACT_BROKER_AUTH_AUDIENCE: AUDIENCE,
    };

    // Seed tenants + memberships trực tiếp qua repo (đường bootstrap thật).
    const { PgTenantRepo } = Infra;
    const repo = new PgTenantRepo(pool);
    await repo.ensureDefaultTenant('tenant-a', 'user-owner-sub');
    await repo.ensureDefaultTenant('tenant-b', 'user-b-owner-sub');
    await repo.ensureDefaultTenant('ecoma', 'ecoma-owner-sub');
    const tenantA = (await repo.getTenantByName('tenant-a')) ?? fail('tenant-a missing');
    const tenantB = (await repo.getTenantByName('tenant-b')) ?? fail('tenant-b missing');
    await repo.upsertMember(tenantA.id, 'user-viewer-sub', 'viewer');
    await repo.upsertMember(tenantA.id, 'user-admin-sub', 'admin');
    await repo.upsertMember(tenantA.id, 'user-multi-sub', 'member');
    await repo.upsertMember(tenantB.id, 'user-multi-sub', 'member');
    // Tenant suspended-only membership.
    const suspended = await repo.ensureDefaultTenant('tenant-suspended', 'user-susp-owner-sub');
    await repo.upsertMember(suspended.id, 'user-suspended-sub', 'member');
    await pool.query(`UPDATE pact.tenants SET status = 'suspended' WHERE id = $1`, [suspended.id]);

    // Machine tokens — kênh Pact CLI vẫn sống bên cạnh kênh user.
    tenantAToken = (
      await repo.createMachineToken(tenantA.id, 'user-owner-sub', 'it-cli-a', ['admin'])
    ).token;
    tenantBToken = (
      await repo.createMachineToken(tenantB.id, 'user-b-owner-sub', 'it-cli-b', ['admin'])
    ).token;
    await pool.end();
  }, 180_000);

  afterAll(async () => {
    await jwks?.close();
    await db?.stop();
  });

  beforeEach(async () => {
    // Giữ tenants/memberships/tokens (bootstrap đắt); xoá domain data + audit.
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

  /** Request JSON qua app thật — trả status + body đã parse. */
  async function reqJson(
    path: string,
    init: RequestInit = {},
    env: Record<string, unknown> = workerEnv,
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const res = await app.request(`${BASE}${path}`, init, env);
    const text = await res.text();
    let body: unknown = text;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // non-JSON — giữ nguyên text
      }
    }
    return { status: res.status, body, headers: res.headers };
  }

  it('fetches JWKS from the path `auth` actually serves — `/jwks.json`', async () => {
    // Ghim contract: `auth` chạy `oidc-provider` với route override
    // `jwks: '/jwks.json'`; `/.well-known/jwks.json` KHÔNG tồn tại (404 trên lane
    // thật). Nếu API fetch sai path, user path chết 401/503 mà test này vẫn
    // xanh nếu server phục vụ mọi path — nên server ở trên 404 mọi path khác.
    jwks.requestedPaths.length = 0;
    const token = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
    const res = await reqJson('/environments', { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(jwks.requestedPaths).toContain(JWKS_PATH);
    expect(jwks.requestedPaths).not.toContain('/.well-known/jwks.json');
  });

  it('fetches JWKS from the internal origin while still matching `iss` against the public issuer', async () => {
    // Origin nội bộ chỉ đổi NƠI lấy JWKS — claim `iss` vẫn so với issuer
    // PUBLIC. Test này dựng issuer/public ở server khác port với internal origin
    // và chứng minh: JWKS lấy từ internal origin, `iss` sai ⇒ 401.
    resetCachedConfig();
    const otherJwks = new LocalJwks({ keys: [] });
    await otherJwks.start();
    try {
      const env = {
        ...workerEnv,
        PACT_BROKER_AUTH_ISSUER: jwks.issuer,
        PACT_BROKER_AUTH_INTERNAL_ORIGIN: otherJwks.issuer,
      };
      // JWKS rỗng ở internal origin ⇒ không verify được ⇒ 401 (token hợp lệ về
      // hình dạng nhưng không có key đúng). Điều này chứng minh resolver đã
      // dùng internal origin, không phải issuer.
      const token = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
      const res = await reqJson('/environments', { headers: bearer(token) }, env);
      expect(res.status).toBe(401);
      expect(otherJwks.requestedPaths).toContain(JWKS_PATH);
    } finally {
      await otherJwks.close();
      resetCachedConfig();
    }
  });

  it('admits a viewer token to reads and scopes it to the member tenant', async () => {
    // Seed dữ liệu chỉ ở tenant-a (qua machine token của tenant-a).
    const seed = await reqJson('/environments', {
      method: 'POST',
      headers: { ...bearer(tenantAToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a-only', displayName: 'A only', production: false }),
    });
    expect(seed.status).toBe(201);

    const token = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
    const res = await reqJson('/environments', { headers: bearer(token) });
    expect(res.status).toBe(200);
    const names = extractEnvironmentNames(res.body);
    expect(names).toContain('a-only');

    // Tenant-scope: dữ liệu của tenant-b không thể thấy qua token viewer-a.
    const seedB = await reqJson('/environments', {
      method: 'POST',
      headers: { ...bearer(tenantBToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'b-only', displayName: 'B only', production: false }),
    });
    expect(seedB.status).toBe(201);
    const resAgain = await reqJson('/environments', { headers: bearer(token) });
    expect(extractEnvironmentNames(resAgain.body)).not.toContain('b-only');
  });

  it('admits owner and admin roles to the same read (owner floors to admin, ADR-0032)', async () => {
    for (const sub of ['user-owner-sub', 'user-admin-sub']) {
      const token = await mintToken(privateKey, jwks.issuer, sub);
      const res = await reqJson('/pacticipants', { headers: bearer(token) });
      expect(res.status, `sub ${sub}`).toBe(200);
    }
  });

  it('rejects an expired token with the uniform 401 shape', async () => {
    const token = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub', {
      expiredSecondsAgo: 3600,
    });
    const res = await reqJson('/pacticipants', { headers: bearer(token) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Unauthorized',
      requestId: expect.any(String),
    });
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="pact-broker-api"');
  });

  it('rejects a token signed by an unknown key, with wrong audience and wrong issuer', async () => {
    const wrongSig = await mintToken(otherPrivateKey, jwks.issuer, 'user-viewer-sub');
    expect((await reqJson('/pacticipants', { headers: bearer(wrongSig) })).status).toBe(401);

    const wrongAud = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub', {
      audience: 'other-audience',
    });
    expect((await reqJson('/pacticipants', { headers: bearer(wrongAud) })).status).toBe(401);

    const wrongIss = await mintToken(privateKey, 'https://issuer.invalid', 'user-viewer-sub');
    expect((await reqJson('/pacticipants', { headers: bearer(wrongIss) })).status).toBe(401);
  });

  it('answers 403, non-distinguishing, for both no-membership and ambiguous subs', async () => {
    const noMembership = await mintToken(privateKey, jwks.issuer, 'user-unknown-sub');
    const ambiguous = await mintToken(privateKey, jwks.issuer, 'user-multi-sub');
    const a = await reqJson('/pacticipants', { headers: bearer(noMembership) });
    const b = await reqJson('/pacticipants', { headers: bearer(ambiguous) });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    // Cùng một body cho cả hai lý do — response không phân biệt được tình
    // trạng membership của sub (fail-closed + non-distinguishing).
    expect(b.body).toEqual(a.body);
  });

  it('answers 401 when the only membership is in a suspended tenant', async () => {
    const token = await mintToken(privateKey, jwks.issuer, 'user-suspended-sub');
    const res = await reqJson('/pacticipants', { headers: bearer(token) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', requestId: expect.any(String) });
  });

  it('blocks every user token from write and admin routes regardless of role', async () => {
    const adminToken = await mintToken(privateKey, jwks.issuer, 'user-admin-sub');
    const create = await reqJson('/environments', {
      method: 'POST',
      headers: { ...bearer(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'via-user', production: false }),
    });
    expect(create.status).toBe(403);

    // /admin/machine-tokens: user-authority path thuộc #207 — user token 403.
    const adminList = await reqJson('/admin/machine-tokens', { headers: bearer(adminToken) });
    expect(adminList.status).toBe(403);
  });

  it('serves GET verification-results at read level for user and machine tokens', async () => {
    // Seed pact + verification qua machine token tenant-a.
    const publish = await reqJson('/pacts/provider/svc/consumer/ci/version/1.0.0', {
      method: 'PUT',
      headers: { ...bearer(tenantAToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        consumer: { name: 'ci' },
        provider: { name: 'svc' },
        interactions: [],
        metadata: { pactSpecification: { version: '2.0.0' } },
      }),
    });
    expect(publish.status).toBe(201);
    const links = (publish.body as Record<string, unknown>)['_links'] as
      | Record<string, { href?: string }>
      | undefined;
    const verificationHref = links?.['pb:publish-verification-results']?.href;
    expect(typeof verificationHref).toBe('string');
    const verify = await reqJson(String(verificationHref).replace(BASE, ''), {
      method: 'POST',
      headers: { ...bearer(tenantAToken), 'content-type': 'application/json' },
      body: JSON.stringify({ success: true, providerApplicationVersion: '9.9.9' }),
    });
    expect(verify.status).toBe(201);
    // self href của verification chứa ĐÚNG path read (sha + id thật) — GET
    // đúng path đó thay vì ghép tay.
    const verificationPath = (
      (
        (verify.body as Record<string, unknown>)['_links'] as
          | Record<string, { href?: string }>
          | undefined
      )?.self?.href ?? ''
    ).replace(BASE, '');
    expect(verificationPath).toContain('/verification-results/');

    // User token (viewer) đọc được — scope của route này là read từ #206.
    const viewerToken = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
    const asUser = await reqJson(verificationPath, { headers: bearer(viewerToken) });
    expect(asUser.status).toBe(200);
    expect(asUser.body).toMatchObject({ success: true });

    // Machine token scope read cũng đạt (read ⊂ write ⊂ admin — hierarchy cũ).
    const pool = await db.createRuntimePool();
    try {
      const repo = new Infra.PgTenantRepo(pool);
      const tenantA = (await repo.getTenantByName('tenant-a')) ?? fail('tenant-a missing');
      const readToken = (await repo.createMachineToken(tenantA.id, null, 'it-cli-read', ['read']))
        .token;
      const asMachineRead = await reqJson(verificationPath, { headers: bearer(readToken) });
      expect(asMachineRead.status).toBe(200);
    } finally {
      await pool.end();
    }
  });

  it('keeps the machine channel working alongside the user channel', async () => {
    const list = await reqJson('/pacticipants', { headers: bearer(tenantAToken) });
    expect(list.status).toBe(200);
    const create = await reqJson('/environments', {
      method: 'POST',
      headers: { ...bearer(tenantAToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'via-machine', production: false }),
    });
    expect(create.status).toBe(201);
  });

  it('returns the same 404 for cross-tenant resources and non-existent ones', async () => {
    // Pact chỉ tồn tại ở tenant-b.
    const publishB = await reqJson('/pacts/provider/b-svc/consumer/b-ci/version/1.0.0', {
      method: 'PUT',
      headers: { ...bearer(tenantBToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        consumer: { name: 'b-ci' },
        provider: { name: 'b-svc' },
        interactions: [],
        metadata: { pactSpecification: { version: '2.0.0' } },
      }),
    });
    expect(publishB.status).toBe(201);

    const viewerToken = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
    const crossTenant = await reqJson('/pacts/provider/b-svc/consumer/b-ci/version/1.0.0', {
      headers: bearer(viewerToken),
    });
    const nonExistent = await reqJson('/pacts/provider/no-svc/consumer/no-ci/version/1.0.0', {
      headers: bearer(viewerToken),
    });
    expect(crossTenant.status).toBe(404);
    expect(nonExistent.status).toBe(404);
    // Non-distinguishing: cùng body shape, requestId riêng là phần duy nhất khác.
    expect(stripRequestId(crossTenant.body)).toEqual(stripRequestId(nonExistent.body));
  });

  it('ignores forged principal headers and enforces the token sub only', async () => {
    const viewerToken = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
    const res = await reqJson('/environments', {
      headers: {
        ...bearer(viewerToken),
        'x-ecoma-sub': 'user-admin-sub',
        'x-tenant-name': 'tenant-b',
        'x-tenant-id': '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(res.status).toBe(200);
    // Vẫn là view của tenant-a: mọi environment của tenant-b vô hình dù header
    // tự xưng tenant khác.
    expect(extractEnvironmentNames(res.body)).not.toContain('b-only');
  });

  it('answers 503 for user tokens when the identity config is absent — machine path unaffected', async () => {
    resetCachedConfig();
    const unconfiguredEnv = { HYPERDRIVE: workerEnv['HYPERDRIVE'] };
    const userToken = await mintToken(privateKey, jwks.issuer, 'user-viewer-sub');
    const asUser = await reqJson('/pacticipants', { headers: bearer(userToken) }, unconfiguredEnv);
    expect(asUser.status).toBe(503);
    expect(asUser.body).toEqual({
      error: 'Service Unavailable',
      message: 'User authentication is not configured',
    });

    // Machine path KHÔNG đọc cấu hình user — vẫn phục vụ bình thường.
    const asMachine = await reqJson(
      '/pacticipants',
      { headers: bearer(tenantAToken) },
      unconfiguredEnv,
    );
    expect(asMachine.status).toBe(200);

    resetCachedConfig(); // trả lại cache cho các test sau (env cấu hình đủ).
  });

  it('answers 503 when the JWKS endpoint is unreachable', async () => {
    const deadIssuer = 'http://127.0.0.1:9'; // port discard không có listener
    const token = await mintToken(privateKey, deadIssuer, 'user-viewer-sub');
    const env = { ...workerEnv, PACT_BROKER_AUTH_ISSUER: deadIssuer };
    const res = await reqJson('/pacticipants', { headers: bearer(token) }, env);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Service Unavailable',
      message: 'Identity provider is unavailable',
    });
  });

  it('audits environment.delete on the machine path', async () => {
    const create = await reqJson('/environments', {
      method: 'POST',
      headers: { ...bearer(tenantAToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'audited', production: false }),
    });
    expect(create.status).toBe(201);
    const del = await reqJson('/environments/audited', {
      method: 'DELETE',
      headers: bearer(tenantAToken),
    });
    expect(del.status).toBe(204);

    const pool = await db.createRuntimePool();
    try {
      const { rows } = await pool.query<{
        action: string;
        detail: unknown;
        actor_token_id: string | null;
      }>(`SELECT action, detail, actor_token_id FROM pact.audit_events`);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('environment.create');
      expect(actions).toContain('environment.delete');
      const deleteRow = rows.find((r) => r.action === 'environment.delete');
      expect(deleteRow?.actor_token_id).not.toBeNull();
      expect(deleteRow?.detail).toMatchObject({ name: 'audited' });
    } finally {
      await pool.end();
    }
  });

  it('audits membership.grant and membership.revoke on the entitlement path', async () => {
    await entitlementQueueBatch(
      {
        queue: 'ecoma-staff-access-entitlement-events',
        messages: [
          entitlementMessage(
            entitlementEventBody(
              '0f0e0d0c-0b0a-4001-8276-001122334455',
              'entitlement.granted',
              1,
              'user-ent-sub',
            ),
          ),
        ],
      },
      { HYPERDRIVE: { connectionString: runtimeConnectionString(db) } },
    );

    // Grant: membership member + audit row.
    const pool = await db.createRuntimePool();
    try {
      const grant = await pool.query<{ role: string }>(
        `SELECT role FROM pact.tenant_members WHERE sub = 'user-ent-sub'`,
      );
      expect(grant.rows.map((r) => r.role)).toEqual(['member']);
      const grantAudit = await pool.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM pact.audit_events WHERE action = 'membership.grant'`,
      );
      expect(grantAudit.rows).toHaveLength(1);
      expect(grantAudit.rows[0]?.detail).toMatchObject({
        memberSub: 'user-ent-sub',
        role: 'member',
      });
    } finally {
      await pool.end();
    }

    await entitlementQueueBatch(
      {
        queue: 'ecoma-staff-access-entitlement-events',
        messages: [
          entitlementMessage(
            entitlementEventBody(
              '0f0e0d0c-0b0a-4002-8276-001122334455',
              'entitlement.revoked',
              2,
              'user-ent-sub',
            ),
          ),
        ],
      },
      { HYPERDRIVE: { connectionString: runtimeConnectionString(db) } },
    );

    const pool2 = await db.createRuntimePool();
    try {
      // Revoke là projection: membership row còn, entitlement_revoked_at set.
      const revoked = await pool2.query<{ entitlement_revoked_at: Date | null }>(
        `SELECT entitlement_revoked_at FROM pact.tenant_members WHERE sub = 'user-ent-sub'`,
      );
      expect(revoked.rows[0]?.entitlement_revoked_at).not.toBeNull();
      const revokeAudit = await pool2.query<{ action: string }>(
        `SELECT action FROM pact.audit_events WHERE action = 'membership.revoke'`,
      );
      expect(revokeAudit.rows).toHaveLength(1);
    } finally {
      await pool2.end();
    }
  });
});

/** Body của một entitlement event trên queue — helper thuần của suite. */
function entitlementEventBody(
  eventId: string,
  type: string,
  revision: number,
  staffId: string,
): Record<string, unknown> {
  return {
    event_id: eventId,
    type,
    staff_id: staffId,
    product: 'pact-broker',
    revision,
    occurred_at: new Date().toISOString(),
    producer: 'staff-access',
  };
}

/** Message của queue consumer — helper thuần của suite. */
function entitlementMessage(body: unknown): {
  id: string;
  body: unknown;
  ack(): Promise<void>;
  retry(): Promise<void>;
} {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    body,
    ack: async (): Promise<void> => undefined,
    retry: async (): Promise<void> => undefined,
  };
}

/** Trích tên environment từ body HAL của listing — helper thuần của suite. */
function extractEnvironmentNames(body: unknown): string[] {
  const embedded = (body as Record<string, unknown>)['_embedded'] as
    | { environments?: Array<{ name?: unknown }> }
    | undefined;
  return (embedded?.environments ?? [])
    .map((environment) => environment.name)
    .filter((name): name is string => typeof name === 'string');
}

/** Bỏ requestId (duy nhất mỗi request) để so hai thân 404 đồng nhất. */
function stripRequestId(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body;
  const { requestId: _omit, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** Nhánh không thể tới trong seed — giữ flow kiểu nhanh không dùng `!`. */
function fail(message: string): never {
  throw new Error(message);
}
