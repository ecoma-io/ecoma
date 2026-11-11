import { classifyIssues } from './classify.js';
import type { PolicyConfig, NormalizedIssue } from './types.js';

const POLICY: PolicyConfig = {
  projectNumber: 13,
  exclusions: {
    issueNumbers: [1],
    botAuthorSuffix: '[bot]',
    titlePrefixes: ['TEST-FIXTURE-'],
  },
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

it('classifies a plain root issue as a desired member', () => {
  const classifications = classifyIssues([makeIssue(10)], POLICY);
  expect(classifications).toHaveLength(1);
  expect(classifications[0]).toMatchObject({
    hierarchy: 'root',
    excluded: false,
    exclusionReason: null,
    desiredMembership: true,
  });
});

it('classifies a sub-issue as a child that is never a desired member', () => {
  const classifications = classifyIssues([makeIssue(11, { parentNumber: 10 })], POLICY);
  expect(classifications[0]).toMatchObject({
    hierarchy: 'child',
    excluded: false,
    exclusionReason: null,
    desiredMembership: false,
  });
});

it('excludes issues whose author login ends with the bot suffix', () => {
  const classifications = classifyIssues(
    [makeIssue(12, { authorLogin: 'ecoma-bot[bot]' })],
    POLICY,
  );
  expect(classifications[0]).toMatchObject({
    hierarchy: 'root',
    excluded: true,
    exclusionReason: 'bot-author',
    desiredMembership: false,
  });
});

it('excludes issues whose title starts with a configured prefix', () => {
  const classifications = classifyIssues([makeIssue(13, { title: 'TEST-FIXTURE-legacy' })], POLICY);
  expect(classifications[0]).toMatchObject({
    excluded: true,
    exclusionReason: 'title-prefix',
    desiredMembership: false,
  });
});

it('excludes issues listed in the explicit exclusion numbers with highest precedence', () => {
  // Issue 1 khớp CẢ explicit list lẫn title prefix; explicit phải thắng.
  const classifications = classifyIssues(
    [makeIssue(1, { title: 'TEST-FIXTURE-repo-bootstrap' })],
    POLICY,
  );
  expect(classifications[0]).toMatchObject({
    excluded: true,
    exclusionReason: 'explicit',
    desiredMembership: false,
  });
});

it('never desires membership for pull request records even when root and unexcluded', () => {
  const classifications = classifyIssues([makeIssue(14, { isPullRequest: true })], POLICY);
  expect(classifications[0]).toMatchObject({
    hierarchy: 'root',
    excluded: false,
    exclusionReason: null,
    desiredMembership: false,
  });
});

it('returns classifications sorted by issue number regardless of input order', () => {
  const classifications = classifyIssues(
    [makeIssue(21), makeIssue(19, { parentNumber: 18 }), makeIssue(20)],
    POLICY,
  );
  expect(classifications.map((classification) => classification.issue.number)).toEqual([
    19, 20, 21,
  ]);
});
