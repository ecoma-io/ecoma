import type { RunResult } from './runner.ts';

/**
 * Evidence chạy bootstrap theo mẫu per-run evidence JSON của #368
 * (`platform-deploy` staging executor, §7.4.1): mỗi lần chạy sinh một bản
 * evidence độc lập để CI/workflow lưu lại như bằng chứng kiểm toán. Evidence
 * KHÔNG chứa secret: giá trị xuyên bước (sub/tenant_id) đi qua env của
 * subprocess và không bao giờ được ghi vào evidence.
 */

export interface StepAuditEntry {
  readonly id: string;
  readonly service: string;
  readonly database: string;
  /** `null` khi bước bị skip (chưa chạy tới) — không phải mã thoát thật. */
  readonly exit: number | null;
  readonly durationMs: number;
  readonly skipped: boolean;
}

export interface RunEvidence {
  /** Định danh lần chạy — caller cấp (timestamp/CI run id). */
  readonly runId: string;
  readonly environment: string;
  readonly status: RunResult['status'];
  readonly finishedAt: string;
  readonly steps: readonly StepAuditEntry[];
  /** Blocker fail-closed tại thời điểm chạy — bằng chứng vì sao không chạy. */
  readonly blockers: readonly string[];
}

export function buildRunEvidence(
  runId: string,
  environment: string,
  result: RunResult,
  blockers: readonly string[],
): RunEvidence {
  return {
    runId,
    environment,
    status: result.status,
    finishedAt: new Date().toISOString(),
    steps: result.steps,
    blockers,
  };
}
