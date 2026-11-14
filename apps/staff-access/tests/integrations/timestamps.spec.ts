/**
 * Timestamp trên wire của `staff-access` — issue #252.
 *
 * `postgres.js` parse cột `timestamptz` (OID 1184) thành `Date`, trong khi
 * contract wire đòi chuỗi ISO 8601. Route `GET /staff/:id/assignments` validate
 * object **trong tiến trình** trước khi serialize, nên `Date` làm validator trả
 * `invalid_entry` và route ném lỗi ⇒ 500; các route còn lại chỉ thoát được vì
 * `JSON.stringify` tự chuyển `Date`. Suite này chạy trên PostgreSQL thật
 * (testcontainers) nên bắt được đúng hình dạng runtime của driver — điều mà
 * unit test với row giả lập chuỗi ISO (`src/routes.spec.ts`) không thể bắt.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRequest } from '@ecoma-io/internal-auth-contracts';
import {
  validateAssignmentListResponse,
  validateAuditListResponse,
  validateEntitlementEntry,
  validateEntitlementReadResponse,
  validatePermissionListResponse,
  validateRoleListResponse,
  validateStaffListResponse,
  validateStaffMember,
} from '@ecoma-io/staff-access-contracts';
import { buildApp, resetCachedConfig } from '../../src/main';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

const SECRET = 'timestamps-internal-secret';

/** ISO 8601 có offset tường minh hoặc `Z` — đúng hình dạng contract ghim. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** `Date` thô hoặc chuỗi thiếu offset đều trượt assertion này. */
function expectIso(value: unknown): void {
  expect(value).toEqual(expect.stringMatching(ISO_WITH_OFFSET));
}

/** Sub hợp lệ theo CHECK của schema (`^sub_[a-z2-7]{32}$`). */
const VALID_SUB = `'sub_' || translate(md5(random()::text || clock_timestamp()::text), '0189', 'abcd')`;

describe('ISO timestamps on the staff-access wire surface', () => {
  let db: StaffAccessDatabase;
  let app: ReturnType<typeof buildApp>;
  let env: {
    DB_STAFF_ACCESS: { connectionString: string };
    AUTH_INTERNAL_SECRET: string;
  };
  let staffId = '';
  let staffWithoutAssignmentsId = '';

  /** GET đã ký envelope nội bộ — `path` phải kèm nguyên query string sẽ gửi. */
  async function signedGet(path: string): Promise<Response> {
    const headers = await signRequest({
      method: 'GET',
      path,
      body: undefined,
      secret: SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: `timestamps-${crypto.randomUUID()}`,
    });
    return app.request(path, { method: 'GET', headers }, env);
  }

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
    resetCachedConfig();
    app = buildApp();
    env = {
      DB_STAFF_ACCESS: {
        connectionString: `postgresql://ecoma_staff_access_runtime:${db.rolePassword}@${db.host}:${db.port}/db-staff-access`,
      },
      AUTH_INTERNAL_SECRET: SECRET,
    };

    // Seed bằng superuser: dữ liệu phải đi qua đúng ràng buộc schema, nhưng
    // không phụ thuộc đường ghi runtime (đường đó có audit riêng).
    const client = await db.connect();
    try {
      const staff = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES (${VALID_SUB}, 'Timestamp Staff', 'active') RETURNING id`,
      );
      staffId = staff.rows[0]?.id ?? '';

      const otherStaff = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES (${VALID_SUB}, 'No Assignments Staff', 'active') RETURNING id`,
      );
      staffWithoutAssignmentsId = otherStaff.rows[0]?.id ?? '';

      const role = await client.query<{ id: string }>(
        `INSERT INTO staff_access.roles (name, kind, status)
         VALUES ('timestamp_role_' || md5(random()::text), 'custom', 'active') RETURNING id`,
      );
      const roleId = role.rows[0]?.id ?? '';

      // Cả bốn cột `timestamptz` của assignment đều là NOT NULL có giá trị
      // hoặc nullable có giá trị: đủ để mapper phải chuẩn hoá từng nhánh.
      const assignment = await client.query<{ id: string }>(
        `INSERT INTO staff_access.role_assignments
           (staff_id, role_id, effective_from, effective_until, created_at, revoked_at)
         VALUES ($1, $2, now() - interval '1 day', now() + interval '1 day',
                 now() - interval '2 days', now() - interval '1 hour')
         RETURNING id`,
        [staffId, roleId],
      );
      const assignmentId = assignment.rows[0]?.id ?? '';

      // Hai audit entry để route list có `hasMore` ⇒ nhánh encode cursor
      // (`at` lấy từ `occurred_at`) cũng được chạy.
      await client.query(
        `INSERT INTO staff_access.authorization_audit (target, action, outcome)
         VALUES ($1, 'role_assignment.create', 'success'),
                ($1, 'role_assignment.revoke', 'success')`,
        [assignmentId],
      );

      await client.query(
        `INSERT INTO staff_access.entitlements (staff_id, product, status)
         VALUES ($1, 'backoffice', 'entitled')`,
        [staffId],
      );
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('returns 200 with contract-valid ISO timestamps for a staff member with assignments', async () => {
    const response = await signedGet(`/staff/${staffId}/assignments`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as unknown;
    expect(validateAssignmentListResponse(body)).toMatchObject({ ok: true });

    const { assignments } = body as { assignments: readonly Record<string, unknown>[] };
    expect(assignments).toHaveLength(1);
    const assignment = assignments[0];
    expectIso(assignment?.['created_at']);
    expectIso(assignment?.['effective_from']);
    expectIso(assignment?.['effective_until']);
    expectIso(assignment?.['revoked_at']);
  });

  it('still returns 200 with an empty list when the staff member has no assignment', async () => {
    const response = await signedGet(`/staff/${staffWithoutAssignmentsId}/assignments`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as unknown;
    expect(validateAssignmentListResponse(body)).toMatchObject({ ok: true });
    expect((body as { assignments: readonly unknown[] }).assignments).toEqual([]);
  });

  it('serialises timestamps as ISO strings on every other read route and keeps cursors usable', async () => {
    // Staff list — nhánh cursor lấy `at` từ `created_at`.
    const staffListResponse = await signedGet('/staff?limit=1');
    expect(staffListResponse.status).toBe(200);
    const staffList = (await staffListResponse.json()) as unknown;
    expect(validateStaffListResponse(staffList)).toMatchObject({ ok: true });
    for (const entry of (staffList as { staff: readonly Record<string, unknown>[] }).staff) {
      expectIso(entry['created_at']);
      expectIso(entry['updated_at']);
    }
    const staffCursor = (staffList as { next_cursor: string | null }).next_cursor;
    expect(staffCursor).toEqual(expect.any(String));
    const nextStaffPage = await signedGet(`/staff?limit=1&cursor=${String(staffCursor)}`);
    expect(nextStaffPage.status).toBe(200);
    expect(validateStaffListResponse(await nextStaffPage.json())).toMatchObject({ ok: true });

    // Staff detail.
    const staffDetailResponse = await signedGet(`/staff/${staffId}`);
    expect(staffDetailResponse.status).toBe(200);
    const staffDetail = (await staffDetailResponse.json()) as unknown;
    expect(validateStaffMember(staffDetail)).toMatchObject({ ok: true });
    expectIso((staffDetail as Record<string, unknown>)['created_at']);
    expectIso((staffDetail as Record<string, unknown>)['updated_at']);

    // Role catalog.
    const roleListResponse = await signedGet('/roles');
    expect(roleListResponse.status).toBe(200);
    const roleList = (await roleListResponse.json()) as unknown;
    expect(validateRoleListResponse(roleList)).toMatchObject({ ok: true });
    for (const entry of (roleList as { roles: readonly Record<string, unknown>[] }).roles) {
      expectIso(entry['created_at']);
    }

    // Permission catalog (seed của migration là dữ liệu thật trong DB).
    const permissionListResponse = await signedGet('/permissions');
    expect(permissionListResponse.status).toBe(200);
    const permissionList = (await permissionListResponse.json()) as unknown;
    expect(validatePermissionListResponse(permissionList)).toMatchObject({ ok: true });
    const permissions = (permissionList as { permissions: readonly Record<string, unknown>[] })
      .permissions;
    expect(permissions.length).toBeGreaterThan(0);
    for (const entry of permissions) {
      expectIso(entry['created_at']);
    }

    // Audit list — nhánh cursor lấy `at` từ `occurred_at`.
    const auditListResponse = await signedGet('/audit/entries?limit=1');
    expect(auditListResponse.status).toBe(200);
    const auditList = (await auditListResponse.json()) as unknown;
    expect(validateAuditListResponse(auditList)).toMatchObject({ ok: true });
    for (const entry of (auditList as { entries: readonly Record<string, unknown>[] }).entries) {
      expectIso(entry['occurred_at']);
    }
    const auditCursor = (auditList as { next_cursor: string | null }).next_cursor;
    expect(auditCursor).toEqual(expect.any(String));
    const nextAuditPage = await signedGet(`/audit/entries?limit=1&cursor=${String(auditCursor)}`);
    expect(nextAuditPage.status).toBe(200);
    expect(validateAuditListResponse(await nextAuditPage.json())).toMatchObject({ ok: true });

    // Entitlement read model — cả list và single entry.
    const entitlementListResponse = await signedGet(`/staff/${staffId}/entitlements`);
    expect(entitlementListResponse.status).toBe(200);
    const entitlementList = (await entitlementListResponse.json()) as unknown;
    expect(validateEntitlementReadResponse(entitlementList)).toMatchObject({ ok: true });
    const entitlements = (entitlementList as { entitlements: readonly Record<string, unknown>[] })
      .entitlements;
    expect(entitlements).toHaveLength(1);
    for (const entry of entitlements) {
      expectIso(entry['occurred_at']);
    }

    const entitlementResponse = await signedGet(`/staff/${staffId}/entitlements/backoffice`);
    expect(entitlementResponse.status).toBe(200);
    const entitlement = (await entitlementResponse.json()) as unknown;
    expect(validateEntitlementEntry(entitlement)).toMatchObject({ ok: true });
    expectIso((entitlement as Record<string, unknown>)['occurred_at']);
  });
});
