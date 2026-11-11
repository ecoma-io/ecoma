import { auditState, TRACK_LABEL } from './audit.js';
import { classifyIssues } from './classify.js';
import type { PolicyConfig, NormalizedIssue, ProjectItemRecord } from './types.js';

const POLICY: PolicyConfig = {
  projectNumber: 13,
  exclusions: { issueNumbers: [], botAuthorSuffix: '[bot]', titlePrefixes: [] },
};

function makeIssue(number: number, overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    number,
    nodeId: `node_${String(number)}`,
    title: `Issue ${String(number)}`,
    state: 'OPEN',
    authorLogin: 'johnitvn',
    isPullRequest: false,
    parentNumber: null,
    subIssueNumbers: [],
    labels: [],
    milestoneNumber: null,
    ...overrides,
  };
}

function makeItem(
  itemId: string,
  contentNumber: number | null,
  contentType: ProjectItemRecord['contentType'] = 'ISSUE',
  isArchived = false,
): ProjectItemRecord {
  return { itemId, contentType, contentNumber, isArchived };
}

function audit(issues: NormalizedIssue[], items: ProjectItemRecord[]) {
  return auditState(issues, items, classifyIssues(issues, POLICY));
}

function codes(findings: ReturnType<typeof auditState>): string[] {
  return findings.map((finding) => finding.code);
}

it('reports a clean state without findings', () => {
  const findings = audit([makeIssue(10)], [makeItem('item_10', 10)]);
  expect(findings).toEqual([]);
});

it('reports missing_membership when a desired root issue has no project item', () => {
  const findings = audit([makeIssue(10)], []);
  expect(codes(findings)).toEqual(['missing_membership']);
  expect(findings[0]).toMatchObject({ severity: 'error', issueNumber: 10 });
});

it('reports unexpected_membership for items of excluded or child issues', () => {
  const issues = [
    makeIssue(10, { authorLogin: 'renovate[bot]' }),
    makeIssue(11, { parentNumber: 12 }),
  ];
  const items = [makeItem('item_10', 10), makeItem('item_11', 11)];
  const findings = audit(issues, items);
  const unexpected = findings.filter((finding) => finding.code === 'unexpected_membership');
  expect(unexpected).toHaveLength(2);
  expect(
    unexpected.map((finding) => finding.issueNumber).toSorted((a, b) => (a ?? 0) - (b ?? 0)),
  ).toEqual([10, 11]);
  expect(unexpected.every((finding) => finding.severity === 'error')).toBe(true);
});

it('reports duplicate_project_items when two items reference the same issue', () => {
  const findings = audit([makeIssue(10)], [makeItem('item_10a', 10), makeItem('item_10b', 10)]);
  expect(codes(findings)).toEqual(['duplicate_project_items']);
  expect(findings[0]).toMatchObject({ severity: 'error', issueNumber: 10 });
});

it('reports orphaned_child when a sub-issue references an absent parent', () => {
  const findings = audit([makeIssue(11, { parentNumber: 999 })], []);
  expect(codes(findings)).toEqual(['orphaned_child']);
  expect(findings[0]).toMatchObject({ severity: 'error', issueNumber: 11 });
});

it('reports invalid_reference for an issue item whose number is absent from the issue set', () => {
  // Issue 10 có item của nó để desired membership thỏa mãn; item "ghost" trỏ
  // số 777 không có trong issue set.
  const findings = audit([makeIssue(10)], [makeItem('item_10', 10), makeItem('item_ghost', 777)]);
  expect(codes(findings)).toEqual(['invalid_reference']);
  expect(findings[0]).toMatchObject({ severity: 'error', issueNumber: 777 });
});

it('reports invalid_reference for draft and pull request items', () => {
  const findings = audit(
    [makeIssue(10)],
    [
      makeItem('item_10', 10),
      makeItem('item_draft', null, 'DRAFT_ISSUE'),
      makeItem('item_pr', 42, 'PULL_REQUEST'),
    ],
  );
  expect(codes(findings)).toEqual(['invalid_reference', 'invalid_reference']);
  expect(findings.every((finding) => finding.severity === 'error')).toBe(true);
});

it('reports archived items as info findings', () => {
  const findings = audit([makeIssue(10)], [makeItem('item_10', 10, 'ISSUE', true)]);
  expect(codes(findings)).toEqual(['archived_item']);
  expect(findings[0]).toMatchObject({ severity: 'info', issueNumber: 10 });
});

it('warns when the track label sits on a sub-issue', () => {
  // Parent 10 có mặt trong issue set (kèm item) để không sinh orphaned_child.
  const findings = audit(
    [makeIssue(10), makeIssue(11, { parentNumber: 10, labels: [TRACK_LABEL] })],
    [makeItem('item_10', 10)],
  );
  expect(codes(findings)).toEqual(['labeled_not_root']);
  expect(findings[0]).toMatchObject({ severity: 'warning', issueNumber: 11 });
});

it('reports the admission label without an item as an info finding', () => {
  // Desired member chưa có item cũng sinh missing_membership (error) — hai
  // finding cùng tồn tại là hành vi đúng: label là dữ liệu, membership là policy.
  const findings = audit([makeIssue(10, { labels: [TRACK_LABEL] })], []);
  expect(codes(findings)).toEqual(['labeled_without_item', 'missing_membership']);
  expect(findings[0]).toMatchObject({ severity: 'info', issueNumber: 10 });
});
