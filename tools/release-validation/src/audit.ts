import type { BaselineIdentity, CandidateIdentity } from './contract.ts';
import type { ValidationOutcome } from './runner.ts';

/**
 * Evidence chạy baseline validation theo mẫu per-run evidence JSON của
 * #368 (`platform-deploy` staging executor, §7.4.1) và hợp đồng provenance
 * store §7.2 (#346): mỗi lần chạy sinh một bản evidence độc lập cho CI/lane
 * lưu lại như bằng chứng kiểm toán, append-only theo danh tính candidate.
 *
 * Evidence KHÔNG chứa secret: connection string không bao giờ vào evidence
 * (chỉ tên stage + kết quả), và mọi stderr nhúng vào `detail` đi qua
 * {@link maskSecrets} trước.
 */

/**
 * Mask password trong connection string (pattern harness `apps/*`):
 * `postgres://user:secret@host` → `postgres://user:****@host`. Mọi stderr
 * của psql/runner có thể lặp lại URL — mask trước khi vào evidence hay console.
 * Hạn chế đã biết: regex chỉ khớp password thuần, KHÔNG khớp password
 * URL-encoded (ví dụ `pass%40word`) — mask là best-effort defense-in-depth,
 * control chính là secret không bao giờ vào đường ra evidence.
 */
export function maskSecrets(text: string): string {
  return text.replace(/:[^:@/]+@/gu, ':****@');
}

export interface ValidationEvidence {
  /** Định danh lần chạy — caller cấp (timestamp/CI run id). */
  readonly runId: string;
  readonly mechanism: 'pg-baseline';
  readonly database: string;
  readonly status: ValidationOutcome['status'];
  readonly finishedAt: string;
  /**
   * `true` khi release đầu tiên của database này — validation rơi về
   * fresh-install path (apply toàn bộ journal lên database trống, cập nhật
   * #379 2026-11-19); `baseline` là `null` đúng khi trường này là `true`.
   */
  readonly firstRelease: boolean;
  /** Danh tính candidate exact (SHA + version) — không bao giờ thiếu. */
  readonly candidate: CandidateIdentity;
  /** Baseline identity versioned per database; `null` ở fresh-install path. */
  readonly baseline: BaselineIdentity | null;
  readonly stages: ValidationOutcome['stages'];
  /** Số entry history sau candidate migration — `null` khi stage không chạy. */
  readonly historyAfter: number | null;
}

/** Gắn kết quả orchestration thành evidence record — không mutate gì, chỉ shape. */
export function buildValidationEvidence(
  runId: string,
  plan: {
    readonly database: string;
    readonly candidate: CandidateIdentity;
    readonly baseline: BaselineIdentity | null;
  },
  outcome: ValidationOutcome,
): ValidationEvidence {
  return {
    runId,
    mechanism: 'pg-baseline',
    database: plan.database,
    status: outcome.status,
    firstRelease: outcome.firstRelease,
    finishedAt: new Date().toISOString(),
    candidate: plan.candidate,
    baseline: plan.baseline,
    stages: outcome.stages,
    historyAfter: outcome.historyAfter,
  };
}
