/**
 * Quyết định idempotent cho consumer entitlement event — compare-and-drop theo
 * `revision`.
 *
 * Source of truth (docs/domains/staff-access/):
 * - `README.md` §3 + invariant 8: consumer ở mỗi sản phẩm phải idempotent —
 *   event trùng (duplicate) hoặc tới sai thứ tự (out-of-order) **không** được
 *   làm state đi lùi.
 * - [ADR-0014](../../docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md):
 *   event mang `revision` tăng đơn điệu theo `(staff_id, product)`; consumer
 *   xử lý out-of-order bằng cách so revision — bản cũ hơn bản đã thấy bị bỏ
 *   qua, không rollback. Freshness bound + fail-closed là control riêng của
 *   consumer (P2.3), **không** nằm trong helper thuần này.
 * - [ADR-0009](../../docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md):
 *   quyết định chỉ dựa trên dữ liệu consumer đã có — không gọi ngược
 *   `staff-access` trên đường request.
 *
 * ⚠️ **Hàm thuần, không I/O, không clock, không phụ thuộc runtime.** Nó chỉ
 * validate envelope (bằng `validateEntitlementEvent`) và `currentRevision` rồi
 * so revision; mọi hiệu ứng sau quyết định (persist state, xoá cache, ghi
 * metric) thuộc consumer gọi nó.
 */

import { validateEntitlementEvent } from './entitlement-events-contract';
import { ENTITLEMENT_MAX_REVISION } from './entitlement-read-contract';

/**
 * Lý do của một quyết định áp dụng entitlement event:
 * - `first` — chưa từng thấy revision nào cho `(staff_id, product)`; áp dụng.
 * - `newer` — revision của event lớn hơn revision đã thấy; áp dụng.
 * - `duplicate` — revision bằng revision đã thấy; bỏ qua.
 * - `stale` — revision nhỏ hơn revision đã thấy (out-of-order); bỏ qua.
 * - `invalid` — envelope hoặc `currentRevision` không hợp lệ; không áp dụng.
 */
export type EntitlementEventDecisionReason = 'first' | 'newer' | 'duplicate' | 'stale' | 'invalid';

/** Kết quả quyết định: có áp dụng event hay không, kèm lý do. */
export interface EntitlementEventDecision {
  readonly apply: boolean;
  readonly reason: EntitlementEventDecisionReason;
}

/**
 * Kiểm tra `currentRevision` — `null` (chưa thấy gì) hoặc số nguyên không âm
 * trong khoảng an toàn. Cùng nguồn trần với read model
 * (`ENTITLEMENT_MAX_REVISION`).
 */
function isCurrentRevision(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= ENTITLEMENT_MAX_REVISION)
  );
}

/**
 * Quyết định consumer có nên áp dụng một entitlement event hay không —
 * compare-and-drop theo `revision`.
 *
 * Thứ tự kiểm: guard `currentRevision`, validate envelope, rồi so revision.
 * `currentRevision` là revision consumer đã thấy cho cùng `(staff_id, product)`;
 * `null` nghĩa là chưa thấy bản nào.
 *
 * ⚠️ Event **và** `currentRevision` không hợp lệ đều trả `invalid`; hàm không
 * ném lỗi và không tự sinh revision — producer bảo đảm revision tăng đơn điệu.
 */
export function shouldApplyEntitlementEvent(
  currentRevision: number | null,
  event: unknown,
): EntitlementEventDecision {
  if (!isCurrentRevision(currentRevision)) {
    return { apply: false, reason: 'invalid' };
  }

  const result = validateEntitlementEvent(event);
  if (!result.ok) {
    return { apply: false, reason: 'invalid' };
  }

  if (currentRevision === null) {
    return { apply: true, reason: 'first' };
  }

  const { revision } = result.payload;
  if (revision > currentRevision) {
    return { apply: true, reason: 'newer' };
  }
  if (revision === currentRevision) {
    return { apply: false, reason: 'duplicate' };
  }
  return { apply: false, reason: 'stale' };
}
