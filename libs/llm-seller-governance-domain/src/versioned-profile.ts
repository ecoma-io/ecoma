/**
 * Phần dùng chung của profile versioned append-only (legal và tax).
 *
 * Hai profile chỉ khác nhau ở bộ field nghiệp vụ; guard khung, cách tính
 * version kế tiếp và cách chọn version hiệu lực tại một thời điểm là giống
 * nhau. Tách ở đây để một thay đổi quy tắc versioning không phải sửa hai nơi.
 *
 * Module này là chi tiết nội bộ của lib, không xuất hiện trong public surface.
 */

import {
  isEpochMillis,
  isSellerActorId,
  isSellerTenantId,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LlmGovernanceResult,
  type SellerActorId,
  type SellerTenantId,
} from './shared';

/** Field khung mà mọi profile version đều có. */
export interface VersionedProfileCommon {
  readonly tenantId: SellerTenantId;
  /** Số thứ tự do domain cấp, bắt đầu từ 1. */
  readonly version: number;
  readonly effectiveFrom: number;
  readonly recordedAt: number;
  readonly recordedBy: SellerActorId;
}

/**
 * Guard cho phần khung của một profile version.
 *
 * Caller bổ sung guard cho field nghiệp vụ của mình.
 */
export function isVersionedProfileCommon(value: unknown): value is VersionedProfileCommon {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VersionedProfileCommon, unknown>>;
  return (
    isSellerTenantId(candidate.tenantId) &&
    typeof candidate.version === 'number' &&
    Number.isSafeInteger(candidate.version) &&
    candidate.version >= 1 &&
    isEpochMillis(candidate.effectiveFrom) &&
    isEpochMillis(candidate.recordedAt) &&
    isSellerActorId(candidate.recordedBy)
  );
}

/**
 * Kiểm tra collection version hiện có và tính số version kế tiếp.
 *
 * Trả lỗi khi collection không phải array (`ambiguous_context`), có phần tử
 * sai shape (`invalid_profile_version`), lệch tenant (`inconsistent_context`)
 * hoặc `effectiveFrom` mới không tăng nghiêm ngặt so với version cuối
 * (`effective_from_not_increasing`).
 */
export function nextProfileVersion<Version extends VersionedProfileCommon>(
  versions: readonly Version[],
  tenantId: SellerTenantId,
  effectiveFrom: number,
  isVersion: (value: unknown) => value is Version,
): LlmGovernanceResult<number> {
  if (!Array.isArray(versions)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!versions.every(isVersion)) {
    return llmGovernanceFailure('invalid_profile_version');
  }
  if (versions.some((version) => version.tenantId !== tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  const lastVersion = versions.reduce<Version | undefined>(
    (last, version) => (last === undefined || version.version > last.version ? version : last),
    undefined,
  );
  if (lastVersion !== undefined && effectiveFrom <= lastVersion.effectiveFrom) {
    return llmGovernanceFailure('effective_from_not_increasing');
  }
  return llmGovernanceOk(lastVersion === undefined ? 1 : lastVersion.version + 1);
}

/**
 * Version hiệu lực tại `at`, tức version có `effectiveFrom` lớn nhất mà
 * `<= at`.
 *
 * `at` không hợp lệ ⇒ `undefined`: hàm chỉ đọc, không có result type để trả lỗi.
 * Caller phải validate `at` trước nếu cần phân biệt "thời điểm hỏng" với "chưa
 * có version nào hiệu lực".
 */
export function versionedProfileAt<Version extends VersionedProfileCommon>(
  versions: readonly Version[],
  at: number,
  isVersion: (value: unknown) => value is Version,
): Version | undefined {
  if (!isEpochMillis(at) || !Array.isArray(versions)) {
    return undefined;
  }
  let current: Version | undefined;
  for (const version of versions) {
    if (!isVersion(version) || version.effectiveFrom > at) {
      continue;
    }
    if (current === undefined || version.effectiveFrom > current.effectiveFrom) {
      current = version;
    }
  }
  return current;
}
