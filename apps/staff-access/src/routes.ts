/** Management routes for the staff-access Worker.
 * #428): staff directory read, role/permission catalog read, assignment
 * list/create/revoke, authorization audit query, entitlement read model.
 *
 * Nguon shape:
 * - Wire shape (request/response) la bat buoc theo `@ecoma-io/staff-access-
 *   contracts` (P1.2, issue #426) — response DUNG qua cac helper `*ListResponse`
 *   / `*Entry` cua contract de khong co duong ghep field bang tay.
 * - SQL la bang chep cua schema qua cac repository cua
 *   `@ecoma-io/staff-access-infrastructure` (Milestone A).
 *
 * Nguyen tac serving-path:
 * - Moi request mot client: `withStaffAccessClient(config, ...)` dong client
 *   trong `finally` (issue #289 — khong reuse client giua cac request).
 * - Ghi privileged (create/revoke assignment) chay trong mot transaction:
 *   assignment + audit entry cung mot commit (SR-013 — grant/revoke khong
 *   ton tai khong audit).
 * - Authn/authz: Milestone B cung cap read API ma backoffice BFF goi server-
 *   side; check permission (staff.read / role.read / permission.read) va viec
 *   anh xa identity tu token sang staff id la cong viec cua caller BFF +
 *   Phase sau (revocation latency, P2.5) — service khong tu nghiem token tai
 *   day (ADR-0009: khong co internal authorization-result contract).
 *   Ngoai le duy nhat: `POST /authorization/verdict` — caller khac bounded
 *   context hoi verdict permission cho **mot** request (ADR-0033 Quyet dinh 3,
 *   supersede-in-part ADR-0009 o dung hop dong do). Route management khong
 *   dung no.
 *
 * ⚠️ Exposure contract (giai doan nay): Worker KHONG publish port ra host,
 * KHONG mang label `traefik.*` (deploy unit — deploys/staff-access-deploy);
 * consumer duy nhat la BFF fetch server-side qua alias DNS noi bo
 * `ecoma-staff-access` trong platform network. Ngoai platform network khong
 * co duong nao cham API nay. Khi co consumer moi (deploy production,
 * cross-network), PHAI them guard rieng (service-token/internal authn) TRUOC
 * khi expose — khong duoc tin vao network isolation lam authn.
 */
import { Hono } from 'hono';
import {
  assignmentListResponse,
  AUDIT_LIST_DEFAULT_LIMIT,
  auditListResponse,
  PERMISSION_LIST_DEFAULT_LIMIT,
  PERMISSION_LIST_MAX_LIMIT,
  permissionEntry,
  permissionListResponse,
  ROLE_LIST_DEFAULT_LIMIT,
  ROLE_LIST_MAX_LIMIT,
  roleListResponse,
  staffListResponse,
  validateAuditQueryRequest,
  validateCreateAssignmentRequest,
  validateCreateStaffRequest,
  validateStaffListRequest,
  validateStaffRoleAssignment,
  validateRevokeAssignmentRequest,
  permissionVerdictResponse,
  validatePermissionVerdictRequest,
  type AuditEntry,
  type AuditQueryRequest,
  type StaffMember,
  type StaffRoleAssignment,
} from '@ecoma-io/staff-access-contracts';
import {
  appendAuditEntry,
  countLiveAssignmentsForStaffRole,
  getAssignmentById,
  getEntitlement,
  getLiveAssignmentForStaffRole,
  getPermissionById,
  getRoleById,
  getStaffById,
  getStaffBySub,
  insertAssignment,
  insertStaff,
  iso,
  isoNullable,
  listActivePermissions,
  listActiveRoles,
  listAssignmentsForStaff,
  listEffectivePermissionIdsForStaff,
  listEntitlementsForStaff,
  listRolePermissionIds,
  listStaff,
  queryAuditEntries,
  revokeAssignment,
  settleOutboxEvent,
  withStaffAccessClient,
  type AssignmentRow,
  type AuditEntryRow,
  type RoleRow,
  type StaffAccessClient,
  type StaffRow,
} from '@ecoma-io/staff-access-infrastructure';
import { staffAccessDomainError } from '@ecoma-io/staff-access-domain';
import type { AppEnv } from './types';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor';

const HIGH_ENTITLEMENT_FRESHNESS_MS = 5_000;
const NORMAL_ENTITLEMENT_FRESHNESS_MS = 60_000;

function isEntitlementFresh(
  row: { status: string; occurred_at: Date | string },
  nowMs = Date.now(),
): boolean {
  const occurredAtMs = Date.parse(iso(row.occurred_at));
  const deadline =
    row.status === 'revoked' ? HIGH_ENTITLEMENT_FRESHNESS_MS : NORMAL_ENTITLEMENT_FRESHNESS_MS;
  return Number.isFinite(occurredAtMs) && nowMs - occurredAtMs <= deadline;
}

/**
 * Role đích của đường bổ nhiệm thường (ADR-0023 Quyết định 2): định danh
 * canonical `system-administrator` — phân giải theo `(kind, name)` (UNIQUE ở
 * `0008`), không theo id cứng, cùng hình phân giải của ADR-0022 Quyết định 4.
 */
const CANONICAL_ADMINISTRATOR_KIND = 'system';
const CANONICAL_ADMINISTRATOR_NAME = 'system-administrator';

function isCanonicalAdministratorRole(role: RoleRow): boolean {
  return role.kind === CANONICAL_ADMINISTRATOR_KIND && role.name === CANONICAL_ADMINISTRATOR_NAME;
}

/**
 * Kiểm permission ghi cho một route quản trị (ADR-0034): đọc tập permission
 * hiệu lực của actor trong envelope (không bao giờ từ body) và ghi hàng audit
 * **commit trước khi trả lời** (ADR-0023 Quyết định 6, ADR-0033 Quyết định 3).
 *
 * - Không actor principal ⇒ 401 — không có lần từ chối quyền nào để audit
 *   (target của hàng `denied` là `staff.id`, mà chưa phân giải được staff nào;
 *   cùng lập luận của `POST /authorization/verdict`).
 * - Actor có principal nhưng thiếu permission ⇒ 403 + đúng một hàng audit
 *   `denied` với `action = <permission>`, `reason = 'permission_denied'`,
 *   `target = actorStaffId`, `correlation_id` = request id.
 */
async function requireWritePermission(
  c: { get: (key: 'actorStaffId' | 'actorSub' | 'requestId') => string | null },
  db: StaffAccessClient,
  permission: string,
): Promise<boolean> {
  const actorStaffId = c.get('actorStaffId');
  if (actorStaffId === null) {
    return false;
  }
  const effective = await listEffectivePermissionIdsForStaff(db, actorStaffId);
  const allowed = effective.includes(permission);
  if (!allowed) {
    await appendAuditEntry(db, {
      actorStaffId,
      actorSub: c.get('actorSub'),
      target: actorStaffId,
      action: permission,
      outcome: 'denied',
      reason: 'permission_denied',
      correlationId: c.get('requestId'),
    });
  }
  return allowed;
}

/** Lỗi http chuan cua route — body JSON khong leak noi bo. */
interface HttpError {
  readonly status: 400 | 404 | 409;
  readonly body: { error: string; message: string };
}

/** 400 payload bat ki — message khong neu gia tri caller gui. */
function badRequest(message: string): HttpError {
  return { status: 400, body: { error: 'Bad Request', message } };
}

/** 404 theo hinh thong nhat cua app (`main.ts`) — khong leak ton tai hay khong. */
function notFound(message: string): HttpError {
  return { status: 404, body: { error: 'Not Found', message } };
}

/**
 * Doc tham so list (limit/cursor) tu query string va kiem qua contract.
 * Tra HttpError (400) khi tham so sai — KHONG dong vi cursor/limit sai.
 */
function parseListParams(
  query: Record<string, string>,
): { ok: true; limit: number; cursor: string | null } | { ok: false; error: HttpError } {
  const rawLimit = query['limit'];
  const rawCursor = query['cursor'];
  const limit =
    rawLimit === undefined
      ? undefined
      : Number.isInteger(Number(rawLimit))
        ? Number(rawLimit)
        : rawLimit; // chuoi khong so — de contract tu bao loi invalid_pagination.
  const validated = validateStaffListRequest({
    limit,
    cursor: rawCursor === '' ? undefined : rawCursor,
  });
  if (!validated.ok) {
    return { ok: false, error: badRequest(validated.detail) };
  }
  return { ok: true, limit: validated.payload.limit, cursor: validated.payload.cursor };
}

/** Doc body JSON cua request POST, tra loi 400 khi khong phai object JSON. */
async function readJsonObject(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: HttpError }> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return { ok: false, error: badRequest('Request body must be valid JSON.') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: badRequest('Request body must be a JSON object.') };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Chuyen mot StaffRow (schema) sang StaffMember (wire) — khong them field. */
function toStaffMember(row: StaffRow): StaffMember {
  return {
    id: row.id,
    sub: row.sub,
    status: row.status as StaffMember['status'],
    display_name: row.display_name,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Chuyen mot RoleRow (schema) + permission ids sang StaffRole (wire). */
function toStaffRole(
  row: RoleRow,
  permissions: readonly string[],
): import('@ecoma-io/staff-access-contracts').StaffRole {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as 'system' | 'custom',
    permissions: [...permissions],
    status: row.status as 'active' | 'retired',
    created_at: iso(row.created_at),
  };
}

/** Chuyen mot AssignmentRow (schema) sang StaffRoleAssignment (wire). */
function toAssignment(row: AssignmentRow): StaffRoleAssignment {
  return {
    id: row.id,
    staff_id: row.staff_id,
    role_id: row.role_id,
    ...(row.scope === null ? {} : { scope: row.scope as StaffRoleAssignment['scope'] }),
    // `effective_from` nullable ở schema nhưng contract khai `?: string` (vắng =
    // hiệu lực từ thời điểm tạo) — `null` phải thành vắng mặt, không phải `null`.
    ...(row.effective_from === null ? {} : { effective_from: iso(row.effective_from) }),
    effective_until: isoNullable(row.effective_until),
    granted_by: row.granted_by,
    created_at: iso(row.created_at),
    revoked_at: isoNullable(row.revoked_at),
  };
}

/** Chuyen mot AuditEntryRow (schema) sang AuditEntry (wire). */
function toAuditEntry(row: AuditEntryRow): AuditEntry {
  return {
    id: row.id,
    actor_staff_id: row.actor_staff_id,
    actor_sub: row.actor_sub,
    target: row.target,
    action: row.action,
    occurred_at: iso(row.occurred_at),
    outcome: row.outcome as AuditEntry['outcome'],
    reason: row.reason,
    correlation_id: row.correlation_id,
    ...(Object.keys(row.context).length === 0 ? {} : { context: row.context }),
  };
}

/**
 * Dung router management — mount vao app chinh SAU middleware config, nen
 * moi handler doc `c.get('config')` da duoc kiem san.
 */
export function staffAccessRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---------------------------------------------------------------- staff --
  app.get('/staff', async (c) => {
    const params = parseListParams(c.req.query());
    if (!params.ok) {
      return c.json(params.error.body, params.error.status);
    }
    const cursor =
      params.cursor === null ? null : decodeKeysetCursor(params.cursor, 'staff-created-at');
    if (params.cursor !== null && cursor === null) {
      return c.json({ error: 'Bad Request', message: 'cursor is not a valid token.' }, 400);
    }
    const rows = await withClient(c, (db) =>
      listStaff(db, {
        limit: params.limit + 1,
        ...(cursor === null ? {} : { cursor: { createdAt: cursor.at, id: cursor.id } }),
      }),
    );
    const page = rows.slice(0, params.limit);
    const hasMore = rows.length > params.limit;
    const last = page[page.length - 1];
    const response = staffListResponse(
      page.map(toStaffMember),
      hasMore && last !== undefined
        ? encodeKeysetCursor({ axis: 'staff-created-at', at: iso(last.created_at), id: last.id })
        : null,
    );
    return c.json(response);
  });

  app.get('/staff/:id', async (c) => {
    const row = await withClient(c, (db) => getStaffById(db, c.req.param('id')));
    if (row === null) {
      return c.json(notFound('Staff entry not found.').body, 404);
    }
    return c.json(toStaffMember(row));
  });

  // ------------------------------------------------- staff create (ADR-0034) --
  // `POST /staff` — đường tạo staff identity (issue #44, ADR-0023 Quyết định 2
  // tiền đề của bổ nhiệm thường). Permission `staff.create` enforce như route
  // gán/thu hồi; sub là Account ID đã tồn tại bên `account` (reference opaque —
  // service này không tạo Account, ADR-0012 §4), display_name theo cap contract.
  app.post('/staff', async (c) => {
    const parsed = await readJsonObject(c);
    if (!parsed.ok) {
      return c.json(parsed.error.body, parsed.error.status);
    }
    const validated = validateCreateStaffRequest(parsed.body);
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const request = validated.payload;

    // Permission enforcement TRƯỚC mọi đọc nghiệp vụ — cùng hình route gán/thu hồi.
    const permitted = await withClient(c, (db) => requireWritePermission(c, db, 'staff.create'));
    if (!permitted) {
      if (c.get('actorStaffId') === null) {
        return c.json(
          {
            error: 'Unauthorized',
            message: 'Creating a staff entry requires an actor principal in the envelope.',
          },
          401,
        );
      }
      return c.json(
        { error: 'Forbidden', message: 'The actor does not hold the staff.create permission.' },
        403,
      );
    }

    const result = await withClient(c, async (db) =>
      db.begin(async (tx) => {
        // sub UNIQUE ở schema là ràng buộc thật; SELECT trước để hàng audit
        // `denied` mang đúng lý do thay vì một lỗi constraint chung.
        const existing = await getStaffBySub(tx, request.sub);
        if (existing !== null) {
          await appendAuditEntry(tx, {
            actorStaffId: c.get('actorStaffId'),
            actorSub: c.get('actorSub'),
            target: existing.id,
            action: 'staff.create',
            outcome: 'denied',
            reason: 'staff_already_exists',
            correlationId: c.get('requestId'),
          });
          return { conflict: true as const };
        }
        const staffId = crypto.randomUUID();
        await insertStaff(tx, {
          id: staffId,
          sub: request.sub,
          displayName: request.display_name,
        });
        // Audit cùng transaction — tạo staff không tồn tại không audit là dấu
        // vết thiếu (SR-013): sổ staff chỉ lớn lên qua đường có audit này.
        await appendAuditEntry(tx, {
          actorStaffId: c.get('actorStaffId'),
          actorSub: c.get('actorSub'),
          target: staffId,
          action: 'staff.create',
          outcome: 'success',
          correlationId: c.get('requestId'),
        });
        return { staffId };
      }),
    );
    if (result.conflict === true) {
      return c.json(
        { error: 'Conflict', message: 'A staff entry already exists for this account.' },
        409,
      );
    }
    const created = await withClient(c, (db) => getStaffById(db, result.staffId));
    if (created === null) {
      throw new Error('staff entry vanished after commit');
    }
    return c.json(toStaffMember(created), 201);
  });

  app.get('/staff/:id/assignments', async (c) => {
    const staffId = c.req.param('id');
    const rows = await withClient(c, (db) => listAssignmentsForStaff(db, staffId));
    const assignments: StaffRoleAssignment[] = [];
    for (const row of rows) {
      const checked = validateStaffRoleAssignment(toAssignment(row));
      if (!checked.ok) {
        throw new Error(`assignment row failed contract validation: ${checked.reason}`);
      }
      assignments.push(checked.payload);
    }
    return c.json(assignmentListResponse(assignments, null));
  });

  app.post('/staff/:id/assignments', async (c) => {
    const staffId = c.req.param('id');
    const parsed = await readJsonObject(c);
    if (!parsed.ok) {
      return c.json(parsed.error.body, parsed.error.status);
    }
    const body = parsed.body;
    const validated = validateCreateAssignmentRequest({ ...body, staff_id: staffId });
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const request = validated.payload;

    // Permission enforcement TRƯỚC mọi đọc nghiệp vụ (ADR-0034): denied ->
    // 403 + hàng audit đã commit (helper ghi trong cùng client rồi helper trả
    // 403; client đóng trong finally nên hàng đã commit khi response về).
    const permitted = await withClient(c, (db) => requireWritePermission(c, db, 'role.assign'));
    if (!permitted) {
      if (c.get('actorStaffId') === null) {
        return c.json(
          {
            error: 'Unauthorized',
            message: 'Granting a role requires an actor principal in the envelope.',
          },
          401,
        );
      }
      return c.json(
        { error: 'Forbidden', message: 'The actor does not hold the role.assign permission.' },
        403,
      );
    }

    const result = await withClient(c, async (db) =>
      db.begin(async (tx) => {
        const staff = await getStaffById(tx, staffId);
        if (staff === null) {
          throw staffAccessDomainError('staff_not_found');
        }
        // Target phải `active` (ADR-0023 Quyết định 2): suspended lẫn terminated
        // đều không phải mục tiêu bổ nhiệm hợp lệ.
        if (staff.status === 'suspended') {
          throw staffAccessDomainError('staff_suspended');
        }
        if (staff.status === 'terminated') {
          throw staffAccessDomainError('staff_terminated');
        }
        const role = await getRoleById(tx, request.role_id);
        if (role === null || role.status !== 'active') {
          throw staffAccessDomainError('role_not_found');
        }
        // SR-005: cấm self-assignment — actor không tự gán role cho chính mình.
        // Không ghi audit trong transaction: ADR-0023 Quyết định 6 đòi hàng
        // `denied` phải commit, mà transaction này không được commit — hàng
        // được ghi ngoài transaction sau khi begin trả về (cùng hình
        // `requireWritePermission`), trước khi route trả 403.
        if (c.get('actorStaffId') === staffId) {
          return { selfAssignment: true as const };
        }
        // ADR-0023 Quyết định 2: target đã có assignment còn hiệu lực cho cùng
        // role -> không tạo thêm; đó là no-op có audit, không phải bổ nhiệm lần hai.
        const live = await getLiveAssignmentForStaffRole(tx, staffId, request.role_id);
        if (live !== null) {
          await appendAuditEntry(tx, {
            actorStaffId: c.get('actorStaffId'),
            actorSub: c.get('actorSub'),
            target: live.id,
            action: 'role_assignment.create',
            outcome: 'success',
            reason: 'duplicate_live_assignment',
            correlationId: c.get('requestId'),
          });
          return { duplicate: live.id };
        }
        const assignmentId = crypto.randomUUID();
        await insertAssignment(tx, {
          id: assignmentId,
          staffId,
          roleId: request.role_id,
          scope: request.scope,
          effectiveFrom: request.effective_from,
          effectiveUntil: request.effective_until ?? undefined,
          grantedBy: c.get('actorStaffId'),
        });
        // Audit cung transaction — grant khong ton tai khong audit (SR-013).
        await appendAuditEntry(tx, {
          actorStaffId: c.get('actorStaffId'),
          actorSub: c.get('actorSub'),
          target: assignmentId,
          action: 'role_assignment.create',
          outcome: 'success',
          correlationId: c.get('requestId'),
          reason:
            request.effective_until === undefined || request.effective_until === null
              ? null
              : 'temporary',
        });
        return { created: assignmentId };
      }),
    );
    if (result.selfAssignment === true) {
      // Hàng audit `denied` ghi ngoài transaction, commit trước khi trả 403
      // (ADR-0023 Quyết định 6 — cùng hình `requireWritePermission`).
      await withClient(c, (db) =>
        appendAuditEntry(db, {
          actorStaffId: c.get('actorStaffId'),
          actorSub: c.get('actorSub'),
          target: staffId,
          action: 'role.assign',
          outcome: 'denied',
          reason: 'self_assignment',
          correlationId: c.get('requestId'),
        }),
      );
      return c.json(
        { error: 'Forbidden', message: 'Self-assignment of a role is not permitted.' },
        403,
      );
    }
    if (result.duplicate !== undefined) {
      // No-op có audit: trả assignment hiện có, không tạo hàng trùng.
      const existing = await withClient(c, (db) => getAssignmentById(db, result.duplicate));
      if (existing === null) {
        throw new Error('live assignment vanished');
      }
      return c.json(toAssignment(existing));
    }
    if (result.created === undefined) {
      throw new Error('assignment create returned no id');
    }
    const created = await withClient(c, (db) => getAssignmentById(db, result.created));
    if (created === null) {
      throw new Error('assignment vanished after commit');
    }
    return c.json(toAssignment(created), 201);
  });

  app.post('/assignments/revoke', async (c) => {
    const parsed = await readJsonObject(c);
    if (!parsed.ok) {
      return c.json(parsed.error.body, parsed.error.status);
    }
    const body = parsed.body;
    const validated = validateRevokeAssignmentRequest(body);
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const assignmentId = validated.payload.id;

    // Permission enforcement TRƯỚC mọi đọc nghiệp vụ — cùng hình route gán.
    const permitted = await withClient(c, (db) => requireWritePermission(c, db, 'role.revoke'));
    if (!permitted) {
      if (c.get('actorStaffId') === null) {
        return c.json(
          {
            error: 'Unauthorized',
            message: 'Revoking an assignment requires an actor principal in the envelope.',
          },
          401,
        );
      }
      return c.json(
        { error: 'Forbidden', message: 'The actor does not hold the role.revoke permission.' },
        403,
      );
    }

    const outcome = await withClient(c, async (db) =>
      db.begin(async (tx) => {
        const existing = await getAssignmentById(tx, assignmentId);
        if (existing === null) {
          return { notFound: true as const };
        }
        if (existing.revoked_at !== null) {
          return { alreadyRevoked: true as const };
        }
        // ADR-0023 Quyết định 2: cấm self-revocation của assignment administrator
        // CUỐI CÙNG còn hiệu lực — administrator không tự rút quyền của chính mình
        // khi không còn ai khác giữ canonical role. Audit `denied` ghi trong cùng
        // transaction rồi transaction ROLLBACK theo kết quả — không có hàng nào
        // khác được ghi.
        if (c.get('actorStaffId') === existing.staff_id && existing.role_id !== null) {
          const role = await getRoleById(tx, existing.role_id);
          if (role !== null && isCanonicalAdministratorRole(role)) {
            const liveCount = await countLiveAssignmentsForStaffRole(
              tx,
              existing.staff_id,
              existing.role_id,
            );
            if (liveCount === 1) {
              // Không ghi audit trong transaction — hàng `denied` phải commit
              // (ADR-0023 Quyết định 6) mà transaction này không được commit;
              // hàng được ghi ngoài transaction trước khi route trả 403.
              return { selfRevocationLastAdmin: true as const };
            }
          }
        }
        const changed = await revokeAssignment(tx, assignmentId, new Date().toISOString());
        if (changed !== 1) {
          throw staffAccessDomainError('invalid_transition');
        }
        await appendAuditEntry(tx, {
          actorStaffId: c.get('actorStaffId'),
          actorSub: c.get('actorSub'),
          target: assignmentId,
          action: 'role_assignment.revoke',
          outcome: 'success',
          correlationId: c.get('requestId'),
        });
        return { alreadyRevoked: false as const, assignment: existing };
      }),
    );
    if (outcome.notFound) {
      return c.json(notFound('Assignment not found.').body, 404);
    }
    if (outcome.selfRevocationLastAdmin === true) {
      // Hàng audit `denied` ghi ngoài transaction, commit trước khi trả 403
      // (ADR-0023 Quyết định 6 — cùng hình `requireWritePermission`).
      await withClient(c, (db) =>
        appendAuditEntry(db, {
          actorStaffId: c.get('actorStaffId'),
          actorSub: c.get('actorSub'),
          target: assignmentId,
          action: 'role.revoke',
          outcome: 'denied',
          reason: 'self_revocation_last_administrator',
          correlationId: c.get('requestId'),
        }),
      );
      return c.json(
        {
          error: 'Forbidden',
          message: 'Self-revocation of the last live administrator assignment is not permitted.',
        },
        403,
      );
    }
    if (outcome.alreadyRevoked) {
      return c.json(
        { error: 'Conflict', message: 'The assignment has already been revoked.' },
        409,
      );
    }
    const fresh = await withClient(c, (db) => getAssignmentById(db, assignmentId));
    if (fresh === null) {
      throw new Error('assignment vanished after revoke');
    }
    return c.json(toAssignment(fresh));
  });

  // ----------------------------------------------------------------- roles --
  app.get('/roles', async (c) => {
    const limit = parseOptionalLimit(c.req.query()['limit'], ROLE_LIST_MAX_LIMIT);
    if (limit === null) {
      return c.json(
        badRequest(`limit must be an integer in [1, ${ROLE_LIST_MAX_LIMIT}].`).body,
        400,
      );
    }
    const effectiveLimit = limit ?? ROLE_LIST_DEFAULT_LIMIT;
    const rows = await withClient(c, async (db) => {
      const roles = await listActiveRoles(db);
      // Enrich permission ids cho tung role trong cung mot client (issue #289
      // — khong mo client moi cho moi role).
      const withPermissions = [];
      for (const role of roles) {
        const permissions = await listRolePermissionIds(db, role.id);
        withPermissions.push(toStaffRole(role, permissions));
      }
      return withPermissions;
    });
    const page = rows.slice(0, effectiveLimit);
    // next_cursor luon null: route chua ho tro input `cursor` (repo khong co
    // keyset cho roles), quang cao cursor khong the tiep dung la sai contract.
    // Them keyset roles khi catalog lon den muc can phan trang thuc su.
    const response = roleListResponse(page, null);
    return c.json(response);
  });

  app.get('/roles/:id', async (c) => {
    const role = await withClient(c, async (db) => {
      const row = await getRoleById(db, c.req.param('id'));
      if (row === null) {
        return null;
      }
      const permissions = await listRolePermissionIds(db, row.id);
      return toStaffRole(row, permissions);
    });
    if (role === null) {
      return c.json(notFound('Role not found.').body, 404);
    }
    return c.json(role);
  });

  // ----------------------------------------------------------- permissions --
  app.get('/permissions', async (c) => {
    const limit = parseOptionalLimit(c.req.query()['limit'], PERMISSION_LIST_MAX_LIMIT);
    if (limit === null) {
      return c.json(
        badRequest(`limit must be an integer in [1, ${PERMISSION_LIST_MAX_LIMIT}].`).body,
        400,
      );
    }
    const effectiveLimit = limit ?? PERMISSION_LIST_DEFAULT_LIMIT;
    const rows = await withClient(c, (db) => listActivePermissions(db));
    const page = rows.slice(0, effectiveLimit);
    // next_cursor luon null — cung ly do voi /roles (khong co keyset input).
    const response = permissionListResponse(
      page.map((row) =>
        permissionEntry(
          row.domain,
          row.action,
          row.status as 'active' | 'retired',
          iso(row.created_at),
        ),
      ),
      null,
    );
    return c.json(response);
  });

  app.get('/permissions/:id', async (c) => {
    const row = await withClient(c, (db) => getPermissionById(db, c.req.param('id')));
    if (row === null) {
      return c.json(notFound('Permission is not in the catalog.').body, 404);
    }
    return c.json(
      permissionEntry(
        row.domain,
        row.action,
        row.status as 'active' | 'retired',
        iso(row.created_at),
      ),
    );
  });

  // ----------------------------------------------------------------- audit --
  // ------------------------------------------- authorization verdict --
  // `POST /authorization/verdict` — bề mặt duy nhất trả verdict permission cho
  // một caller khác bounded context (ADR-0033 Quyết định 3). KHÔNG phải route
  // management: nó đọc tập permission hiệu lực của chính actor trong envelope
  // và ghi một hàng audit cho mỗi lần hỏi, commit trước khi trả lời.
  app.post('/authorization/verdict', async (c) => {
    const actorStaffId = c.get('actorStaffId');
    // Không có actor principal ⇒ không có verdict nào để quyết. 401 (thiếu
    // danh tính), không phải 403: đây không phải một lần từ chối quyền, nên
    // không có hàng audit `denied` — target của hàng đó là `staff.id`, mà chưa
    // phân giải được staff nào (ADR-0023 Quyết định 6).
    if (actorStaffId === null) {
      return c.json(
        {
          error: 'Unauthorized',
          message: 'A permission verdict requires an actor principal in the envelope.',
        },
        401,
      );
    }
    const parsed = await readJsonObject(c);
    if (!parsed.ok) {
      return c.json(parsed.error.body, parsed.error.status);
    }
    const validated = validatePermissionVerdictRequest(parsed.body);
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const request = validated.request;

    // Đọc và ghi trên cùng một client; `appendAuditEntry` là một câu INSERT nên
    // hàng audit đã commit khi route trả lời (SR-013, ADR-0023 Quyết định 6).
    const allowed = await withClient(c, async (db) => {
      const effective = await listEffectivePermissionIdsForStaff(db, actorStaffId);
      const isAllowed = effective.includes(request.permission);
      await appendAuditEntry(db, {
        actorStaffId,
        actorSub: c.get('actorSub'),
        target: actorStaffId,
        action: request.permission,
        outcome: isAllowed ? 'success' : 'denied',
        reason: isAllowed ? null : 'permission_denied',
        correlationId: request.correlation_id,
      });
      return isAllowed;
    });

    return c.json(permissionVerdictResponse(allowed ? 'allowed' : 'denied', actorStaffId));
  });

  app.get('/audit/entries', async (c) => {
    const query = c.req.query();
    const candidate: AuditQueryRequest = {
      ...(query['actor_staff_id'] === undefined ? {} : { actor_staff_id: query['actor_staff_id'] }),
      ...(query['actor_sub'] === undefined ? {} : { actor_sub: query['actor_sub'] }),
      ...(query['target'] === undefined ? {} : { target: query['target'] }),
      ...(query['action'] === undefined ? {} : { action: query['action'] }),
      ...(query['occurred_from'] === undefined ? {} : { occurred_from: query['occurred_from'] }),
      ...(query['occurred_to'] === undefined ? {} : { occurred_to: query['occurred_to'] }),
      ...(query['correlation_id'] === undefined ? {} : { correlation_id: query['correlation_id'] }),
      ...(query['limit'] === undefined ? {} : { limit: Number(query['limit']) }),
      ...(query['cursor'] === undefined || query['cursor'] === ''
        ? {}
        : { cursor: query['cursor'] }),
    };
    const validated = validateAuditQueryRequest(candidate);
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const request = validated.payload;
    const cursor =
      request.cursor === undefined || request.cursor === null
        ? null
        : decodeKeysetCursor(request.cursor, 'audit-occurred-at');
    if (request.cursor !== undefined && request.cursor !== null && cursor === null) {
      return c.json({ error: 'Bad Request', message: 'cursor is not a valid token.' }, 400);
    }
    const rows = await withClient(c, (db) =>
      queryAuditEntries(
        db,
        {
          actorStaffId: request.actor_staff_id,
          actorSub: request.actor_sub,
          target: request.target,
          action: request.action,
          occurredFrom: request.occurred_from,
          occurredTo: request.occurred_to,
          correlationId: request.correlation_id,
        },
        {
          limit: (request.limit ?? AUDIT_LIST_DEFAULT_LIMIT) + 1,
          ...(cursor === null ? {} : { cursor: { occurredAt: cursor.at, id: cursor.id } }),
        },
      ),
    );
    const effectiveLimit = request.limit ?? AUDIT_LIST_DEFAULT_LIMIT;
    const page = rows.slice(0, effectiveLimit);
    const hasMore = rows.length > effectiveLimit;
    const last = page[page.length - 1];
    const response = auditListResponse(
      page.map(toAuditEntry),
      hasMore && last !== undefined
        ? encodeKeysetCursor({ axis: 'audit-occurred-at', at: iso(last.occurred_at), id: last.id })
        : null,
    );
    return c.json(response);
  });

  // --------------------------------------------------------- entitlements --
  app.get('/staff/:id/entitlements/:product', async (c) => {
    const row = await withClient(c, (db) =>
      getEntitlement(db, c.req.param('id'), c.req.param('product')),
    );
    if (row === null || !isEntitlementFresh(row)) {
      return c.json(notFound('Entitlement not found.').body, 404);
    }
    return c.json({
      staff_id: row.staff_id,
      product: row.product,
      status: row.status as 'entitled' | 'revoked',
      revision: Number(row.revision),
      occurred_at: iso(row.occurred_at),
    });
  });

  app.get('/staff/:id/entitlements', async (c) => {
    const rows = await withClient(c, (db) => listEntitlementsForStaff(db, c.req.param('id')));
    const freshRows = rows.filter((row) => isEntitlementFresh(row));
    if (freshRows.length !== rows.length) {
      return c.json({ error: 'Service Unavailable', message: 'Entitlement state is stale.' }, 503);
    }
    return c.json({
      entitlements: freshRows.map((row) => ({
        staff_id: row.staff_id,
        product: row.product,
        status: row.status as 'entitled' | 'revoked',
        revision: Number(row.revision),
        occurred_at: iso(row.occurred_at),
      })),
      next_cursor: null,
    });
  });

  // --------------------------------------------------------- outbox settle --
  app.post('/outbox/:event_id/settle', async (c) => {
    try {
      const eventId = c.req.param('event_id');
      const ok = await withClient(c, (db) =>
        settleOutboxEvent(db, eventId, new Date().toISOString()),
      );
      if (!ok) {
        return c.json(notFound('Outbox event not found.').body, 404);
      }
      return c.json({ settled: true });
    } catch (err) {
      // oxlint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Failed to settle outbox event',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return c.json({ error: 'Internal Server Error' }, 500);
    }
  });

  return app;
}

/** Doc limit tuy chon tu query string — `null` la sai hinh, `undefined` la vang. */
function parseOptionalLimit(raw: string | undefined, max: number): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return null;
  }
  return value;
}

/** Chay fn tren mot client moi theo config trong context — dong client trong finally. */
function withClient<T>(
  c: { get: (key: 'config') => { hyperdrive: { connectionString: string } } },
  fn: (db: StaffAccessClient) => Promise<T>,
): Promise<T> {
  return withStaffAccessClient(c.get('config'), fn);
}
