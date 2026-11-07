/**
 * Tenant — ranh giới cách ly dữ liệu của một tổ chức/customer trong LLM.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §1, §1, §9.
 *
 * ⚠️ Tenant **không** mang lifecycle `status`. Trạng thái vận hành
 * (`active`/`suspended`/...) là kết quả suy ra từ các `SuspensionRecord`
 * (`./suspension.ts`), không phải một cột thứ hai có thể lệch nguồn sự thật.
 * Vòng đời pháp lý (archive/terminate/delete/retention) **chưa chốt** nên
 * không có transition nào trong module này.
 *
 * ⚠️ **Exactly one owner** được bảo đảm bằng cấu trúc: `owner` là một field
 * bắt buộc, singleton, không có collection owner và không có constructor nào
 * tạo tenant mà thiếu owner. Vì vậy "tenant không owner" và "tenant hai
 * owner" không biểu diễn được, không phải chỉ bị kiểm lúc runtime.
 *
 * Chuyển ownership **chưa có quyết định** (điều kiện, consent, audit). Module
 * này không có operation transfer và không mô phỏng một workflow chưa chốt.
 */

import {
  llmTenantFailure,
  llmTenantOk,
  type LlmTenantResult,
  type TenantActorId,
  type TenantId,
  isEpochMillis,
  isTenantActorId,
  isTenantId,
} from './shared';

/** Tên tenant — nhãn hiển thị, không phải định danh. */
export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly owner: TenantActorId;
  readonly createdAt: number;
}

/** Độ dài tối đa của tên tenant để chặn payload bất thường từ input. */
export const MAX_TENANT_NAME_LENGTH = 200;

/** Kiểm tra tên tenant: chuỗi đã trim, không rỗng, trong giới hạn. */
export function isTenantName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TENANT_NAME_LENGTH &&
    value.trim() === value
  );
}

/** Input tạo tenant — owner là bắt buộc, không có biến thể "ownerless". */
export interface CreateTenantInput {
  readonly id: unknown;
  readonly name: unknown;
  readonly owner: unknown;
  readonly createdAt: unknown;
}

/**
 * Tạo tenant với đúng một owner.
 *
 * Fail closed trên mọi input không đọc được: ID sai, owner sai, tên sai hay
 * timestamp sai đều trả result thất bại chứ không tạo tenant.
 *
 * Không có biến thể nào nhận owner rỗng/`null`/`undefined` — invariant
 * "tenant luôn có đúng một owner" được giữ ở kiểu dữ liệu của {@link Tenant}.
 */
export function createTenant(input: CreateTenantInput): LlmTenantResult<Tenant> {
  if (!isTenantId(input.id)) {
    return llmTenantFailure('invalid_tenant_id');
  }
  if (!isTenantName(input.name)) {
    return llmTenantFailure('invalid_tenant_name');
  }
  if (!isTenantActorId(input.owner)) {
    return llmTenantFailure('invalid_actor');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmTenantFailure('invalid_timestamp');
  }
  return llmTenantOk(
    Object.freeze({
      id: input.id,
      name: input.name,
      owner: input.owner,
      createdAt: input.createdAt,
    }),
  );
}

/**
 * Actor có phải owner của tenant không.
 *
 * Đây là **nguồn authority duy nhất** của owner: quyền owner không đến từ
 * permission grant, không từ membership, và không có role toàn cục nào thay
 * thế được tenant isolation.
 */
export function isTenantOwner(tenant: Tenant, actor: TenantActorId): boolean {
  return tenant.owner === actor;
}
