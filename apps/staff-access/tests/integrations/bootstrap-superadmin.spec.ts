/**
 * Bootstrap S1/S2/S3 của Staff Access trên PostgreSQL thật.
 *
 * Source of truth:
 * - docs/domains/staff-access/adr/0021-first-admin-bootstrap-path.md
 * - docs/domains/staff-access/adr/0022-measured-first-admin-guard.md
 * - docs/domains/staff-access/adr/0023-administrator-lifecycle-paths.md Quyết định 6
 * - docs/domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md Quyết định 5
 * - docs/applications/staff-access/03-operations.md §2 Bước 5–8
 *
 * ⚠️ Không có `describe.skipIf`: thiếu Docker thì `globalSetup` ném và toàn bộ lần chạy
 * đỏ (06-testing.md §6). Suite này chạy bằng credential migrator thật, đúng bề mặt
 * offline mà CLI dùng (`pg_advisory_xact_lock` không chạy qua Hyperdrive).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assignBootstrapAdministrator,
  type BootstrapDeniedError,
  type BootstrapStaffInput,
  provisionBootstrapStaff,
  verifyBootstrapStaff,
} from '../../db/bootstrap.mts';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

const APP_ROOT = resolve(import.meta.dirname, '../..');
const TSX_BIN = resolve(APP_ROOT, '../../node_modules/.bin/tsx');

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `sub` hợp lệ: `sub_` + 32 ký tự base32 thường (khớp `isStaffSubFormat`). */
function randomSub(): string {
  const bytes = randomBytes(32);
  let suffix = '';
  for (const byte of bytes) {
    suffix += BASE32[byte % 32];
  }
  return `sub_${suffix}`;
}

function bootstrapInput(overrides: Partial<BootstrapStaffInput> = {}): BootstrapStaffInput {
  return {
    correlationId: `corr_${randomBytes(8).toString('hex')}`,
    operatorRef: 'CHG-TEST-0001',
    sub: randomSub(),
    ...overrides,
  };
}

/** Xoá dữ liệu nghiệp vụ giữa các test — audit append-only nên vẫn tích luỹ. */
async function resetBusinessRows(db: StaffAccessDatabase): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('DELETE FROM staff_access.role_assignments');
    await client.query('DELETE FROM staff_access.staff');
  } finally {
    await client.end();
  }
}

async function countRows(
  db: StaffAccessDatabase,
  table:
    | 'staff'
    | 'roles'
    | 'role_assignments'
    | 'role_permissions'
    | 'permissions'
    | 'authorization_audit',
): Promise<number> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM staff_access.${table}`,
    );
    return Number(rows[0]?.count ?? '0');
  } finally {
    await client.end();
  }
}

interface AuditRow {
  readonly target: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly correlation_id: string;
  readonly context: Record<string, unknown>;
}

async function auditRowsFor(db: StaffAccessDatabase, correlationId: string): Promise<AuditRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<AuditRow>(
      `SELECT target, action, outcome, reason, correlation_id, context
         FROM staff_access.authorization_audit
        WHERE correlation_id = $1
        ORDER BY occurred_at, id`,
      [correlationId],
    );
    return rows;
  } finally {
    await client.end();
  }
}

/** Chạy một bước và trả mã lý do từ chối; fail nếu bước đó lại thành công. */
async function expectDenied(promise: Promise<unknown>): Promise<BootstrapDeniedError['reason']> {
  try {
    await promise;
  } catch (error) {
    const reason = (error as { reason?: string }).reason;
    if (reason === undefined) {
      throw error;
    }
    return reason as BootstrapDeniedError['reason'];
  }
  throw new Error('expected the step to be denied, but it succeeded');
}

// ---------------------------------------------------------------------------
// 1 + 2. Catalog, seed và uniqueness — container riêng
// ---------------------------------------------------------------------------

describe('migrations, canonical seed and uniqueness constraints', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('seeds exactly one canonical role and exactly four read permissions', async () => {
    const client = await db.connect();
    try {
      const roles = await client.query<{ id: string; kind: string; name: string; status: string }>(
        `SELECT id, kind, name, status FROM staff_access.roles`,
      );
      expect(roles.rows).toEqual([
        {
          id: 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b',
          kind: 'system',
          name: 'system-administrator',
          status: 'active',
        },
      ]);

      const permissions = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM staff_access.permissions ORDER BY id`,
      );
      expect(permissions.rows).toEqual([
        { id: 'audit.read', status: 'active' },
        { id: 'permission.read', status: 'active' },
        { id: 'role.read', status: 'active' },
        { id: 'staff.read', status: 'active' },
      ]);

      const rolePermissions = await client.query<{ permission_id: string }>(
        `SELECT permission_id FROM staff_access.role_permissions ORDER BY permission_id`,
      );
      expect(rolePermissions.rows.map((row) => row.permission_id)).toEqual([
        'audit.read',
        'permission.read',
        'role.read',
        'staff.read',
      ]);
    } finally {
      await client.end();
    }
  });

  it('creates UNIQUE (kind, name) on roles and the live-assignment partial unique index', async () => {
    const client = await db.connect();
    try {
      const constraint = await client.query<{ contype: string; cols: string[] }>(
        `SELECT c.contype::text AS contype,
                array_agg(a.attname::text ORDER BY a.attname::text) AS cols
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_catalog.pg_attribute a
             ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey::int2[])
          WHERE n.nspname = 'staff_access'
            AND t.relname = 'roles'
            AND c.contype = 'u'
          GROUP BY c.contype, c.conname`,
      );
      expect(constraint.rows.some((row) => row.cols.join(',') === 'kind,name')).toBe(true);

      const index = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'staff_access'
            AND tablename = 'role_assignments'
            AND indexname = 'role_assignments_active_unique_idx'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0]?.indexdef).toContain('(staff_id, role_id)');
      expect(index.rows[0]?.indexdef).toContain('revoked_at IS NULL');

      const seedCounts = await client.query<{ roles: string; permissions: string }>(
        `SELECT (SELECT count(*)::text FROM staff_access.roles) AS roles,
                (SELECT count(*)::text FROM staff_access.permissions) AS permissions`,
      );
      expect(seedCounts.rows[0]).toEqual({ roles: '1', permissions: '4' });
    } finally {
      await client.end();
    }
  });

  it('rejects a duplicate (kind, name) role and two live assignments for the same pair', async () => {
    const client = await db.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO staff_access.roles (kind, name, status)
           VALUES ('system', 'system-administrator', 'active')`,
        ),
      ).rejects.toThrow(/roles_kind_name_unique|duplicate key/iu);

      const staff = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ($1, 'Uniqueness Staff', 'active') RETURNING id`,
        [randomSub()],
      );
      const staffId = staff.rows[0]?.id ?? '';
      const role = await client.query<{ id: string }>(
        `SELECT id FROM staff_access.roles WHERE kind = 'system' AND name = 'system-administrator'`,
      );
      const roleId = role.rows[0]?.id ?? '';

      await client.query(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)`,
        [staffId, roleId],
      );
      await expect(
        client.query(
          `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)`,
          [staffId, roleId],
        ),
      ).rejects.toThrow(/role_assignments_active_unique_idx|duplicate key/iu);

      // Hàng đã revoke không chiếm index: gán lại sau revoke là hợp lệ ở tầng schema.
      const assignment = await client.query<{ id: string }>(
        `SELECT id FROM staff_access.role_assignments WHERE staff_id = $1 AND role_id = $2`,
        [staffId, roleId],
      );
      await client.query(
        `UPDATE staff_access.role_assignments SET revoked_at = now() WHERE id = $1`,
        [assignment.rows[0]?.id],
      );
      await expect(
        client.query(
          `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)`,
          [staffId, roleId],
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it('keeps the permission catalog sealed: the runtime role cannot insert a new permission', async () => {
    // Tên test trước đây nói "seed từ chối permission lạ" nhưng lại assert một
    // INSERT **thành công** bằng superuser — nó không chứng minh gì về seal.
    // Seal thật là: ghi vào catalog chỉ migrator làm được (0008 mục 4).
    const runtime = await db.asRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO staff_access.permissions (id, domain, action, status)
           VALUES ('role.assign', 'role', 'assign', 'active')`,
        ),
      ).rejects.toThrow(/permission denied|insufficient privilege/iu);
    } finally {
      await runtime.end();
    }

    // Và catalog vẫn đúng bốn permission sau lần thử đó.
    const client = await db.connect();
    try {
      const permissions = await client.query<{ id: string }>(
        `SELECT id FROM staff_access.permissions ORDER BY id`,
      );
      expect(permissions.rows.map((row) => row.id)).toEqual([
        'audit.read',
        'permission.read',
        'role.read',
        'staff.read',
      ]);
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 3 + 6 + 7 + 9. S1/S2/S3 behavior, denial audit, re-run semantics, read-only S3
// ---------------------------------------------------------------------------

describe('bootstrap steps against the canonical seed', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('S1 creates one active staff row with an empty display_name and never writes email', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    try {
      const result = await provisionBootstrapStaff(client, input);
      expect(result.stage).toBe('staff.provision');
      expect(result.status).toBe('created');

      const { rows } = await client.query<{
        id: string;
        sub: string;
        display_name: string;
        status: string;
      }>(`SELECT id, sub, display_name, status FROM staff_access.staff WHERE sub = $1`, [
        input.sub,
      ]);
      expect(rows).toEqual([
        { id: result.staffId, sub: input.sub, display_name: '', status: 'active' },
      ]);

      const audit = await auditRowsFor(db, input.correlationId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        target: result.staffId,
        action: 'staff.provision',
        outcome: 'success',
        reason: null,
      });
      expect(audit[0]?.context).toMatchObject({
        mode: 'bootstrap',
        operator_ref: input.operatorRef,
        admins_before: 0,
        admins_ever: 0,
        step: 'staff.provision',
      });
      expect(audit[0]?.context).not.toHaveProperty('noop');
    } finally {
      await client.end();
    }
  });

  it('S1 converges on an existing active staff and records a noop audit row', async () => {
    await resetBusinessRows(db);
    const first = bootstrapInput();
    const second = bootstrapInput({ sub: first.sub });

    const client = await db.connectAsMigrator();
    try {
      const created = await provisionBootstrapStaff(client, first);
      const converged = await provisionBootstrapStaff(client, second);
      expect(converged.status).toBe('converged');
      expect(converged.staffId).toBe(created.staffId);
      expect(await countRows(db, 'staff')).toBe(1);

      const audit = await auditRowsFor(db, second.correlationId);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.context).toMatchObject({ noop: true, admins_before: 0, admins_ever: 0 });
    } finally {
      await client.end();
    }
  });

  it('S1 denies a suspended and a terminated staff without reactivating either', async () => {
    await resetBusinessRows(db);
    const superuser = await db.connect();
    try {
      for (const status of ['suspended', 'terminated'] as const) {
        const input = bootstrapInput();
        const createdAt = new Date(Date.now() - 60_000);
        await superuser.query(
          `INSERT INTO staff_access.staff (sub, display_name, status, created_at, updated_at)
           VALUES ($1, '', $2, $3, $3)`,
          [input.sub, status, createdAt],
        );

        const client = await db.connectAsMigrator();
        try {
          expect(await expectDenied(provisionBootstrapStaff(client, input))).toBe(
            'staff_not_active',
          );
        } finally {
          await client.end();
        }

        const { rows } = await superuser.query<{ status: string }>(
          `SELECT status FROM staff_access.staff WHERE sub = $1`,
          [input.sub],
        );
        expect(rows[0]?.status).toBe(status);

        const audit = await auditRowsFor(db, input.correlationId);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          outcome: 'denied',
          reason: 'staff_not_active',
          action: 'role_assignment.create',
        });
      }
    } finally {
      await superuser.end();
    }
  });

  it('S2 resolves staff from sub, creates one assignment, and a re-run is denied mode_mismatch', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    try {
      const provisioned = await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);
      expect(assigned.stage).toBe('staff.assign');
      expect(assigned.status).toBe('created');
      expect(assigned.staffId).toBe(provisioned.staffId);
      expect(assigned.assignmentId).toBeDefined();

      const { rows } = await client.query<{
        staff_id: string;
        role_id: string;
        granted_by: string | null;
      }>(`SELECT staff_id, role_id, granted_by FROM staff_access.role_assignments WHERE id = $1`, [
        assigned.assignmentId,
      ]);
      expect(rows[0]).toEqual({
        staff_id: provisioned.staffId,
        role_id: 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b',
        granted_by: null,
      });

      const audit = await auditRowsFor(db, input.correlationId);
      expect(audit.map((row) => row.action).toSorted()).toEqual([
        'staff.assign',
        'staff.provision',
      ]);

      // Chạy lại sau khi S2 đã commit: guard đo admins_before = 1, admins_ever = 1.
      const rerun = bootstrapInput({ sub: input.sub });
      let denied: BootstrapDeniedError['reason'] | undefined;
      try {
        await assignBootstrapAdministrator(client, rerun);
      } catch (error) {
        denied = (error as BootstrapDeniedError).reason;
      }
      expect(denied).toBe('mode_mismatch');
      expect(await countRows(db, 'role_assignments')).toBe(1);

      const deniedAudit = await auditRowsFor(db, rerun.correlationId);
      expect(deniedAudit).toHaveLength(1);
      expect(deniedAudit[0]).toMatchObject({
        outcome: 'denied',
        reason: 'mode_mismatch',
        // Guard từ chối ở bước đo, **trước** khi transaction này phân giải `staff.id`;
        // ADR-0023 Quyết định 6 chốt `target` là giá trị identity đã dùng để tra trong
        // trường hợp đó, không phải id mà lần chạy trước đã trả về.
        target: rerun.sub,
      });
      expect(deniedAudit[0]?.context).toMatchObject({
        mode: 'bootstrap',
        operator_ref: rerun.operatorRef,
        admins_before: 1,
        admins_ever: 1,
        step: 'staff.assign',
      });

      // Số ghi trên row `denied` phải khớp phép đo trực tiếp — đây là bằng chứng phân
      // loại "đã có administrator" với "một lần chạy khác vừa thắng race" (ADR-0022).
      const measured = await client.query<{ admins_before: number; admins_ever: number }>(
        `SELECT (SELECT count(DISTINCT ra.staff_id)
                   FROM staff_access.role_assignments ra
                   JOIN staff_access.roles r ON r.id = ra.role_id
                   JOIN staff_access.staff s ON s.id = ra.staff_id
                  WHERE r.kind = 'system' AND r.name = 'system-administrator'
                    AND r.status = 'active' AND s.status = 'active'
                    AND ra.revoked_at IS NULL
                    AND (ra.effective_from IS NULL OR ra.effective_from <= now())
                    AND (ra.effective_until IS NULL OR ra.effective_until > now()))::int
                  AS admins_before,
                (SELECT count(*)
                   FROM staff_access.role_assignments ra
                   JOIN staff_access.roles r ON r.id = ra.role_id
                  WHERE r.kind = 'system' AND r.name = 'system-administrator')::int
                  AS admins_ever`,
      );
      expect(deniedAudit[0]?.context['admins_before']).toBe(measured.rows[0]?.admins_before);
      expect(deniedAudit[0]?.context['admins_ever']).toBe(measured.rows[0]?.admins_ever);
    } finally {
      await client.end();
    }
  });

  it('a revoked administrator is never re-granted by a bootstrap re-run', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    const superuser = await db.connect();
    try {
      await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);
      await superuser.query(
        `UPDATE staff_access.role_assignments SET revoked_at = now() WHERE id = $1`,
        [assigned.assignmentId],
      );

      const rerun = bootstrapInput({ sub: input.sub });
      expect(await expectDenied(assignBootstrapAdministrator(client, rerun))).toBe('mode_mismatch');

      const live = await superuser.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM staff_access.role_assignments
          WHERE staff_id = $1 AND revoked_at IS NULL`,
        [assigned.staffId],
      );
      expect(live.rows[0]?.count).toBe('0');

      const audit = await auditRowsFor(db, rerun.correlationId);
      expect(audit[0]?.context).toMatchObject({ admins_before: 0, admins_ever: 1 });
    } finally {
      await superuser.end();
      await client.end();
    }
  });

  it('commits the denial audit outside the rolled-back guard transaction, exactly once', async () => {
    await resetBusinessRows(db);
    const setup = bootstrapInput();
    const client = await db.connectAsMigrator();
    try {
      await provisionBootstrapStaff(client, setup);
      await assignBootstrapAdministrator(client, setup);

      const deniedInput = bootstrapInput();
      expect(await expectDenied(provisionBootstrapStaff(client, deniedInput))).toBe(
        'mode_mismatch',
      );

      // Transaction guard rollback không cuốn theo audit row.
      const audit = await auditRowsFor(db, deniedInput.correlationId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        outcome: 'denied',
        reason: 'mode_mismatch',
        action: 'role_assignment.create',
      });
      expect(audit[0]?.context).toMatchObject({
        mode: 'bootstrap',
        operator_ref: deniedInput.operatorRef,
        admins_before: 1,
        admins_ever: 1,
        step: 'staff.provision',
      });

      // Không có hàng nghiệp vụ nào của lần bị từ chối.
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM staff_access.staff WHERE sub = $1`,
        [deniedInput.sub],
      );
      expect(rows[0]?.count).toBe('0');

      // Đúng một row cho correlation id đó — gọi lại cùng correlation không nhân bản.
      expect(await auditRowsFor(db, deniedInput.correlationId)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it('S3 verifies a completed run, requires correlation_id for the audit check, and writes nothing', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    const superuser = await db.connect();
    try {
      await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);

      const snapshotBefore = await superuser.query<{ snapshot: Record<string, string> }>(
        `SELECT jsonb_build_object(
                  'staff', (SELECT count(*) FROM staff_access.staff),
                  'roles', (SELECT count(*) FROM staff_access.roles),
                  'assignments', (SELECT count(*) FROM staff_access.role_assignments),
                  'permissions', (SELECT count(*) FROM staff_access.permissions),
                  'role_permissions', (SELECT count(*) FROM staff_access.role_permissions),
                  'staff_updated_at', (SELECT max(updated_at)::text FROM staff_access.staff),
                  'audit', (SELECT count(*) FROM staff_access.authorization_audit)
                ) AS snapshot`,
      );

      const verification = await verifyBootstrapStaff(client, {
        sub: input.sub,
        correlationId: input.correlationId,
      });
      expect(verification.ok).toBe(true);
      expect(verification.staffId).toBe(assigned.staffId);
      expect(verification.checks.map((check) => check.check).toSorted()).toEqual([
        'assignment',
        'audit',
        'permissions',
        'role',
        'staff',
      ]);
      expect(verification.reasons).toEqual([]);

      // Không có correlationId: kiểm tra audit bị bỏ, phần còn lại vẫn đạt.
      const withoutAudit = await verifyBootstrapStaff(client, { sub: input.sub });
      expect(withoutAudit.ok).toBe(true);
      expect(withoutAudit.checks.map((check) => check.check)).not.toContain('audit');

      // Sai correlationId: kiểm tra audit trượt với mã riêng, không phải mode_mismatch.
      const wrongCorrelation = await verifyBootstrapStaff(client, {
        sub: input.sub,
        correlationId: 'corr_missing',
      });
      expect(wrongCorrelation.ok).toBe(false);
      expect(wrongCorrelation.reasons).toContain('audit_trail_missing');

      const snapshotAfter = await superuser.query<{ snapshot: Record<string, string> }>(
        `SELECT jsonb_build_object(
                  'staff', (SELECT count(*) FROM staff_access.staff),
                  'roles', (SELECT count(*) FROM staff_access.roles),
                  'assignments', (SELECT count(*) FROM staff_access.role_assignments),
                  'permissions', (SELECT count(*) FROM staff_access.permissions),
                  'role_permissions', (SELECT count(*) FROM staff_access.role_permissions),
                  'staff_updated_at', (SELECT max(updated_at)::text FROM staff_access.staff),
                  'audit', (SELECT count(*) FROM staff_access.authorization_audit)
                ) AS snapshot`,
      );
      expect(snapshotAfter.rows[0]?.snapshot).toEqual(snapshotBefore.rows[0]?.snapshot);
    } finally {
      await superuser.end();
      await client.end();
    }
  });

  it('S3 requires exactly one success audit row per step, not merely one of each action', async () => {
    // Audit là append-only (trigger chặn UPDATE/DELETE) nên hàng trùng không dọn
    // được — dùng một correlation id riêng để phần còn lại của suite không thấy nó.
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    const superuser = await db.connect();
    try {
      await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);

      await superuser.query(
        `INSERT INTO staff_access.authorization_audit
           (actor_staff_id, actor_sub, target, action, outcome, correlation_id, context)
         VALUES (NULL, NULL, $1, 'staff.assign', 'success', $2, '{}'::jsonb)`,
        [assigned.assignmentId, input.correlationId],
      );

      const duplicated = await verifyBootstrapStaff(client, {
        sub: input.sub,
        correlationId: input.correlationId,
      });
      expect(duplicated.ok).toBe(false);
      expect(duplicated.reasons).toEqual(['audit_trail_missing']);
    } finally {
      await superuser.end();
      await client.end();
    }
  });

  it('S3 verifies the staff of the bootstrapped sub when unrelated non-admin staff already exist', async () => {
    // Runbook Bước 8 kiểm 1 đọc staff theo `sub`, không đếm toàn bảng. Một
    // environment có staff không phải administrator từ trước là trạng thái hợp
    // lệ, và một S3 đếm toàn bảng sẽ từ chối oan — hoặc tệ hơn, xác nhận nhầm
    // staff của người khác là staff vừa bootstrap.
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const unrelated = [randomSub(), randomSub()];
    const superuser = await db.connect();
    const client = await db.connectAsMigrator();
    try {
      for (const sub of unrelated) {
        await superuser.query(
          `INSERT INTO staff_access.staff (sub, display_name, status) VALUES ($1, '', 'active')`,
          [sub],
        );
      }

      await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);

      const verification = await verifyBootstrapStaff(client, {
        sub: input.sub,
        correlationId: input.correlationId,
      });
      expect(verification.ok).toBe(true);
      expect(verification.staffId).toBe(assigned.staffId);
      expect(verification.reasons).toEqual([]);
      expect(unrelated).not.toContain(verification.staffId);

      // S3 không được nhận một `sub` khác có staff active: đó là staff của người
      // khác, dù nó tồn tại và `active`.
      const otherStaff = await verifyBootstrapStaff(client, { sub: unrelated[0] });
      expect(otherStaff.ok).toBe(false);
      expect(otherStaff.reasons).toContain('administrator_assignment_missing');

      // Một `sub` không có staff vẫn fail-closed, không rơi về hàng nào khác.
      const unknownSub = await verifyBootstrapStaff(client, { sub: randomSub() });
      expect(unknownSub.ok).toBe(false);
      expect(unknownSub.reasons).toContain('staff_missing_or_ambiguous');
      expect(unknownSub.staffId).toBeUndefined();
    } finally {
      await client.end();
      await superuser.end();
    }
  });

  it('S3 fails closed when sub is missing or malformed instead of guessing a staff row', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    try {
      await provisionBootstrapStaff(client, input);
      await assignBootstrapAdministrator(client, input);

      for (const sub of [undefined, '', 'not-a-sub']) {
        const verification = await verifyBootstrapStaff(client, sub === undefined ? {} : { sub });
        expect(verification.ok).toBe(false);
        expect(verification.reasons).toEqual(['invalid_sub']);
        expect(verification.staffId).toBeUndefined();
        // Chỉ kiểm 1 chạy: không có câu đọc nào được thực hiện trước khi fail.
        expect(verification.checks).toEqual([{ check: 'staff', ok: false, reason: 'invalid_sub' }]);
      }
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Measured values and concurrency
// ---------------------------------------------------------------------------

describe('measured guard and concurrency', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('denies bootstrap after revocation with admins_before = 0 and admins_ever > 0', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    const superuser = await db.connect();
    try {
      await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);
      await superuser.query(
        `UPDATE staff_access.role_assignments SET revoked_at = now() WHERE id = $1`,
        [assigned.assignmentId],
      );

      const rerun = bootstrapInput({ sub: input.sub });
      expect(await expectDenied(provisionBootstrapStaff(client, rerun))).toBe('mode_mismatch');

      const audit = await auditRowsFor(db, rerun.correlationId);
      expect(audit[0]?.context).toMatchObject({ admins_before: 0, admins_ever: 1 });
    } finally {
      await superuser.end();
      await client.end();
    }
  });

  it('denies bootstrap when the assignment has expired but was never revoked', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const client = await db.connectAsMigrator();
    const superuser = await db.connect();
    try {
      await provisionBootstrapStaff(client, input);
      const assigned = await assignBootstrapAdministrator(client, input);
      await superuser.query(
        `UPDATE staff_access.role_assignments
            SET effective_from = now() - interval '2 hours',
                effective_until = now() - interval '1 hour'
          WHERE id = $1`,
        [assigned.assignmentId],
      );

      const rerun = bootstrapInput({ sub: input.sub });
      expect(await expectDenied(assignBootstrapAdministrator(client, rerun))).toBe('mode_mismatch');

      // Không nhân bản: vẫn đúng một hàng assignment.
      const { rows } = await superuser.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM staff_access.role_assignments WHERE staff_id = $1`,
        [assigned.staffId],
      );
      expect(rows[0]?.count).toBe('1');

      const audit = await auditRowsFor(db, rerun.correlationId);
      expect(audit[0]?.context).toMatchObject({ admins_before: 0, admins_ever: 1 });
    } finally {
      await superuser.end();
      await client.end();
    }
  });

  it('serializes two parallel bootstrap runs: exactly one becomes administrator', async () => {
    await resetBusinessRows(db);
    const input = bootstrapInput();
    const first = await db.connectAsMigrator();
    const second = await db.connectAsMigrator();
    try {
      const provisionResults = await Promise.allSettled([
        provisionBootstrapStaff(first, input),
        provisionBootstrapStaff(second, input),
      ]);
      expect(provisionResults.every((result) => result.status === 'fulfilled')).toBe(true);

      const assignResults = await Promise.allSettled([
        assignBootstrapAdministrator(first, input),
        assignBootstrapAdministrator(second, input),
      ]);
      const fulfilled = assignResults.filter((result) => result.status === 'fulfilled');
      const rejected = assignResults.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        reason: 'mode_mismatch',
      });

      expect(await countRows(db, 'staff')).toBe(1);
      expect(await countRows(db, 'role_assignments')).toBe(1);

      const live = await db.connect();
      try {
        const { rows } = await live.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM staff_access.role_assignments
            WHERE staff_id = $1 AND role_id = $2 AND revoked_at IS NULL`,
          [
            (fulfilled[0] as PromiseFulfilledResult<{ staffId: string }>).value.staffId,
            'eeb3abcb-31ef-479f-9dd1-198a9d520b1b',
          ],
        );
        expect(rows[0]?.count).toBe('1');
      } finally {
        await live.end();
      }
    } finally {
      await first.end();
      await second.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Role identity failures
// ---------------------------------------------------------------------------

describe('role identity failures', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('denies role_identity_ambiguous when two canonical rows resolve', async () => {
    const superuser = await db.connect();
    try {
      // Ràng buộc UNIQUE (kind, name) là yêu cầu schema; nhánh phòng thủ của guard vẫn
      // phải đúng nếu dữ liệu vi phạm nó (một lần restore từ backup, một lần sửa tay).
      await superuser.query(
        `ALTER TABLE staff_access.roles DROP CONSTRAINT roles_kind_name_unique`,
      );
      await superuser.query(
        `INSERT INTO staff_access.roles (id, kind, name, status)
         VALUES ('11111111-1111-4111-8111-111111111111', 'system', 'system-administrator', 'active')`,
      );

      const input = bootstrapInput();
      const client = await db.connectAsMigrator();
      try {
        expect(await expectDenied(provisionBootstrapStaff(client, input))).toBe(
          'role_identity_ambiguous',
        );

        const audit = await auditRowsFor(db, input.correlationId);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          outcome: 'denied',
          reason: 'role_identity_ambiguous',
          target: input.sub,
        });
        // Bị từ chối trước phép đo: không bịa số đo.
        expect(audit[0]?.context).not.toHaveProperty('admins_before');
        expect(audit[0]?.context).not.toHaveProperty('admins_ever');
      } finally {
        await client.end();
      }
    } finally {
      // Dọn để container không ở trạng thái vi phạm constraint cho test sau:
      // xoá hàng trùng TRƯỚC, rồi mới thêm lại constraint (thêm trước sẽ luôn
      // fail và bị nuốt, để schema thiếu ràng buộc cho phần còn lại của suite).
      await superuser.query(
        `DELETE FROM staff_access.roles WHERE id = '11111111-1111-4111-8111-111111111111'`,
      );
      await superuser.query(
        `ALTER TABLE staff_access.roles ADD CONSTRAINT roles_kind_name_unique UNIQUE (kind, name)`,
      );
      await superuser.end();
    }
  });

  it('denies role_identity_missing when the canonical role was removed', async () => {
    const superuser = await db.connect();
    try {
      await superuser.query(`DELETE FROM staff_access.role_permissions`);
      await superuser.query(`DELETE FROM staff_access.roles`);

      const input = bootstrapInput();
      const client = await db.connectAsMigrator();
      try {
        expect(await expectDenied(provisionBootstrapStaff(client, input))).toBe(
          'role_identity_missing',
        );
        const audit = await auditRowsFor(db, input.correlationId);
        expect(audit[0]).toMatchObject({ outcome: 'denied', reason: 'role_identity_missing' });
      } finally {
        await client.end();
      }
    } finally {
      await superuser.end();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI wire shapes — stdout/stderr JSON đúng literal mà `tools/dx` parse
// ---------------------------------------------------------------------------

describe('CLI wire shapes', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  // Mỗi test CLI bắt đầu từ environment "chưa từng có administrator": audit là
  // append-only nên chỉ xoá dữ liệu nghiệp vụ. Không dọn thì `admins_ever` tích luỹ qua
  // các test và mọi lần chạy đều bị guard từ chối.
  beforeEach(async () => {
    await resetBusinessRows(db);
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function runCli(
    action: 'staff-provision' | 'staff-assign' | 'staff-verify',
    stdin: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const databaseUrl = `postgresql://ecoma_staff_access_migrator:${db.rolePassword}@${db.host}:${db.port}/db-staff-access`;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(TSX_BIN, ['--tsconfig', 'tsconfig.db.json', 'db/bootstrap.mts', action], {
        cwd: APP_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.end(JSON.stringify(stdin));
    });
  }

  it('emits the exact stdout envelope for provision, assign and verify', async () => {
    const sub = randomSub();
    const correlationId = `corr_${randomBytes(8).toString('hex')}`;
    const base = { correlation_id: correlationId, operator_ref: 'CHG-CLI-1', sub };

    const provision = await runCli('staff-provision', base);
    expect(provision.code).toBe(0);
    const provisionLine = JSON.parse(provision.stdout.trim()) as Record<string, string>;
    expect(provisionLine).toEqual({
      stage: 'staff.provision',
      status: 'created',
      staff_id: provisionLine['staff_id'],
    });
    expect(provisionLine['staff_id']).toMatch(/^[0-9a-f-]{36}$/u);

    const assign = await runCli('staff-assign', base);
    expect(assign.code).toBe(0);
    const assignLine = JSON.parse(assign.stdout.trim()) as Record<string, string>;
    expect(assignLine).toEqual({
      stage: 'staff.assign',
      status: 'created',
      staff_id: provisionLine['staff_id'],
      assignment_id: assignLine['assignment_id'],
    });
    expect(assignLine['assignment_id']).toMatch(/^[0-9a-f-]{36}$/u);

    const verify = await runCli('staff-verify', {
      correlation_id: correlationId,
      sub,
    });
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.stdout.trim())).toEqual({
      stage: 'staff.verify',
      status: 'verified',
      staff_id: provisionLine['staff_id'],
    });
  });

  it('emits the exact stderr envelope and exit code 1 on a guard denial', async () => {
    const sub = randomSub();
    const correlationId = `corr_${randomBytes(8).toString('hex')}`;
    const input = { correlation_id: correlationId, operator_ref: 'CHG-CLI-2', sub };

    expect((await runCli('staff-provision', input)).code).toBe(0);
    expect((await runCli('staff-assign', input)).code).toBe(0);

    const denied = await runCli('staff-assign', {
      ...input,
      correlation_id: `corr_${randomBytes(8).toString('hex')}`,
    });
    expect(denied.code).toBe(1);
    expect(denied.stdout.trim()).toBe('');
    expect(JSON.parse(denied.stderr.trim())).toEqual({
      stage: 'staff.assign',
      status: 'denied',
      reason: 'mode_mismatch',
    });
  });

  it('rejects a malformed sub before opening a write transaction', async () => {
    const result = await runCli('staff-provision', {
      correlation_id: 'corr_cli_invalid_sub',
      operator_ref: 'CHG-CLI-3',
      sub: 'not-a-sub',
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toEqual({
      stage: 'staff.provision',
      status: 'denied',
      reason: 'invalid_sub',
    });
  });

  it('refuses staff-verify without the sub of the bootstrapped account', async () => {
    // S3 không có `sub` thì không có gì để neo kiểm tra: CLI từ chối thay vì
    // đếm toàn bảng staff và xác nhận nhầm một hàng khác.
    const result = await runCli('staff-verify', {
      correlation_id: 'corr_cli_no_sub',
      operator_ref: 'CHG-CLI-4',
    });
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe('');
    expect(JSON.parse(result.stderr.trim())).toEqual({
      stage: 'staff.verify',
      status: 'denied',
      reason: 'sub_missing',
    });
  });
});
