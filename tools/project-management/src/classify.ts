/**
 * Phân loại từng issue: root hay child, có bị loại trừ không, và có được
 * member của Project hay không. Pure — đầu vào là dữ liệu đã normalize.
 */

import { exclusionReason, type ExclusionReason } from './policy.js';
import type { NormalizedIssue, PolicyConfig } from './types.js';

/** Vị trí trong hierarchy: không có cha là root, có cha là child (sub-issue). */
export type IssueHierarchy = 'root' | 'child';

/** Kết quả phân loại một issue cho policy membership hiện hành. */
export interface IssueClassification {
  issue: NormalizedIssue;
  hierarchy: IssueHierarchy;
  excluded: boolean;
  exclusionReason: ExclusionReason | null;
  /** Sự thật mong muốn: issue này có nên là item của Project không. */
  desiredMembership: boolean;
}

/**
 * Phân loại toàn bộ issue list, sort theo số issue tăng dần để output luôn
 * deterministic bất kể thứ tự trang GitHub trả về.
 *
 * Desired membership = không phải PR ∧ root ∧ không bị loại trừ. Trạng thái
 * OPEN/CLOSED không đổi desired membership: policy quản membership, không quản
 * lifecycle issue.
 */
export function classifyIssues(
  issues: readonly NormalizedIssue[],
  policy: PolicyConfig,
): IssueClassification[] {
  return issues
    .toSorted((a, b) => a.number - b.number)
    .map((issue): IssueClassification => {
      const hierarchy: IssueHierarchy = issue.parentNumber !== null ? 'child' : 'root';
      const reason = exclusionReason(issue, policy);
      const excluded = reason !== null;
      const desiredMembership = !issue.isPullRequest && hierarchy === 'root' && !excluded;
      return { issue, hierarchy, excluded, exclusionReason: reason, desiredMembership };
    });
}
