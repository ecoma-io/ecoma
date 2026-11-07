/**
 * Kiến trúc dùng chung của domain library `llm-seller-tenant`.
 *
 * Đây là nửa **tenant** của bounded context Seller (ADR-0018): Seller tenant +
 * ownership transfer, membership, permission grant, authorization ladder và
 * payout permission identifier/scope constants. Restriction, appeal,
 * verification/onboarding, legal/tax profile và evidence thuộc
 * `llm-seller-governance` và **không** được import từ đây.
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
  llmSellerDomainError,
  type LlmSellerDomainError,
  type LlmSellerDomainErrorCode,
} from './errors';

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------

/** Nhánh thành công: mang giá trị đã validate. */
export interface LlmSellerOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface LlmSellerFailure {
  readonly ok: false;
  readonly error: LlmSellerDomainError;
}

/** Kết quả của một operation domain. */
export type LlmSellerResult<Value> = LlmSellerOk<Value> | LlmSellerFailure;

/** Dựng nhánh thành công. */
export function llmSellerOk<Value>(value: Value): LlmSellerResult<Value> {
  return Object.freeze({ ok: true, value });
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy. */
export function llmSellerFailure<Value = never>(
  code: LlmSellerDomainErrorCode,
): LlmSellerResult<Value> {
  return Object.freeze({ ok: false, error: llmSellerDomainError(code) });
}

// ---------------------------------------------------------------------------
// Định danh
// ---------------------------------------------------------------------------

/**
 * `sub` — Account ID do `account` phát hành, chỉ được lấy từ verified
 * authentication context. Đây là **tham chiếu opaque**, không FK xuyên
 * database; giá trị client gửi lên không bao giờ trở thành actor.
 */
declare const sellerActorBrand: unique symbol;

/** Account ID (`sub`) đã qua validate. */
export type SellerActorId = string & { readonly [sellerActorBrand]?: true };

declare const sellerTenantIdBrand: unique symbol;

/** Định danh Seller tenant. */
export type SellerTenantId = string & { readonly [sellerTenantIdBrand]?: true };

declare const membershipIdBrand: unique symbol;

/**
 * Định danh một **lần** membership. Cùng `(tenant, actor)` có thể có nhiều lần
 * membership theo thời gian (revoke rồi provision lại), nên grant phải trỏ tới
 * lần membership cụ thể — nếu không, quyền cũ sẽ sống lại sau khi provision lại.
 */
export type MembershipId = string & { readonly [membershipIdBrand]?: true };

declare const grantIdBrand: unique symbol;

/** Định danh một lần cấp permission grant. */
export type GrantId = string & { readonly [grantIdBrand]?: true };

declare const permissionIdBrand: unique symbol;

/** Định danh permission theo hình `domain.action`; catalog thuộc `staff-access`. */
export type PermissionId = string & { readonly [permissionIdBrand]?: true };

/** Độ dài tối đa của mọi định danh opaque để chặn payload bất thường từ input. */
export const MAX_OPAQUE_ID_LENGTH = 200;

/** Độ dài tối đa của text tự do (name, reason) trong domain tenant. */
export const MAX_SELLER_TEXT_LENGTH = 500;

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

/** Type guard cho `SellerActorId` — dùng khi đọc `sub` từ token/DB/contract. */
export function isSellerActorId(value: unknown): value is SellerActorId {
  return isOpaqueId(value);
}

/** Type guard cho `SellerTenantId`. */
export function isSellerTenantId(value: unknown): value is SellerTenantId {
  return isOpaqueId(value);
}

/** Type guard cho `MembershipId`. */
export function isMembershipId(value: unknown): value is MembershipId {
  return isOpaqueId(value);
}

/** Type guard cho `GrantId`. */
export function isGrantId(value: unknown): value is GrantId {
  return isOpaqueId(value);
}

const PERMISSION_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

/**
 * Type guard cho `PermissionId`.
 *
 * Chỉ validate **hình dạng** `domain.action`; ngữ nghĩa và việc permission có
 * tồn tại trong catalog hay không thuộc governance của `staff-access`
 * (`llm-seller` ADR-0007).
 */
export function isPermissionId(value: unknown): value is PermissionId {
  return (
    typeof value === 'string' &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    PERMISSION_ID_PATTERN.test(value)
  );
}

/**
 * Dựng `SellerActorId` từ giá trị đã verify.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createSellerActorId(value: string): SellerActorId {
  if (!isSellerActorId(value)) {
    throw new TypeError('Seller actor ID is not valid.');
  }
  return value;
}

/** Dựng `SellerTenantId`. @throws TypeError khi giá trị không hợp lệ. */
export function createSellerTenantId(value: string): SellerTenantId {
  if (!isSellerTenantId(value)) {
    throw new TypeError('Seller tenant ID is not valid.');
  }
  return value;
}

/** Dựng `MembershipId`. @throws TypeError khi giá trị không hợp lệ. */
export function createMembershipId(value: string): MembershipId {
  if (!isMembershipId(value)) {
    throw new TypeError('Membership ID is not valid.');
  }
  return value;
}

/** Dựng `GrantId`. @throws TypeError khi giá trị không hợp lệ. */
export function createGrantId(value: string): GrantId {
  if (!isGrantId(value)) {
    throw new TypeError('Grant ID is not valid.');
  }
  return value;
}

/** Dựng `PermissionId`. @throws TypeError khi giá trị không hợp lệ. */
export function createPermissionId(value: string): PermissionId {
  if (!isPermissionId(value)) {
    throw new TypeError('Permission ID is not valid.');
  }
  return value;
}

/** Timestamp epoch millis hợp lệ: số nguyên an toàn. */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Text tự do hợp lệ: string đã trim, không rỗng, không quá `MAX_SELLER_TEXT_LENGTH`. */
export function isSellerText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SELLER_TEXT_LENGTH &&
    value.trim() === value
  );
}

/**
 * Permission Seller-side yêu cầu cho payout/EC→UC conversion.
 *
 * Đây là **identifier**, không phải nội dung catalog; `staff-access` sở hữu
 * catalog và `llm-seller` ADR-0007 chốt ranh giới này.
 */
export const LLM_SELLER_PAYOUT_PERMISSION = createPermissionId('payout.manage');

/**
 * Target capability của payout/EC→UC conversion.
 *
 * `authorizeSellerPayout` ghim target này để evaluation bắt buộc phải được tính
 * cho capability payout. Tenant-scope restriction vẫn khớp target capability
 * (xem `matchesTarget`), nên chỉ có restriction dành riêng cho capability khác
 * là không chặn payout — đúng ngữ nghĩa scope.
 */
export const LLM_SELLER_PAYOUT_TARGET = Object.freeze({
  kind: 'capability',
  capability: 'payout',
} as const);

/**
 * Scope của một quyết định authorization Seller.
 *
 * Luôn là Seller tenant: kết quả authorization ở đây **không** cấp quyền ở
 * Consumer tenant (`llm-consumer-tenant`), và consumer không được diễn giải
 * khác.
 */
export const LLM_SELLER_AUTHORIZATION_SCOPE = 'seller_tenant' as const;
