/**
 * Seller operational eligibility verdict — **khai báo tại biên**, không import
 * `llm-seller-*`.
 *
 * Source of truth: `docs/domains/llm-seller-governance/adr/0018-seller-bounded-context-split.md`
 * §3 (Governance là owner duy nhất của eligibility verdict),
 * `docs/domains/llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md`,
 * `docs/domains/llm-marketplace/domain-model.md` §8.
 *
 * Marketplace **tiêu thụ** verdict, không tính lại nó:
 *
 * - Không đọc verification case, restriction record, legal/tax profile hay
 *   evidence — tất cả thuộc `llm-seller-governance`.
 * - Không import `llm-seller-tenant-domain`, `llm-seller-governance-domain`
 *   hay `llm-financial-domain`; kiểu ở đây là bản khai báo độc lập tại biên.
 * - Verdict mang `tenantId`; marketplace từ chối verdict có tenant khác offer
 *   (`eligibility_tenant_mismatch`), không "dùng tạm" rồi tiếp tục.
 *
 * Fail closed: verdict `eligible: true` nhưng còn `blockers` là **không nhất
 * quán**, và bị từ chối (`invalid_eligibility_verdict`) chứ không được đọc là
 * eligible.
 */

import {
  isOpaqueLabel,
  isSellerTenantId,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  type LlmMarketplaceResult,
  type SellerTenantId,
} from './shared';

/**
 * Verdict operational eligibility của một Seller tenant tại một thời điểm.
 *
 * `assessedAt` là thời điểm Governance đánh giá. Marketplace không tính lại,
 * nhưng dùng nó để từ chối verdict cũ hơn dữ liệu offer đang được kích hoạt
 * (xem `evaluateActivationEligibility`).
 */
export interface SellerOperationalEligibility {
  readonly tenantId: SellerTenantId;
  readonly eligible: boolean;
  /** Lý do không eligible — opaque label do Governance cấp. */
  readonly blockers: readonly string[];
  readonly assessedAt: number;
}

/**
 * Type guard cho `SellerOperationalEligibility`.
 *
 * Shape hợp lệ khi:
 * - `tenantId` là opaque id; `assessedAt` là epoch millis;
 * - `blockers` là mảng label hợp lệ, không trùng;
 * - `eligible === true` ⇒ `blockers` rỗng;
 * - `eligible === false` ⇒ `blockers` **không** rỗng.
 *
 * Hai điều kiện cuối là bất biến nhất quán: một verdict nói "eligible" mà còn
 * blocker, hoặc "không eligible" mà không nói vì sao, không dùng được để quyết
 * định.
 */
export function isSellerOperationalEligibility(
  value: unknown,
): value is SellerOperationalEligibility {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof SellerOperationalEligibility, unknown>>;
  if (!isSellerTenantId(candidate.tenantId)) {
    return false;
  }
  if (typeof candidate.eligible !== 'boolean') {
    return false;
  }
  if (typeof candidate.assessedAt !== 'number' || !Number.isSafeInteger(candidate.assessedAt)) {
    return false;
  }
  if (!Array.isArray(candidate.blockers)) {
    return false;
  }
  if (!candidate.blockers.every(isOpaqueLabel)) {
    return false;
  }
  if (new Set(candidate.blockers).size !== candidate.blockers.length) {
    return false;
  }
  return candidate.eligible ? candidate.blockers.length === 0 : candidate.blockers.length > 0;
}

/**
 * Khẳng định verdict thuộc đúng Seller tenant của offer.
 *
 * Fail closed: verdict lệch tenant bị từ chối **nguyên khối**
 * (`eligibility_tenant_mismatch`), không lọc. Verdict hỏng shape trả
 * `invalid_eligibility_verdict`.
 */
export function assertEligibilityForTenant(
  verdict: unknown,
  sellerTenantId: SellerTenantId,
): LlmMarketplaceResult<SellerOperationalEligibility> {
  if (!isSellerOperationalEligibility(verdict)) {
    return llmMarketplaceFailure('invalid_eligibility_verdict');
  }
  if (!isSellerTenantId(sellerTenantId)) {
    return llmMarketplaceFailure('invalid_seller_tenant_id');
  }
  if (verdict.tenantId !== sellerTenantId) {
    return llmMarketplaceFailure('eligibility_tenant_mismatch');
  }
  return llmMarketplaceOk(verdict);
}

/** Kết quả đánh giá điều kiện activation phía eligibility. */
export interface ActivationEligibilityAssessment {
  readonly eligible: boolean;
  /** `false` khi verdict lệch tenant hoặc không nhất quán. */
  readonly verdictUsable: boolean;
  readonly blockers: readonly string[];
}

/**
 * Đánh giá verdict cho activation.
 *
 * - Verdict hỏng shape, lệch tenant, hoặc `eligible: false` ⇒ không eligible.
 * - Verdict eligible nhưng `assessedAt` **sớm hơn** `notBefore` (thời điểm
 *   baseline của offer) ⇒ không eligible: một verdict cũ không chứng minh được
 *   trạng thái hiện tại.
 * - `notBefore === null` bỏ qua kiểm thời gian.
 *
 * Trả object thuần, không ném exception; đây là *view* để operation activation
 * dùng, không phải operation ghi.
 */
export function evaluateActivationEligibility(
  verdict: unknown,
  sellerTenantId: SellerTenantId,
  notBefore: number | null,
): ActivationEligibilityAssessment {
  if (!isSellerOperationalEligibility(verdict) || verdict.tenantId !== sellerTenantId) {
    return Object.freeze({
      eligible: false,
      verdictUsable: false,
      blockers: Object.freeze(['seller_eligibility_unusable']),
    });
  }
  const blockers: string[] = [...verdict.blockers];
  if (notBefore !== null && verdict.assessedAt < notBefore) {
    blockers.push('seller_eligibility_stale');
  }
  return Object.freeze({
    eligible: !verdict.eligible ? false : blockers.length === 0,
    verdictUsable: true,
    blockers: Object.freeze(blockers),
  });
}
