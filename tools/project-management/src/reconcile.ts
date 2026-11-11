/**
 * Orchestrator của pipeline: discover → audit → plan → idempotency-check →
 * (apply → verify). Port là dependency được inject nên orchestrator test được
 * với fake, không chạm GitHub.
 *
 * Fail-closed: discovery một phần ⇒ status 'failed', không audit/apply gì nữa.
 * Verify không tin mutation thành công: sau apply luôn refetch snapshot item
 * và re-derive drift còn lại từ dữ liệu thật, với bounded polling chống độ trễ
 * truyền bá item của GitHub Projects (`verify.ts`).
 */

import { auditState, type AuditFinding } from './audit.js';
import { classifyIssues } from './classify.js';
import { computeIdempotencyCheck, type IdempotencyCheck } from './diff.js';
import { buildPlan, type PlanAction } from './plan.js';
import type { GitHubPort } from './github.js';
import {
  notApplicableResult,
  verifyAfterApply,
  type AppliedMutation,
  type VerificationResult,
  type VerifyPollingOptions,
} from './verify.js';
import type {
  NormalizedIssue,
  PolicyConfig,
  ProjectItemRecord,
  ReconciliationMode,
} from './types.js';

export type ReconciliationStatus = 'clean' | 'drift' | 'failed';

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
  /** Ghi đè cấu hình poll của bước verify (deadline, backoff, sleep, clock). */
  verify?: Partial<VerifyPollingOptions>;
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
  verify,
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
      verification: notApplicableResult('verification skipped because discovery failed'),
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
      verification: notApplicableResult('audit mode never mutates; nothing to verify'),
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

  // Verify bằng refetch có poll bounded (xem verify.ts): mutation thành công
  // không được tin mù quáng; residual giải thích được bằng mutation ok thì
  // chờ propagation, khác biệt thật thì báo drift ngay.
  const { verification, afterItems } = await verifyAfterApply({
    port,
    issues,
    classifications,
    appliedMutations,
    options: verify,
  });

  let error: string | null = null;
  if (verification.status === 'verification_failed') {
    error = 'verification could not refetch the project items after apply';
  } else if (verification.status === 'inventory_incomplete') {
    error = 'verification could not read a complete project item snapshot after apply';
  }

  const status: ReconciliationStatus =
    error !== null ? 'failed' : verification.status === 'clean' ? 'clean' : 'drift';

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
