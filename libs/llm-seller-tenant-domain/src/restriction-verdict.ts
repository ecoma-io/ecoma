/**
 * Verdict restriction mà authorization ladder tiêu thụ — khai báo **tại biên**
 * của tenant, không import `llm-seller-governance`.
 *
 * ADR-0018: `llm-seller-tenant` không được phụ thuộc `llm-seller-governance`.
 * Giống cách `llm-consumer-routing-domain` khai báo lại `ExecutionEvidence` tại
 * biên, tenant khai báo đúng shape mình cần đọc và ghim tính tương thích cấu
 * trúc bằng một spec trong governance lib.
 *
 * Kiểu khai báo bốn field quyết định mà authorization thực sự đọc —
 * `tenantId`, `target`, `blocked`, `unevaluable` — cộng hai field audit
 * (`blockingRecordIds`, `unknownPolicies`). Hai field audit **bắt buộc** vì
 * guard từ chối payload không mang chúng: một evaluation do
 * `evaluateRestrictions` sinh ra luôn có đủ hai mảng, nên một verdict thiếu
 * chúng là payload bị sửa chứ không phải verdict. Kiểu phải khớp guard, nếu
 * không một giá trị hợp lệ theo TypeScript sẽ bị từ chối tại runtime.
 *
 * Ladder **không** được ra quyết định dựa trên hai field audit; chúng tồn tại
 * để validate payload và để chẩn đoán. Quyết định chỉ đọc `blocked` và
 * `unevaluable`.
 */

import { MAX_OPAQUE_ID_LENGTH, isSellerTenantId, type SellerTenantId } from './shared';

/**
 * Target mà một verdict restriction được tính cho.
 *
 * Cùng ngữ nghĩa với `RestrictionTarget` của governance; tenant chỉ đọc
 * `kind`/`capability` nên tự khai báo shape thay vì import.
 */
export type SellerRestrictionTarget =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'capability'; readonly capability: string };

/**
 * Kết quả đánh giá restriction mà ladder tin được.
 *
 * `blocked` và `unevaluable` **bắt buộc** là boolean thật: một object thiếu
 * field sẽ đọc ra `undefined` (falsy) và biến restriction thành fail-open nếu
 * ladder tin nó. Vì vậy consumer phải chạy `isSellerRestrictionVerdict` trước.
 */
export interface SellerRestrictionVerdict {
  /** Tenant mà verdict thuộc về; verdict của tenant khác không trả lời câu hỏi. */
  readonly tenantId: SellerTenantId;
  /** Target đã được đánh giá. */
  readonly target: SellerRestrictionTarget;
  /** Có ít nhất một record hiệu lực chặn target. */
  readonly blocked: boolean;
  /** Có record chặn mà policy không đánh giá được — consumer phải deny. */
  readonly unevaluable: boolean;
  /** Audit: id của record chặn target. Không dùng để ra quyết định. */
  readonly blockingRecordIds: readonly string[];
  /** Audit: policy không có trong cấu hình và bị coi là restrictive. */
  readonly unknownPolicies: readonly string[];
}

const TENANT_TARGET_KEYS: readonly string[] = ['kind'];
const CAPABILITY_TARGET_KEYS: readonly string[] = ['kind', 'capability'];

/** Type guard cho `SellerRestrictionTarget`. */
export function isSellerRestrictionTarget(value: unknown): value is SellerRestrictionTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; capability?: unknown };
  if (candidate.kind === 'tenant') {
    return candidate.capability === undefined && hasOnlyKeys(value, TENANT_TARGET_KEYS);
  }
  return (
    candidate.kind === 'capability' &&
    isOpaqueId(candidate.capability) &&
    hasOnlyKeys(value, CAPABILITY_TARGET_KEYS)
  );
}

/**
 * Type guard cho verdict đọc từ storage/cache/event.
 *
 * Field audit của governance phải có mặt và đúng hình dạng: một mảng
 * `blockingRecordIds` hỏng hoặc thiếu là dấu hiệu payload bị sửa, không phải
 * dữ liệu để bỏ qua.
 */
export function isSellerRestrictionVerdict(value: unknown): value is SellerRestrictionVerdict {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    tenantId?: unknown;
    target?: unknown;
    blocked?: unknown;
    unevaluable?: unknown;
    blockingRecordIds?: unknown;
    unknownPolicies?: unknown;
  };
  if (
    !isSellerTenantId(candidate.tenantId) ||
    !isSellerRestrictionTarget(candidate.target) ||
    typeof candidate.blocked !== 'boolean' ||
    typeof candidate.unevaluable !== 'boolean'
  ) {
    return false;
  }
  // Giữ nguyên độ mạnh của guard cũ: evaluation phải mang đủ hai mảng audit,
  // đúng hình dạng. Thiếu chúng là payload chưa được `evaluateRestrictions`
  // sinh ra, không phải verdict để tin.
  return (
    Array.isArray(candidate.blockingRecordIds) &&
    candidate.blockingRecordIds.every(isOpaqueId) &&
    Array.isArray(candidate.unknownPolicies) &&
    candidate.unknownPolicies.every(isOpaqueId)
  );
}

/** Hai target trỏ cùng một đối tượng (tenant, hoặc cùng capability). */
export function isSameRestrictionTarget(
  left: SellerRestrictionTarget,
  right: SellerRestrictionTarget,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === 'tenant' || left.capability === (right as { capability: string }).capability;
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
