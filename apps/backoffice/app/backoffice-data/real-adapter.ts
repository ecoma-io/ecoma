/**
 * Adapter thật — đọc dữ liệu từ backend qua internal fetch cùng-origin.
 *
 * Ba phương thức đọc gọi `GET /api/staff`, `GET /api/roles`,
 * `GET /api/permissions` bên trong Worker (hoặc từ trình duyệt, cùng origin),
 * rồi ánh xạ hình dạng hợp đồng wire sang kiểu UI. Mọi lỗi (mạng, phi 2xx,
 * DB không khả dụng, enforcement từ chối) đều bị ném ra để `useAsyncState`
 * hiển thị trạng thái error — fail-closed, không bao giờ trả dữ liệu giả.
 *
 * ## Phương thức ghi (#191)
 *
 * Ba phương thức ghi POST tới route BFF ghi cùng origin
 * (`/api/staff`, `/api/staff/:id/assignments`, `/api/assignments/revoke`) kèm
 * CSRF double-submit: cookie `__Host-backoffice-csrf` echo trong header
 * `x-ecoma-csrf` (cùng luật với logout — `use-backoffice-session.ts`). Route
 * kiểm session + CSRF rồi gọi staff-access, nơi permission được enforce;
 * 403/409 là **kết quả nghiệp vụ** nên ghi trả `BackofficeWriteResult` với
 * `status` + `message` (lý do domain forward nguyên vẹn) thay vì ném.
 *
 * Tên cookie/header được khai lại ở đây (không import package infra): bundle
 * client không được kéo pool/db của lib — cùng quy ước với
 * `use-backoffice-session.ts`; lệch tên làm route 403 và UI hiện lỗi, không có
 * chế độ "sai im lặng".
 *
 * `isPreview = false`: UI không hiển thị banner "dữ liệu mẫu".
 *
 * ⚠️ Không truy cập DB trực tiếp: mọi đường đi dữ liệu đi qua read route
 * (`server/api/{staff,roles,permissions,entitlements,audit}.get.ts`), mỗi route
 * đã có enforcement riêng. Adapter này chỉ là consommateur của hợp đồng API
 * nội bộ.
 */
import { BackofficeRouteError } from './route-error';
import type {
  AuditEntry,
  BackofficeDataAdapter,
  BackofficeWriteResult,
  Permission,
  StaffAssignment,
  StaffEntitlementSummary,
  StaffMember,
  SystemRole,
} from './types';

const CSRF_COOKIE_NAME = '__Host-backoffice-csrf';
const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/** Hình dạng route trả về cho `GET /api/staff`. */
type WireStaff = {
  /** UUID nội bộ của staff trong Staff Access — tham chiếu assignment. */
  readonly id: string;
  readonly sub: string;
  readonly status: string;
  readonly displayName: string | null;
};

/** Hình dạng route trả về cho `GET /api/roles`. */
type WireRole = {
  readonly id: string;
  readonly isSystem: boolean;
};

/** Hình dạng route trả về cho `GET /api/permissions`. */
type WirePermission = {
  readonly id: string;
  readonly domain: string;
  readonly action: string;
  readonly status: string;
};

/** Hình dạng route trả về cho `GET /api/entitlements`. */
type WireEntitlement = {
  readonly staff_id: string;
  readonly product: string;
  readonly status: 'entitled' | 'revoked';
  readonly revision: number;
  readonly occurred_at: string;
};

/** Hình dạng route trả về cho `GET /api/audit/entries`. */
type WireAuditEntry = {
  readonly id: string;
  readonly actor_staff_id: string | null;
  readonly actor_sub: string | null;
  readonly target: string;
  readonly action: string;
  readonly occurred_at: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly correlation_id: string | null;
};

/** Hình dạng route ghi trả về — đúng `StaffRoleAssignment` của contract. */
type WireStaffRoleAssignment = {
  readonly id: string;
  readonly role_id: string;
  readonly revoked_at: string | null;
};

type WireStaffResponse = { readonly staff: readonly WireStaff[] };
type WireRolesResponse = { readonly roles: readonly WireRole[] };
type WirePermissionsResponse = { readonly permissions: readonly WirePermission[] };
type WireEntitlementsResponse = {
  readonly entitlements: readonly WireEntitlement[];
  readonly next_cursor: string | null;
};
type WireAuditResponse = {
  readonly entries: readonly WireAuditEntry[];
  readonly next_cursor: string | null;
};
type WireAssignmentListResponse = { readonly assignments: readonly WireStaffRoleAssignment[] };

/**
 * Gọi một route đọc nội bộ, fail-closed: phi 2xx hoặc lỗi mạng đều ném.
 *
 * Lỗi phi 2xx là `BackofficeRouteError` mang `status` — useAsyncState đọc nó
 * vào `AsyncState.error.status` để UI phân nhánh theo ADR-0011 §4 (401 → đường
 * đăng nhập lại; 403/503 giữ hành vi cũ). Mạng đứt vẫn là `Error` trần: không
 * có status nào để phân nhánh.
 */
async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new BackofficeRouteError(
      `Backoffice route ${path} trả về ${response.status}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

/**
 * Đọc cookie CSRF bằng semantics của `document.cookie` — cùng logic với
 * `use-backoffice-session.ts` (đóng gói riêng vì composable phiên không thuộc
 * lớp dữ liệu).
 */
function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

/**
 * Gọi một route ghi nội bộ. Phi 2xx là kết quả nghiệp vụ (403 denial, 409
 * conflict, 503 hạ tầng) → `{ ok: false, status, message }` với `message`
 * đọc từ body `{ error, message }` của route; lỗi mạng ném (không có status
 * nào để phân nhánh).
 */
async function postJson<T>(path: string, body: unknown): Promise<BackofficeWriteResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const csrf = readCsrfToken();
  if (csrf !== undefined) {
    headers[CSRF_HEADER_NAME] = csrf;
  }
  const response = await fetch(path, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message: string | undefined;
    try {
      const parsed = (await response.json()) as { message?: unknown; statusMessage?: unknown };
      // h3 bọc `createError` thành envelope `{ statusCode, statusMessage }`
      // (đo ở `write-routes.spec.ts`), nên message domain của staff-access nằm
      // ở `statusMessage`; `message` giữ làm nhánh phụ cho body tự do.
      message =
        typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.statusMessage === 'string'
            ? parsed.statusMessage
            : undefined;
    } catch {
      // Body phi JSON — không có message để hiện.
    }
    return { ok: false, status: response.status, ...(message === undefined ? {} : { message }) };
  }
  return { ok: true, value: (await response.json()) as T };
}

function mapStaff(row: WireStaff): StaffMember {
  return {
    accountId: row.sub,
    displayName: row.displayName ?? '',
    status: row.status as StaffMember['status'],
    roleIds: [],
    entitlements: [],
    // UUID nội bộ Staff Access — tham chiếu cho đường assignment (gán/thu hồi).
    staffId: row.id,
  };
}

function mapAssignment(row: WireStaffRoleAssignment): StaffAssignment {
  return {
    assignmentId: row.id,
    roleId: row.role_id,
    revokedAt: row.revoked_at,
  };
}

function mapRole(row: WireRole): SystemRole {
  return {
    id: row.id,
    permissionIds: [],
  };
}

function mapPermission(row: WirePermission): Permission {
  return {
    id: row.id,
    domain: row.domain,
    action: row.action,
  };
}

function mapEntitlement(row: WireEntitlement): StaffEntitlementSummary {
  return {
    product: row.product,
    status: row.status,
  };
}

function mapAuditEntry(row: WireAuditEntry): AuditEntry {
  return {
    id: row.id,
    actor_staff_id: row.actor_staff_id,
    actor_sub: row.actor_sub,
    target: row.target,
    action: row.action,
    occurred_at: row.occurred_at,
    outcome: row.outcome as AuditEntry['outcome'],
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.correlation_id !== null ? { correlation_id: row.correlation_id } : {}),
  };
}

export function createRealBackofficeAdapter(): BackofficeDataAdapter {
  return {
    isPreview: false,

    async listStaff(): Promise<readonly StaffMember[]> {
      const response = await fetchJson<WireStaffResponse>('/api/staff');
      return response.staff.map(mapStaff);
    },

    async listRoles(): Promise<readonly SystemRole[]> {
      const response = await fetchJson<WireRolesResponse>('/api/roles');
      return response.roles.map(mapRole);
    },

    async listPermissions(): Promise<readonly Permission[]> {
      const response = await fetchJson<WirePermissionsResponse>('/api/permissions');
      return response.permissions.map(mapPermission);
    },

    async listEntitlements(staffId: string): Promise<readonly StaffEntitlementSummary[]> {
      const response = await fetchJson<WireEntitlementsResponse>(
        `/api/entitlements?staff_id=${encodeURIComponent(staffId)}`,
      );
      return response.entitlements.map(mapEntitlement);
    },

    async listAuditEntries(query: Record<string, string>): Promise<readonly AuditEntry[]> {
      const search = new URLSearchParams(query).toString();
      const response = await fetchJson<WireAuditResponse>(`/api/audit/entries?${search}`);
      return response.entries.map(mapAuditEntry);
    },

    async createStaff(request: {
      readonly sub: string;
      readonly displayName: string;
    }): Promise<BackofficeWriteResult<StaffMember>> {
      const result = await postJson<WireStaff>('/api/staff', {
        sub: request.sub,
        display_name: request.displayName,
      });
      return result.ok ? { ok: true, value: mapStaff(result.value) } : result;
    },

    async assignRole(request: {
      readonly staffId: string;
      readonly roleId: string;
    }): Promise<BackofficeWriteResult<StaffAssignment>> {
      const result = await postJson<WireStaffRoleAssignment>(
        `/api/staff/${encodeURIComponent(request.staffId)}/assignments`,
        { role_id: request.roleId },
      );
      return result.ok ? { ok: true, value: mapAssignment(result.value) } : result;
    },

    async revokeRole(assignmentId: string): Promise<BackofficeWriteResult<StaffAssignment>> {
      const result = await postJson<WireStaffRoleAssignment>('/api/assignments/revoke', {
        id: assignmentId,
      });
      return result.ok ? { ok: true, value: mapAssignment(result.value) } : result;
    },

    async listAssignments(staffInternalId: string): Promise<readonly StaffAssignment[]> {
      const response = await fetchJson<WireAssignmentListResponse>(
        `/api/staff/${encodeURIComponent(staffInternalId)}/assignments`,
      );
      return response.assignments.map(mapAssignment);
    },
  };
}
