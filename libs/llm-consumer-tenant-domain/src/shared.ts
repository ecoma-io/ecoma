/**
 * Kiến trúc dùng chung của domain library `llm-consumer-tenant`.
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào —
 * domain không đọc đồng hồ (`Date.now()`), không parse RFC 3339, không sinh số
 * ngẫu nhiên. Mọi hàm là thuần: không sửa input, không giữ state, và trả
 * result (`ok`/`error`) thay vì ném exception cho dữ liệu đầu vào hỏng.
 *
 * Runtime string (error message) viết bằng ENGLISH theo language policy của
 * repo.
 */

import {
  llmTenantDomainError,
  type LlmTenantDomainError,
  type LlmTenantDomainErrorCode,
} from './errors';

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------

/** Nhánh thành công: mang giá trị đã validate. */
export interface LlmTenantOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface LlmTenantFailure {
  readonly ok: false;
  readonly error: LlmTenantDomainError;
}

/** Kết quả của một operation domain. */
export type LlmTenantResult<Value> = LlmTenantOk<Value> | LlmTenantFailure;

/** Dựng nhánh thành công. */
export function llmTenantOk<Value>(value: Value): LlmTenantResult<Value> {
  return { ok: true, value };
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy. */
export function llmTenantFailure<Value = never>(
  code: LlmTenantDomainErrorCode,
): LlmTenantResult<Value> {
  return { ok: false, error: llmTenantDomainError(code) };
}

// ---------------------------------------------------------------------------
// Định danh
// ---------------------------------------------------------------------------

/**
 * `sub` — Account ID do `account` phát hành, chỉ được lấy từ verified
 * authentication context. Đây là **tham chiếu opaque**, không FK xuyên
 * database; giá trị client gửi lên không bao giờ trở thành actor.
 */
declare const actorBrand: unique symbol;

/** Account ID (`sub`) đã qua validate. */
export type TenantActorId = string & { readonly [actorBrand]?: true };

/** Tenant ID đã qua validate. */
declare const tenantIdBrand: unique symbol;

/** Định danh tenant. */
export type TenantId = string & { readonly [tenantIdBrand]?: true };

/** Workspace ID đã qua validate. */
declare const workspaceIdBrand: unique symbol;

/** Định danh workspace trong phạm vi một tenant. */
export type WorkspaceId = string & { readonly [workspaceIdBrand]?: true };

declare const membershipIdBrand: unique symbol;

/**
 * Định danh một **lần** membership. Cùng `(tenant, actor)` có thể có nhiều lần
 * membership theo thời gian (revoke rồi provision lại), nên grant phải trỏ tới
 * lần membership cụ thể — nếu không, quyền cũ sẽ sống lại sau khi provision lại.
 */
export type MembershipId = string & { readonly [membershipIdBrand]?: true };

/** Độ dài tối đa của mọi định danh opaque để chặn payload bất thường từ input. */
export const MAX_OPAQUE_ID_LENGTH = 200;

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

/** Type guard cho `TenantActorId` — dùng khi đọc `sub` từ token/DB/contract. */
export function isTenantActorId(value: unknown): value is TenantActorId {
  return isOpaqueId(value);
}

/** Type guard cho `TenantId` — dùng khi đọc tenant ID từ selector đã verify. */
export function isTenantId(value: unknown): value is TenantId {
  return isOpaqueId(value);
}

/** Type guard cho `WorkspaceId`. */
export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return isOpaqueId(value);
}

/** Type guard cho `MembershipId`. */
export function isMembershipId(value: unknown): value is MembershipId {
  return isOpaqueId(value);
}

/**
 * Dựng `TenantActorId` từ giá trị đã verify.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createTenantActorId(value: string): TenantActorId {
  if (!isTenantActorId(value)) {
    throw new TypeError('Tenant actor ID must be a non-empty, trimmed opaque string.');
  }
  return value;
}

/**
 * Dựng `TenantId`.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createTenantId(value: string): TenantId {
  if (!isTenantId(value)) {
    throw new TypeError('Tenant ID must be a non-empty, trimmed opaque string.');
  }
  return value;
}

/**
 * Dựng `WorkspaceId`.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createWorkspaceId(value: string): WorkspaceId {
  if (!isWorkspaceId(value)) {
    throw new TypeError('Workspace ID must be a non-empty, trimmed opaque string.');
  }
  return value;
}

/**
 * Dựng `MembershipId`.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createMembershipId(value: string): MembershipId {
  if (!isMembershipId(value)) {
    throw new TypeError('Membership ID must be a non-empty, trimmed opaque string.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Thời gian
// ---------------------------------------------------------------------------

/** Kiểm tra một giá trị có phải epoch millis hợp lệ (số nguyên an toàn) không. */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

// ---------------------------------------------------------------------------
// Permission identifier
// ---------------------------------------------------------------------------

/**
 * Định danh permission theo định dạng **`domain.action` dot-style** — quy ước
 * canonical đã chốt ở
 * `docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md`.
 *
 * ⚠️ Lib này **không** sở hữu permission catalog. Nó giữ định danh như một
 * giá trị opaque đã validate hình dạng, đúng ranh giới "catalog govern ở
 * `staff-access` / backend enforce" (A21–A24, ADR-0009); việc một permission
 * có tồn tại trong catalog hay không là dữ liệu của catalog, không phải của
 * domain model này.
 *
 * Wildcard (`*`, `admin.all`) bị từ chối: ADR-0010 loại permission bao trùm.
 */
export type PermissionId = string & { readonly [permissionIdBrand]?: true };

declare const permissionIdBrand: unique symbol;

/**
 * Hai nửa `domain` và `action` đều bắt đầu bằng chữ thường, chỉ gồm
 * `[a-z0-9_]`; action cho phép dấu `.` để giữ các tên nhiều tầng
 * (`workspace.settings.update`) trong khi vẫn chỉ có **một** dấu phân tách
 * domain/action đầu tiên.
 */
const PERMISSION_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

/** Type guard cho `PermissionId` — dùng khi đọc permission từ catalog/request. */
export function isPermissionId(value: unknown): value is PermissionId {
  return (
    typeof value === 'string' &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    PERMISSION_ID_PATTERN.test(value)
  );
}

/**
 * Dựng `PermissionId` từ định danh đã đọc ở boundary.
 * @throws TypeError khi định danh sai quy ước `domain.action`.
 */
export function createPermissionId(value: string): PermissionId {
  if (!isPermissionId(value)) {
    throw new TypeError('Permission ID must follow the dot-style "domain.action" convention.');
  }
  return value;
}

/**
 * Permission quản lý billing của tenant — cho phép member khởi tạo/top up cho
 * tenant và **không** cấp quyền quản trị tenant khác hay quyền payment.
 *
 * ⚠️ Ranh giới: đây là định danh **do domain `llm-consumer-tenant` dùng** cho quyết
 * định authorization; nó không phải một entry catalog được lib này tạo ra.
 * Việc đăng ký/seed định danh trong permission catalog thuộc governance của
 * catalog (ADR-0010) và là open boundary được ghi ở
 * `docs/domains/llm-consumer-tenant/domain-model.md` §2, §8.
 */
export const LLM_TENANT_BILLING_MANAGEMENT_PERMISSION = createPermissionId('billing.manage');
