/**
 * Client `backoffice → staff-access` qua contract nội bộ `GET /staff`,
 * `GET /roles`, `GET /permissions` (issue #475, P5.1).
 *
 * ## Service Binding là transport, không phải authenticator
 *
 * Cùng lý luận với `account/client.ts`: binding `STAFF_ACCESS_SERVICE`
 * **không** mang header hay `cf`, nên mọi request đều ký HMAC với
 * `AUTH_INTERNAL_SECRET`. Binding chỉ quyết định request đi tới đâu;
 * authentication nằm ở envelope.
 *
 * ## Một failure mode có chủ đích: fail-closed, không ném
 *
 * Module này trả **discriminated result** thay vì ném — khác
 * `AccountClient` của `auth`, vốn fail-closed tuyệt đối. Lý do: ba consumer
 * ở đây đều là **gate dữ liệu** (không phải controlled degrade như
 * `GET /api/staff` trước P5.1): khi staff-access không trả lời được, route
 * không có dữ liệu giả để phục vụ ⇒ caller ném 503. Caller quyết định
 * phản hồi, client không tự quyết — cùng ranh giới với `account/client.ts`.
 *
 * ## Vì sao hàm này nhận `env` thay vì `H3Event`
 *
 * Cùng quy ước với `account/client.ts`: lib infrastructure không ràng buộc
 * vào framework serving của một app; cách đọc `env` ra khỏi request là chi
 * tiết composition, phía app làm qua `readWorkerEnv` rồi truyền giá trị
 * thường vào đây.
 */

import { createNonce, signRequest } from '@ecoma-io/internal-auth-contracts';
import {
  validateAssignmentListResponse,
  validateAuditListResponse,
  validateEntitlementReadResponse,
  validatePermissionListResponse,
  validateRoleListResponse,
  validateStaffListResponse,
  type AssignmentListResponse,
  validateStaffRoleAssignment,
  type AuditEntry,
  type EntitlementReadResponse,
  type Permission,
  type StaffEntitlementEntry,
  type CreateAssignmentRequest,
  type StaffMember,
  type StaffRole,
  type StaffRoleAssignment,
} from '@ecoma-io/staff-access-contracts';

/**
 * Tên binding Service Binding tới `staff-access` — **không** chứa giá trị
 * nào khác (invariant 4: application code chỉ chứa tên binding).
 */
export const STAFF_ACCESS_SERVICE_BINDING_NAME = 'STAFF_ACCESS_SERVICE';

/**
 * Tên biến `env` của Worker giữ secret HMAC ký envelope nội bộ — same secret
 * mà `staff-access` dùng để verify. Giá trị do deploy layer cấp
 * (`wrangler secret`); code chỉ chứa tên.
 */
export const STAFF_ACCESS_SECRET_ENV = 'AUTH_INTERNAL_SECRET';

/** Shape tối thiểu của Service Binding mà module này đọc từ `env` của Worker. */
export interface StaffServiceBinding {
  fetch: (input: Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Timeout cho một lần gọi staff-access — cùng giá trị với `account` client.
 * Không có nó thì một staff-access unreachable giữ request tới hết hạn
 * Worker; có nó thì lỗi là "không gọi được" và fail nhanh.
 */
const STAFF_ACCESS_TIMEOUT_MS = 3_000;

/**
 * Mã lỗi ổn định của nhánh hạ infrastructure — đi vào log, không phải
 * message cho người dùng.
 */
export type StaffAccessCallFailureReason =
  | 'binding_missing'
  | 'secret_missing'
  | 'unreachable'
  | 'http_error'
  | 'invalid_response';

/** Kết quả một lần gọi list staff — discriminated union, không ném. */
export type StaffDirectoryCallResult =
  | { readonly ok: true; readonly staff: readonly StaffMember[] }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/** Kết quả một lần gọi list role — discriminated union, không ném. */
export type RoleCatalogCallResult =
  | { readonly ok: true; readonly roles: readonly StaffRole[] }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/** Kết quả một lần gọi list permission — discriminated union, không ném. */
export type PermissionCatalogCallResult =
  | { readonly ok: true; readonly permissions: readonly Permission[] }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/** Kết quả một lần gọi đọc entitlement của một staff — discriminated union, không ném. */
export type StaffEntitlementsCallResult =
  | { readonly ok: true; readonly entitlements: readonly StaffEntitlementEntry[] }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/** Kết quả một lần gọi đọc audit entries — discriminated union, không ném. */
export type AuditListCallResult =
  | { readonly ok: true; readonly entries: readonly AuditEntry[] }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/** Kết quả một lần gọi đọc assignments của một staff — discriminated union, không ném. */
export type StaffAssignmentsCallResult =
  | { readonly ok: true; readonly assignments: readonly StaffRoleAssignment[] }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

/**
 * Cấu hình đã qua kiểm hình dạng mà client cần cho mỗi lần gọi.
 *
 * ⚠️ Secret KHÔNG nằm trong object này — nó sống trong closure của
 * `signHeaders` và không bao giờ là property trả về cho caller. Xem lý do
 * đầy đủ ở `account/client.ts`.
 */
export interface StaffAccessClientConfig {
  readonly binding: StaffServiceBinding;
  readonly signHeaders: (
    path: string,
    init?: {
      readonly method?: string;
      readonly body?: Uint8Array | null;
      readonly actorSub?: string;
    },
  ) => Promise<Record<string, string>>;
}

/** `readString` — `null` khi không phải chuỗi khác rỗng. */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Đọc cấu hình client từ `env` của Worker.
 *
 * ⚠️ Phía app đọc `env` qua `readWorkerEnv` (`event.context.cloudflare.env`),
 * **không** qua `useRuntimeConfig(event).cloudflare` — preset `cloudflare-module`
 * của Nitro không populate khoá đó.
 *
 * @param env `env` của Worker — đọc ra khỏi request context bởi caller; giữ
 *   `unknown` để lib này không ràng buộc cách đọc.
 * @returns `null` khi thiếu binding hoặc secret — "chưa cấu hình" là trạng thái
 *   deployment hợp lệ, caller quyết định fail thế nào (không ném ở đây).
 */
export function staffAccessClientConfig(env: unknown): StaffAccessClientConfig | null {
  if (typeof env !== 'object' || env === null) {
    return null;
  }
  const record = env as Record<string, unknown>;
  const bindingValue = record[STAFF_ACCESS_SERVICE_BINDING_NAME];
  const secret = readString(record[STAFF_ACCESS_SECRET_ENV]);
  if (
    typeof bindingValue !== 'object' ||
    bindingValue === null ||
    typeof (bindingValue as StaffServiceBinding).fetch !== 'function' ||
    secret === null
  ) {
    return null;
  }
  const hmacSecret: string = secret;
  const binding = bindingValue as StaffServiceBinding;

  /**
   * Ký một GET nội bộ — cùng canonical envelope với phía verify của
   * `staff-access` (`signRequest` từ `@ecoma-io/internal-auth-contracts`).
   *
   * ⚠️ `path` phải là pathname + search nguyên vẹn: query string là một phần
   * của chuỗi ký. Headers trả về là một bản ghi phẳng, đi thẳng vào
   * `RequestInit.headers`.
   *
   * Ký ngay trong closure của config: secret đi vào `signRequest` với đủ
   * envelope đặc trưng — sanitizer của rule `security-sensitive-value-in-http-response`
   * cắt taint tại lời gọi này, nên object trả về cho caller chỉ mang binding
   * và hàm ký, không mang khóa.
   */
  async function signer(
    path: string,
    init?: {
      readonly method?: string;
      readonly body?: Uint8Array | null;
      readonly actorSub?: string;
    },
  ): Promise<Record<string, string>> {
    const method = init?.method ?? 'GET';
    const body = init?.body ?? new Uint8Array();
    const headers = await signRequest({
      method,
      path,
      body,
      secret: hmacSecret,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
      actorSub: init?.actorSub,
    });
    return { ...headers };
  }
  return {
    binding,
    signHeaders: signer,
  };
}

/**
 * Gọi một endpoint list nội bộ, fail-closed: lỗi mạng, phi 2xx, hoặc body
 * sai contract đều trả `{ ok: false, reason }`. Response validator là lưới
 * an toàn bắt buộc: payload đã đi qua `JSON.parse`, không còn ai giữ type.
 */
async function callList<T>(
  config: StaffAccessClientConfig,
  path: string,
  validate: (body: unknown) => { readonly ok: boolean; readonly payload?: unknown },
  onOk: (payload: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await config.binding.fetch(new Request(`https://staff-access.internal${path}`), {
      headers: await config.signHeaders(path),
      // Timeout qua `init.signal` — giới hạn duy nhất mà Service Binding có.
      signal: AbortSignal.timeout(STAFF_ACCESS_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' } as unknown as T;
  }

  if (!response.ok) {
    return { ok: false, reason: 'http_error' } as unknown as T;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_response' } as unknown as T;
  }

  const validation = validate(body);
  if (!validation.ok) {
    return { ok: false, reason: 'invalid_response' } as unknown as T;
  }
  return onOk(validation.payload);
}

/**
 * Gọi `GET /staff` và validate response. Mọi nhánh lỗi đều trả
 * `{ ok: false, reason }` — không ném, không trả dữ liệu giả.
 */
export async function fetchStaffDirectory(
  config: StaffAccessClientConfig,
): Promise<StaffDirectoryCallResult> {
  return callList<StaffDirectoryCallResult>(
    config,
    '/staff',
    validateStaffListResponse as (body: unknown) => {
      readonly ok: boolean;
      readonly payload: unknown;
    },
    (payload) => ({
      ok: true,
      staff: (payload as { readonly staff: readonly StaffMember[] }).staff,
    }),
  );
}

/**
 * Gọi `GET /roles` và validate response. Mọi nhánh lỗi đều trả
 * `{ ok: false, reason }` — không ném, không trả dữ liệu giả.
 */
export async function fetchRoleCatalog(
  config: StaffAccessClientConfig,
): Promise<RoleCatalogCallResult> {
  return callList<RoleCatalogCallResult>(
    config,
    '/roles',
    validateRoleListResponse as (body: unknown) => {
      readonly ok: boolean;
      readonly payload: unknown;
    },
    (payload) => ({ ok: true, roles: (payload as { readonly roles: readonly StaffRole[] }).roles }),
  );
}

/**
 * Gọi `GET /permissions` và validate response. Mọi nhánh lỗi đều trả
 * `{ ok: false, reason }` — không ném, không trả dữ liệu giả.
 */
export async function fetchPermissionCatalog(
  config: StaffAccessClientConfig,
): Promise<PermissionCatalogCallResult> {
  return callList<PermissionCatalogCallResult>(
    config,
    '/permissions',
    validatePermissionListResponse as (body: unknown) => {
      readonly ok: boolean;
      readonly payload: unknown;
    },
    (payload) => ({
      ok: true,
      permissions: (payload as { readonly permissions: readonly Permission[] }).permissions,
    }),
  );
}

/**
 * Gọi `GET /staff/:id/entitlements` — read model entitlement của một staff,
 * fail-closed: mọi nhánh lỗi trả `{ ok: false, reason }`.
 */
export async function fetchStaffEntitlements(
  config: StaffAccessClientConfig,
  staffId: string,
): Promise<StaffEntitlementsCallResult> {
  return callList<StaffEntitlementsCallResult>(
    config,
    `/staff/${encodeURIComponent(staffId)}/entitlements`,
    validateEntitlementReadResponse as (body: unknown) => {
      readonly ok: boolean;
      readonly payload: unknown;
    },
    (payload) => ({
      ok: true,
      entitlements: (payload as EntitlementReadResponse).entitlements,
    }),
  );
}

/**
 * Gọi `GET /staff/:id/assignments` — đọc assignments của một staff từ Staff
 * Access, fail-closed: mọi nhánh lỗi trả `{ ok: false, reason }`.
 */
export async function fetchStaffAssignments(
  config: StaffAccessClientConfig,
  staffId: string,
): Promise<StaffAssignmentsCallResult> {
  return callList<StaffAssignmentsCallResult>(
    config,
    `/staff/${encodeURIComponent(staffId)}/assignments`,
    validateAssignmentListResponse as (body: unknown) => {
      readonly ok: boolean;
      readonly payload: unknown;
    },
    (payload) => ({
      ok: true,
      assignments: (payload as AssignmentListResponse).assignments,
    }),
  );
}

/**
 * Gọi `GET /audit/entries` — truy vấn bản ghi authorization audit,
 * fail-closed: mọi nhánh lỗi trả `{ ok: false, reason }`.
 */
export async function fetchAuditEntries(
  config: StaffAccessClientConfig,
  query: Record<string, string>,
): Promise<AuditListCallResult> {
  const search = new URLSearchParams(query).toString();
  return callList<AuditListCallResult>(
    config,
    `/audit/entries?${search}`,
    validateAuditListResponse as (body: unknown) => {
      readonly ok: boolean;
      readonly payload: unknown;
    },
    (payload) => ({
      ok: true,
      entries: (payload as { readonly entries: readonly AuditEntry[] }).entries,
    }),
  );
}

export type StaffAssignmentWriteResult =
  | { readonly ok: true; readonly assignment: StaffRoleAssignment }
  | { readonly ok: false; readonly reason: StaffAccessCallFailureReason };

export async function createStaffAssignment(
  config: StaffAccessClientConfig,
  request: CreateAssignmentRequest,
  actorSub: string,
): Promise<StaffAssignmentWriteResult> {
  const path = `/staff/${encodeURIComponent(request.staff_id)}/assignments`;
  const body = new TextEncoder().encode(JSON.stringify(request));
  let response: Response;
  try {
    response = await config.binding.fetch(
      new Request(`https://staff-access.internal${path}`, {
        method: 'POST',
        body,
        headers: await config.signHeaders(path, { method: 'POST', body, actorSub }),
        signal: AbortSignal.timeout(STAFF_ACCESS_TIMEOUT_MS),
      }),
    );
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'http_error' };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  const validation = validateStaffRoleAssignment(parsed);
  if (!validation.ok) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, assignment: validation.payload };
}

export async function revokeStaffAssignment(
  config: StaffAccessClientConfig,
  assignmentId: string,
  actorSub: string,
): Promise<StaffAssignmentWriteResult> {
  const path = '/assignments/revoke';
  const bodyObj = { id: assignmentId };
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  let response: Response;
  try {
    response = await config.binding.fetch(
      new Request(`https://staff-access.internal${path}`, {
        method: 'POST',
        body,
        headers: await config.signHeaders(path, { method: 'POST', body, actorSub }),
        signal: AbortSignal.timeout(STAFF_ACCESS_TIMEOUT_MS),
      }),
    );
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'http_error' };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  const validation = validateStaffRoleAssignment(parsed);
  if (!validation.ok) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, assignment: validation.payload };
}
