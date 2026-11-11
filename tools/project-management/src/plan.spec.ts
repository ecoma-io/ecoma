import { buildPlan } from './plan.js';
import { classifyIssues } from './classify.js';
import type { PolicyConfig, NormalizedIssue, ProjectItemRecord } from './types.js';

const POLICY: PolicyConfig = {
  projectNumber: 13,
  exclusions: { issueNumbers: [1], botAuthorSuffix: '[bot]', titlePrefixes: [] },
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
): ProjectItemRecord {
  return { itemId, contentType, contentNumber, isArchived: false };
}

function plan(issues: NormalizedIssue[], items: ProjectItemRecord[]) {
  return buildPlan(classifyIssues(issues, POLICY), items);
}

it('plans an add for a desired member missing from the project', () => {
  const actions = plan([makeIssue(10)], []);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ action: 'add', issueNumber: 10 });
  expect(actions[0]?.itemId).toBeUndefined();
});

it('plans a remove for an unexpected project item', () => {
  const actions = plan(
    [makeIssue(10, { authorLogin: 'renovate[bot]' })],
    [makeItem('item_10', 10)],
  );
  expect(actions).toEqual([
    expect.objectContaining({ action: 'remove', issueNumber: 10, itemId: 'item_10' }),
  ]);
});

it('plans keep for a desired member already present', () => {
  const actions = plan([makeIssue(10)], [makeItem('item_10', 10)]);
  expect(actions).toEqual([
    expect.objectContaining({ action: 'keep', issueNumber: 10, itemId: 'item_10' }),
  ]);
});

it('plans keep_out for a non-member that is not desired', () => {
  const actions = plan([makeIssue(1), makeIssue(11, { parentNumber: 10 })], []);
  expect(actions).toHaveLength(2);
  expect(actions.every((action) => action.action === 'keep_out')).toBe(true);
  expect(actions.map((action) => action.issueNumber)).toEqual([1, 11]);
});

it('keeps one item and removes extras when a desired member has duplicates', () => {
  const actions = plan([makeIssue(10)], [makeItem('item_10b', 10), makeItem('item_10a', 10)]);
  expect(actions).toEqual([
    expect.objectContaining({ action: 'keep', itemId: 'item_10a', issueNumber: 10 }),
    expect.objectContaining({ action: 'remove', itemId: 'item_10b', issueNumber: 10 }),
  ]);
});

it('is deterministic and sorted by issue number across runs', () => {
  const issues = [
    makeIssue(21),
    makeIssue(19, { parentNumber: 18 }),
    makeIssue(20, { authorLogin: 'renovate[bot]' }),
    makeIssue(1),
  ];
  const items = [makeItem('item_19', 19), makeItem('item_20', 20)];
  const first = plan(issues, items);
  const second = plan(issues, items);
  expect(first).toEqual(second);
  const numbers = first.map((action) => action.issueNumber);
  expect(numbers.toSorted((a, b) => a - b)).toEqual(numbers);
  // Mỗi issue trùng số trong input phải vẫn cho output ổn định theo itemId.
  const removesFor20 = first.filter((action) => action.issueNumber === 20);
  expect(removesFor20.map((action) => action.action)).toEqual(['remove']);
});
