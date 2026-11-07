/**
 * `reconcile` — so sánh request-level usage với tổng attempt-level usage và
 * settlement; trả về `match` / `mismatch` / `incomplete`.
 *
 * Domain KHÔNG sở hữu settlement, KHÔNG overwrite dữ liệu, KHÔNG alert (alerting
 * thuộc application/infrastructure). `settlement` là tham số so sánh thuần.
 *
 * U-4 (ngưỡng so sánh / tolerance) vẫn mở; hàm này so sánh exact (không sai số
 * nào được phép), và trả `incomplete` khi thiếu dữ liệu để so sánh.
 *
 * Nguồn: `docs/domains/llm-usage/domain-model.md` §7.
 */

import type { NormalizedUsage, ReconciliationResult, RequestUsage } from './types';
import { computeTotalTokens } from './normalized-usage';

/**
 * So sánh request-level usage với tổng attempt-level và settlement.
 *
 * @returns `ReconciliationResult`:
 *   - `match`: request-level == tổng attempt-level (và == settlement nếu có).
 *   - `mismatch`: khác nhau (exact).
 *   - `incomplete`: không đủ dữ liệu để khẳng định.
 */
export function reconcile({
  requestUsage,
  attemptUsages,
  settlement,
}: {
  requestUsage: RequestUsage;
  attemptUsages: readonly NormalizedUsage[];
  settlement: NormalizedUsage | null;
}): ReconciliationResult {
  const requestTotal =
    requestUsage.aggregated === null ? null : computeTotalTokens(requestUsage.aggregated);

  // Tổng attempt-level: sum của các attempt; null nếu không có attempt nào.
  let attemptTotal: number | null = null;
  if (attemptUsages.length > 0) {
    const sums = attemptUsages.map((u) => computeTotalTokens(u));
    if (sums.every((t) => t !== null)) {
      attemptTotal = sums.reduce((acc, t) => acc + (t ?? 0), 0);
    } else {
      attemptTotal = null;
    }
  }

  const settlementTotal = settlement === null ? null : computeTotalTokens(settlement);

  // Không đủ dữ liệu để so sánh → incomplete (KHÔNG khẳng định mismatch).
  if (requestTotal === null && attemptTotal === null && settlementTotal === null) {
    return {
      outcome: 'incomplete',
      detail: 'Insufficient usage data to compare reconciliation',
    };
  }

  // So sánh theo cặp: chỉ cặp nào cả hai bên có dữ liệu thì mới so sánh.
  const comparablePairs: Array<{ a: number | null; b: number | null; label: string }> = [
    { a: requestTotal, b: attemptTotal, label: 'request vs attempt' },
    { a: requestTotal, b: settlementTotal, label: 'request vs settlement' },
    { a: attemptTotal, b: settlementTotal, label: 'attempt vs settlement' },
  ].filter((p) => p.a !== null && p.b !== null);

  // Không có cặp nào đủ dữ liệu để so sánh → incomplete.
  if (comparablePairs.length === 0) {
    return {
      outcome: 'incomplete',
      detail: 'Insufficient usage data to compare reconciliation',
    };
  }

  // Bất kỳ cặp so sánh nào khác nhau → mismatch (exact).
  for (const pair of comparablePairs) {
    if (pair.a !== pair.b) {
      return {
        outcome: 'mismatch',
        detail: `Request-level usage differs from attempt-level total or settlement`,
      };
    }
  }

  // Tất cả cặp có thể so sánh đều bằng nhau → match.
  return {
    outcome: 'match',
    detail: 'Request-level usage matches attempt-level total and settlement',
  };
}
