import { runReconciliation } from './reconcile.js';
import type { GitHubPort } from './github.js';
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

interface FakePortState {
  issues: NormalizedIssue[];
  projectItems: ProjectItemRecord[];
  complete?: boolean;
  /** Snapshot trả về bởi refetchProjectItems; mặc định là projectItems. */
  refetchedItems?: ProjectItemRecord[];
  /** Đổi thành một Error để refetch sau apply fail. */
  refetchError?: Error;
  /** Đổi thành một Error để addItem fail dù plan muốn add. */
  addError?: Error;
}

function fakePort(state: FakePortState): {
  port: GitHubPort;
  addedNodeIds: string[];
  removedItemIds: string[];
} {
  const addedNodeIds: string[] = [];
  const removedItemIds: string[] = [];
  const port: GitHubPort = {
    discoverAll: async () => ({
      issues: state.issues,
      projectItems: state.projectItems,
      complete: state.complete ?? true,
    }),
    addItem: async (issueNodeId) => {
      if (state.addError !== undefined) {
        throw state.addError;
      }
      addedNodeIds.push(issueNodeId);
      return `new_item_${issueNodeId}`;
    },
    removeItem: async (itemId) => {
      removedItemIds.push(itemId);
    },
    refetchProjectItems: async () => {
      if (state.refetchError !== undefined) {
        throw state.refetchError;
      }
      return state.refetchedItems ?? state.projectItems;
    },
  };
  return { port, addedNodeIds, removedItemIds };
}

const FIXED_NOW = (): Date => new Date('2026-11-11T05:30:00.000Z');

it('fails closed with zero mutation calls when discovery is incomplete', async () => {
  const { port, addedNodeIds, removedItemIds } = fakePort({
    issues: [makeIssue(10)],
    projectItems: [],
    complete: false,
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'apply', now: FIXED_NOW });
  expect(report.status).toBe('failed');
  expect(report.error).toContain('discovery is incomplete');
  expect(addedNodeIds).toEqual([]);
  expect(removedItemIds).toEqual([]);
  expect(report.plan).toEqual([]);
  expect(report.verification.performed).toBe(false);
});

it('reports drift in audit mode and never calls a mutation', async () => {
  const { port, addedNodeIds, removedItemIds } = fakePort({
    issues: [makeIssue(10), makeIssue(11, { parentNumber: 10 })],
    projectItems: [makeItem('item_11', 11)],
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'audit', now: FIXED_NOW });
  expect(report.status).toBe('drift');
  expect(addedNodeIds).toEqual([]);
  expect(removedItemIds).toEqual([]);
  // #10 (root) thiếu item → add; #11 (child) đang có item_11 → remove; không
  // còn issue nào khác nên plan không chứa keep_out.
  expect(report.plan.map((action) => action.action)).toEqual(['add', 'remove']);
  expect(report.verification.performed).toBe(false);
  expect(report.afterItems).toBe(report.beforeItems);
  expect(report.generatedAt).toBe('2026-11-11T05:30:00.000Z');
});

it('reports clean in audit mode when membership already matches the policy', async () => {
  const { port } = fakePort({
    issues: [makeIssue(10)],
    projectItems: [makeItem('item_10', 10)],
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'audit', now: FIXED_NOW });
  expect(report.status).toBe('clean');
  expect(report.counts.addsPlanned).toBe(0);
  expect(report.counts.removesPlanned).toBe(0);
});

it('applies adds and removes per plan and verifies convergence after refetch', async () => {
  const { port, addedNodeIds, removedItemIds } = fakePort({
    issues: [makeIssue(10), makeIssue(11, { parentNumber: 10 })],
    projectItems: [makeItem('item_11', 11)],
    refetchedItems: [makeItem('new_item_node_10', 10)],
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'apply', now: FIXED_NOW });
  expect(addedNodeIds).toEqual(['node_10']);
  expect(removedItemIds).toEqual(['item_11']);
  expect(report.status).toBe('clean');
  expect(report.verification.status).toBe('converged');
  expect(report.counts.addsApplied).toBe(1);
  expect(report.counts.removesApplied).toBe(1);
  expect(report.beforeItems.map((item) => item.itemId)).toEqual(['item_11']);
  expect(report.afterItems.map((item) => item.itemId)).toEqual(['new_item_node_10']);
});

it('catches a lying mutation through verification instead of trusting addItem', async () => {
  // addItem "thành công" nhưng snapshot refetch không có item mới — verify
  // phải phát hiện drift còn lại và status không được là clean.
  const { port, addedNodeIds } = fakePort({
    issues: [makeIssue(10)],
    projectItems: [],
    refetchedItems: [],
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'apply', now: FIXED_NOW });
  expect(addedNodeIds).toEqual(['node_10']);
  expect(report.status).toBe('drift');
  expect(report.verification.status).toBe('drift');
  expect(report.verification.residualPlan.map((action) => action.action)).toEqual(['add']);
  expect(report.appliedMutations).toHaveLength(1);
  expect(report.appliedMutations[0]).toMatchObject({ action: 'add', ok: true });
});

it('handles duplicate items by keeping one and removing only the extras', async () => {
  const { port, removedItemIds, addedNodeIds } = fakePort({
    issues: [makeIssue(10)],
    projectItems: [makeItem('item_10a', 10), makeItem('item_10b', 10)],
    refetchedItems: [makeItem('item_10a', 10)],
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'apply', now: FIXED_NOW });
  expect(addedNodeIds).toEqual([]);
  expect(removedItemIds).toEqual(['item_10b']);
  expect(report.status).toBe('clean');
});

it('marks the report failed when verification cannot refetch after apply', async () => {
  const { port } = fakePort({
    issues: [makeIssue(10)],
    projectItems: [],
    refetchError: new Error('refetch exploded'),
  });
  const report = await runReconciliation({ port, policy: POLICY, mode: 'apply', now: FIXED_NOW });
  expect(report.status).toBe('failed');
  expect(report.error).toContain('verification could not refetch');
  expect(report.verification.status).toBe('unavailable');
  expect(report.appliedMutations[0]).toMatchObject({ action: 'add', ok: true });
});
