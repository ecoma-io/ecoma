/**
 * Stage audit: so desired membership với snapshot Project hiện tại và sinh
 * findings. Pure — không mutation, không I/O. Mọi finding code đều có test
 * riêng; severity: error = vi phạm policy membership, warning/info = dữ liệu
 * đáng chú ý không phá membership.
 */

import type { IssueClassification } from './classify.js';
import type { NormalizedIssue, ProjectItemRecord } from './types.js';

/**
 * Label admission tạm thời theo transition policy (`work-management.md` §3.3):
 * audit dùng nó cho hai finding `labeled_not_root` và `labeled_without_item`.
 */
export const TRACK_LABEL = 'project:track';

export type AuditSeverity = 'error' | 'warning' | 'info';

export type AuditFindingCode =
  | 'missing_membership'
  | 'unexpected_membership'
  | 'duplicate_project_items'
  | 'orphaned_child'
  | 'invalid_reference'
  | 'archived_item'
  | 'labeled_not_root'
  | 'labeled_without_item';

export interface AuditFinding {
  code: AuditFindingCode;
  severity: AuditSeverity;
  /** Số issue liên quan khi finding ánh được về một issue. */
  issueNumber?: number;
  detail: string;
}

/** Gom ISSUE item theo số issue; PR/draft item không thuộc nhóm nào. */
function indexIssueItems(
  projectItems: readonly ProjectItemRecord[],
): Map<number, ProjectItemRecord[]> {
  const byNumber = new Map<number, ProjectItemRecord[]>();
  for (const item of projectItems) {
    if (item.contentType !== 'ISSUE' || item.contentNumber === null) {
      continue;
    }
    const list = byNumber.get(item.contentNumber) ?? [];
    list.push(item);
    byNumber.set(item.contentNumber, list);
  }
  return byNumber;
}

function describeNonDesired(classification: IssueClassification): string {
  if (classification.issue.isPullRequest) {
    return 'pull requests are never members';
  }
  if (classification.hierarchy === 'child') {
    return 'sub-issues are never members';
  }
  return `excluded by policy (${String(classification.exclusionReason)})`;
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.toSorted(
    (a, b) =>
      (a.issueNumber ?? Number.MAX_SAFE_INTEGER) - (b.issueNumber ?? Number.MAX_SAFE_INTEGER) ||
      a.code.localeCompare(b.code) ||
      a.detail.localeCompare(b.detail),
  );
}

/**
 * Sinh findings theo code:
 *
 * - `missing_membership` (error): desired member mà không có item.
 * - `unexpected_membership` (error): item ISSUE trỏ về issue không desired.
 * - `duplicate_project_items` (error): hai item ISSUE cùng trỏ một issue.
 * - `orphaned_child` (error): sub-issue trỏ parent không có trong issue set.
 * - `invalid_reference` (error): item ISSUE trỏ số không có trong issue set,
 *   hoặc item DRAFT_ISSUE/PULL_REQUEST — loại này policy không bao giờ desire.
 * - `archived_item` (info): item đã archived.
 * - `labeled_not_root` (warning): label `project:track` nằm trên sub-issue.
 * - `labeled_without_item` (info): desired member mang label admission mà chưa
 *   có item — giả định auto-add workflow (đã bị delete theo issue #29).
 */
export function auditState(
  issues: readonly NormalizedIssue[],
  projectItems: readonly ProjectItemRecord[],
  classifications: readonly IssueClassification[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const issueByNumber = new Map<number, NormalizedIssue>(
    issues.map((issue) => [issue.number, issue]),
  );
  const itemsByNumber = indexIssueItems(projectItems);

  for (const classification of classifications) {
    const number = classification.issue.number;
    const items = itemsByNumber.get(number) ?? [];
    if (classification.desiredMembership && items.length === 0) {
      findings.push({
        code: 'missing_membership',
        severity: 'error',
        issueNumber: number,
        detail: `root issue #${number} is a desired member but is absent from the project`,
      });
    }
    if (!classification.desiredMembership) {
      for (const item of items) {
        findings.push({
          code: 'unexpected_membership',
          severity: 'error',
          issueNumber: number,
          detail: `issue #${number} is not a desired member (${describeNonDesired(classification)}) but project item ${item.itemId} references it`,
        });
      }
    }
    if (classification.hierarchy === 'child') {
      const parentNumber = classification.issue.parentNumber;
      if (parentNumber !== null && !issueByNumber.has(parentNumber)) {
        findings.push({
          code: 'orphaned_child',
          severity: 'error',
          issueNumber: number,
          detail: `sub-issue #${number} references parent issue #${parentNumber} that is absent from the repository issue set`,
        });
      }
      if (classification.issue.labels.includes(TRACK_LABEL)) {
        findings.push({
          code: 'labeled_not_root',
          severity: 'warning',
          issueNumber: number,
          detail: `sub-issue #${number} carries the "${TRACK_LABEL}" label but is not a root issue`,
        });
      }
    }
    if (
      classification.desiredMembership &&
      classification.issue.labels.includes(TRACK_LABEL) &&
      items.length === 0
    ) {
      findings.push({
        code: 'labeled_without_item',
        severity: 'info',
        issueNumber: number,
        detail: `issue #${number} carries the "${TRACK_LABEL}" label but has no project item yet`,
      });
    }
  }

  for (const [number, items] of itemsByNumber) {
    if (items.length > 1) {
      findings.push({
        code: 'duplicate_project_items',
        severity: 'error',
        issueNumber: number,
        detail: `${items.length} project items reference issue #${number}`,
      });
    }
  }

  for (const item of projectItems) {
    if (item.contentType === 'DRAFT_ISSUE') {
      findings.push({
        code: 'invalid_reference',
        severity: 'error',
        detail: `project item ${item.itemId} is a draft issue, which this policy never desires`,
      });
    } else if (item.contentType === 'PULL_REQUEST') {
      findings.push({
        code: 'invalid_reference',
        severity: 'error',
        issueNumber: item.contentNumber ?? undefined,
        detail: `project item ${item.itemId} is a pull request, which this policy never desires`,
      });
    } else if (item.contentNumber === null || !issueByNumber.has(item.contentNumber)) {
      const target = item.contentNumber === null ? '<no number>' : `#${String(item.contentNumber)}`;
      findings.push({
        code: 'invalid_reference',
        severity: 'error',
        issueNumber: item.contentNumber ?? undefined,
        detail: `project item ${item.itemId} references issue ${target} that is absent from the repository issue set`,
      });
    }
    if (item.isArchived) {
      findings.push({
        code: 'archived_item',
        severity: 'info',
        issueNumber: item.contentNumber ?? undefined,
        detail: `project item ${item.itemId} is archived`,
      });
    }
  }

  return sortFindings(findings);
}
