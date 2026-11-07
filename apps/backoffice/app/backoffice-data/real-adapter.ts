/**
 * Adapter thật — đọc dữ liệu từ backend qua internal fetch cùng-origin.
 *
 * Ba phương thức đọc gọi `GET /api/staff`, `GET /api/roles`,
 * `GET /api/permissions` bên trong Worker (hoặc từ trình duyệt, cùng origin),
 * rồi ánh xạ hình dạng hợp đồng wire sang kiểu UI. Mọi lỗi (mạng, phi 2xx,
 * DB không khả dụng, enforcement từ chối) đều bị ném ra để `useAsyncState`
 * hiển thị trạng thái error — fail-closed, không bao giờ trả dữ liệu giả.
 *
 * `isPreview = false`: UI không hiển thị banner "dữ liệu mẫu".
 *
 * ⚠️ Không truy cập DB trực tiếp: mọi đường đi dữ liệu đi qua read route
 * (`server/api/{staff,roles,permissions,entitlements,audit}.get.ts`), mỗi route
 * đã có enforcement riêng. Adapter này chỉ là consommateur của hợp đồng API
 * nội bộ.
 */
import type {
  AuditEntry,
  BackofficeDataAdapter,
  Permission,
  StaffEntitlementSummary,
  StaffMember,
  SystemRole,
} from './types';

/** Hình dạng route trả về cho `GET /api/staff`. */
type WireStaff = {
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

/** Gọi một route đọc nội bộ, fail-closed: phi 2xx hoặc lỗi mạng đều ném. */
async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Backoffice route ${path} trả về ${response.status}`);
  }

  return (await response.json()) as T;
}

function mapStaff(row: WireStaff): StaffMember {
  return {
    accountId: row.sub,
    displayName: row.displayName ?? '',
    status: row.status as StaffMember['status'],
    roleIds: [],
    entitlements: [],
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
  };
}
