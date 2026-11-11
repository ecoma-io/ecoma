/**
 * Idempotency evidence: áp plan lên trạng thái giả định sau-apply rồi re-plan.
 * Hai lần chạy reconcile liên tiếp phải cho plan thứ hai không còn action
 * mutation nào — nếu còn, pipeline không tự hội tụ và phải lộ ra ở đây.
 */

import { applyPlanToItems, buildPlan, type PlanAction } from './plan.js';
import type { IssueClassification } from './classify.js';
import type { ProjectItemRecord } from './types.js';

export interface IdempotencyCheck {
  /** true khi re-plan trên trạng thái sau-apply không còn add/remove nào. */
  idempotent: boolean;
  /** Các action mutation còn sót lại trên trạng thái sau-apply. */
  residualActions: PlanAction[];
}

/**
 * Re-plan trên trạng thái sau-apply (giả lập bằng `applyPlanToItems`) và trả
 * về các action mutation còn lại. Rỗng list = chạy apply lần hai sẽ không
 * mutation gì thêm.
 */
export function computeIdempotencyCheck(
  plan: readonly PlanAction[],
  classifications: readonly IssueClassification[],
  projectItems: readonly ProjectItemRecord[],
): IdempotencyCheck {
  const postItems = applyPlanToItems(plan, projectItems);
  const postPlan = buildPlan(classifications, postItems);
  const residualActions = postPlan.filter(
    (action) => action.action === 'add' || action.action === 'remove',
  );
  return { idempotent: residualActions.length === 0, residualActions };
}
