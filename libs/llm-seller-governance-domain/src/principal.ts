/**
 * `FirstPartyLegalPrincipal` — bản ghi authoritative của principal pháp lý
 * first-party (Ecoma-io) và các operation trên chính nó.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §3.8, §4, §7;
 * [ADR-0027](../../../docs/domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3, §5.
 *
 * Nguyên tắc:
 * - Principal **không phải** tenant, không phải aggregate tổ chức xuyên sản
 *   phẩm: không sở hữu tenant lifecycle/membership/owner/account/credential/
 *   offer (ADR-0026 §5 giữ nguyên). Nó chỉ mang hồ sơ pháp lý/thuế
 *   authoritative, `status` và audit.
 * - Profile versions của principal dùng **cùng cơ chế** versioned append-only
 *   với profile tenant (`versioned-profile`), nhưng mang `principalId` —
 *   principal không mượn shape của tenant.
 * - Trạng thái `active | reverification_required | blocked`. Tạo record luôn ở
 *   `reverification_required` (§7: chưa có approved coverage nào, fail-closed).
 *   `active` chỉ đạt được qua approval của case principal-scoped còn phủ cặp
 *   revision hiện hành — nghi thức đó nằm ở `decideVerification`, không ở
 *   module này.
 * - Append revision mới ⇒ `reverification_required` **đồng bộ trong cùng thao
 *   tác** (§3.8) — không job nền, không fan-out per-tenant. Từ `blocked`,
 *   append bị từ chối: đường duy nhất ra khỏi `blocked` là `unblock` (§7).
 * - Unblock không bao giờ trả thẳng `active` (§7): sau unblock, principal ở
 *   `reverification_required` và cần một case principal-scoped mới được
 *   approved còn phủ revision hiện hành mới `active` lại.
 *
 * Thẩm quyền actor cho block/unblock: **chưa chốt** (§8.3) — domain chỉ bắt
 * buộc có actor và ghi audit; application layer quyết định ai được gọi.
 */

import {
  isEpochMillis,
  isLegalPrincipalId,
  isOpaqueLabel,
  isSellerActorId,
  isSellerText,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LegalPrincipalId,
  type LlmGovernanceResult,
  type SellerActorId,
} from './shared';
import {
  isVersionedProfileCommon,
  nextProfileVersion,
  versionedProfileAt,
  type VersionedProfileCommon,
} from './versioned-profile';

/** Trạng thái của principal pháp lý first-party. */
export type LegalPrincipalStatus = 'active' | 'reverification_required' | 'blocked';

/** Một revision legal profile của principal — append-only như §3.4. */
export interface PrincipalLegalProfileVersion extends VersionedProfileCommon {
  readonly principalId: LegalPrincipalId;
  readonly legalName: string;
  /** Loại pháp lý (`company`, ...) — opaque label. */
  readonly legalType: string;
  readonly jurisdiction: string;
  readonly registrationReference: string;
}

/** Một revision tax profile của principal — append-only như §3.4. */
export interface PrincipalTaxProfileVersion extends VersionedProfileCommon {
  readonly principalId: LegalPrincipalId;
  /** Nơi cư trú thuế — opaque label. */
  readonly taxResidency: string;
  readonly taxIdentifier: string;
  /** Tham chiếu tới declaration/tài liệu thuế. */
  readonly declarationReference: string;
}

/**
 * Bản ghi authoritative của principal pháp lý first-party.
 *
 * `statusChangedAt`/`statusChangedBy` ghi audit của lần block/unblock/activation
 * gần nhất (activation nằm ở `decideVerification`); `null` khi chưa có thao tác
 * trạng thái nào sau khi tạo.
 */
export interface FirstPartyLegalPrincipal {
  readonly principalId: LegalPrincipalId;
  readonly status: LegalPrincipalStatus;
  readonly legalProfileVersions: readonly PrincipalLegalProfileVersion[];
  readonly taxProfileVersions: readonly PrincipalTaxProfileVersion[];
  readonly statusChangedAt: number | null;
  readonly statusChangedBy: SellerActorId | null;
  readonly createdAt: number;
  readonly createdBy: SellerActorId;
}

/** Input tạo principal kèm revision hồ sơ pháp lý/thuế đầu tiên. */
export interface CreateFirstPartyLegalPrincipalInput {
  readonly principalId: unknown;
  readonly legalName: unknown;
  readonly legalType: unknown;
  readonly jurisdiction: unknown;
  readonly registrationReference: unknown;
  readonly taxResidency: unknown;
  readonly taxIdentifier: unknown;
  readonly declarationReference: unknown;
  /** `effectiveFrom` dùng chung cho cả hai revision đầu tiên. */
  readonly effectiveFrom: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
  /** Principal đã có — dùng cho guard trùng `principalId`. */
  readonly existing?: readonly FirstPartyLegalPrincipal[];
}

/**
 * Tạo principal record ở trạng thái `reverification_required` (§7) kèm revision
 * đầu tiên của cả legal và tax profile — chưa có approved coverage nào, mọi
 * tenant first-party suy ra từ nó đều ineligible cho tới khi case principal-
 * scoped đầu tiên được approved (fail-closed).
 *
 * Guard: field hợp lệ, `effectiveFrom`/`recordedAt`/`recordedBy` hợp lệ,
 * `existing` (nếu cấp) mọi phần tử hợp lệ và chưa có `principalId` trùng.
 */
export function createFirstPartyLegalPrincipal(
  input: CreateFirstPartyLegalPrincipalInput,
): LlmGovernanceResult<FirstPartyLegalPrincipal> {
  if (!isLegalPrincipalId(input.principalId)) {
    return llmGovernanceFailure('invalid_legal_principal_id');
  }
  if (
    !isSellerText(input.legalName) ||
    !isOpaqueLabel(input.legalType) ||
    !isSellerText(input.jurisdiction) ||
    !isSellerText(input.registrationReference)
  ) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (
    !isOpaqueLabel(input.taxResidency) ||
    !isSellerText(input.taxIdentifier) ||
    !isSellerText(input.declarationReference)
  ) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (!isEpochMillis(input.effectiveFrom)) {
    return llmGovernanceFailure('invalid_effective_from');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isSellerActorId(input.recordedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isFirstPartyLegalPrincipal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (existing.some((principal) => principal.principalId === input.principalId)) {
    return llmGovernanceFailure('duplicate_legal_principal_id');
  }
  const principalId = input.principalId;
  const legalProfileVersions: readonly PrincipalLegalProfileVersion[] = Object.freeze([
    Object.freeze({
      principalId,
      version: 1,
      legalName: input.legalName,
      legalType: input.legalType,
      jurisdiction: input.jurisdiction,
      registrationReference: input.registrationReference,
      effectiveFrom: input.effectiveFrom,
      recordedAt: input.recordedAt,
      recordedBy: input.recordedBy,
    }),
  ]);
  const taxProfileVersions: readonly PrincipalTaxProfileVersion[] = Object.freeze([
    Object.freeze({
      principalId,
      version: 1,
      taxResidency: input.taxResidency,
      taxIdentifier: input.taxIdentifier,
      declarationReference: input.declarationReference,
      effectiveFrom: input.effectiveFrom,
      recordedAt: input.recordedAt,
      recordedBy: input.recordedBy,
    }),
  ]);
  return llmGovernanceOk(
    Object.freeze({
      principalId,
      status: 'reverification_required' as const,
      legalProfileVersions,
      taxProfileVersions,
      statusChangedAt: null,
      statusChangedBy: null,
      createdAt: input.recordedAt,
      createdBy: input.recordedBy,
    }),
  );
}

/** Input ghi revision legal mới của principal. */
export interface AppendPrincipalProfileVersionInput {
  readonly principal: FirstPartyLegalPrincipal;
  readonly legalName: unknown;
  readonly legalType: unknown;
  readonly jurisdiction: unknown;
  readonly registrationReference: unknown;
  readonly effectiveFrom: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
}

/**
 * Ghi revision legal mới của principal ⇒ `reverification_required` đồng bộ
 * (§3.8, §7).
 *
 * Guard: principal hợp lệ; field nghiệp vụ hợp lệ; `effectiveFrom` **tăng
 * nghiêm ngặt** so với revision cuối (`effective_from_not_increasing`);
 * `recordedAt >= createdAt` và không trước `effectiveFrom` hiện hành của trục
 * này thì không bắt buộc — chỉ nghiêm ngặt theo `effectiveFrom`.
 *
 * Từ `blocked`, append bị từ chối (`invalid_principal_status_transition`):
 * đường duy nhất ra khỏi `blocked` là `unblock`, nên một revision mới không
 * được phép "làm mới" principal đang bị block. Từ `reverification_required`,
 * append vẫn cho phép (thao tác publish có thể sửa cả hai trục trước khi có
 * approval) — trạng thái đã là đích của append rồi.
 */
export function appendPrincipalLegalProfileVersion(
  input: AppendPrincipalProfileVersionInput,
): LlmGovernanceResult<FirstPartyLegalPrincipal> {
  if (!isFirstPartyLegalPrincipal(input.principal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (input.principal.status === 'blocked') {
    return llmGovernanceFailure('invalid_principal_status_transition');
  }
  if (
    !isSellerText(input.legalName) ||
    !isOpaqueLabel(input.legalType) ||
    !isSellerText(input.jurisdiction) ||
    !isSellerText(input.registrationReference)
  ) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (!isEpochMillis(input.effectiveFrom)) {
    return llmGovernanceFailure('invalid_effective_from');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isSellerActorId(input.recordedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  const nextVersion = nextProfileVersion(
    input.principal.legalProfileVersions,
    input.principal.principalId,
    (version) => version.principalId,
    input.effectiveFrom,
    isPrincipalLegalProfileVersion,
  );
  if (!nextVersion.ok) {
    return nextVersion;
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.principal,
      status: 'reverification_required' as const,
      legalProfileVersions: Object.freeze([
        ...input.principal.legalProfileVersions,
        Object.freeze({
          principalId: input.principal.principalId,
          version: nextVersion.value,
          legalName: input.legalName,
          legalType: input.legalType,
          jurisdiction: input.jurisdiction,
          registrationReference: input.registrationReference,
          effectiveFrom: input.effectiveFrom,
          recordedAt: input.recordedAt,
          recordedBy: input.recordedBy,
        }),
      ]),
      // Append chính là thao tác gây transition sang `reverification_required`
      // (§3.8 đồng bộ), nên audit trạng thái ghi actor/time của lần publish này.
      statusChangedAt: input.recordedAt,
      statusChangedBy: input.recordedBy,
    }),
  );
}

/** Input ghi revision tax mới của principal. */
export interface AppendPrincipalTaxProfileVersionInput {
  readonly principal: FirstPartyLegalPrincipal;
  readonly taxResidency: unknown;
  readonly taxIdentifier: unknown;
  readonly declarationReference: unknown;
  readonly effectiveFrom: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
}

/**
 * Ghi revision tax mới — cùng nghi thức với `appendPrincipalLegalProfileVersion`
 * trên trục tax (§3.8, §7).
 */
export function appendPrincipalTaxProfileVersion(
  input: AppendPrincipalTaxProfileVersionInput,
): LlmGovernanceResult<FirstPartyLegalPrincipal> {
  if (!isFirstPartyLegalPrincipal(input.principal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (input.principal.status === 'blocked') {
    return llmGovernanceFailure('invalid_principal_status_transition');
  }
  if (
    !isOpaqueLabel(input.taxResidency) ||
    !isSellerText(input.taxIdentifier) ||
    !isSellerText(input.declarationReference)
  ) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (!isEpochMillis(input.effectiveFrom)) {
    return llmGovernanceFailure('invalid_effective_from');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isSellerActorId(input.recordedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  const nextVersion = nextProfileVersion(
    input.principal.taxProfileVersions,
    input.principal.principalId,
    (version) => version.principalId,
    input.effectiveFrom,
    isPrincipalTaxProfileVersion,
  );
  if (!nextVersion.ok) {
    return nextVersion;
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.principal,
      status: 'reverification_required' as const,
      taxProfileVersions: Object.freeze([
        ...input.principal.taxProfileVersions,
        Object.freeze({
          principalId: input.principal.principalId,
          version: nextVersion.value,
          taxResidency: input.taxResidency,
          taxIdentifier: input.taxIdentifier,
          declarationReference: input.declarationReference,
          effectiveFrom: input.effectiveFrom,
          recordedAt: input.recordedAt,
          recordedBy: input.recordedBy,
        }),
      ]),
      // Append chính là thao tác gây transition sang `reverification_required`
      // (§3.8 đồng bộ), nên audit trạng thái ghi actor/time của lần publish này.
      statusChangedAt: input.recordedAt,
      statusChangedBy: input.recordedBy,
    }),
  );
}

/**
 * Revision legal hiện hành của principal tại `at`, hoặc `undefined` khi chưa có
 * revision nào bắt đầu hiệu lực.
 */
export function principalLegalProfileVersionAt(
  principal: FirstPartyLegalPrincipal,
  at: number,
): PrincipalLegalProfileVersion | undefined {
  return versionedProfileAt(principal.legalProfileVersions, at, isPrincipalLegalProfileVersion);
}

/** Revision tax hiện hành của principal tại `at`, hoặc `undefined`. */
export function principalTaxProfileVersionAt(
  principal: FirstPartyLegalPrincipal,
  at: number,
): PrincipalTaxProfileVersion | undefined {
  return versionedProfileAt(principal.taxProfileVersions, at, isPrincipalTaxProfileVersion);
}

/** Input block principal. */
export interface BlockLegalPrincipalInput {
  readonly principal: FirstPartyLegalPrincipal;
  readonly blockedBy: unknown;
  readonly blockedAt: unknown;
}

/**
 * Quyết định có thẩm quyền đặt principal `blocked` ⇒ mọi tenant liên kết
 * ineligible (§3.8). Cho phép từ `active` và `reverification_required`; từ
 * `blocked` là no-op sai (`invalid_principal_status_transition`).
 *
 * Không có đường "un-block" ở đây ngoài `unblockLegalPrincipal`, và unblock
 * không bao giờ trả `active` trực tiếp (§7).
 */
export function blockLegalPrincipal(
  input: BlockLegalPrincipalInput,
): LlmGovernanceResult<FirstPartyLegalPrincipal> {
  if (!isFirstPartyLegalPrincipal(input.principal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (!isSellerActorId(input.blockedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.blockedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.principal.status === 'blocked') {
    return llmGovernanceFailure('invalid_principal_status_transition');
  }
  if (input.blockedAt < input.principal.createdAt) {
    return llmGovernanceFailure('invalid_principal_status_transition');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.principal,
      status: 'blocked' as const,
      statusChangedAt: input.blockedAt,
      statusChangedBy: input.blockedBy,
    }),
  );
}

/** Input unblock principal. */
export interface UnblockLegalPrincipalInput {
  readonly principal: FirstPartyLegalPrincipal;
  readonly unblockedBy: unknown;
  readonly unblockedAt: unknown;
}

/**
 * Đặt principal về `reverification_required` (§7: không bao giờ `blocked →
 * active` trực tiếp). `active` lại chỉ qua một case principal-scoped mới được
 * approved còn phủ revision hiện hành — nghi thức ở `decideVerification`.
 */
export function unblockLegalPrincipal(
  input: UnblockLegalPrincipalInput,
): LlmGovernanceResult<FirstPartyLegalPrincipal> {
  if (!isFirstPartyLegalPrincipal(input.principal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (!isSellerActorId(input.unblockedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.unblockedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.principal.status !== 'blocked') {
    return llmGovernanceFailure('invalid_principal_status_transition');
  }
  if (input.unblockedAt < input.principal.createdAt) {
    return llmGovernanceFailure('invalid_principal_status_transition');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.principal,
      status: 'reverification_required' as const,
      statusChangedAt: input.unblockedAt,
      statusChangedBy: input.unblockedBy,
    }),
  );
}

/** Shape guard cho principal đọc từ storage. */
export function isFirstPartyLegalPrincipal(value: unknown): value is FirstPartyLegalPrincipal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof FirstPartyLegalPrincipal, unknown>>;
  if (!isLegalPrincipalId(candidate.principalId) || !isLegalPrincipalStatus(candidate.status)) {
    return false;
  }
  if (!isEpochMillis(candidate.createdAt) || !isSellerActorId(candidate.createdBy)) {
    return false;
  }
  if (
    !(candidate.statusChangedAt === null || isEpochMillis(candidate.statusChangedAt)) ||
    !(candidate.statusChangedBy === null || isSellerActorId(candidate.statusChangedBy))
  ) {
    return false;
  }
  if (
    !Array.isArray(candidate.legalProfileVersions) ||
    !Array.isArray(candidate.taxProfileVersions)
  ) {
    return false;
  }
  return (
    candidate.legalProfileVersions.every(isPrincipalLegalProfileVersion) &&
    candidate.taxProfileVersions.every(isPrincipalTaxProfileVersion)
  );
}

/** Shape guard cho revision legal của principal. */
export function isPrincipalLegalProfileVersion(
  value: unknown,
): value is PrincipalLegalProfileVersion {
  if (!isVersionedProfileCommon(value)) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalLegalProfileVersion, unknown>>;
  return (
    isLegalPrincipalId(candidate.principalId) &&
    isSellerText(candidate.legalName) &&
    isOpaqueLabel(candidate.legalType) &&
    isSellerText(candidate.jurisdiction) &&
    isSellerText(candidate.registrationReference)
  );
}

/** Shape guard cho revision tax của principal. */
export function isPrincipalTaxProfileVersion(value: unknown): value is PrincipalTaxProfileVersion {
  if (!isVersionedProfileCommon(value)) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalTaxProfileVersion, unknown>>;
  return (
    isLegalPrincipalId(candidate.principalId) &&
    isOpaqueLabel(candidate.taxResidency) &&
    isSellerText(candidate.taxIdentifier) &&
    isSellerText(candidate.declarationReference)
  );
}

function isLegalPrincipalStatus(value: unknown): value is LegalPrincipalStatus {
  return value === 'active' || value === 'reverification_required' || value === 'blocked';
}
