/**
 * ModelOffer — aggregate root của bounded context `llm-marketplace`.
 *
 * Source of truth: `docs/domains/llm-marketplace/domain-model.md` §1, §3.1, §4, §5.
 *
 * Vòng đời:
 *
 * ```
 * draft --activate--> active <--deactivate/activate--> inactive
 *   |                   |                                  |
 *   +-------------------+---------retire------------------+--> retired (terminal)
 * ```
 *
 * Quy tắc đã chốt cho lib này:
 * - `activate` chỉ hợp lệ từ `draft` hoặc `inactive`; gọi lại khi đang `active`
 *   trả `offer_already_active` — **không** im lặng thành công. Trạng thái là dữ
 *   liệu audit; một operation "thành công" mà không đổi gì sẽ che mất lỗi gọi
 *   lặp ở application layer.
 * - `deactivate` chỉ hợp lệ từ `active`; gọi lại khi đang `inactive` trả
 *   `offer_already_inactive`.
 * - `retire` hợp lệ từ mọi trạng thái chưa `retired`; `retired` là terminal và
 *   mọi operation làm đổi trạng thái sau đó trả `offer_retired`.
 * - `draft → inactive` không hợp lệ: offer chưa từng phục vụ thì không có nghĩa
 *   "đang tắt".
 * - Activation yêu cầu **đồng thời** verdict operational eligibility hợp lệ của
 *   đúng Seller tenant **và** ít nhất một endpoint pool `healthy` của chính
 *   offer. Marketplace không tự tính eligibility (ADR-0018 §3).
 */

import {
  isEpochMillis,
  isModelOfferId,
  isSellerTenantId,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  MAX_PUBLIC_ALIAS_LENGTH,
  type LlmMarketplaceResult,
  type ModelOfferId,
  type SellerTenantId,
} from './shared';
import { createCapabilitySet, isCapabilitySet, type CapabilitySet } from './capability';
import { evaluateOfferEndpointHealth, isEndpointPool, type EndpointPool } from './endpoint';
import {
  assertEligibilityForTenant,
  evaluateActivationEligibility,
  isSellerOperationalEligibility,
  type SellerOperationalEligibility,
} from './eligibility';
import { isNormalizedModelId as isNormalizedModelIdValue } from './model-identity';

/** Trạng thái của model offer. `retired` là terminal. */
export type ModelOfferStatus = 'draft' | 'active' | 'inactive' | 'retired';

/** Giá trị canonical của `ModelOfferStatus`. */
export const MODEL_OFFER_STATUS: Readonly<Record<ModelOfferStatus, ModelOfferStatus>> =
  Object.freeze({
    draft: 'draft',
    active: 'active',
    inactive: 'inactive',
    retired: 'retired',
  });

/** Type guard cho `ModelOfferStatus`. */
export function isModelOfferStatus(value: unknown): value is ModelOfferStatus {
  return value === 'draft' || value === 'active' || value === 'inactive' || value === 'retired';
}

/**
 * Public alias của offer.
 *
 * Là tên customer-visible (xem `docs/domains/llm-marketplace/README.md` §2). Cùng
 * hình dạng với normalized model id: lowercase, không khoảng trắng. Unique
 * trong phạm vi marketplace được kiểm ở biên ghi (`assertPublicAliasUnique`),
 * không phải bất biến của một offer đơn lẻ.
 */
export function isPublicAlias(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PUBLIC_ALIAS_LENGTH &&
    /^[a-z0-9][a-z0-9._-]*$/u.test(value)
  );
}

/** Một model offer. */
export interface ModelOffer {
  readonly id: ModelOfferId;
  readonly sellerTenantId: SellerTenantId;
  /** Normalized model identity — canonical cho dedup/group. */
  readonly normalizedModelId: string;
  readonly status: ModelOfferStatus;
  readonly publicAlias: string | null;
  readonly capabilities: CapabilitySet;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Thời điểm activation gần nhất; `null` khi chưa từng active. */
  readonly activatedAt: number | null;
  /** Thời điểm deactivate gần nhất; `null` khi chưa từng deactivate. */
  readonly deactivatedAt: number | null;
  readonly retiredAt: number | null;
}

/** Input tạo model offer. */
export interface CreateModelOfferInput {
  readonly id: unknown;
  readonly sellerTenantId: unknown;
  readonly normalizedModelId: unknown;
  readonly capabilities: unknown;
  readonly publicAlias?: unknown;
  readonly createdAt: unknown;
  /** Offer đã có — dùng cho guard trùng `id` và alias. */
  readonly existing?: readonly ModelOffer[];
}

/**
 * Tạo model offer ở trạng thái `draft`.
 *
 * Guard:
 * - `id`, `sellerTenantId`, `createdAt` hợp lệ.
 * - `normalizedModelId` hợp lệ (lowercase canonical).
 * - `capabilities` qua `createCapabilitySet` (không rỗng, không trùng).
 * - `publicAlias` (nếu cấp) qua `isPublicAlias` và chưa được offer nào khác
 *   dùng (`invalid_public_alias` khi trùng).
 * - `existing` (nếu cấp) mọi phần tử hợp lệ, không trùng `id`.
 */
export function createModelOffer(input: CreateModelOfferInput): LlmMarketplaceResult<ModelOffer> {
  if (!isModelOfferId(input.id)) {
    return llmMarketplaceFailure('invalid_model_offer_id');
  }
  if (!isSellerTenantId(input.sellerTenantId)) {
    return llmMarketplaceFailure('invalid_seller_tenant_id');
  }
  if (!isNormalizedModelIdValue(input.normalizedModelId)) {
    return llmMarketplaceFailure('invalid_normalized_model_id');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  const capabilities = createCapabilitySet(input.capabilities);
  if (!capabilities.ok) {
    return capabilities;
  }
  const publicAlias = input.publicAlias ?? null;
  if (publicAlias !== null && !isPublicAlias(publicAlias)) {
    return llmMarketplaceFailure('invalid_public_alias');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (!existing.every(isModelOffer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (existing.some((offer) => offer.id === input.id)) {
    return llmMarketplaceFailure('duplicate_model_offer_id');
  }
  if (publicAlias !== null) {
    const unique = assertPublicAliasUnique(publicAlias, existing);
    if (!unique.ok) {
      return unique;
    }
  }
  return llmMarketplaceOk(
    Object.freeze({
      id: input.id,
      sellerTenantId: input.sellerTenantId,
      normalizedModelId: input.normalizedModelId,
      status: 'draft' as const,
      publicAlias,
      capabilities: capabilities.value,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      activatedAt: null,
      deactivatedAt: null,
      retiredAt: null,
    }),
  );
}

/** Input gán public alias. */
export interface AssignPublicAliasInput {
  readonly offer: ModelOffer;
  readonly publicAlias: unknown;
  readonly assignedAt: unknown;
  /** Offer khác trong marketplace — dùng cho guard unique alias. */
  readonly existing?: readonly ModelOffer[];
}

/**
 * Gán hoặc đổi public alias.
 *
 * Chỉ hợp lệ khi offer còn `draft`: alias là tên customer-visible, nên đổi nó
 * sau khi offer đã phục vụ sẽ làm hỏng consumer đang gọi theo tên cũ. Sau
 * activation, thao tác trả `public_alias_immutable`.
 *
 * Guard thêm: alias hợp lệ, chưa được offer khác dùng, `assignedAt >=
 * offer.updatedAt`.
 */
export function assignPublicAlias(input: AssignPublicAliasInput): LlmMarketplaceResult<ModelOffer> {
  if (!isModelOffer(input.offer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (!isPublicAlias(input.publicAlias)) {
    return llmMarketplaceFailure('invalid_public_alias');
  }
  if (!isEpochMillis(input.assignedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (input.offer.status === 'retired') {
    return llmMarketplaceFailure('offer_retired');
  }
  if (input.offer.status !== 'draft') {
    return llmMarketplaceFailure('public_alias_immutable');
  }
  if (input.assignedAt < input.offer.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (!existing.every(isModelOffer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (
    existing.some(
      (offer) =>
        offer.id !== input.offer.id &&
        offer.publicAlias !== null &&
        offer.publicAlias === input.publicAlias,
    )
  ) {
    return llmMarketplaceFailure('invalid_public_alias');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.offer,
      publicAlias: input.publicAlias,
      updatedAt: input.assignedAt,
    }),
  );
}

/** Input thay tập capability của offer. */
export interface ReplaceCapabilitiesInput {
  readonly offer: ModelOffer;
  readonly capabilities: unknown;
  readonly updatedAt: unknown;
}

/**
 * Thay tập capability.
 *
 * Chỉ hợp lệ khi offer chưa `retired` (`offer_retired`). Offer đang `active`
 * được phép đổi capability: capability là dữ liệu filter, không phải cam kết
 * hợp đồng, và một capability bị gỡ không làm offer ngừng phục vụ các request
 * không yêu cầu nó. Guard: tập mới hợp lệ, `updatedAt >= offer.updatedAt`.
 */
export function replaceCapabilities(
  input: ReplaceCapabilitiesInput,
): LlmMarketplaceResult<ModelOffer> {
  if (!isModelOffer(input.offer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (!isEpochMillis(input.updatedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (input.offer.status === 'retired') {
    return llmMarketplaceFailure('offer_retired');
  }
  if (input.updatedAt < input.offer.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  const capabilities = createCapabilitySet(input.capabilities);
  if (!capabilities.ok) {
    return capabilities;
  }
  return llmMarketplaceOk(
    Object.freeze({ ...input.offer, capabilities: capabilities.value, updatedAt: input.updatedAt }),
  );
}

/** Input activate offer. */
export interface ActivateModelOfferInput {
  readonly offer: ModelOffer;
  /** Verdict từ `llm-seller-governance` — marketplace chỉ tiêu thụ. */
  readonly eligibility: SellerOperationalEligibility;
  /** Toàn bộ endpoint pool của offer tại thời điểm activation. */
  readonly pools: readonly EndpointPool[];
  readonly activatedAt: unknown;
}

/**
 * Activate offer (`draft | inactive → active`).
 *
 * Guard, theo thứ tự (fail closed):
 * 1. `activatedAt` hợp lệ và không lùi so với `offer.updatedAt`.
 * 2. Offer hợp lệ; `retired` ⇒ `offer_retired`; `active` ⇒ `offer_already_active`;
 *    `draft`/`inactive` được tiếp tục.
 * 3. Verdict hợp lệ và **đúng** `sellerTenantId` — shape hỏng ⇒
 *    `invalid_eligibility_verdict`, lệch tenant ⇒ `eligibility_tenant_mismatch`.
 * 4. Verdict `eligible`, không blocker và không cũ hơn `offer.createdAt` —
 *    ngược lại `seller_not_eligible`.
 * 5. `pools` không rỗng, mọi pool hợp lệ và thuộc đúng offer (lệch ⇒
 *    `pool_offer_mismatch`), và có ít nhất một pool `healthy` — ngược lại
 *    `endpoint_pool_not_healthy` (hoặc `endpoint_pool_missing` khi rỗng).
 *
 * Activation không idempotent: gọi lại trên offer đang active là lỗi domain.
 */
export function activateModelOffer(
  input: ActivateModelOfferInput,
): LlmMarketplaceResult<ModelOffer> {
  if (!isEpochMillis(input.activatedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (!isModelOffer(input.offer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (input.offer.status === 'retired') {
    return llmMarketplaceFailure('offer_retired');
  }
  if (input.offer.status === 'active') {
    return llmMarketplaceFailure('offer_already_active');
  }
  if (input.activatedAt < input.offer.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  if (!isSellerOperationalEligibility(input.eligibility)) {
    return llmMarketplaceFailure('invalid_eligibility_verdict');
  }
  const verdictCheck = assertEligibilityForTenant(input.eligibility, input.offer.sellerTenantId);
  if (!verdictCheck.ok) {
    return verdictCheck;
  }
  const eligibility = evaluateActivationEligibility(
    verdictCheck.value,
    input.offer.sellerTenantId,
    input.offer.createdAt,
  );
  if (!eligibility.eligible) {
    return llmMarketplaceFailure('seller_not_eligible');
  }
  const health = evaluateOfferEndpointHealth(input.offer.id, input.pools);
  if (!health.ok) {
    return health;
  }
  if (!health.value.hasHealthyPool) {
    return llmMarketplaceFailure('endpoint_pool_not_healthy');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.offer,
      status: 'active' as const,
      activatedAt: input.activatedAt,
      updatedAt: input.activatedAt,
    }),
  );
}

/** Input deactivate offer. */
export interface DeactivateModelOfferInput {
  readonly offer: ModelOffer;
  readonly deactivatedAt: unknown;
}

/**
 * Deactivate offer (`active → inactive`).
 *
 * Guard: `deactivatedAt` hợp lệ và không lùi; offer `retired` ⇒ `offer_retired`;
 * offer không `active` ⇒ `offer_already_inactive` khi đang `inactive`, còn
 * `draft` ⇒ `invalid_offer_transition`.
 */
export function deactivateModelOffer(
  input: DeactivateModelOfferInput,
): LlmMarketplaceResult<ModelOffer> {
  if (!isEpochMillis(input.deactivatedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (!isModelOffer(input.offer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (input.offer.status === 'retired') {
    return llmMarketplaceFailure('offer_retired');
  }
  if (input.offer.status === 'inactive') {
    return llmMarketplaceFailure('offer_already_inactive');
  }
  if (input.offer.status !== 'active') {
    return llmMarketplaceFailure('invalid_offer_transition');
  }
  if (input.deactivatedAt < input.offer.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.offer,
      status: 'inactive' as const,
      deactivatedAt: input.deactivatedAt,
      updatedAt: input.deactivatedAt,
    }),
  );
}

/** Input retire offer. */
export interface RetireModelOfferInput {
  readonly offer: ModelOffer;
  readonly retiredAt: unknown;
}

/**
 * Retire offer — terminal từ mọi trạng thái chưa `retired`.
 *
 * Guard: `retiredAt` hợp lệ và không lùi; offer đã `retired` ⇒ `offer_retired`.
 * Không có operation nào đưa offer ra khỏi `retired`.
 */
export function retireModelOffer(input: RetireModelOfferInput): LlmMarketplaceResult<ModelOffer> {
  if (!isEpochMillis(input.retiredAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (!isModelOffer(input.offer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (input.offer.status === 'retired') {
    return llmMarketplaceFailure('offer_retired');
  }
  if (input.retiredAt < input.offer.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.offer,
      status: 'retired' as const,
      retiredAt: input.retiredAt,
      updatedAt: input.retiredAt,
    }),
  );
}

/**
 * Offer có đang phục vụ customer không: `active` **và** còn pool healthy.
 *
 * Đây là view thuần; caller phải truyền đúng tập pool của offer. Pool lệch
 * offer trả `false` (fail closed) thay vì tính tiếp trên dữ liệu sai.
 */
export function isModelOfferServing(offer: ModelOffer, pools: readonly EndpointPool[]): boolean {
  if (!isModelOffer(offer) || offer.status !== 'active') {
    return false;
  }
  if (!Array.isArray(pools) || !pools.every(isEndpointPool)) {
    return false;
  }
  if (pools.some((pool) => pool.offerId !== offer.id)) {
    return false;
  }
  const health = evaluateOfferEndpointHealth(offer.id, pools);
  return health.ok && health.value.serving;
}

/** Shape guard cho `ModelOffer` đọc từ storage/contract. */
export function isModelOffer(value: unknown): value is ModelOffer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ModelOffer, unknown>>;
  if (
    !isModelOfferId(candidate.id) ||
    !isSellerTenantId(candidate.sellerTenantId) ||
    !isNormalizedModelIdValue(candidate.normalizedModelId) ||
    !isModelOfferStatus(candidate.status) ||
    !isCapabilitySet(candidate.capabilities) ||
    !isEpochMillis(candidate.createdAt) ||
    !isEpochMillis(candidate.updatedAt) ||
    (candidate.updatedAt as number) < candidate.createdAt
  ) {
    return false;
  }
  if (!(candidate.publicAlias === null || isPublicAlias(candidate.publicAlias))) {
    return false;
  }
  if (
    !isNullableTimestamp(candidate.activatedAt) ||
    !isNullableTimestamp(candidate.deactivatedAt)
  ) {
    return false;
  }
  if (!isNullableTimestamp(candidate.retiredAt)) {
    return false;
  }
  // Timestamp của sự kiện không được nằm ngoài khoảng đã ghi nhận.
  if (
    (candidate.activatedAt !== null && candidate.activatedAt > candidate.updatedAt) ||
    (candidate.deactivatedAt !== null && candidate.deactivatedAt > candidate.updatedAt) ||
    (candidate.retiredAt !== null && candidate.retiredAt > candidate.updatedAt)
  ) {
    return false;
  }
  switch (candidate.status) {
    case 'draft':
      // Draft chưa từng phục vụ: không có mốc activation/deactivation/retire.
      return (
        candidate.activatedAt === null &&
        candidate.deactivatedAt === null &&
        candidate.retiredAt === null
      );
    case 'active':
      return candidate.activatedAt !== null && candidate.retiredAt === null;
    case 'inactive':
      // Inactive chỉ đến từ `active → inactive`.
      return (
        candidate.activatedAt !== null &&
        candidate.deactivatedAt !== null &&
        candidate.retiredAt === null
      );
    case 'retired':
      return candidate.retiredAt !== null;
    default:
      return false;
  }
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isEpochMillis(value);
}

/**
 * Khẳng định public alias chưa được offer **khác** dùng.
 *
 * Tách khỏi `createModelOffer`/`assignPublicAlias` để adapter dùng ở biên ghi
 * khi hai thao tác chạy trong hai transaction khác nhau.
 */
export function assertPublicAliasUnique(
  alias: unknown,
  existing: readonly ModelOffer[],
  selfId?: ModelOfferId,
): LlmMarketplaceResult<string> {
  if (!isPublicAlias(alias)) {
    return llmMarketplaceFailure('invalid_public_alias');
  }
  if (!Array.isArray(existing) || !existing.every(isModelOffer)) {
    return llmMarketplaceFailure('invalid_model_offer');
  }
  if (
    existing.some(
      (offer) => offer.id !== selfId && offer.publicAlias !== null && offer.publicAlias === alias,
    )
  ) {
    return llmMarketplaceFailure('invalid_public_alias');
  }
  return llmMarketplaceOk(alias);
}

/** Tên trạng thái đích của một activation hợp lệ — dùng cho test/đọc hiểu. */
export const MODEL_OFFER_ACTIVATABLE_STATUSES: readonly ModelOfferStatus[] = Object.freeze([
  'draft',
  'inactive',
]);
