/**
 * Orchestrator của pipeline: discover → audit → plan → idempotency-check →
 * (apply → verify). Port là dependency được inject nên orchestrator test được
 * với fake, không chạm GitHub.
 *
 * Fail-closed: discovery một phần ⇒ status 'failed', không audit/apply gì nữa.
 * Verify không tin mutation thành công: sau apply luôn refetch snapshot item
 * và re-derive drift còn lại từ dữ liệu thật.
 */

import { auditState, type AuditFinding } from './audit.js';
import { classifyIssues } from './classify.js';
import { computeIdempotencyCheck, type IdempotencyCheck } from './diff.js';
import { buildPlan, type PlanAction } from './plan.js';
import type { GitHubPort } from './github.js';
import type {
  NormalizedIssue,
  PolicyConfig,
  ProjectItemRecord,
  ReconciliationMode,
} from './types.js';

export type ReconciliationStatus = 'clean' | 'drift' | 'failed';

/** Một mutation đã thực thi trong mode apply, kèm kết quả thật của nó. */
export interface AppliedMutation {
  action: 'add' | 'remove';
  issueNumber: number | null;
  /** itemId trả về (add) hoặc itemId đích (remove); null khi mutation lỗi. */
  itemId: string | null;
  ok: boolean;
  detail: string;
}

export interface VerificationResult {
  /** false cho mode audit: audit không mutation nên không có gì để verify. */
  performed: boolean;
  status: 'not_applicable' | 'converged' | 'drift' | 'unavailable';
  residualFindings: AuditFinding[];
  /** Chỉ chứa action mutation còn sót lại sau khi verify. */
  residualPlan: PlanAction[];
  detail: string;
}

export interface ReportCounts {
  issues: number;
  desiredMembers: number;
  projectItemsBefore: number;
  findings: number;
  addsPlanned: number;
  removesPlanned: number;
  addsApplied: number;
  removesApplied: number;
}

export interface ReconciliationReport {
  status: ReconciliationStatus;
  mode: ReconciliationMode;
  generatedAt: string;
  counts: ReportCounts;
  findings: AuditFinding[];
  plan: PlanAction[];
  /** null khi pipeline fail trước khi kịp dựng plan (vd discovery một phần). */
  idempotency: IdempotencyCheck | null;
  appliedMutations: AppliedMutation[];
  verification: VerificationResult;
  beforeItems: ProjectItemRecord[];
  afterItems: ProjectItemRecord[];
  /** Nguyên nhân khi status 'failed', ngược lại null. */
  error: string | null;
}

export interface RunReconciliationInput {
  port: GitHubPort;
  policy: PolicyConfig;
  mode: ReconciliationMode;
  /** Đồng hồ cho `generatedAt` — inject để test deterministic. */
  now?: () => Date;
}

const MUTATING_ACTIONS = new Set<PlanAction['action']>(['add', 'remove']);

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function buildCounts(
  issues: readonly NormalizedIssue[],
  classifications: { desiredMembership: boolean }[],
  findings: readonly AuditFinding[],
  plan: readonly PlanAction[],
  beforeItems: readonly ProjectItemRecord[],
  appliedMutations: readonly AppliedMutation[],
): ReportCounts {
  return {
    issues: issues.length,
    desiredMembers: classifications.filter((classification) => classification.desiredMembership)
      .length,
    projectItemsBefore: beforeItems.length,
    findings: findings.length,
    addsPlanned: plan.filter((action) => action.action === 'add').length,
    removesPlanned: plan.filter((action) => action.action === 'remove').length,
    addsApplied: appliedMutations.filter((mutation) => mutation.action === 'add' && mutation.ok)
      .length,
    removesApplied: appliedMutations.filter(
      (mutation) => mutation.action === 'remove' && mutation.ok,
    ).length,
  };
}

export async function runReconciliation({
  port,
  policy,
  mode,
  now = () => new Date(),
}: RunReconciliationInput): Promise<ReconciliationReport> {
  const discovery = await port.discoverAll();
  if (!discovery.complete) {
    return {
      status: 'failed',
      mode,
      generatedAt: now().toISOString(),
      counts: {
        issues: 0,
        desiredMembers: 0,
        projectItemsBefore: 0,
        findings: 0,
        addsPlanned: 0,
        removesPlanned: 0,
        addsApplied: 0,
        removesApplied: 0,
      },
      findings: [],
      plan: [],
      idempotency: null,
      appliedMutations: [],
      verification: {
        performed: false,
        status: 'not_applicable',
        residualFindings: [],
        residualPlan: [],
        detail: 'verification skipped because discovery failed',
      },
      beforeItems: [],
      afterItems: [],
      error:
        'discovery is incomplete: at least one page could not be read after retries; refusing to audit or mutate on a partial inventory',
    };
  }

  const issues = discovery.issues;
  const beforeItems = discovery.projectItems;
  const classifications = classifyIssues(issues, policy);
  const findings = auditState(issues, beforeItems, classifications);
  const plan = buildPlan(classifications, beforeItems);
  const idempotency = computeIdempotencyCheck(plan, classifications, beforeItems);

  if (mode === 'audit') {
    const hasDrift = plan.some((action) => MUTATING_ACTIONS.has(action.action));
    return {
      status: hasDrift ? 'drift' : 'clean',
      mode,
      generatedAt: now().toISOString(),
      counts: buildCounts(issues, classifications, findings, plan, beforeItems, []),
      findings,
      plan,
      idempotency,
      appliedMutations: [],
      verification: {
        performed: false,
        status: 'not_applicable',
        residualFindings: [],
        residualPlan: [],
        detail: 'audit mode never mutates; nothing to verify',
      },
      beforeItems,
      afterItems: beforeItems,
      error: null,
    };
  }

  // Mode apply: thực thi từng action mutation rồi verify bằng dữ liệu refetch,
  // không tin kết quả mutation thành công.
  const issueByNumber = new Map<number, NormalizedIssue>(
    classifications.map((classification) => [classification.issue.number, classification.issue]),
  );
  const appliedMutations: AppliedMutation[] = [];
  for (const action of plan) {
    if (action.action === 'add') {
      const issue = issueByNumber.get(action.issueNumber);
      if (issue === undefined) {
        appliedMutations.push({
          action: 'add',
          issueNumber: action.issueNumber,
          itemId: null,
          ok: false,
          detail: `plan action references unknown issue #${String(action.issueNumber)}; skipped`,
        });
        continue;
      }
      try {
        const itemId = await port.addItem(issue.nodeId);
        appliedMutations.push({
          action: 'add',
          issueNumber: action.issueNumber,
          itemId,
          ok: true,
          detail: action.reason,
        });
      } catch (cause) {
        appliedMutations.push({
          action: 'add',
          issueNumber: action.issueNumber,
          itemId: null,
          ok: false,
          detail: `addItem failed for issue #${String(action.issueNumber)}: ${errorMessage(cause)}`,
        });
      }
    } else if (action.action === 'remove') {
      if (action.itemId === undefined) {
        appliedMutations.push({
          action: 'remove',
          issueNumber: action.issueNumber,
          itemId: null,
          ok: false,
          detail: `plan action for issue #${String(action.issueNumber)} has no itemId; skipped`,
        });
        continue;
      }
      try {
        await port.removeItem(action.itemId);
        appliedMutations.push({
          action: 'remove',
          issueNumber: action.issueNumber,
          itemId: action.itemId,
          ok: true,
          detail: action.reason,
        });
      } catch (cause) {
        appliedMutations.push({
          action: 'remove',
          issueNumber: action.issueNumber,
          itemId: action.itemId,
          ok: false,
          detail: `removeItem failed for item ${action.itemId}: ${errorMessage(cause)}`,
        });
      }
    }
  }

  let afterItems: ProjectItemRecord[];
  let verification: VerificationResult;
  let error: string | null = null;
  try {
    afterItems = await port.refetchProjectItems();
    const residualFindings = auditState(issues, afterItems, classifications);
    const residualPlan = buildPlan(classifications, afterItems).filter((action) =>
      MUTATING_ACTIONS.has(action.action),
    );
    const converged = residualPlan.length === 0;
    verification = {
      performed: true,
      status: converged ? 'converged' : 'drift',
      residualFindings,
      residualPlan,
      detail: converged
        ? 'refetched project items match the desired membership'
        : `${String(residualPlan.length)} mutation(s) still required after apply`,
    };
  } catch (cause) {
    afterItems = [];
    verification = {
      performed: true,
      status: 'unavailable',
      residualFindings: [],
      residualPlan: [],
      detail: `verification failed: refetchProjectItems errored after retries (${errorMessage(cause)})`,
    };
    error = 'verification could not refetch the project items after apply';
  }

  const status: ReconciliationStatus =
    error !== null ? 'failed' : verification.status === 'converged' ? 'clean' : 'drift';

  return {
    status,
    mode: 'apply',
    generatedAt: now().toISOString(),
    counts: buildCounts(issues, classifications, findings, plan, beforeItems, appliedMutations),
    findings,
    plan,
    idempotency,
    appliedMutations,
    verification,
    beforeItems,
    afterItems,
    error,
  };
}
