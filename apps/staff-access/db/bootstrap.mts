/**
 * Bootstrap S1/S2/S3 của Staff Access — CLI offline chạy bằng credential migrator.
 *
 * Source of truth:
 * - docs/domains/staff-access/adr/0021-first-admin-bootstrap-path.md Quyết định 4, 5, 6, 7.
 * - docs/domains/staff-access/adr/0022-measured-first-admin-guard.md (guard đo được).
 * - docs/domains/staff-access/adr/0023-administrator-lifecycle-paths.md Quyết định 6 (denial audit).
 * - docs/domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md Quyết định 5, 6.
 * - docs/applications/staff-access/03-operations.md §2 Bước 5–8.
 *
 * Ba bước độc lập, mỗi bước một transaction:
 *
 * | Bước | Hàm                            | Ghi                                                      |
 * | ---- | ------------------------------ | -------------------------------------------------------- |
 * | S1   | `provisionBootstrapStaff`      | một `staff` row + audit success                          |
 * | S2   | `assignBootstrapAdministrator` | một `role_assignments` row + audit success               |
 * | S3   | `verifyBootstrapStaff`         | **không ghi gì** — chỉ đọc và trả kết quả có cấu trúc     |
 *
 * S1 và S2 **không** chia sẻ phép đo: mỗi transaction tự lấy advisory lock và tự đo lại
 * `admins_before`/`admins_ever`. Đó là lớp chặn cho hai lần bootstrap chạy song song —
 * cả hai đều thấy 0 khi vào S1, nhưng lần thứ hai vào S2 thấy lần thứ nhất vừa commit và
 * bị từ chối (ADR-0022 Quyết định 1, 5).
 *
 * ⚠️ Lock và mức cô lập: `READ COMMITTED` là bắt buộc. Transaction thứ hai phải thấy row
 * mà transaction thắng đã commit **sau khi** lấy được lock; ở `REPEATABLE READ` snapshot
 * chốt ở câu lấy lock nên nó đọc số cũ và cả hai cùng ghi (ADR-0022 Quyết định 10).
 *
 * ⚠️ Chỉ chạy ở bề mặt offline: `pg_advisory_xact_lock` không chạy qua Hyperdrive (HD6,
 * `docs/architecture/04-platform-facts.md`). Không route, không Worker bundle.
 */

import { pathToFileURL } from 'node:url';

import { isStaffSubFormat } from '@ecoma-io/staff-access-contracts';
import { Client } from 'pg';

/** Định danh canonical của system administrator role — hằng, không phải cấu hình. */
export const CANONICAL_ROLE_KIND = 'system';
export const CANONICAL_ROLE_NAME = 'system-administrator';

/**
 * Khoá advisory mà **đường ghi bootstrap** (S1/S2) lấy trong critical section của nó.
 *
 * ADR-0022 Quyết định 5 đòi mọi đường ghi canonical role dùng **cùng một** khoá. Hôm
 * nay chỉ procedure này lấy nó: route gán assignment của serving path
 * (`POST /staff/:id/assignments`) chưa lấy khoá và chưa có guard, đã ghi nhận ở runbook
 * §3.1 và ADR-0023 Quyết định 2. Đường appointment thường (#44) phải lấy đúng khoá này
 * khi nó được hiện thực — nếu không, ADR-0022 Quyết định 5 không còn đúng.
 */
export const ADMINISTRATOR_ASSIGNMENT_LOCK = 'staff_access.administrator_assignment';

/** Chế độ chạy mà procedure chấp nhận; chỉ `bootstrap` được hiện thực ở #17. */
export const BOOTSTRAP_MODE = 'bootstrap';

/** Hành động ghi vào `authorization_audit.action` cho mọi lần từ chối (ADR-0023 Quyết định 6). */
export const ROLE_ASSIGNMENT_CREATE_ACTION = 'role_assignment.create';

/** Tập permission sealed của role canonical (ADR-0024 Quyết định 5). */
export const CANONICAL_ROLE_PERMISSIONS = [
  'audit.read',
  'permission.read',
  'role.read',
  'staff.read',
] as const;

/**
 * Lý do từ chối. Mọi mã **của guard** (những mã được ném bên trong
 * `runGuardedStep`) xuất hiện trong audit `denied` và trên stderr CLI.
 *
 * Các mã input/hạ tầng dưới đây chỉ ra stderr, **không** có audit row: chúng bị từ
 * chối trước khi có transaction nào để rollback (`invalid_sub`, `sub_missing`,
 * `correlation_id_missing`, `operator_ref_missing`), hoặc vì database không dùng
 * được (`database_unreachable`, `internal_error`), hoặc vì S3 là bước chỉ đọc
 * (`staff_missing_or_ambiguous`, `administrator_assignment_missing`,
 * `role_permissions_mismatch`, `audit_trail_missing`). Đừng grep `authorization_audit`
 * để kết luận "chưa từng có lần chạy".
 *
 * - `role_identity_missing`: không có hàng `roles` canonical.
 * - `role_identity_ambiguous`: nhiều hơn một hàng canonical (guard không được đoán).
 * - `mode_mismatch`: `admins_before`/`admins_ever` không đồng thời bằng 0.
 * - `staff_not_active`: staff theo `sub` tồn tại nhưng `suspended`/`terminated`.
 * - `assignment_window_expired`: assignment còn `revoked_at IS NULL` nhưng đã hết hạn —
 *   duplicate key trên partial unique index, fail-closed, không tự sửa. Với thứ tự
 *   guard hiện tại nhánh này **không tới được**: hàng hết hạn đó đã làm `admins_ever`
 *   khác 0 nên `mode_mismatch` chặn trước. Giữ nhánh làm phòng thủ cho một thay đổi
 *   sau này (ví dụ đường recovery #46), không phải đường đang chạy.
 * - `invalid_sub`: `sub` không khớp `isStaffSubFormat` (kiểm trước khi mở transaction).
 * - `correlation_id_missing`: CLI được gọi mà stdin thiếu `correlation_id`.
 * - `operator_ref_missing`: CLI được gọi mà stdin thiếu `operator_ref`.
 * - `sub_missing`: CLI S1/S2/S3 được gọi mà stdin thiếu `sub`.
 *
 * S3 trả mã riêng cho từng kiểm tra trượt — không dùng chung `mode_mismatch` hay một mã
 * "verification_failed" chung, vì người đọc cần biết **kiểm nào** trượt:
 * `staff_missing_or_ambiguous`, `role_identity_missing`, `role_identity_ambiguous`,
 * `administrator_assignment_missing`, `role_permissions_mismatch`, `audit_trail_missing`.
 * `invalid_sub` ở S3 nghĩa là `sub` đầu vào thiếu/sai định dạng.
 */
export type StaffAccessBootstrapDenialReason =
  | 'role_identity_missing'
  | 'role_identity_ambiguous'
  | 'mode_mismatch'
  | 'staff_not_active'
  | 'assignment_window_expired'
  | 'invalid_sub'
  | 'correlation_id_missing'
  | 'operator_ref_missing'
  | 'sub_missing'
  | 'staff_missing_or_ambiguous'
  | 'administrator_assignment_missing'
  | 'role_permissions_mismatch'
  | 'audit_trail_missing'
  | 'invalid_input'
  | 'database_unreachable'
  | 'internal_error';

/**
 * Lỗi có mã lý do. CLI map thành `{"stage":...,"status":"denied","reason":...}` trên
 * stderr và exit 1; integration test assert `reason`.
 *
 * `adminsBefore`/`adminsEver` chỉ có khi phép đo **đã chạy** trước khi từ chối (ví dụ
 * `mode_mismatch`) — khi đó denial audit phải mang đúng số đã đo, vì đó là bằng chứng
 * phân loại "environment đã có administrator" với "một lần chạy khác vừa thắng race".
 * Nhánh từ chối trước phép đo để hai trường này `undefined` — không bịa số chưa đo.
 */
export class BootstrapDeniedError extends Error {
  readonly reason: StaffAccessBootstrapDenialReason;
  readonly adminsBefore?: number;
  readonly adminsEver?: number;

  constructor(
    reason: StaffAccessBootstrapDenialReason,
    message: string,
    measurements?: { readonly adminsBefore: number; readonly adminsEver: number },
  ) {
    super(message);
    this.name = 'BootstrapDeniedError';
    this.reason = reason;
    if (measurements !== undefined) {
      this.adminsBefore = measurements.adminsBefore;
      this.adminsEver = measurements.adminsEver;
    }
  }
}

/** Đầu vào chung của S1 và S2. */
export interface BootstrapStaffInput {
  readonly correlationId: string;
  readonly operatorRef: string;
  readonly sub: string;
}

/** Đầu vào S2: chỉ cần `sub`; `staffId` được phân giải bên trong transaction có lock. */
export interface AssignBootstrapAdministratorInput extends BootstrapStaffInput {
  /** Tuỳ chọn — khi có, phải khớp hàng phân giải được từ `sub`. */
  readonly staffId?: string;
}

/** Kết quả một bước. */
export interface BootstrapStaffResult {
  readonly stage: 'staff.provision' | 'staff.assign';
  readonly status: 'created' | 'converged';
  readonly staffId: string;
  readonly assignmentId?: string;
}

/** Một kiểm tra của S3. */
export interface BootstrapVerificationCheck {
  readonly check: 'staff' | 'role' | 'assignment' | 'permissions' | 'audit';
  readonly ok: boolean;
  /** Mã lý do khi `ok = false`; `undefined` khi đạt. */
  readonly reason?: StaffAccessBootstrapDenialReason;
}

/** Kết quả S3 — không ném khi chỉ có kiểm tra trượt; caller đọc `ok`/`reasons`. */
export interface BootstrapVerification {
  readonly stage: 'staff.verify';
  readonly ok: boolean;
  readonly staffId?: string;
  readonly checks: readonly BootstrapVerificationCheck[];
  /** Tập mã lý do của các kiểm tra trượt, không trùng lặp. */
  readonly reasons: readonly StaffAccessBootstrapDenialReason[];
}

/**
 * Tuy chọn S3.
 *
 * `sub` là **bắt buộc để kiểm đúng staff**: runbook Bước 8 kiểm 1 đọc `staff`
 * theo `sub` mà A2 trả ra, chứ không đọc "hàng staff duy nhất trong database" —
 * một environment có thể đã có staff khác (không phải administrator) trước khi
 * bootstrap chạy, và bỏ `sub` sẽ biến S3 thành phép đếm toàn bảng.
 *
 * `correlationId` bỏ trống thì bỏ kiểm tra audit row.
 */
export interface BootstrapVerificationOptions {
  readonly sub?: string;
  readonly correlationId?: string;
}

/**
 * Đo `admins_before`: số administrator **còn hiệu lực**. Câu SQL canonical của
 * ADR-0022 Quyết định 4, không viết lại.
 */
const ADMINS_BEFORE_SQL = `
  SELECT count(DISTINCT ra.staff_id)::int AS admins
    FROM staff_access.role_assignments ra
    JOIN staff_access.roles r ON r.id = ra.role_id
    JOIN staff_access.staff s ON s.id = ra.staff_id
   WHERE r.kind = $1 AND r.name = $2
     AND r.status = 'active'
     AND s.status = 'active'
     AND ra.revoked_at IS NULL
     AND (ra.effective_from IS NULL OR ra.effective_from <= now())
     AND (ra.effective_until IS NULL OR ra.effective_until > now())`;

/**
 * Đo `admins_ever`: số hàng assignment của role canonical từng tồn tại. Không lọc
 * `status`, `revoked_at` hay cửa sổ hiệu lực — ngưỡng khác 0 chống cấp lại quyền.
 */
const ADMINS_EVER_SQL = `
  SELECT count(*)::int AS assignments
    FROM staff_access.role_assignments ra
    JOIN staff_access.roles r ON r.id = ra.role_id
   WHERE r.kind = $1 AND r.name = $2`;

interface MeasuredGuard {
  readonly roleId: string;
  readonly adminsBefore: number;
  readonly adminsEver: number;
}

interface AuditContext {
  readonly mode: string;
  readonly operatorRef: string;
  readonly adminsBefore: number;
  readonly adminsEver: number;
  readonly step: string;
  readonly noop?: boolean;
}

/** Trạng thái dùng chung giữa bước đang chạy và nhánh ghi audit `denied`. */
interface StepContext {
  /** `staff.id` khi đã phân giải được, ngược lại là `sub` đã dùng để tra. */
  resoluteTarget: string;
}

/**
 * Mở transaction guard: `BEGIN`, đặt `READ COMMITTED`, lấy advisory lock, phân giải role,
 * đo hai số. Trả về số đo **của transaction này** — không nhận từ ngoài.
 */
async function enterGuard(client: Client): Promise<MeasuredGuard> {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMINISTRATOR_ASSIGNMENT_LOCK]);

  const roles = await client.query<{ id: string }>(
    `SELECT id FROM staff_access.roles WHERE kind = $1 AND name = $2`,
    [CANONICAL_ROLE_KIND, CANONICAL_ROLE_NAME],
  );
  if (roles.rows.length === 0) {
    throw new BootstrapDeniedError(
      'role_identity_missing',
      `canonical role (kind=${CANONICAL_ROLE_KIND}, name=${CANONICAL_ROLE_NAME}) is missing; run the seed migration`,
    );
  }
  if (roles.rows.length > 1) {
    throw new BootstrapDeniedError(
      'role_identity_ambiguous',
      `canonical role (kind=${CANONICAL_ROLE_KIND}, name=${CANONICAL_ROLE_NAME}) resolves to ${roles.rows.length} rows; refusing to guess which one is canonical`,
    );
  }
  const roleId = roles.rows[0]?.id;
  if (roleId === undefined) {
    throw new Error('canonical role lookup returned no id');
  }

  const before = await client.query<{ admins: number }>(ADMINS_BEFORE_SQL, [
    CANONICAL_ROLE_KIND,
    CANONICAL_ROLE_NAME,
  ]);
  const ever = await client.query<{ assignments: number }>(ADMINS_EVER_SQL, [
    CANONICAL_ROLE_KIND,
    CANONICAL_ROLE_NAME,
  ]);
  const adminsBefore = before.rows[0]?.admins ?? 0;
  const adminsEver = ever.rows[0]?.assignments ?? 0;

  if (adminsBefore !== 0 || adminsEver !== 0) {
    // Số đo đã có: đính kèm vào lỗi để nhánh ghi audit `denied` giữ được bằng chứng
    // phân loại (ADR-0022 Quyết định 3, 9; runbook Bước 9).
    throw new BootstrapDeniedError(
      'mode_mismatch',
      `mode "${BOOTSTRAP_MODE}" requires admins_before = 0 and admins_ever = 0, measured admins_before=${adminsBefore}, admins_ever=${adminsEver}`,
      { adminsBefore, adminsEver },
    );
  }

  return { roleId, adminsBefore, adminsEver };
}

/**
 * Ghi một row `authorization_audit` **trong transaction đang mở** — dùng cho audit
 * `success` của S1/S2 (cùng transaction với dữ liệu nghiệp vụ).
 */
async function insertAudit(
  client: Client,
  input: BootstrapStaffInput,
  context: AuditContext,
  values: {
    readonly target: string;
    readonly action: string;
    readonly outcome: 'success' | 'denied';
    readonly reason?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO staff_access.authorization_audit
       (actor_staff_id, actor_sub, target, action, outcome, reason, correlation_id, context)
     VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6::jsonb)`,
    [
      values.target,
      values.action,
      values.outcome,
      values.reason ?? null,
      input.correlationId,
      JSON.stringify({
        mode: context.mode,
        operator_ref: context.operatorRef,
        admins_before: context.adminsBefore,
        admins_ever: context.adminsEver,
        step: context.step,
        ...(context.noop === undefined ? {} : { noop: context.noop }),
      }),
    ],
  );
}

/**
 * Ghi audit `denied` trong một transaction **riêng, đã commit**, sau khi transaction
 * guard đã rollback (ADR-0023 Quyết định 6). Ném khi audit không ghi được, để caller
 * quyết định: lỗi audit không được nuốt thành một lần chạy "bình thường".
 */
async function recordDenial(
  client: Client,
  input: BootstrapStaffInput,
  denial: BootstrapDeniedError,
  state: {
    readonly step: string;
    readonly target: string;
    readonly adminsBefore?: number;
    readonly adminsEver?: number;
  },
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO staff_access.authorization_audit
         (actor_staff_id, actor_sub, target, action, outcome, reason, correlation_id, context)
       VALUES (NULL, NULL, $1, $2, 'denied', $3, $4, $5::jsonb)`,
      [
        state.target,
        ROLE_ASSIGNMENT_CREATE_ACTION,
        denial.reason,
        input.correlationId,
        JSON.stringify({
          mode: BOOTSTRAP_MODE,
          operator_ref: input.operatorRef,
          step: state.step,
          ...(state.adminsBefore === undefined ? {} : { admins_before: state.adminsBefore }),
          ...(state.adminsEver === undefined ? {} : { admins_ever: state.adminsEver }),
        }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Chạy một bước ghi trong transaction guard, rollback khi bị từ chối, rồi commit audit
 * `denied` ở transaction riêng. `target` khi chưa phân giải được staff là `sub` — giá trị
 * đã dùng để tra, không phải chuỗi rỗng.
 *
 * ADR-0023 Quyết định 6 nói lần từ chối trước bước phân giải identity mang `address_hash`
 * đã dùng để tra. Với bootstrap, **chỉ `sub` đi xuyên service** (ADR-0024; runbook §1),
 * và `address_hash` không bao giờ tới `staff-access`, nên giá trị tra được duy nhất là
 * `sub`. Đó là mapping đúng cho đường này, không phải một chỗ lệch ADR.
 */
async function runGuardedStep(
  client: Client,
  input: BootstrapStaffInput,
  step: string,
  body: (guard: MeasuredGuard, context: StepContext) => Promise<BootstrapStaffResult>,
): Promise<BootstrapStaffResult> {
  // `target` của audit row: `staff.id` khi đã phân giải được identity, ngược lại là `sub`
  // đã dùng để tra (ADR-0023 Quyết định 6 cấm chuỗi rỗng và id bịa).
  const context: StepContext = { resoluteTarget: input.sub };
  let guard: MeasuredGuard | undefined;
  try {
    guard = await enterGuard(client);
    const result = await body(guard, context);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof BootstrapDeniedError) {
      // Ưu tiên số đo đã thực sự lấy được: `guard` khi phép đo đã hoàn tất, hoặc số
      // đính kèm trên lỗi khi guard đo xong rồi mới từ chối (`mode_mismatch`). Nhánh
      // chưa từng đo (role lookup, invalid_sub) không có số nào — không bịa.
      const adminsBefore = guard?.adminsBefore ?? error.adminsBefore;
      const adminsEver = guard?.adminsEver ?? error.adminsEver;
      await recordDenial(client, input, error, {
        step,
        target: context.resoluteTarget,
        ...(adminsBefore === undefined ? {} : { adminsBefore }),
        ...(adminsEver === undefined ? {} : { adminsEver }),
      });
    }
    throw error;
  }
}

/**
 * S1 — tạo staff identity theo `sub`.
 *
 * `sub` được kiểm bằng `isStaffSubFormat` **trước** khi mở transaction: một giá trị sai
 * định dạng không phải lý do để mở transaction hay ghi audit.
 */
export async function provisionBootstrapStaff(
  client: Client,
  input: BootstrapStaffInput,
): Promise<BootstrapStaffResult> {
  if (!isStaffSubFormat(input.sub)) {
    throw new BootstrapDeniedError(
      'invalid_sub',
      'sub must be an Account ID: sub_ prefix + 32 lowercase base32 characters',
    );
  }

  return runGuardedStep(client, input, 'staff.provision', async (guard, context) => {
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM staff_access.staff WHERE sub = $1`,
      [input.sub],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      context.resoluteTarget = row.id;
    }

    let staffId: string;
    let converged: boolean;

    if (row === undefined) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ($1, '', 'active') RETURNING id`,
        [input.sub],
      );
      const insertedId = inserted.rows[0]?.id;
      if (insertedId === undefined) {
        throw new Error('staff INSERT RETURNING produced no row');
      }
      staffId = insertedId;
      context.resoluteTarget = insertedId;
      converged = false;
    } else if (row.status === 'active') {
      staffId = row.id;
      converged = true;
    } else {
      // Không hồi sinh: trigger `staff_identity_and_terminal_guard` chặn terminated, và
      // suspended cũng là trạng thái cần người quyết định (ADR-0021 Quyết định 5).
      throw new BootstrapDeniedError(
        'staff_not_active',
        `staff for the given sub exists with status "${row.status}"; bootstrap never reactivates a staff row`,
      );
    }

    await insertAudit(
      client,
      input,
      {
        mode: BOOTSTRAP_MODE,
        operatorRef: input.operatorRef,
        adminsBefore: guard.adminsBefore,
        adminsEver: guard.adminsEver,
        step: 'staff.provision',
        ...(converged ? { noop: true } : {}),
      },
      { target: staffId, action: 'staff.provision', outcome: 'success' },
    );

    return {
      stage: 'staff.provision',
      status: converged ? 'converged' : 'created',
      staffId,
    };
  });
}

/**
 * S2 — gán canonical system administrator role cho staff phân giải từ `sub`.
 *
 * `staffId` (nếu caller truyền) chỉ là ràng buộc chéo: nó phải khớp hàng phân giải được
 * từ `sub` **bên trong** transaction có lock, nên không có cửa sổ giữa hai lần đọc.
 */
export async function assignBootstrapAdministrator(
  client: Client,
  input: AssignBootstrapAdministratorInput,
): Promise<BootstrapStaffResult> {
  if (!isStaffSubFormat(input.sub)) {
    throw new BootstrapDeniedError(
      'invalid_sub',
      'sub must be an Account ID: sub_ prefix + 32 lowercase base32 characters',
    );
  }

  return runGuardedStep(client, input, 'staff.assign', async (guard, context) => {
    const staff = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM staff_access.staff WHERE sub = $1`,
      [input.sub],
    );
    const staffRow = staff.rows[0];
    if (staffRow !== undefined) {
      context.resoluteTarget = staffRow.id;
    }
    if (staffRow === undefined) {
      throw new BootstrapDeniedError(
        'staff_not_active',
        'no staff row exists for the given sub; run staff-provision first',
      );
    }
    if (staffRow.status !== 'active') {
      throw new BootstrapDeniedError(
        'staff_not_active',
        `staff for the given sub exists with status "${staffRow.status}"; bootstrap never reactivates a staff row`,
      );
    }
    if (input.staffId !== undefined && input.staffId !== staffRow.id) {
      throw new BootstrapDeniedError(
        'staff_not_active',
        'the staffId supplied by the caller does not match the staff row resolved from sub',
      );
    }
    const staffId = staffRow.id;

    const live = await client.query<{ id: string }>(
      // Cùng predicate "còn hiệu lực" với `admins_before` và với S3 kiểm 3. Thiếu
      // cửa sổ hiệu lực ở đây sẽ coi một assignment đã hết hạn nhưng chưa revoke là
      // hội tụ thành công, trong khi nó không còn cấp quyền administrator nào.
      `SELECT id FROM staff_access.role_assignments
        WHERE staff_id = $1 AND role_id = $2
          AND revoked_at IS NULL
          AND (effective_from IS NULL OR effective_from <= now())
          AND (effective_until IS NULL OR effective_until > now())`,
      [staffId, guard.roleId],
    );
    const liveRow = live.rows[0];

    let assignmentId: string;
    let converged: boolean;

    if (liveRow !== undefined) {
      assignmentId = liveRow.id;
      converged = true;
    } else {
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO staff_access.role_assignments (staff_id, role_id, granted_by)
           VALUES ($1, $2, NULL) RETURNING id`,
          [staffId, guard.roleId],
        );
        const insertedId = inserted.rows[0]?.id;
        if (insertedId === undefined) {
          throw new Error('role_assignments INSERT RETURNING produced no row');
        }
        assignmentId = insertedId;
        converged = false;
      } catch (error) {
        // Partial unique index chỉ thấy hàng `revoked_at IS NULL`; assignment đã hết hạn
        // nhưng chưa revoked vẫn chiếm index. Đó là fail-closed cần người quyết định,
        // không phải no-op (ADR-0021 Quyết định 5).
        if ((error as { code?: string }).code === '23505') {
          throw new BootstrapDeniedError(
            'assignment_window_expired',
            'a live role assignment row already exists for this staff and role but its effective window has expired; resolve it explicitly, bootstrap never repairs it',
          );
        }
        throw error;
      }
    }

    await insertAudit(
      client,
      input,
      {
        mode: BOOTSTRAP_MODE,
        operatorRef: input.operatorRef,
        adminsBefore: guard.adminsBefore,
        adminsEver: guard.adminsEver,
        step: 'staff.assign',
        ...(converged ? { noop: true } : {}),
      },
      { target: assignmentId, action: 'staff.assign', outcome: 'success' },
    );

    return {
      stage: 'staff.assign',
      status: converged ? 'converged' : 'created',
      staffId,
      assignmentId,
    };
  });
}

/**
 * S3 — đọc lại, tuyệt đối không ghi.
 *
 * Năm kiểm tra của runbook Bước 8. `sub` là **đầu vào bắt buộc**: kiểm 1 đọc
 * `staff` theo `sub` mà A2 trả ra, không đếm toàn bảng — environment có thể đã
 * có staff không phải administrator. `sub` thiếu/sai định dạng trả `invalid_sub`
 * trước mọi câu đọc.
 *
 * `correlationId` bỏ trống thì bỏ kiểm tra audit row (đường verify chạy lại sau
 * một S2 đã commit không có correlation id mới). Khi có, S3 đòi đúng một row
 * `success` cho mỗi bước S1 và S2 của lần chạy đó.
 *
 * Không ném vì kiểm tra trượt: trả `ok = false` cùng danh sách lý do để caller phân loại.
 */
export async function verifyBootstrapStaff(
  client: Client,
  options: BootstrapVerificationOptions = {},
): Promise<BootstrapVerification> {
  const checks: BootstrapVerificationCheck[] = [];
  const reasons = new Set<StaffAccessBootstrapDenialReason>();

  const fail = (
    check: BootstrapVerificationCheck['check'],
    reason: StaffAccessBootstrapDenialReason,
  ): void => {
    checks.push({ check, ok: false, reason });
    reasons.add(reason);
  };

  // `sub` vắng mặt hoặc sai định dạng thì không có gì để neo kiểm tra — từ chối,
  // không đoán staff nào là staff của lần chạy. Kiểm trước mọi câu đọc, và trả
  // `invalid_sub` chứ không phải `staff_missing_or_ambiguous`: đó là lỗi input,
  // không phải trạng thái database.
  const staffSub = options.sub;
  if (!isStaffSubFormat(staffSub)) {
    fail('staff', 'invalid_sub');
    return { stage: 'staff.verify', ok: false, checks, reasons: [...reasons] };
  }

  // Kiểm 1 — đúng một staff row **theo `sub`** và nó phải `active` (runbook Bước 8).
  //
  // Không đọc toàn bảng: một environment có staff không phải administrator từ
  // trước là trạng thái hợp lệ, và đếm "hàng staff duy nhất" ở đó sẽ từ chối một
  // lần bootstrap hoàn toàn đúng (hoặc, tệ hơn, xác nhận nhầm một staff khác).
  const staff = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM staff_access.staff WHERE sub = $1`,
    [staffSub],
  );
  const onlyStaff = staff.rows.length === 1 ? staff.rows[0] : undefined;
  const staffId = onlyStaff?.status === 'active' ? onlyStaff.id : undefined;
  if (staffId === undefined) {
    fail('staff', 'staff_missing_or_ambiguous');
  } else {
    checks.push({ check: 'staff', ok: true });
  }

  // Kiểm 2 — đúng một canonical role active.
  const role = await client.query<{ id: string }>(
    `SELECT id FROM staff_access.roles
      WHERE kind = $1 AND name = $2 AND status = 'active'`,
    [CANONICAL_ROLE_KIND, CANONICAL_ROLE_NAME],
  );
  const roleId = role.rows.length === 1 ? role.rows[0]?.id : undefined;
  if (roleId === undefined) {
    fail('role', role.rows.length > 1 ? 'role_identity_ambiguous' : 'role_identity_missing');
  } else {
    checks.push({ check: 'role', ok: true });
  }

  // Kiểm 3 — đúng một assignment còn hiệu lực, cùng predicate với `admins_before`.
  if (staffId !== undefined && roleId !== undefined) {
    const assignment = await client.query<{ id: string }>(
      `SELECT ra.id
         FROM staff_access.role_assignments ra
        WHERE ra.staff_id = $1 AND ra.role_id = $2
          AND ra.revoked_at IS NULL
          AND (ra.effective_from IS NULL OR ra.effective_from <= now())
          AND (ra.effective_until IS NULL OR ra.effective_until > now())`,
      [staffId, roleId],
    );
    if (assignment.rows.length === 1) {
      checks.push({ check: 'assignment', ok: true });
    } else {
      fail('assignment', 'administrator_assignment_missing');
    }
  } else {
    fail('assignment', 'administrator_assignment_missing');
  }

  // Kiểm 4 — role_permissions đúng tập bốn read permission.
  if (roleId !== undefined) {
    const permissions = await client.query<{ permission_id: string }>(
      `SELECT permission_id FROM staff_access.role_permissions WHERE role_id = $1`,
      [roleId],
    );
    const actual = permissions.rows
      .map((row) => row.permission_id)
      .toSorted((a, b) => a.localeCompare(b, 'en'));
    const expected = [...CANONICAL_ROLE_PERMISSIONS].toSorted((a, b) => a.localeCompare(b, 'en'));
    if (actual.length === expected.length && actual.every((id, index) => id === expected[index])) {
      checks.push({ check: 'permissions', ok: true });
    } else {
      fail('permissions', 'role_permissions_mismatch');
    }
  } else {
    fail('permissions', 'role_permissions_mismatch');
  }

  // Kiểm 5 — audit row của mọi bước trong lần chạy (chỉ khi có correlationId).
  //
  // Đếm **đúng một** row cho mỗi bước và buộc `target` khớp thứ vừa kiểm: chỉ
  // kiểm "có ít nhất một row" sẽ cho hai row `staff.assign` (một lần chạy lại
  // dùng correlation id, một lần ghi trùng) đi qua như một lần chạy sạch.
  if (options.correlationId !== undefined && options.correlationId !== '') {
    if (staffId === undefined || roleId === undefined) {
      fail('audit', 'audit_trail_missing');
    } else {
      const audit = await client.query<{ action: string; target: string }>(
        `SELECT action, target FROM staff_access.authorization_audit
          WHERE correlation_id = $1 AND outcome = 'success'`,
        [options.correlationId],
      );
      const provisionRows = audit.rows.filter((row) => row.action === 'staff.provision');
      const assignRows = audit.rows.filter((row) => row.action === 'staff.assign');

      // `target` của `staff.assign` là assignment id — phải là assignment canonical
      // của chính staff này, không phải một hàng bất kỳ của correlation id đó.
      const assignment = await client.query<{ id: string }>(
        `SELECT id FROM staff_access.role_assignments WHERE id = $1 AND staff_id = $2 AND role_id = $3`,
        [assignRows[0]?.target, staffId, roleId],
      );
      const complete =
        provisionRows.length === 1 &&
        provisionRows[0]?.target === staffId &&
        assignRows.length === 1 &&
        assignment.rows.length === 1;
      if (complete) {
        checks.push({ check: 'audit', ok: true });
      } else {
        fail('audit', 'audit_trail_missing');
      }
    }
  }

  return {
    stage: 'staff.verify',
    ok: checks.every((check) => check.ok),
    ...(staffId === undefined ? {} : { staffId }),
    checks,
    reasons: [...reasons],
  };
}

/** Stage trên wire, map từ argv. */
type CliAction = 'staff-provision' | 'staff-assign' | 'staff-verify';

const CLI_STAGE: Record<CliAction, 'staff.provision' | 'staff.assign' | 'staff.verify'> = {
  'staff-provision': 'staff.provision',
  'staff-assign': 'staff.assign',
  'staff-verify': 'staff.verify',
};

interface CliInput {
  readonly correlation_id?: unknown;
  readonly operator_ref?: unknown;
  readonly sub?: unknown;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requireString(value: unknown, reason: StaffAccessBootstrapDenialReason): string {
  if (typeof value !== 'string' || value === '') {
    throw new BootstrapDeniedError(reason, `missing required stdin field (${reason})`);
  }
  return value;
}

/** Một dòng JSON trên stdout; mọi trường snake_case (wire shape của `tools/dx`). */
function writeSuccess(payload: Record<string, string>): void {
  console.log(JSON.stringify(payload));
}

function writeDenial(stage: string, reason: string): void {
  console.error(JSON.stringify({ stage, status: 'denied', reason }));
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== 'staff-provision' && action !== 'staff-assign' && action !== 'staff-verify') {
    console.error(
      'usage: tsx db/bootstrap.mts <staff-provision|staff-assign|staff-verify>; input is a JSON object on stdin',
    );
    process.exit(1);
  }
  const stage = CLI_STAGE[action satisfies CliAction];

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Bootstrap runs from the CI runner with the migrator role, never from the Worker (HD6: Hyperdrive does not support advisory locks).',
    );
    process.exit(1);
  }

  let input: CliInput;
  try {
    const raw = await readStdin();
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as CliInput);
  } catch {
    // Không in message của `JSON.parse`: nó trích nguyên đoạn stdin vào stderr.
    writeDenial(stage, 'invalid_input');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-staff-access-bootstrap',
  });

  try {
    await client.connect();
  } catch {
    // Cũng không in message của driver — nó có thể mang host/database name.
    writeDenial(stage, 'database_unreachable');
    process.exit(1);
  }

  try {
    const correlationId = requireString(input.correlation_id, 'correlation_id_missing');

    if (action === 'staff-verify') {
      // S3 cần đúng `sub` của Account đã bootstrap: runbook Bước 8 kiểm staff theo
      // `sub`, không đếm toàn bảng (một environment có thể đã có staff khác).
      const sub = requireString(input.sub, 'sub_missing');
      const verification = await verifyBootstrapStaff(client, { sub, correlationId });
      if (!verification.ok) {
        // Mã lý do cụ thể của kiểm tra trượt đầu tiên — không dùng `mode_mismatch` cho S3.
        writeDenial(stage, verification.reasons[0] ?? 'staff_missing_or_ambiguous');
        process.exitCode = 1;
        return;
      }
      writeSuccess({
        stage,
        status: 'verified',
        staff_id: verification.staffId ?? '',
      });
      return;
    }

    const operatorRef = requireString(input.operator_ref, 'operator_ref_missing');
    const sub = requireString(input.sub, 'sub_missing');
    const bootstrapInput: BootstrapStaffInput = { correlationId, operatorRef, sub };

    if (action === 'staff-provision') {
      const result = await provisionBootstrapStaff(client, bootstrapInput);
      writeSuccess({ stage, status: result.status, staff_id: result.staffId });
      return;
    }

    const result = await assignBootstrapAdministrator(client, bootstrapInput);
    writeSuccess({
      stage,
      status: result.status,
      staff_id: result.staffId,
      assignment_id: result.assignmentId ?? '',
    });
  } catch (error) {
    if (error instanceof BootstrapDeniedError) {
      writeDenial(stage, error.reason);
      process.exitCode = 1;
      return;
    }
    // Lỗi ngoài hợp đồng: chỉ in mã máy đọc — message của driver có thể chứa giá
    // trị cột (pg chèn giá trị vào một số lỗi), nên không bao giờ ra ngoài.
    writeDenial(stage, 'internal_error');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main();
  } catch {
    // Cùng lý do như nhánh catch bên trong: không để message thô của driver ra ngoài.
    const action = process.argv[2];
    const stage =
      action === 'staff-provision' || action === 'staff-assign' || action === 'staff-verify'
        ? CLI_STAGE[action]
        : 'staff.bootstrap';
    writeDenial(stage, 'internal_error');
    process.exitCode = 1;
  }
}
