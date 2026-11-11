/**
 * Render Report ra văn bản cho người đọc (stdout) và JSON để lưu artifact.
 * Toàn bộ output runtime là tiếng Anh theo language policy của repository.
 */

import type { ReconciliationReport } from './reconcile.js';

function findingLine(finding: ReconciliationReport['findings'][number]): string {
  const issue = finding.issueNumber === undefined ? '' : ` #${String(finding.issueNumber)}`;
  return `  [${finding.severity}] ${finding.code}${issue}: ${finding.detail}`;
}

function planLine(action: ReconciliationReport['plan'][number]): string {
  const item = action.itemId === undefined ? '' : ` ${action.itemId}`;
  return `  ${action.action}${item} #${String(action.issueNumber)}: ${action.reason}`;
}

function mutationLine(mutation: ReconciliationReport['appliedMutations'][number]): string {
  const outcome = mutation.ok ? 'ok' : 'FAILED';
  const item = mutation.itemId === null ? '<unavailable>' : mutation.itemId;
  return `  ${outcome} ${mutation.action} #${String(mutation.issueNumber ?? -1)} -> ${item}: ${mutation.detail}`;
}

/** Render report thành văn bản nhiều dòng, đọc được trực tiếp trên stdout. */
export function renderReportText(report: ReconciliationReport): string {
  const lines: string[] = [
    'Project membership reconciliation report',
    `mode: ${report.mode}`,
    `status: ${report.status}`,
    `generatedAt: ${report.generatedAt}`,
  ];
  if (report.error !== null) {
    lines.push(`error: ${report.error}`);
  }
  const counts = report.counts;
  lines.push(
    `counts: issues=${String(counts.issues)} desiredMembers=${String(counts.desiredMembers)} ` +
      `projectItemsBefore=${String(counts.projectItemsBefore)} findings=${String(counts.findings)} ` +
      `addsPlanned=${String(counts.addsPlanned)} removesPlanned=${String(counts.removesPlanned)} ` +
      `addsApplied=${String(counts.addsApplied)} removesApplied=${String(counts.removesApplied)}`,
  );
  const idempotency = report.idempotency;
  lines.push(
    idempotency === null
      ? 'idempotency: not evaluated'
      : `idempotency: ${idempotency.idempotent ? 'second pass plans no mutations' : `NOT idempotent (${String(idempotency.residualActions.length)} residual mutation(s))`}`,
  );

  lines.push(
    report.findings.length === 0
      ? 'findings: none'
      : `findings (${String(report.findings.length)}):`,
  );
  if (report.findings.length > 0) {
    for (const finding of report.findings) {
      lines.push(findingLine(finding));
    }
  }

  lines.push(
    report.plan.length === 0 ? 'plan: no actions' : `plan (${String(report.plan.length)}):`,
  );
  if (report.plan.length > 0) {
    for (const action of report.plan) {
      lines.push(planLine(action));
    }
  }

  if (report.mode === 'apply') {
    lines.push(
      report.appliedMutations.length === 0
        ? 'mutations applied: none'
        : `mutations applied (${String(report.appliedMutations.length)}):`,
    );
    for (const mutation of report.appliedMutations) {
      lines.push(mutationLine(mutation));
    }
  }

  const verification = report.verification;
  lines.push(
    `verification: ${verification.status} — ${verification.detail}` +
      (verification.residualPlan.length === 0
        ? ''
        : ` (residual actions: ${String(verification.residualPlan.length)})`),
  );
  if (verification.performed) {
    const outcomes = verification.attempts
      .map((attempt) => `#${String(attempt.index)}:${attempt.outcome}`)
      .join(' ');
    lines.push(
      `verification attempts: ${String(verification.attempts.length)}${outcomes === '' ? '' : ` (${outcomes})`}`,
    );
    lines.push(
      `verification polling: waited=${String(verification.waitedMs)}ms deadline=${String(verification.deadlineMs)}ms`,
    );
  }
  lines.push(
    `project items: before=${String(report.beforeItems.length)} after=${String(report.afterItems.length)}`,
  );
  return lines.join('\n');
}

/** Render report thành JSON (indent 2) để ghi artifact `--out`. */
export function renderReportJson(report: ReconciliationReport): string {
  return JSON.stringify(report, null, 2);
}
