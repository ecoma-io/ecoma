import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exclusionReason, loadPolicy, PolicyValidationError, validatePolicy } from './policy.js';
import type { NormalizedIssue } from './types.js';

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

it('accepts a policy with the documented shape', () => {
  const policy = validatePolicy({
    projectNumber: 13,
    exclusions: {
      issueNumbers: [1, 8],
      botAuthorSuffix: '[bot]',
      titlePrefixes: ['TEST-FIXTURE-'],
    },
  });
  expect(policy).toEqual({
    projectNumber: 13,
    exclusions: {
      issueNumbers: [1, 8],
      botAuthorSuffix: '[bot]',
      titlePrefixes: ['TEST-FIXTURE-'],
    },
  });
});

it('loads the bundled membership policy from disk', async () => {
  const policy = await loadPolicy(
    new URL('../config/membership-policy.json', import.meta.url).pathname,
  );
  expect(policy.projectNumber).toBe(13);
  expect(policy.exclusions.issueNumbers).toEqual([1, 8]);
  expect(policy.exclusions.botAuthorSuffix).toBe('[bot]');
  expect(policy.exclusions.titlePrefixes).toEqual(['TEST-FIXTURE-']);
});

it('rejects unknown keys at the policy root', () => {
  const error = (() => {
    try {
      validatePolicy({ projectNumber: 13, exclusions: {}, autoClose: true });
      return null;
    } catch (cause) {
      return cause;
    }
  })();
  expect(error).toBeInstanceOf(PolicyValidationError);
  expect((error as PolicyValidationError).problems.join('\n')).toContain('unknown key "autoClose"');
});

it('rejects unknown keys inside exclusions', () => {
  const error = (() => {
    try {
      validatePolicy({
        projectNumber: 13,
        exclusions: {
          issueNumbers: [],
          botAuthorSuffix: '[bot]',
          titlePrefixes: [],
          archived: false,
        },
      });
      return null;
    } catch (cause) {
      return cause;
    }
  })();
  expect(error).toBeInstanceOf(PolicyValidationError);
  expect((error as PolicyValidationError).problems.join('\n')).toContain('unknown key "archived"');
});

it('rejects wrong types and missing fields', () => {
  const error = (() => {
    try {
      validatePolicy({
        projectNumber: '13',
        exclusions: { issueNumbers: 'all', botAuthorSuffix: '', titlePrefixes: [3] },
      });
      return null;
    } catch (cause) {
      return cause;
    }
  })();
  expect(error).toBeInstanceOf(PolicyValidationError);
  const problems = (error as PolicyValidationError).problems.join('\n');
  expect(problems).toContain('"projectNumber" must be a positive integer');
  expect(problems).toContain('"exclusions.issueNumbers" must be an array of positive integers');
  expect(problems).toContain('"exclusions.botAuthorSuffix" must be a non-empty string');
  expect(problems).toContain('"exclusions.titlePrefixes" must be an array of non-empty strings');
});

it('fails when the policy file does not exist', async () => {
  await expect(loadPolicy('/nonexistent/membership-policy.json')).rejects.toBeInstanceOf(
    PolicyValidationError,
  );
});

it('fails when the policy file is not valid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'policy-spec-'));
  try {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ not json', 'utf8');
    await expect(loadPolicy(path)).rejects.toBeInstanceOf(PolicyValidationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('computes exclusion reasons with explicit, bot-author and title-prefix precedence', () => {
  const policy = {
    projectNumber: 13,
    exclusions: {
      issueNumbers: [1],
      botAuthorSuffix: '[bot]',
      titlePrefixes: ['TEST-FIXTURE-'],
    },
  };
  expect(exclusionReason(makeIssue(1), policy)).toBe('explicit');
  expect(exclusionReason(makeIssue(2, { authorLogin: 'renovate[bot]' }), policy)).toBe(
    'bot-author',
  );
  expect(exclusionReason(makeIssue(3, { title: 'TEST-FIXTURE-old' }), policy)).toBe('title-prefix');
  expect(exclusionReason(makeIssue(4), policy)).toBeNull();
});
