import { classifyIssues } from './classify.js';
import type { GitHubPort, GitHubPortError } from './github.js';
import type {
  NormalizedIssue,
  PolicyConfig,
  ProjectItemRecord,
  ProjectItemSnapshot,
} from './types.js';
import { verifyAfterApply, type VerifyPollingOptions } from './verify.js';

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

/** Đồng hồ ảo + sleep ảo: thời gian chỉ tiến khi sleep được gọi. */
function virtualClock(): { options: Partial<VerifyPollingOptions>; slept: () => number[] } {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    options: {
      nowMs: () => now,
      rng: () => 0, // jitter xác định: delay * (0.5 + 0.5*0) = delay / 2
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
    },
    slept: () => slept,
  };
}

/** Port với kịch bản refetch theo thứ tự; mỗi phần tử là một lần đọc. */
interface RefetchScriptEntry {
  items?: ProjectItemRecord[];
  complete?: boolean;
  error?: Error;
  snapshotError?: string | null;
}

interface ScriptedPort {
  port: GitHubPort;
  reads(): number;
}

function fakePort(script: RefetchScriptEntry[]): ScriptedPort {
  let reads = 0;
  const port: GitHubPort = {
    discoverAll: async () => {
      throw new Error('discoverAll is not used by verifyAfterApply');
    },
    addItem: async () => {
      throw new Error('addItem is not used by verifyAfterApply');
    },
    removeItem: async () => {
      throw new Error('removeItem is not used by verifyAfterApply');
    },
    refetchProjectItems: async (): Promise<ProjectItemSnapshot> => {
      const entry = script[Math.min(reads, script.length - 1)];
      reads += 1;
      if (entry.error !== undefined) {
        throw entry.error;
      }
      const complete = entry.complete ?? true;
      return {
        items: entry.items ?? [],
        complete,
        error: complete ? null : (entry.snapshotError ?? 'pagination did not finish'),
      };
    },
  };
  return { port, reads: () => reads };
}

function rateLimitError(): GitHubPortError {
  return Object.assign(new Error('GitHub GraphQL rate-limited the request'), {
    name: 'GitHubPortError',
    retryable: true,
  }) as GitHubPortError;
}

const FAST_OPTIONS: Partial<VerifyPollingOptions> = {
  deadlineMs: 10_000,
  initialDelayMs: 2_000,
  multiplier: 2,
  maxDelayMs: 30_000,
};

it('waits through propagation delay: first snapshot misses an add, the second sees it', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([
    { items: [] }, // attempt 1: add chưa hiện
    { items: [makeItem('new_item_node_10', 10)] }, // attempt 2: đã hiện
  ]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(outcome.verification.attempts.map((attempt) => attempt.outcome)).toEqual([
    'residual_pending',
    'clean',
  ]);
  expect(clock.slept()).toHaveLength(1);
  expect(outcome.verification.waitedMs).toBe(clock.slept()[0]);
});

it('waits through propagation delay for a remove: first snapshot still shows the item', async () => {
  // Plan thật của trạng thái này: add #10 (root thiếu item) + remove item_11
  // (child nằm trong Project). Refetch đầu vẫn thấy item_11 và chưa thấy item
  // mới của #10; refetch thứ hai sạch.
  const issues = [makeIssue(10), makeIssue(11, { parentNumber: 10 })];
  const clock = virtualClock();
  const { port } = fakePort([
    { items: [makeItem('item_11', 11)] },
    { items: [makeItem('new_item_node_10', 10)] },
  ]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
      { action: 'remove', issueNumber: 11, itemId: 'item_11', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(outcome.afterItems.map((item) => item.itemId)).toEqual(['new_item_node_10']);
});

it('tolerates different propagation delays across multiple mutations', async () => {
  const issues = [makeIssue(10), makeIssue(11)];
  const clock = virtualClock();
  const { port } = fakePort([
    { items: [] }, // chưa cái nào hiện
    { items: [makeItem('item_a_10', 10)] }, // add #10 hiện, #11 chưa
    { items: [makeItem('item_a_10', 10), makeItem('item_a_11', 11)] }, // đủ
  ]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'item_a_10', ok: true, detail: '' },
      { action: 'add', issueNumber: 11, itemId: 'item_a_11', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(outcome.verification.attempts.map((attempt) => attempt.outcome)).toEqual([
    'residual_pending',
    'residual_pending',
    'clean',
  ]);
  expect(clock.slept()).toHaveLength(2);
});

it('reports propagation_pending when the delay exceeds the whole deadline', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([{ items: [] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('propagation_pending');
  expect(outcome.verification.residualPlan.map((action) => action.action)).toEqual(['add']);
  expect(outcome.verification.waitedMs).toBeLessThanOrEqual(
    FAST_OPTIONS.deadlineMs ?? Number.MAX_SAFE_INTEGER,
  );
  // Lịch 2s → 4s → 8s (jitter 0.5) = 1s + 2s + 4s = 7s ≤ deadline 10s; lần
  // chờ kế tiếp (8s) sẽ vượt deadline nên dừng ở 7s.
  expect(clock.slept()).toEqual([1_000, 2_000, 4_000]);
  expect(outcome.afterItems).toEqual([]);
});

it('reports drift immediately when a residual cannot be explained by successful mutations', async () => {
  const issues = [makeIssue(10), makeIssue(11, { parentNumber: 10 })];
  const clock = virtualClock();
  const { port } = fakePort([{ items: [makeItem('item_x', 11)] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    // add #10 ok nhưng chưa hiện (explainable); item #11 (child) xuất hiện
    // ngoài plan — KHÔNG có mutation ok nào giải thích được.
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('drift');
  expect(clock.slept()).toEqual([]); // dừng sớm, không poll
  expect(
    outcome.verification.residualPlan.map((action) => [action.action, action.issueNumber]),
  ).toEqual([
    ['add', 10],
    ['remove', 11],
  ]);
});

it('reports drift when a planned mutation genuinely failed and the state did not converge', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([{ items: [] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: null, ok: false, detail: 'addItem failed' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('drift');
  expect(clock.slept()).toEqual([]);
});

it('treats an ambiguous mutation timeout as clean when the item is actually present', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([{ items: [makeItem('new_item_node_10', 10)] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    // add timeout sau khi GitHub đã áp dụng: snapshot thấy item → residual
    // rỗng → clean, không false drift, và không re-apply.
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: null, ok: false, detail: 'network timeout' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(clock.slept()).toEqual([]);
});

it('reports verification_failed when every refetch attempt errors (5xx after port retries)', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([{ error: new Error('GitHub GraphQL responded HTTP 502') }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('verification_failed');
  expect(outcome.verification.attempts.every((attempt) => attempt.outcome === 'error')).toBe(true);
  expect(outcome.verification.detail).toContain('502');
});

it('reports verification_failed when refetch stays rate-limited past the deadline', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([{ error: rateLimitError() }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('verification_failed');
});

it('reports inventory_incomplete when pagination stays partial past the deadline', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([
    {
      items: [makeItem('item_a', 10)],
      complete: false,
      snapshotError: 'page 2 failed after retries',
    },
  ]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('inventory_incomplete');
  expect(outcome.verification.status).not.toBe('clean');
  expect(outcome.verification.detail).toContain('page 2 failed');
  // Snapshot partial không được dùng để suy residual.
  expect(outcome.verification.residualPlan).toEqual([]);
});

it('recovers when pagination is incomplete once and complete on the next attempt', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([
    { items: [makeItem('item_a', 10)], complete: false, snapshotError: 'transient' },
    { items: [makeItem('item_a', 10)] },
  ]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(outcome.verification.attempts.map((attempt) => attempt.outcome)).toEqual([
    'incomplete',
    'clean',
  ]);
});

it('verifies once without polling when no mutations were required', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port, reads } = fakePort([{ items: [makeItem('item_10', 10)] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(outcome.verification.attempts).toHaveLength(1);
  expect(clock.slept()).toEqual([]);
  expect(reads()).toBe(1);
});

it('never sleeps after a clean verification', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port, reads } = fakePort([{ items: [makeItem('item_10', 10)] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [{ action: 'add', issueNumber: 10, itemId: 'item_10', ok: true, detail: '' }],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.status).toBe('clean');
  expect(clock.slept()).toEqual([]);
  expect(reads()).toBe(1);
});

it('keeps polling bounded: total wait never exceeds the deadline', async () => {
  const issues = [makeIssue(10)];
  const clock = virtualClock();
  const { port } = fakePort([{ items: [] }]);
  const outcome = await verifyAfterApply({
    port,
    issues,
    classifications: classify(issues),
    appliedMutations: [
      { action: 'add', issueNumber: 10, itemId: 'new_item_node_10', ok: true, detail: '' },
    ],
    options: { ...FAST_OPTIONS, ...clock.options },
  });
  expect(outcome.verification.waitedMs).toBeLessThanOrEqual(
    FAST_OPTIONS.deadlineMs ?? Number.MAX_SAFE_INTEGER,
  );
  expect(clock.slept().length).toBeGreaterThan(1);
});

/** classify helper dùng chung các test ở trên. */
function classify(issues: readonly NormalizedIssue[]) {
  return classifyIssues(issues, POLICY);
}
