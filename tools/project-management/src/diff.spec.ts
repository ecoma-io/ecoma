import { computeIdempotencyCheck } from './diff.js';
import { applyPlanToItems, buildPlan } from './plan.js';
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

function makeItem(itemId: string, contentNumber: number | null): ProjectItemRecord {
  return { itemId, contentType: 'ISSUE', contentNumber, isArchived: false };
}

function classify(issues: NormalizedIssue[]) {
  return classifyIssues(issues, POLICY);
}

function mutationActions(plan: ReturnType<typeof buildPlan>) {
  return plan.filter((action) => action.action === 'add' || action.action === 'remove');
}

it('reports idempotent when the current state already matches the desired membership', () => {
  const issues = [makeIssue(10), makeIssue(11, { parentNumber: 10 })];
  const items = [makeItem('item_10', 10)];
  const classifications = classify(issues);
  const check = computeIdempotencyCheck(buildPlan(classifications, items), classifications, items);
  expect(check.idempotent).toBe(true);
  expect(check.residualActions).toEqual([]);
});

it('reports a drifted state as idempotent because one apply pass converges', () => {
  // Trạng thái lệch (child #11 có item, root #10 thiếu) vẫn cho plan hội tụ
  // sau MỘT lượt apply — idempotency đo trạng thái SAU apply, không phải mức
  // độ lệch của trạng thái trước đó.
  const issues = [makeIssue(10), makeIssue(11, { parentNumber: 10 })];
  const items = [makeItem('item_11', 11)];
  const classifications = classify(issues);
  const plan = buildPlan(classifications, items);
  expect(mutationActions(plan).map((action) => action.action)).toEqual(['add', 'remove']);
  const check = computeIdempotencyCheck(plan, classifications, items);
  expect(check.idempotent).toBe(true);
  expect(check.residualActions).toEqual([]);
});

it('flags residual mutations when the post state still holds a colliding item', () => {
  // Plan được dựng từ snapshot không có item cho #10, nhưng snapshot đưa vào
  // check lại chứa item cho #10 — re-plan trên trạng thái hậu apply vẫn cần
  // remove: đúng lúc check phát hiện plan không hội tụ với thực tế.
  const issues = [makeIssue(10)];
  const classifications = classify(issues);
  const plan = buildPlan(classifications, []);
  expect(mutationActions(plan).map((action) => action.action)).toEqual(['add']);
  const check = computeIdempotencyCheck(plan, classifications, [makeItem('item_hidden', 10)]);
  expect(check.idempotent).toBe(false);
  expect(check.residualActions.map((action) => action.action)).toEqual(['remove']);
});

it('reports idempotent after applying the plan to a hypothetical post state', () => {
  const issues = [makeIssue(10), makeIssue(11, { parentNumber: 10 })];
  const items = [makeItem('item_11', 11)];
  const classifications = classify(issues);
  const plan = buildPlan(classifications, items);
  // Áp plan lên snapshot item (giả lập trạng thái sau apply) rồi re-plan:
  // plan thứ hai phải không còn action mutation nào.
  const postItems = applyPlanToItems(plan, items);
  const secondPlan = buildPlan(classifications, postItems);
  expect(mutationActions(secondPlan)).toEqual([]);
  const secondCheck = computeIdempotencyCheck(secondPlan, classifications, postItems);
  expect(secondCheck.idempotent).toBe(true);
});
