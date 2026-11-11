/**
 * Phần dùng chung của profile versioned append-only (legal và tax).
 *
 * Hai profile chỉ khác nhau ở bộ field nghiệp vụ; guard khung, cách tính
 * version kế tiếp và cách chọn version hiệu lực tại một thời điểm là giống
 * nhau. Tách ở đây để một thay đổi quy tắc versioning không phải sửa hai nơi.
 *
 * Cơ chế này phục vụ **cả hai chủ thể** của governance (§3.4, §3.8): profile
 * tenant-scoped (đường customer) và revision profile của
 * `FirstPartyLegalPrincipal` (đường first-party). Vì vậy phần khung **không**
 * mang `tenantId` — chủ thể đượcCaller mô tả qua projection `subjectOf`, còn
 * field chủ thể (`tenantId` hoặc `principalId`) do guard của từng profile tự
 * kiểm. Điều đó giữ một cơ chế versioning duy nhất mà không cho principal
 * mượn shape của tenant.
 *
 * Module này là chi tiết nội bộ của lib, không xuất hiện trong public surface.
 */

import {
  isEpochMillis,
  isSellerActorId,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LlmGovernanceResult,
  type SellerActorId,
} from './shared';

/** Field khung mà mọi profile version đều có, bất kể chủ thể. */
export interface VersionedProfileCommon {
  /** Số thứ tự do domain cấp, bắt đầu từ 1. */
  readonly version: number;
  readonly effectiveFrom: number;
  readonly recordedAt: number;
  readonly recordedBy: SellerActorId;
}

/**
 * Guard cho phần khung của một profile version.
 *
 * Caller bổ sung guard cho field nghiệp vụ **và** field chủ thể của mình.
 */
export function isVersionedProfileCommon(value: unknown): value is VersionedProfileCommon {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VersionedProfileCommon, unknown>>;
  return (
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
 * `subject` là giá trị chủ thể đã được caller validate (ví dụ `tenantId` hay
 * `principalId`); `subjectOf` chiếu một version ra giá trị chủ thể của nó.
 *
 * Trả lỗi khi collection không phải array (`ambiguous_context`), có phần tử
 * sai shape (`invalid_profile_version`), có version thuộc chủ thể khác
 * (`inconsistent_context`) hoặc `effectiveFrom` mới không tăng nghiêm ngặt so
 * với version cuối (`effective_from_not_increasing`).
 */
export function nextProfileVersion<Version extends VersionedProfileCommon, Subject>(
  versions: readonly Version[],
  subject: Subject,
  subjectOf: (version: Version) => Subject,
  effectiveFrom: number,
  isVersion: (value: unknown) => value is Version,
): LlmGovernanceResult<number> {
  if (!Array.isArray(versions)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!versions.every(isVersion)) {
    return llmGovernanceFailure('invalid_profile_version');
  }
  if (versions.some((version) => subjectOf(version) !== subject)) {
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
