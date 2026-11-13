/**
 * Integration test cho migration `0009_bootstrap_staff_display_name.sql` — sửa một lần
 * các hàng staff mà bootstrap cũ (trước ADR-0029) chèn với `display_name` rỗng (#170).
 *
 * Môi trường mô phỏng đúng một môi trường **đã bootstrap trước khi nâng code**: apply
 * migrations (pass 1) tạo schema + seed canonical, seed hàng "legacy" bằng superuser,
 * rồi `applyAllMigrations` lần 2 với credential migrator thật — đúng runner production
 * (`db:migrate`) — và 0009 chạy giữa các file. Pass 3 chứng minh idempotency trên runner
 * không ledger. Trên môi trường thật, các hàng legacy chỉ có thể sinh ra từ S1 cũ vì
 * bootstrap là writer production duy nhất của `staff_access.staff`.
 *
 * Comment tiếng Việt; test title tiếng Anh; dữ liệu mẫu tiếng Việt được phép (fixture).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  staffListResponse,
  validateStaffListResponse,
  type StaffStatus,
} from '@ecoma-io/staff-access-contracts';
import { applyAllMigrations } from '../../db/apply.mts';
import {
  BOOTSTRAP_STAFF_DISPLAY_NAME,
  CANONICAL_ROLE_KIND,
  CANONICAL_ROLE_NAME,
} from '../../db/bootstrap.mts';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

interface StaffRow {
  id: string;
  sub: string;
  display_name: string;
  // CHECK của bảng chỉ cho phép ba giá trị này; pg trả string runtime nhưng
  // hình dữ liệu luôn nằm trong union của contract.
  status: StaffStatus;
  created_at: Date;
  updated_at: Date;
}

let db: StaffAccessDatabase;
let emptyRow: StaffRow | undefined;
/** Snapshot directory NGAY SAU pass 2 (lần repair duy nhất) cho test idempotency. */
let afterRepair: StaffRow[] = [];
let assignmentAfterRepair:
  | {
      id: string;
      staff_id: string;
      role_id: string;
      created_at: Date;
      updated_at: Date;
      revoked_at: Date | null;
    }
  | undefined;
let auditCountAfterRepair = 0;

beforeAll(async () => {
  db = await startStaffAccessDatabase();
  const migrator = await db.connectAsMigrator();
  try {
    // Pass 1: schema + seed canonical — trạng thái "môi trường đã bootstrap cũ".
    await applyAllMigrations(migrator);
  } finally {
    await migrator.end();
  }
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `sub` dạng `sub_` + 32 ký tự base32 (đúng format CHECK của bảng), ổn định theo seed. */
function legacySub(seed: string): string {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  let sub = 'sub_';
  for (let index = 0; index < 32; index += 1) {
    hash = Math.imul(hash ^ (index + 1), 2654435761);
    sub += BASE32[Math.abs(hash) % BASE32.length];
  }
  return sub;
}

/**
 * Seed một hàng staff "legacy" đúng hình S1 cũ tạo: `display_name` do caller chỉ định,
 * created_at/updated_at trong quá khứ để thấy rõ repair có đụng `updated_at` hay không.
 */
async function seedLegacyStaff(
  seed: string,
  displayName: string,
  status: StaffStatus = 'active',
): Promise<StaffRow> {
  const sub = legacySub(seed);
  const seededAt = new Date(Date.now() - 60_000);
  const superuser = await db.connect();
  try {
    const { rows } = await superuser.query<StaffRow>(
      `INSERT INTO staff_access.staff (sub, display_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING id, sub, display_name, status, created_at, updated_at`,
      [sub, displayName, status, seededAt],
    );
    return rows[0] as StaffRow;
  } finally {
    await superuser.end();
  }
}

/** Đọc lại toàn bộ sổ staff đúng các cột route `GET /staff` đọc (staff-repository `listStaff`). */
async function readStaffDirectory(): Promise<StaffRow[]> {
  const superuser = await db.connect();
  try {
    const { rows } = await superuser.query<StaffRow>(
      `SELECT id, sub, display_name, status, created_at, updated_at
         FROM staff_access.staff ORDER BY sub`,
    );
    return rows;
  } finally {
    await superuser.end();
  }
}

describe('migration 0009 repairs legacy bootstrap display_name rows on a real PostgreSQL', () => {
  it('repairs legacy empty and whitespace-only rows in place and preserves valid names, assignments and audit', async () => {
    const seededEmpty = await seedLegacyStaff('empty', '');
    const seededWhitespace = await seedLegacyStaff('whitespace', '   ');
    const seededValid = await seedLegacyStaff('valid', 'Nguyễn Văn A');
    const seededTerminated = await seedLegacyStaff('terminated-empty', '', 'terminated');
    emptyRow = seededEmpty;

    // Gắn assignment + audit cho hàng rỗng TRƯỚC khi repair — precondition "môi trường
    // đang sống" mà repair không được phá.
    const superuser = await db.connect();
    try {
      const { rows: roleRows } = await superuser.query<{ id: string }>(
        `SELECT id FROM staff_access.roles WHERE kind = $1 AND name = $2`,
        [CANONICAL_ROLE_KIND, CANONICAL_ROLE_NAME],
      );
      const roleId = roleRows[0]?.id ?? '';
      expect(roleId).not.toBe('');
      await superuser.query(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)`,
        [seededEmpty.id, roleId],
      );
      await superuser.query(
        `INSERT INTO staff_access.authorization_audit (target, action, outcome, context)
         VALUES ($1, 'staff.provision', 'success', '{}'::jsonb)`,
        [seededEmpty.id],
      );
    } finally {
      await superuser.end();
    }

    // Pass 2: đúng runner production; 0009 sửa hàng legacy giữa các file.
    const migrator = await db.connectAsMigrator();
    try {
      await applyAllMigrations(migrator);
    } finally {
      await migrator.end();
    }

    afterRepair = await readStaffDirectory();
    const bySub = new Map(afterRepair.map((row) => [row.sub, row]));

    // Hàng rỗng và hàng chỉ-toàn-whitespace cùng được sửa thành hằng bootstrap,
    // `updated_at` bumped đúng bằng lần sửa.
    for (const seeded of [seededEmpty, seededWhitespace]) {
      const row = bySub.get(seeded.sub);
      expect(row?.display_name).toBe(BOOTSTRAP_STAFF_DISPLAY_NAME);
      expect(row?.status).toBe('active');
      expect(row?.id).toBe(seeded.id);
      expect(row?.updated_at.getTime()).toBeGreaterThan(seeded.updated_at.getTime());
    }

    // Tên hiển thị hợp lệ của người thật không bao giờ khớp predicate — giữ nguyên,
    // kể cả `updated_at` (repair không đụng hàng không vi phạm).
    const untouched = bySub.get(seededValid.sub);
    expect(untouched?.display_name).toBe('Nguyễn Văn A');
    expect(untouched?.id).toBe(seededValid.id);
    expect(untouched?.updated_at.getTime()).toBe(seededValid.updated_at.getTime());

    // Hàng terminated rỗng cũng được sửa (contract validate cả entry terminated)
    // mà vẫn giữ status terminal.
    const terminated = bySub.get(seededTerminated.sub);
    expect(terminated?.display_name).toBe(BOOTSTRAP_STAFF_DISPLAY_NAME);
    expect(terminated?.status).toBe('terminated');
    expect(terminated?.id).toBe(seededTerminated.id);

    // Toàn bộ trang sau repair phải đi qua đúng validator mà consumer (backoffice)
    // dùng để đọc sổ staff — một entry rỗng là nguyên nhân 503 của #170.
    const page = staffListResponse(
      afterRepair.map((row) => ({
        id: row.id,
        sub: row.sub,
        status: row.status,
        display_name: row.display_name,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
      null,
    );
    const validated = validateStaffListResponse(page);
    expect(validated.ok).toBe(true);
  });

  it('keeps role assignments and audit history of the repaired staff intact', async () => {
    const target = emptyRow;
    expect(target).toBeDefined();
    if (!target) {
      throw new Error('unreachable: the previous assertion pins the row');
    }

    const superuser = await db.connect();
    try {
      const { rows: assignments } = await superuser.query<{
        id: string;
        staff_id: string;
        role_id: string;
        created_at: Date;
        updated_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, staff_id, role_id, created_at, updated_at, revoked_at
            FROM staff_access.role_assignments WHERE staff_id = $1`,
        [target.id],
      );
      assignmentAfterRepair = assignments[0];

      const { rows: auditCounts } = await superuser.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM staff_access.authorization_audit
          WHERE target = $1`,
        [target.id],
      );
      auditCountAfterRepair = Number.parseInt(auditCounts[0]?.count ?? '0', 10);
    } finally {
      await superuser.end();
    }

    // Assignment vẫn còn, đúng hàng đã seed trước repair, chưa bị revoke.
    expect(assignmentAfterRepair).toBeDefined();
    expect(assignmentAfterRepair?.staff_id).toBe(target.id);
    expect(assignmentAfterRepair?.revoked_at).toBeNull();
    // Audit history không mất đi và không sinh thêm (repair không ghi audit).
    expect(auditCountAfterRepair).toBe(1);
  });

  it('re-applying the migrations leaves repaired rows untouched (idempotent, no ledger)', async () => {
    expect(afterRepair.length).toBeGreaterThan(0);

    // Pass 3: runner chạy LẠI mọi file; 0009 không được sửa thêm gì — hàng đã sửa
    // không còn khớp predicate, nên cả `updated_at` phải đứng yên.
    const migrator = await db.connectAsMigrator();
    try {
      await applyAllMigrations(migrator);
    } finally {
      await migrator.end();
    }

    const afterReapply = await readStaffDirectory();
    expect(afterReapply).toEqual(afterRepair);
  });
});
