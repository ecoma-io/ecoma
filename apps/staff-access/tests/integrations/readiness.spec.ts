import { randomUUID } from 'node:crypto';

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
  }, 60_000);

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
    const env = {
      DB_STAFF_ACCESS: { connectionString: 'postgresql://nobody@127.0.0.1:1/db-staff-access' },
      AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
    };
    const response = await app.request('/ready', {}, env);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.text()).not.toContain('db-staff-access');
    // /health la liveness: DB chet KHONG duoc lam no do, va no khong duoc
    // chay qua probe — neu khong, orchestrator restart-loop vo ich.
    expect((await app.request('/health', {}, env)).status).toBe(200);
  });

  it('returns 503 when the runtime role can read only a subset of the staff columns', async () => {
    // PostgreSQL chi doi quyen tren MOT cot nao do de `SELECT 1 FROM staff`.
    // Mot role chi con `SELECT(sub)` van qua probe kieu cu trong khi
    // `getStaffBySub` (doc id, sub, display_name, status, created_at,
    // updated_at) bi `permission denied` — readiness 200 gia dung o kieu grant
    // drift ma no ton tai de bat.
    const client = await db.connect();
    try {
      await client.query('REVOKE SELECT ON staff_access.staff FROM ecoma_staff_access_runtime');
      await client.query('GRANT SELECT (sub) ON staff_access.staff TO ecoma_staff_access_runtime');
      resetCachedConfig();
      const app = buildApp();
      const response = await app.request('/ready', {}, runtimeEnv(db));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).not.toContain('staff_access');
    } finally {
      // Tra grant ve dung hinh `0002` de test sau khong an trang thai nay.
      await client.query(
        'REVOKE SELECT (sub) ON staff_access.staff FROM ecoma_staff_access_runtime',
      );
      await client.query('GRANT SELECT ON staff_access.staff TO ecoma_staff_access_runtime');
      await client.end();
    }
  });

  it('returns 503 when the database is migrated only up to 0001 (missing internal_nonces)', async () => {
    // Moi request da xac thuc deu claim nonce trong `staff_access.internal_nonces`
    // (0005). Mot database dung o 0001 van co bang `staff` — probe kieu cu se
    // 200 trong khi moi request that 503/500. Dung container RIENG de khong
    // pha fixture cua cac test khac.
    const partial = await startStaffAccessDatabase();
    try {
      const client = await partial.connect();
      try {
        await client.query('DROP TABLE staff_access.internal_nonces');
      } finally {
        await client.end();
      }
      resetCachedConfig();
      const app = buildApp();
      const response = await app.request('/ready', {}, runtimeEnv(partial));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).not.toContain('internal_nonces');
    } finally {
      await partial.stop();
    }
  }, 180_000);

  it('returns 503 when the roles exist but the migrations have not run', async () => {
    // Nua duong cua mot lan deploy that: database + role da provision nhung
    // schema `staff_access` chua co. `/ready` KHONG duoc 200 — neu probe chi
    // `SELECT 1` thi mot database chua migrate se bao san sang va moi request
    // that se 503 o tang route.
    const unmigrated = await startStaffAccessDatabase({ migrate: false });
    try {
      resetCachedConfig();
      const app = buildApp();
      const response = await app.request('/ready', {}, runtimeEnv(unmigrated));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).not.toContain('staff_access');
    } finally {
      await unmigrated.stop();
    }
  }, 180_000);

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
      nonce: `readiness-${randomUUID()}`,
    });
    const response = await app.request('/staff', { headers: signed }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { staff: Array<{ sub: string; status: string }> };
    expect(body.staff.some((row) => row.sub === STAFF_SUB)).toBe(true);
  });
});
