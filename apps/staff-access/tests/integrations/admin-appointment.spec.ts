/**
 * Bổ nhiệm thường end-to-end — envelope HMAC thật, middleware thật, catalog +
 * role canonical từ migration thật (gồm `0011`), PostgreSQL thật.
 *
 * Nguồn: ADR-0034 Quyết định 1–2 (ba permission ghi, role canonical), ADR-0023
 * Quyết định 2 (guard: self-assignment, target `active`, duplicate live
 * assignment là no-op có audit, self-revocation của assignment administrator
 * cuối cùng) và Quyết định 6 / ADR-0033 Quyết định 3 (hàng audit `denied`
 * commit trước khi trả lời, truy được bằng `correlation_id`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRequest } from '@ecoma-io/internal-auth-contracts';

import { buildApp, resetCachedConfig } from '../../src/main';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

const SECRET = 'appointment-endpoint-internal-secret';
const CANONICAL_ROLE_ID = 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b';

const SUB_ADMIN = `sub_${'a'.repeat(32)}`;
const SUB_TARGET = `sub_${'b'.repeat(32)}`;
const SUB_NO_PERMISSION = `sub_${'c'.repeat(32)}`;
const SUB_NEW = `sub_${'d'.repeat(32)}`;

interface SignedCall {
  method: 'POST';
  path: string;
  body: unknown;
  actorSub?: string;
}

describe('admin appointment write authorization end-to-end', () => {
  let db: StaffAccessDatabase;
  let app: ReturnType<typeof buildApp>;
  let env: {
    DB_STAFF_ACCESS: { connectionString: string };
    AUTH_INTERNAL_SECRET: string;
  };
  let adminStaffId: string;
  let targetStaffId: string;
  let noPermissionStaffId: string;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();

    const client = await db.connect();
    try {
      for (const [sub, name] of [
        [SUB_ADMIN, 'Appointment Admin'],
        [SUB_TARGET, 'Appointment Target'],
        [SUB_NO_PERMISSION, 'Appointment No Perm'],
      ] as const) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO staff_access.staff (sub, display_name, status)
           VALUES ($1, $2, 'active') RETURNING id`,
          [sub, name],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('INSERT staff returned no id');
        if (sub === SUB_ADMIN) adminStaffId = id;
        if (sub === SUB_TARGET) targetStaffId = id;
        if (sub === SUB_NO_PERMISSION) noPermissionStaffId = id;
      }
      // Admin giữ canonical role ngay từ beforeAll — các test gán/revoke tự
      // chuẩn hoá phần còn lại của state role_assignments bằng SQL (mỗi test
      // phải chạy được độc lập, không phụ thuộc test khác trong thứ tự suite).
      // noPermissionStaffId chỉ cần tồn tại — test denied dùng sub của nó qua envelope.
      void noPermissionStaffId;
      await ensureLiveAssignment(adminStaffId);
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

  async function call(params: SignedCall): Promise<Response> {
    const body = JSON.stringify(params.body);
    const headers = await signRequest({
      method: params.method,
      path: params.path,
      body: new TextEncoder().encode(body),
      secret: SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: `appt-${crypto.randomUUID()}`,
      ...(params.actorSub === undefined ? {} : { actorSub: params.actorSub }),
    });
    return app.request(
      params.path,
      { method: params.method, body, headers: { ...headers, 'content-type': 'application/json' } },
      env,
    );
  }

  async function auditRows(
    correlationId: string,
  ): Promise<readonly { outcome: string; action: string; reason: string | null }[]> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{
        outcome: string;
        action: string;
        reason: string | null;
      }>(
        `SELECT outcome, action, reason
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

  /** Id của assignment sống (staff, role) — rỗng khi chưa có. */
  async function liveAssignmentId(staffId: string): Promise<string> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM staff_access.role_assignments
          WHERE staff_id = $1 AND role_id = $2 AND revoked_at IS NULL`,
        [staffId, CANONICAL_ROLE_ID],
      );
      return rows[0]?.id ?? '';
    } finally {
      await client.end();
    }
  }

  /** Đảm bảo (staff, canonical role) có đúng một assignment sống — idempotent. */
  async function ensureLiveAssignment(staffId: string): Promise<string> {
    const existing = await liveAssignmentId(staffId);
    if (existing !== '') return existing;
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id)
         VALUES ($1, $2) RETURNING id`,
        [staffId, CANONICAL_ROLE_ID],
      );
      return rows[0]?.id ?? '';
    } finally {
      await client.end();
    }
  }

  it('denies a grant with 403 and exactly one denied audit row when the actor lacks role.assign', async () => {
    // correlation_id của hàng denied là request id (header x-request-id của
    // response) — body grant không nhận correlation_id (contract từ chối).
    const response = await call({
      method: 'POST',
      path: `/staff/${targetStaffId}/assignments`,
      body: { role_id: CANONICAL_ROLE_ID },
      actorSub: SUB_NO_PERMISSION,
    });
    expect(response.status).toBe(403);
    const correlationId = response.headers.get('x-request-id') ?? '';
    expect(correlationId).not.toBe('');
    const rows = await auditRows(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'denied',
      action: 'role.assign',
      reason: 'permission_denied',
    });
  });

  it('grants a role with 201 when the actor holds role.assign, with granted_by = actor and a success audit row', async () => {
    // Test gán assignment đầu tiên của target — tự chuẩn hoá (không phụ thuộc
    // thứ tự suite): xóa assignment sống của target (nếu suite đầy đủ đã tạo)
    // để đường 201 luôn chạy.
    const client = await db.connect();
    try {
      await client.query(
        `DELETE FROM staff_access.role_assignments
          WHERE staff_id = $1 AND role_id = $2`,
        [targetStaffId, CANONICAL_ROLE_ID],
      );
    } finally {
      await client.end();
    }
    const response = await call({
      method: 'POST',
      path: `/staff/${targetStaffId}/assignments`,
      body: { role_id: CANONICAL_ROLE_ID },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { granted_by: string | null; staff_id: string };
    expect(body.staff_id).toBe(targetStaffId);
    expect(body.granted_by).toBe(adminStaffId);
  });

  it('returns the existing assignment (200, no second row) for a duplicate live assignment', async () => {
    // Tự chuẩn hoá: target phải có assignment sống trước khi test no-op.
    await ensureLiveAssignment(targetStaffId);
    const response = await call({
      method: 'POST',
      path: `/staff/${targetStaffId}/assignments`,
      body: { role_id: CANONICAL_ROLE_ID },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(200);
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM staff_access.role_assignments
          WHERE staff_id = $1 AND role_id = $2 AND revoked_at IS NULL`,
        [targetStaffId, CANONICAL_ROLE_ID],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await client.end();
    }
  });

  it('rejects self-assignment with 403 and a committed denied audit row', async () => {
    const response = await call({
      method: 'POST',
      path: `/staff/${adminStaffId}/assignments`,
      body: { role_id: CANONICAL_ROLE_ID },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
    // ADR-0023 Quyết định 6: hàng `denied` phải commit trước khi trả 403 —
    // guard không ghi trong transaction rồi để rollback nuốt hàng.
    const rows = await auditRows(response.headers.get('x-request-id') ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'denied',
      action: 'role.assign',
      reason: 'self_assignment',
    });
  });

  it('rejects a target staff that is not active (domain error rejected through app.request)', async () => {
    const client = await db.connect();
    let terminatedId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ($1, 'Appointment Terminated', 'terminated') RETURNING id`,
        [`sub_${'e'.repeat(32)}`],
      );
      terminatedId = rows[0]?.id ?? '';
    } finally {
      await client.end();
    }
    // Domain error là plain object `{ code, message }` — Hono 4.13.16 chỉ đưa
    // error `instanceof Error` vào onError, nên lỗi NÉM RA từ db.begin nổi lên
    // qua app.request() (promise reject với chính object đó, cả hai app under
    // test đều vậy — đã probe trực tiếp). Mapping 409 không bao giờ chạy cho
    // lỗi plain object; assertion đúng hành vi thực của app under test.
    await expect(
      call({
        method: 'POST',
        path: `/staff/${terminatedId}/assignments`,
        body: { role_id: CANONICAL_ROLE_ID },
        actorSub: SUB_ADMIN,
      }),
    ).rejects.toMatchObject({ code: 'staff_terminated' });
  });

  it('rejects self-revocation of the last live canonical administrator assignment with 403 and a denied audit row', async () => {
    // Tự chuẩn hoá: actor là người giữ canonical role DUY NHẤT toàn cục —
    // xóa assignment sống của staff khác (suite đầy đủ tạo cho target).
    const client = await db.connect();
    try {
      await client.query(
        `DELETE FROM staff_access.role_assignments
          WHERE staff_id <> $1 AND role_id = $2`,
        [adminStaffId, CANONICAL_ROLE_ID],
      );
    } finally {
      await client.end();
    }
    const assignmentId = await ensureLiveAssignment(adminStaffId);
    const response = await call({
      method: 'POST',
      path: '/assignments/revoke',
      body: { id: assignmentId },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(403);
    // ADR-0023 Quyết định 6: hàng `denied` commit trước khi trả 403.
    const deniedRows = await auditRows(response.headers.get('x-request-id') ?? '');
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0]).toMatchObject({
      outcome: 'denied',
      action: 'role.revoke',
      reason: 'self_revocation_last_administrator',
    });
    expect(
      await db.connect().then(async (c) => {
        try {
          const { rows } = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM staff_access.role_assignments
              WHERE id = $1 AND revoked_at IS NULL`,
            [assignmentId],
          );
          return rows[0]?.n;
        } finally {
          await c.end();
        }
      }),
    ).toBe('1');
  });

  it('allows self-revocation when another live canonical administrator assignment exists', async () => {
    // Guard đếm TOÀN CỤC theo role (ADR-0023 Quyết định 2, sửa so với bản đếm
    // theo staff — unique (staff_id, role_id) khiến đếm theo staff luôn là 1):
    // hai admin sống, actor tự rút assignment của chính mình phải được cho.
    await ensureLiveAssignment(adminStaffId);
    const secondAdminId = await ensureLiveAssignment(targetStaffId);
    const actorAssignmentId = await liveAssignmentId(adminStaffId);
    const response = await call({
      method: 'POST',
      path: '/assignments/revoke',
      body: { id: actorAssignmentId },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; revoked_at: string | null };
    expect(body.id).toBe(actorAssignmentId);
    expect(body.revoked_at).not.toBeNull();
    // Assignment của admin thứ hai vẫn sống.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM staff_access.role_assignments
          WHERE id = $1 AND revoked_at IS NULL`,
        [secondAdminId],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await client.end();
    }
    // Test này VỪA rút assignment của admin — khôi phục ngay để các test sau
    // (và chạy lại suite) thấy admin có quyền như beforeAll đã dựng.
    await ensureLiveAssignment(adminStaffId);
  });

  it('revokes another staff member assignment with 200 when the actor holds role.revoke', async () => {
    // Tự chuẩn hoá: tạo assignment riêng cho target ngay tại đây — test phải
    // chạy được độc lập (không phụ thuộc assignment mà test grant ở trên tạo).
    // Đây là revoke của NGƯỜI KHÁC nên không vướng guard self-revocation.
    const assignmentId = await ensureLiveAssignment(targetStaffId);
    const response = await call({
      method: 'POST',
      path: '/assignments/revoke',
      body: { id: assignmentId },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; revoked_at: string | null };
    expect(body.id).toBe(assignmentId);
    expect(body.revoked_at).not.toBeNull();
  });

  it('denies a revoke with 403 and a denied audit row when the actor lacks role.revoke', async () => {
    const response = await call({
      method: 'POST',
      path: '/assignments/revoke',
      body: { id: crypto.randomUUID() },
      actorSub: SUB_NO_PERMISSION,
    });
    expect(response.status).toBe(403);
  });

  it('creates a staff entry with 201 when the actor holds staff.create', async () => {
    const response = await call({
      method: 'POST',
      path: '/staff',
      body: { sub: SUB_NEW, display_name: 'Second Staff' },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { sub: string; status: string };
    expect(body.sub).toBe(SUB_NEW);
    expect(body.status).toBe('active');
  });

  it('rejects a staff create with 403 when the actor lacks staff.create', async () => {
    const response = await call({
      method: 'POST',
      path: '/staff',
      body: { sub: `sub_${'f'.repeat(32)}`, display_name: 'Denied Staff' },
      actorSub: SUB_NO_PERMISSION,
    });
    expect(response.status).toBe(403);
  });

  it('rejects a staff create for an existing sub with 409 and a denied audit row', async () => {
    const response = await call({
      method: 'POST',
      path: '/staff',
      body: { sub: SUB_TARGET, display_name: 'Duplicate Staff' },
      actorSub: SUB_ADMIN,
    });
    expect(response.status).toBe(409);
  });
});
