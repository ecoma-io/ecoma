import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRequest } from '@ecoma-io/internal-auth-contracts';
import { buildApp, resetCachedConfig } from '../../src/main';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

describe('internal HMAC envelope authentication', () => {
  let db: StaffAccessDatabase;
  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });
  it('enforces missing, invalid, valid, and replayed envelopes at the management boundary', async () => {
    resetCachedConfig();
    const app = buildApp();
    const env = {
      DB_STAFF_ACCESS: {
        connectionString: `postgresql://ecoma_staff_access_runtime:${db.rolePassword}@${db.host}:${db.port}/db-staff-access`,
      },
      AUTH_INTERNAL_SECRET: 'endpoint-internal-secret',
    };
    const body = JSON.stringify({ id: '00000000-0000-0000-0000-000000000001' });
    const common = {
      method: 'POST',
      path: '/assignments/revoke',
      body: new TextEncoder().encode(body),
      secret: env.AUTH_INTERNAL_SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: `endpoint-valid-${crypto.randomUUID()}`,
    } as const;
    expect((await app.request('/assignments/revoke', { method: 'POST', body }, env)).status).toBe(
      401,
    );
    const invalid = {
      ...(await signRequest({ ...common, nonce: `endpoint-invalid-${crypto.randomUUID()}` })),
      'x-ecoma-internal-signature': 'v1=invalid',
    };
    expect(
      (await app.request('/assignments/revoke', { method: 'POST', body, headers: invalid }, env))
        .status,
    ).toBe(401);
    const signed = await signRequest(common);
    const valid = await app.request(
      '/assignments/revoke',
      { method: 'POST', body, headers: signed },
      env,
    );
    expect(valid.status).toBe(404);
    const replay = await app.request(
      '/assignments/revoke',
      { method: 'POST', body, headers: signed },
      env,
    );
    expect(replay.status).toBe(401);
  });
});

describe('nonce pruning during claim', () => {
  let db: StaffAccessDatabase;
  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('removes expired nonces, keeps unexpired, rejects replay, prunes without making valid envelope replayable', async () => {
    await db.truncateData();
    resetCachedConfig();
    const app = buildApp();
    const env = {
      DB_STAFF_ACCESS: {
        connectionString: `postgresql://ecoma_staff_access_runtime:${db.rolePassword}@${db.host}:${db.port}/db-staff-access`,
      },
      AUTH_INTERNAL_SECRET: 'endpoint-internal-secret',
    };
    const expiredNonce = 'expired-nonce-' + crypto.randomUUID();
    const unexpiredNonce = 'unexpired-nonce-' + crypto.randomUUID();
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO staff_access.internal_nonces (nonce, expires_at) VALUES ($1, $2), ($3, $4)`,
        [expiredNonce, 1, unexpiredNonce, Math.floor(Date.now() / 1000) + 3600],
      );
    } finally {
      await client.end();
    }
    const body = JSON.stringify({});
    const ts = String(Math.floor(Date.now() / 1000));
    const common = {
      method: 'POST',
      path: '/assignments/revoke',
      body: new TextEncoder().encode(body),
      secret: env.AUTH_INTERNAL_SECRET,
      timestamp: ts,
      nonce: `fresh-${crypto.randomUUID()}`,
    } as const;
    const signed = await signRequest(common);
    const res = await app.request(
      '/assignments/revoke',
      { method: 'POST', body, headers: signed },
      env,
    );
    expect([200, 400, 401, 403, 404, 409, 503]).toContain(res.status);

    const c2 = await db.connect();
    let expiredCount = 0;
    let unexpiredCount = 0;
    try {
      const r1 = await c2.query(
        `SELECT count(*)::int AS c FROM staff_access.internal_nonces WHERE nonce = $1`,
        [expiredNonce],
      );
      expiredCount = r1.rows[0].c;
      const r2 = await c2.query(
        `SELECT count(*)::int AS c FROM staff_access.internal_nonces WHERE nonce = $1`,
        [unexpiredNonce],
      );
      unexpiredCount = r2.rows[0].c;
    } finally {
      await c2.end();
    }
    expect(expiredCount).toBe(0);
    expect(unexpiredCount).toBe(1);

    const replay = await app.request(
      '/assignments/revoke',
      { method: 'POST', body, headers: signed },
      env,
    );
    expect(replay.status).toBe(401);
  });
});
