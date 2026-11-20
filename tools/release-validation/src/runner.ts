import type { BaselineIdentity, CandidateIdentity } from './contract.ts';

/**
 * Stage machine của một lần baseline validation (§3a.6): target-install →
 * integrity → candidate-migration. Fail-closed: một stage fail thì mọi stage
 * sau được đánh dấu `skipped` và run dừng — không stage nào chạy "một phần"
 * ngầm. First-release (baseline `null`) thì integrity là `not-applicable`
 * và candidate migration áp lên database trống (fresh-install path, cập nhật
 * #379 2026-11-19).
 *
 * Pure orchestration: mọi side effect (restore, psql, spawn runner) nằm trong
 * `ValidationDeps` được inject — spec unit chạy với giả, không Docker.
 */

export type ValidationStage = 'target-install' | 'integrity' | 'candidate-migration';
export type StageStatus = 'passed' | 'failed' | 'skipped' | 'not-applicable';

export interface StageOutcome {
  readonly stage: ValidationStage;
  readonly status: StageStatus;
  /** Chi tiết kết quả — đã mask secret ở lớp caller (audit.maskSecrets). */
  readonly detail: string;
  /** Exit code của tiến trình con khi stage có spawn; `null` khi không có. */
  readonly exit: number | null;
  readonly durationMs: number;
}

export interface ValidationPlan {
  readonly database: string;
  readonly candidate: CandidateIdentity;
  /** `null` = first-release fresh-install path. */
  readonly baseline: BaselineIdentity | null;
}

export interface ValidationDeps {
  /**
   * Dựng target dùng-đi về state baseline: restore dump (kèm recreate
   * database) khi có baseline, hoặc tạo database trống cho fresh-install.
   * Contract: target là instance validation dùng-đi — mechanism DROP database
   * hợp đồng trên target này.
   */
  installTarget(
    database: string,
    baseline: BaselineIdentity | null,
  ): { readonly ok: boolean; readonly detail: string };
  /** Integrity check §3a.6: so state sau restore với fingerprint đã ghi. */
  verifyIntegrity(
    database: string,
    baseline: BaselineIdentity,
  ): { readonly ok: boolean; readonly detail: string };
  /** Apply candidate migrations từ baseline qua migration authority thật. */
  runCandidateMigration(database: string): {
    readonly exit: number;
    readonly detail: string;
    readonly historyAfter: number | null;
  };
}

export interface ValidationOutcome {
  readonly status: 'passed' | 'failed';
  readonly firstRelease: boolean;
  readonly stages: readonly StageOutcome[];
  readonly historyAfter: number | null;
}

/** Stage outcome cho một stage bị nhảy cóc — fail-closed, không chạy ngầm. */
const skip = (stage: ValidationStage): StageOutcome => ({
  stage,
  status: 'skipped',
  detail: 'not run — an earlier stage failed',
  exit: null,
  durationMs: 0,
});

export function runValidation(plan: ValidationPlan, deps: ValidationDeps): ValidationOutcome {
  const stages: StageOutcome[] = [];

  let startedAt = Date.now();
  const install = deps.installTarget(plan.database, plan.baseline);
  stages.push({
    stage: 'target-install',
    status: install.ok ? 'passed' : 'failed',
    detail: install.detail,
    exit: null,
    durationMs: Date.now() - startedAt,
  });
  if (!install.ok) {
    stages.push(skip('integrity'), skip('candidate-migration'));
    return { status: 'failed', firstRelease: plan.baseline === null, stages, historyAfter: null };
  }

  startedAt = Date.now();
  if (plan.baseline === null) {
    stages.push({
      stage: 'integrity',
      status: 'not-applicable',
      detail: 'first release: no baseline exists, candidate applies onto an empty database',
      exit: null,
      durationMs: Date.now() - startedAt,
    });
  } else {
    const integrity = deps.verifyIntegrity(plan.database, plan.baseline);
    stages.push({
      stage: 'integrity',
      status: integrity.ok ? 'passed' : 'failed',
      detail: integrity.detail,
      exit: null,
      durationMs: Date.now() - startedAt,
    });
    if (!integrity.ok) {
      stages.push(skip('candidate-migration'));
      return { status: 'failed', firstRelease: false, stages, historyAfter: null };
    }
  }

  startedAt = Date.now();
  const migration = deps.runCandidateMigration(plan.database);
  stages.push({
    stage: 'candidate-migration',
    status: migration.exit === 0 ? 'passed' : 'failed',
    detail: migration.detail,
    exit: migration.exit,
    durationMs: Date.now() - startedAt,
  });

  return {
    status: migration.exit === 0 ? 'passed' : 'failed',
    firstRelease: plan.baseline === null,
    stages,
    historyAfter: migration.historyAfter,
  };
}
