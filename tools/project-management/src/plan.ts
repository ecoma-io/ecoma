/**
 * Stage plan: từ classification + snapshot Project sinh danh sách action để
 * đưa Project về desired membership. Pure và deterministic: sort theo số
 * issue, rồi action, rồi itemId.
 *
 * Phạm vi mutation: pipeline chỉ tự sửa membership của ISSUE mà nó định danh
 * được. Item PR/draft hoặc item ISSUE trỏ số lạ chỉ bị báo qua audit
 * (`invalid_reference`) và KHÔNG tự xoá — fail-closed, không mutation thứ mà
 * pipeline không định danh được.
 */

import type { IssueClassification } from './classify.js';
import type { ProjectItemRecord } from './types.js';

export type PlanActionType = 'add' | 'remove' | 'keep' | 'keep_out';

export interface PlanAction {
  action: PlanActionType;
  issueNumber: number;
  /** itemId đích cho remove/keep; add chưa có item nên không có. */
  itemId?: string;
  reason: string;
}

const ACTION_ORDER: Record<PlanActionType, number> = { add: 0, keep: 1, remove: 2, keep_out: 3 };

function compareItemIds(a: ProjectItemRecord, b: ProjectItemRecord): number {
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

/** Gom ISSUE item theo số issue, sort itemId để hành vi trên item trùng ổn định. */
function indexIssueItems(
  projectItems: readonly ProjectItemRecord[],
): Map<number, ProjectItemRecord[]> {
  const unsorted = new Map<number, ProjectItemRecord[]>();
  for (const item of projectItems) {
    if (item.contentType !== 'ISSUE' || item.contentNumber === null) {
      continue;
    }
    const list = unsorted.get(item.contentNumber) ?? [];
    list.push(item);
    unsorted.set(item.contentNumber, list);
  }
  const sorted = new Map<number, ProjectItemRecord[]>();
  for (const [number, list] of unsorted) {
    sorted.set(number, list.toSorted(compareItemIds));
  }
  return sorted;
}

function nonDesiredReason(classification: IssueClassification): string {
  if (classification.issue.isPullRequest) {
    return 'pull requests are never members';
  }
  if (classification.hierarchy === 'child') {
    return 'sub-issues are never members';
  }
  return `excluded by policy (${String(classification.exclusionReason)})`;
}

function sortActions(actions: PlanAction[]): PlanAction[] {
  return actions.toSorted(
    (a, b) =>
      a.issueNumber - b.issueNumber ||
      ACTION_ORDER[a.action] - ACTION_ORDER[b.action] ||
      (a.itemId ?? '').localeCompare(b.itemId ?? ''),
  );
}

/**
 * add = desired member thiếu item; remove = item có mặt nhưng issue không
 * desired (hoặc item thừa khi issue desired nhưng bị trùng item); keep = có
 * mặt và desired; keep_out = vắng mặt và không desired.
 */
export function buildPlan(
  classifications: readonly IssueClassification[],
  projectItems: readonly ProjectItemRecord[],
): PlanAction[] {
  const itemsByNumber = indexIssueItems(projectItems);
  const actions: PlanAction[] = [];
  for (const classification of classifications) {
    const number = classification.issue.number;
    const items = itemsByNumber.get(number) ?? [];
    if (classification.desiredMembership) {
      if (items.length === 0) {
        actions.push({
          action: 'add',
          issueNumber: number,
          reason: `desired root issue #${number} is missing from the project`,
        });
      } else {
        const kept = items[0];
        actions.push({
          action: 'keep',
          issueNumber: number,
          itemId: kept.itemId,
          reason: `desired root issue #${number} is already a project member`,
        });
        for (const extra of items.slice(1)) {
          actions.push({
            action: 'remove',
            issueNumber: number,
            itemId: extra.itemId,
            reason: `duplicate project item ${extra.itemId} for desired root issue #${number}; keeping ${kept.itemId}`,
          });
        }
      }
    } else if (items.length === 0) {
      actions.push({
        action: 'keep_out',
        issueNumber: number,
        reason: `issue #${number} is not a desired member (${nonDesiredReason(classification)}) and is absent from the project`,
      });
    } else {
      for (const item of items) {
        actions.push({
          action: 'remove',
          issueNumber: number,
          itemId: item.itemId,
          reason: `project item ${item.itemId} is not a desired member: ${nonDesiredReason(classification)}`,
        });
      }
    }
  }
  return sortActions(actions);
}

/**
 * Áp plan lên một snapshot item GIẢ ĐỊNH: bỏ item bị remove, sinh item giả
 * cho action add. Dùng cho idempotency check và test — không gọi GitHub.
 */
export function applyPlanToItems(
  plan: readonly PlanAction[],
  projectItems: readonly ProjectItemRecord[],
): ProjectItemRecord[] {
  const removed = new Set(
    plan
      .filter(
        (action): action is PlanAction & { itemId: string } =>
          action.action === 'remove' && action.itemId !== undefined,
      )
      .map((action) => action.itemId),
  );
  const postItems = projectItems.filter((item) => !removed.has(item.itemId));
  for (const action of plan) {
    if (action.action !== 'add') {
      continue;
    }
    postItems.push({
      itemId: `simulated:${String(action.issueNumber)}`,
      contentType: 'ISSUE',
      contentNumber: action.issueNumber,
      isArchived: false,
    });
  }
  return postItems;
}
