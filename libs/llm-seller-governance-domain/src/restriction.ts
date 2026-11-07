/**
 * Restriction record của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §1, §3.1, §3.7;
 * ADR-0003.
 *
 * Nguyên tắc:
 * - Không có `status = restricted` trên tenant. "Đang bị hạn chế" là **giá trị
 *   suy ra** từ tập record tại một thời điểm do caller cấp.
 * - Nhiều record độc lập: lift một record không mở khoá record khác.
 * - `publicReason` được ra public projection; `internalReason` thì **không**,
 *   ở bất kỳ hình thức nào kể cả error object.
 * - Policy là định danh mở, cấu hình do caller cấp. Policy không có trong cấu
 *   hình bị coi là restrictive **và** đánh dấu `unevaluable` — fail closed.
 */

import {
  isEpochMillis,
  isOpaqueLabel,
  isRestrictionId,
  isSellerTenantId,
  isSellerText,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LlmGovernanceResult,
  type RestrictionId,
  type SellerTenantId,
} from './shared';

/**
 * Phạm vi của restriction.
 *
 * `tenant` chặn mọi capability; `capability` chỉ chặn capability trùng tên.
 * Capability là định danh mở, không phải enum của domain.
 */
export type RestrictionScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'capability'; readonly capability: string };

/** Một restriction record. `expiresAt`/`liftedAt`/`appealDeadline` là `null` khi không áp dụng. */
export interface RestrictionRecord {
  readonly id: RestrictionId;
  readonly tenantId: SellerTenantId;
  readonly policy: string;
  /** Lý do được phép công bố cho Seller. */
  readonly publicReason: string;
  /** Lý do nội bộ: không bao giờ ra public projection/contract/event. */
  readonly internalReason: string;
  readonly scope: RestrictionScope;
  readonly activatesAt: number;
  readonly expiresAt: number | null;
  readonly liftedAt: number | null;
  readonly appealDeadline: number | null;
}

/** Input tạo restriction record. */
export interface CreateRestrictionRecordInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly policy: unknown;
  readonly publicReason: unknown;
  readonly internalReason: unknown;
  readonly scope: unknown;
  readonly activatesAt: unknown;
  readonly expiresAt?: unknown;
  readonly liftedAt?: unknown;
  readonly appealDeadline?: unknown;
}

/**
 * Tạo restriction record.
 *
 * Guard cửa sổ (khi field khác `null`):
 * - `expiresAt > activatesAt` — cửa sổ nửa mở không được rỗng.
 * - `liftedAt >= activatesAt` — không lift trước khi record có hiệu lực.
 * - `appealDeadline >= activatesAt` — không đặt hạn appeal trước khi record
 *   bắt đầu hiệu lực.
 *
 * `existing` (tùy chọn) là tập record hiện có của tenant; nếu cấp, `id` phải
 * chưa tồn tại và mọi phần tử phải thuộc đúng tenant. Adapter idempotency dùng
 * tham số này; domain không tự đọc storage.
 */
export function createRestrictionRecord(
  input: CreateRestrictionRecordInput,
  existing: readonly RestrictionRecord[] = [],
): LlmGovernanceResult<RestrictionRecord> {
  if (!isRestrictionId(input.id)) {
    return llmGovernanceFailure('invalid_restriction_id');
  }
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (
    !isOpaqueLabel(input.policy) ||
    !isSellerText(input.publicReason) ||
    !isSellerText(input.internalReason) ||
    !isRestrictionScope(input.scope)
  ) {
    return llmGovernanceFailure('invalid_restriction_record');
  }
  if (!isEpochMillis(input.activatesAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  const window = readWindow(input);
  if (window === undefined) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isValidWindow(input.activatesAt, window)) {
    return llmGovernanceFailure('invalid_restriction_window');
  }
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isRestrictionRecord)) {
    return llmGovernanceFailure('invalid_restriction_record');
  }
  if (existing.some((record) => record.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((record) => record.id === input.id)) {
    return llmGovernanceFailure('duplicate_restriction_id');
  }
  return llmGovernanceOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      policy: input.policy,
      publicReason: input.publicReason,
      internalReason: input.internalReason,
      scope: Object.freeze(input.scope),
      activatesAt: input.activatesAt,
      expiresAt: window.expiresAt,
      liftedAt: window.liftedAt,
      appealDeadline: window.appealDeadline,
    }),
  );
}

interface RestrictionWindow {
  readonly expiresAt: number | null;
  readonly liftedAt: number | null;
  readonly appealDeadline: number | null;
}

/** Đọc ba field thời gian; `undefined` mang nghĩa "không áp dụng". */
function readWindow(input: CreateRestrictionRecordInput): RestrictionWindow | undefined {
  const expiresAt = readOptionalTimestamp(input.expiresAt);
  const liftedAt = readOptionalTimestamp(input.liftedAt);
  const appealDeadline = readOptionalTimestamp(input.appealDeadline);
  if (expiresAt === undefined || liftedAt === undefined || appealDeadline === undefined) {
    return undefined;
  }
  return { expiresAt, liftedAt, appealDeadline };
}

/** `undefined` → `null`; giá trị khác phải là timestamp hợp lệ, ngược lại `undefined` (lỗi). */
function readOptionalTimestamp(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return isEpochMillis(value) ? value : undefined;
}

function isValidWindow(activatesAt: number, window: RestrictionWindow): boolean {
  if (window.expiresAt !== null && window.expiresAt <= activatesAt) {
    return false;
  }
  if (window.liftedAt !== null && window.liftedAt < activatesAt) {
    return false;
  }
  if (window.appealDeadline !== null && window.appealDeadline < activatesAt) {
    return false;
  }
  return true;
}

/**
 * Record có hiệu lực tại `now` không.
 *
 * Cửa sổ nửa mở `[activatesAt, expiresAt)`; `liftedAt <= now` vô hiệu hoá
 * record. Lift đặt ở tương lai chưa có tác dụng.
 */
export function isRestrictionEffective(record: RestrictionRecord, now: number): boolean {
  // Record đọc từ storage có thể hỏng; hàm này chỉ trả boolean nên phải tự chặn
  // trước khi đọc field, không để lọt `TypeError` ra ngoài.
  if (!isRestrictionRecord(record) || !isEpochMillis(now)) {
    return false;
  }
  if (now < record.activatesAt) {
    return false;
  }
  if (record.expiresAt !== null && now >= record.expiresAt) {
    return false;
  }
  if (record.liftedAt !== null && record.liftedAt <= now) {
    return false;
  }
  return true;
}

/** Đối tượng được đánh giá restriction. */
export type RestrictionTarget =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'capability'; readonly capability: string };

/** Cấu hình policy: policy này có chặn khi hiệu lực hay không. */
export interface RestrictionPolicy {
  readonly restrictive: boolean;
}

/** Kết quả đánh giá restriction tại `now`. */
export interface RestrictionEvaluation {
  /**
   * Tenant mà evaluation thuộc về. Consumer (authorization) phải kiểm tra giá
   * trị này: evaluation của tenant khác không được dùng làm bằng chứng "không bị
   * chặn" cho tenant này.
   */
  readonly tenantId: SellerTenantId;
  /** Target đã được đánh giá. */
  readonly target: RestrictionTarget;
  /** Có ít nhất một record hiệu lực chặn target. */
  readonly blocked: boolean;
  /**
   * Có record hiệu lực chặn target mà policy không có trong cấu hình. Consumer
   * **phải** coi như deny, kể cả khi `blocked` đã `true`.
   */
  readonly unevaluable: boolean;
  /** ID record đã chặn — dùng cho audit, không ra public contract. */
  readonly blockingRecordIds: readonly RestrictionId[];
  /** Policy chưa có trong cấu hình mà đã gặp. */
  readonly unknownPolicies: readonly string[];
}

/** Input đánh giá restriction. */
export interface EvaluateRestrictionsInput {
  readonly tenantId: unknown;
  readonly records: readonly RestrictionRecord[];
  readonly policies: Readonly<Record<string, RestrictionPolicy>>;
  readonly target: RestrictionTarget;
  readonly now: unknown;
}

/**
 * Đánh giá tập restriction tại `now` cho một target.
 *
 * Hàm thuần của `(records, policies, target, now)`:
 * - Record lệch tenant bị từ chối **nguyên khối** (`inconsistent_context`),
 *   không lọc rồi tiếp tục.
 * - Policy không có trong `policies` ⇒ restrictive **và** `unevaluable`.
 * - `blocked` là hợp của mọi record hiệu lực khớp target và restrictive.
 */
export function evaluateRestrictions(
  input: EvaluateRestrictionsInput,
): LlmGovernanceResult<RestrictionEvaluation> {
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isEpochMillis(input.now)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!Array.isArray(input.records) || !isRestrictionTarget(input.target)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!isPolicyMap(input.policies)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (input.records.some((record) => !isRestrictionRecord(record))) {
    return llmGovernanceFailure('invalid_restriction_record');
  }
  if (input.records.some((record) => record.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }

  const blockingRecordIds: RestrictionId[] = [];
  const unknownPolicies: string[] = [];
  let unevaluable = false;

  for (const record of input.records) {
    if (!isRestrictionEffective(record, input.now)) {
      continue;
    }
    if (!matchesTarget(record.scope, input.target)) {
      continue;
    }
    const policy = Object.hasOwn(input.policies, record.policy)
      ? input.policies[record.policy]
      : undefined;
    if (policy === undefined) {
      // Fail closed: policy chưa biết vừa chặn vừa đánh dấu không đánh giá được.
      unevaluable = true;
      if (!unknownPolicies.includes(record.policy)) {
        unknownPolicies.push(record.policy);
      }
      blockingRecordIds.push(record.id);
      continue;
    }
    if (policy.restrictive) {
      blockingRecordIds.push(record.id);
    }
  }

  return llmGovernanceOk(
    Object.freeze({
      tenantId: input.tenantId,
      target: Object.freeze({ ...input.target }),
      blocked: blockingRecordIds.length > 0,
      unevaluable,
      blockingRecordIds: Object.freeze(blockingRecordIds),
      unknownPolicies: Object.freeze(unknownPolicies),
    }),
  );
}

/** Input lift restriction. */
export interface LiftRestrictionInput {
  readonly record: RestrictionRecord;
  readonly liftedAt: unknown;
}

/**
 * Lift một restriction record.
 *
 * Không xoá record và không sửa record khác. Record đã lift trả
 * `restriction_already_lifted` thay vì ghi đè `liftedAt`: thời điểm lift là dữ
 * liệu audit.
 */
export function liftRestriction(
  input: LiftRestrictionInput,
): LlmGovernanceResult<RestrictionRecord> {
  if (!isEpochMillis(input.liftedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isRestrictionRecord(input.record)) {
    return llmGovernanceFailure('invalid_restriction_record');
  }
  if (input.record.liftedAt !== null) {
    return llmGovernanceFailure('restriction_already_lifted');
  }
  if (input.liftedAt < input.record.activatesAt) {
    return llmGovernanceFailure('invalid_restriction_window');
  }
  return llmGovernanceOk(Object.freeze({ ...input.record, liftedAt: input.liftedAt }));
}

/**
 * Restriction ở dạng Seller được đọc.
 *
 * Không có `internalReason`. Đây là kiểu duy nhất được phép đi ra public API,
 * contract hay event.
 */
export interface PublicRestriction {
  readonly id: RestrictionId;
  readonly tenantId: SellerTenantId;
  readonly policy: string;
  readonly publicReason: string;
  readonly scope: RestrictionScope;
  readonly activatesAt: number;
  readonly expiresAt: number | null;
  readonly liftedAt: number | null;
  readonly appealDeadline: number | null;
}

/**
 * Chiếu một record sang public projection.
 *
 * Projection được liệt kê từng field, không dùng spread: nếu ai thêm field nội
 * bộ vào `RestrictionRecord`, spread sẽ tự động rò rỉ nó. `scope` được dựng
 * lại từ hai field hợp lệ thay vì copy reference: một scope đọc từ storage có
 * thể mang key thừa (kể cả `internalReason`), và mutation vào kết quả này
 * không được phép làm đổi record nội bộ.
 */
export function toPublicRestriction(record: RestrictionRecord): PublicRestriction {
  if (typeof record !== 'object' || record === null) {
    // Projection không có result type: record hỏng là lỗi lập trình ở caller.
    // Nhưng vẫn phải từ chối rõ ràng thay vì để `undefined.id` ném TypeError.
    throw new TypeError('toPublicRestriction: restriction record is not an object.');
  }
  return Object.freeze({
    id: record.id,
    tenantId: record.tenantId,
    policy: record.policy,
    publicReason: record.publicReason,
    scope: copyPublicScope(record.scope),
    activatesAt: record.activatesAt,
    expiresAt: record.expiresAt,
    liftedAt: record.liftedAt,
    appealDeadline: record.appealDeadline,
  });
}

function copyPublicScope(scope: RestrictionScope): RestrictionScope {
  return Object.freeze(
    scope.kind === 'tenant'
      ? { kind: 'tenant' as const }
      : { kind: 'capability' as const, capability: scope.capability },
  );
}

/** Key hợp lệ của từng nhánh `RestrictionScope`. */
const TENANT_SCOPE_KEYS: readonly string[] = ['kind'];
const CAPABILITY_SCOPE_KEYS: readonly string[] = ['kind', 'capability'];

/** Type guard cho `RestrictionScope`. */
export function isRestrictionScope(value: unknown): value is RestrictionScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; capability?: unknown };
  if (candidate.kind === 'tenant') {
    return candidate.capability === undefined && hasOnlyKeys(value, TENANT_SCOPE_KEYS);
  }
  return (
    candidate.kind === 'capability' &&
    isOpaqueLabel(candidate.capability) &&
    hasOnlyKeys(value, CAPABILITY_SCOPE_KEYS)
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Type guard cho `RestrictionTarget`. */
export function isRestrictionTarget(value: unknown): value is RestrictionTarget {
  return isRestrictionScope(value);
}

/**
 * Re-run shape guard cho restriction record đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng record cho authorization/evaluation.
 */
export function isRestrictionRecord(value: unknown): value is RestrictionRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof RestrictionRecord, unknown>>;
  if (!isRestrictionId(candidate.id) || !isSellerTenantId(candidate.tenantId)) {
    return false;
  }
  if (
    !isOpaqueLabel(candidate.policy) ||
    !isSellerText(candidate.publicReason) ||
    !isSellerText(candidate.internalReason) ||
    !isRestrictionScope(candidate.scope) ||
    !isEpochMillis(candidate.activatesAt)
  ) {
    return false;
  }
  return (
    isNullableTimestamp(candidate.expiresAt) &&
    isNullableTimestamp(candidate.liftedAt) &&
    isNullableTimestamp(candidate.appealDeadline)
  );
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isEpochMillis(value);
}

/**
 * Re-run shape guard cho restriction evaluation đọc từ storage/cache/event.
 *
 * `blocked` và `unevaluable` phải là boolean thật: một object thiếu hai field
 * đó sẽ khiến `if (evaluation.blocked)` đọc ra `undefined` và authorization
 * fail-open. Vì vậy consumer **phải** gọi hàm này trước khi tin một evaluation.
 */
export function isRestrictionEvaluation(value: unknown): value is RestrictionEvaluation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof RestrictionEvaluation, unknown>>;
  if (
    !isSellerTenantId(candidate.tenantId) ||
    !isRestrictionTarget(candidate.target) ||
    typeof candidate.blocked !== 'boolean' ||
    typeof candidate.unevaluable !== 'boolean'
  ) {
    return false;
  }
  if (!Array.isArray(candidate.blockingRecordIds) || !Array.isArray(candidate.unknownPolicies)) {
    return false;
  }
  return (
    candidate.blockingRecordIds.every(isRestrictionId) &&
    candidate.unknownPolicies.every((policy) => typeof policy === 'string' && isOpaqueLabel(policy))
  );
}

function isPolicyMap(value: unknown): value is Readonly<Record<string, RestrictionPolicy>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (policy) =>
      typeof policy === 'object' &&
      policy !== null &&
      typeof (policy as { restrictive?: unknown }).restrictive === 'boolean',
  );
}

function matchesTarget(scope: RestrictionScope, target: RestrictionTarget): boolean {
  if (scope.kind === 'tenant') {
    return true;
  }
  return target.kind === 'capability' && target.capability === scope.capability;
}
