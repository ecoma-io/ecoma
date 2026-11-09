import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signRequest } from '@ecoma-io/internal-auth-contracts';
import { buildApp, resetCachedConfig } from '../../src/main';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

/**
 * Readiness cua `staff-access` tren PostgreSQL THAT (testcontainers, schema da
 * migrate bang runner production).
 *
 * Ba dieu can chung minh — va moi dieu phai fail-closed, khong duoc 200 gia:
 *
 * 1. Migration da chay: `/ready` 200 chi khi schema `staff_access` va grant
 *    runtime ton tai (probe di qua credential runtime that).
 * 2. Dependency khong tra loi duoc: `/ready` 503 (khong phai 200, khong phai
 *    500) — day la dieu kien de Docker healthcheck chuyen `unhealthy`.
 * 3. Management API doc du lieu that tu `db-staff-access` qua envelope HMAC
 *    hop le; thieu/ sai chu ky bi tu choi truoc khi cham DB.
 */

const INTERNAL_SECRET = 'endpoint-internal-secret';

/** `sub` của staff row — shape bat buoc boi CHECK `^sub_[a-z2-7]{32}$` cua 0001. */
const STAFF_SUB = 'sub_aaaaaaaabbbbbbbbccccccccdddddddd';

/** Env cua Worker tro vao database that cua suite, bang credential runtime. */
function runtimeEnv(db: StaffAccessDatabase) {
  return {
    DB_STAFF_ACCESS: {
      connectionString: `postgresql://ecoma_staff_access_runtime:${db.rolePassword}@${db.host}:${db.port}/db-staff-access`,
    },
    AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
  };
}

describe('readiness against the real database', () => {
  let db: StaffAccessDatabase;
  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('returns 200 only after the migrations have created the schema readable by the runtime role', async () => {
    resetCachedConfig();
    const app = buildApp();
    const env = runtimeEnv(db);

    const response = await app.request('/ready', {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { service: string; status: string };
    expect(body).toEqual({ service: 'staff-access', status: 'ready' });
    expect((await app.request('/health')).status).toBe(200);
  });

  it('returns 503 instead of 200 when the database is unreachable', async () => {
    resetCachedConfig();
    const app = buildApp();
    const response = await app.request(
      '/ready',
      {},
      {
        DB_STAFF_ACCESS: { connectionString: 'postgresql://nobody@127.0.0.1:1/db-staff-access' },
        AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.text()).not.toContain('db-staff-access');
  });

  it('serves a DB-backed read to a validly signed envelope and rejects a missing signature', async () => {
    // Management API + real DB + HMAC: khong co envelope thi 401 (khong cham
    // DB); envelope hop le thi 200 voi du lieu that tu `staff_access.staff`.
    resetCachedConfig();
    const app = buildApp();
    const env = runtimeEnv(db);

    const anonymous = await app.request('/staff', {}, env);
    expect(anonymous.status).toBe(401);

    await db.truncateData();
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO staff_access.staff (sub, display_name, status) VALUES ($1, $2, $3)`,
        [STAFF_SUB, 'Readiness E2E', 'active'],
      );
    } finally {
      await client.end();
    }

    const signed = await signRequest({
      method: 'GET',
      path: '/staff',
      body: new Uint8Array(),
      secret: INTERNAL_SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: `readiness-${crypto.randomUUID()}`,
    });
    const response = await app.request('/staff', { headers: signed }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { staff: Array<{ sub: string; status: string }> };
    expect(body.staff.some((row) => row.sub === STAFF_SUB)).toBe(true);
  });
});
