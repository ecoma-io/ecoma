/**
 * `POST /authorization/verdict` end-to-end — envelope HMAC thật, middleware
 * thật, catalog + role canonical từ migration thật, PostgreSQL thật.
 *
 * Nguồn: ADR-0033 Quyết định 2–3 (literal `invitation.create`, grant cho role
 * canonical `system-administrator`, hợp đồng verdict) và ADR-0023 Quyết định 6
 * (hàng audit `denied` commit trước khi trả lời, `action`/`target` NOT NULL,
 * truy được bằng `correlation_id` và trả về **đúng một** hàng `denied`).
 *
 * Đây là suite duy nhất chứng minh cả chuỗi: seed migration `0010` → tập
 * permission hiệu lực của staff → verdict → audit. Không truncate: trạng thái
 * mong đợi chính là catalog sau migration, nên truncate sẽ xoá đúng thứ cần
 * chứng minh.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRequest } from '@ecoma-io/internal-auth-contracts';

import { buildApp, resetCachedConfig } from '../../src/main';
import { AUTHORIZATION_VERDICT_PATH } from '../../src/authorization-verdict';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

const SECRET = 'verdict-endpoint-internal-secret';
const PERMISSION = 'invitation.create';
/** Định danh canonical của role `system-administrator` (ADR-0024 Quyết định 5). */
const CANONICAL_ROLE_ID = 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b';

const SUB_ADMIN = `sub_${'a'.repeat(32)}`;
const SUB_VIEWER = `sub_${'b'.repeat(32)}`;
const SUB_WITHOUT_STAFF = `sub_${'c'.repeat(32)}`;
const SUB_REVOKED = `sub_${'d'.repeat(32)}`;

/** `id` của hàng vừa insert — ném khi RETURNING không trả gì (không dùng `!`). */
function firstRowId(rows: readonly { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error('INSERT ... RETURNING id returned no row');
  }
  return row.id;
}

describe('POST /authorization/verdict end-to-end', () => {
  let db: StaffAccessDatabase;
  let app: ReturnType<typeof buildApp>;
  let env: {
    DB_STAFF_ACCESS: { connectionString: string };
    AUTH_INTERNAL_SECRET: string;
  };
  let adminStaffId: string;
  let viewerStaffId: string;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();

    const client = await db.connect();
    try {
      const admin = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ($1, 'Verdict Admin', 'active') RETURNING id`,
        [SUB_ADMIN],
      );
      adminStaffId = firstRowId(admin.rows);
      const viewer = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ($1, 'Verdict Viewer', 'active') RETURNING id`,
        [SUB_VIEWER],
      );
      viewerStaffId = firstRowId(viewer.rows);
      const revoked = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ($1, 'Verdict Revoked', 'active') RETURNING id`,
        [SUB_REVOKED],
      );
      const revokedStaffId = firstRowId(revoked.rows);

      await client.query(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)`,
        [adminStaffId, CANONICAL_ROLE_ID],
      );
      await client.query(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id, revoked_at)
         VALUES ($1, $2, now())`,
        [revokedStaffId, CANONICAL_ROLE_ID],
      );
    } finally {
      await client.end();
    }

    resetCachedConfig();
    app = buildApp();
    env = {
      DB_STAFF_ACCESS: {
        connectionString: `postgresql://ecoma_staff_access_runtime:${db.rolePassword}@${db.host}:${db.port}/db-staff-access`,
      },
      AUTH_INTERNAL_SECRET: SECRET,
    };
  }, 240_000);

  afterAll(async () => {
    await db?.stop();
  });

  /** Ký và gửi một request verdict — nonce mới mỗi lần để không tự biến thành replay. */
  async function verdictRequest(params: {
    body: unknown;
    actorSub?: string;
    secret?: string;
  }): Promise<Response> {
    const body = JSON.stringify(params.body);
    const headers = await signRequest({
      method: 'POST',
      path: AUTHORIZATION_VERDICT_PATH,
      body: new TextEncoder().encode(body),
      secret: params.secret ?? SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: `verdict-${crypto.randomUUID()}`,
      ...(params.actorSub === undefined ? {} : { actorSub: params.actorSub }),
    });
    return app.request(
      AUTHORIZATION_VERDICT_PATH,
      { method: 'POST', body, headers: { ...headers, 'content-type': 'application/json' } },
      env,
    );
  }

  /** Đếm hàng audit theo correlation_id — đúng truy vấn kiểm chứng của ADR-0023 Quyết định 6. */
  async function auditRows(
    correlationId: string,
  ): Promise<
    readonly { outcome: string; action: string; target: string; actor_staff_id: string | null }[]
  > {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{
        outcome: string;
        action: string;
        target: string;
        actor_staff_id: string | null;
      }>(
        `SELECT outcome, action, target, actor_staff_id
           FROM staff_access.authorization_audit
          WHERE correlation_id = $1
          ORDER BY outcome`,
        [correlationId],
      );
      return rows;
    } finally {
      await client.end();
    }
  }

  it('returns allowed for a staff member holding the seeded permission and audits success', async () => {
    const correlationId = crypto.randomUUID();
    const response = await verdictRequest({
      body: { permission: PERMISSION, correlation_id: correlationId },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verdict: 'allowed',
      actor_staff_id: adminStaffId,
    });

    // Hàng audit đã commit khi response về — không phải "sẽ ghi sau".
    expect(await auditRows(correlationId)).toEqual([
      {
        outcome: 'success',
        action: PERMISSION,
        target: adminStaffId,
        actor_staff_id: adminStaffId,
      },
    ]);
  });

  it('returns denied with exactly one denied audit row for a staff member without the permission', async () => {
    const correlationId = crypto.randomUUID();
    const response = await verdictRequest({
      body: { permission: PERMISSION, correlation_id: correlationId },
      actorSub: SUB_VIEWER,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verdict: 'denied',
      actor_staff_id: viewerStaffId,
    });

    const rows = await auditRows(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'denied',
      action: PERMISSION,
      target: viewerStaffId,
      actor_staff_id: viewerStaffId,
    });
  });

  it('denies a permission that exists in no catalog entry for a staff member who holds another one', async () => {
    // Verdict là về **tập hiệu lực của actor**, không phải về sự tồn tại của
    // literal trong catalog: một literal chưa seed không thể là `allowed`.
    const correlationId = crypto.randomUUID();
    const response = await verdictRequest({
      body: { permission: 'role.assign', correlation_id: correlationId },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verdict: 'denied',
      actor_staff_id: adminStaffId,
    });
    expect((await auditRows(correlationId)).map((row) => row.outcome)).toEqual(['denied']);
  });

  it('denies after the assignment is revoked — the verdict is read-time, never cached', async () => {
    const correlationId = crypto.randomUUID();
    const response = await verdictRequest({
      body: { permission: PERMISSION, correlation_id: correlationId },
      actorSub: SUB_REVOKED,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verdict: 'denied',
      actor_staff_id: expect.any(String),
    });
  });

  it('rejects a sub that is not an active staff member with 403 and writes no audit row', async () => {
    // Từ chối danh tính ở middleware là pre-existing behaviour, không phải một
    // verdict permission: không có `staff.id` để làm `target` (ADR-0023 Quyết định 6).
    const correlationId = crypto.randomUUID();
    const response = await verdictRequest({
      body: { permission: PERMISSION, correlation_id: correlationId },
      actorSub: SUB_WITHOUT_STAFF,
    });
    expect(response.status).toBe(403);
    expect(await auditRows(correlationId)).toHaveLength(0);
  });

  it('rejects an envelope without an actor principal with 401 and writes no audit row', async () => {
    const correlationId = crypto.randomUUID();
    const response = await verdictRequest({
      body: { permission: PERMISSION, correlation_id: correlationId },
      actorSub: undefined,
    });
    expect(response.status).toBe(401);
    expect(await auditRows(correlationId)).toHaveLength(0);
  });

  it('rejects an invalid permission or correlation_id with 400 and writes no audit row', async () => {
    const correlationId = crypto.randomUUID();
    const invalidPermission = await verdictRequest({
      body: { permission: 'invitation', correlation_id: correlationId },
      actorSub: SUB_ADMIN,
    });
    expect(invalidPermission.status).toBe(400);

    const missingCorrelation = await verdictRequest({
      body: { permission: PERMISSION },
      actorSub: SUB_ADMIN,
    });
    expect(missingCorrelation.status).toBe(400);
    expect(await auditRows(correlationId)).toHaveLength(0);
  });

  it('rejects unsigned and forged requests with 401', async () => {
    const unsigned = await app.request(
      AUTHORIZATION_VERDICT_PATH,
      {
        method: 'POST',
        body: JSON.stringify({ permission: PERMISSION, correlation_id: crypto.randomUUID() }),
        headers: { 'content-type': 'application/json' },
      },
      env,
    );
    expect(unsigned.status).toBe(401);

    const forged = await verdictRequest({
      body: { permission: PERMISSION, correlation_id: crypto.randomUUID() },
      actorSub: SUB_ADMIN,
      secret: 'wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(forged.status).toBe(401);
  });
});
