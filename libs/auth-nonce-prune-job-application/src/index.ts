/**
 * Application lib của `auth-nonce-prune-job` — thuật toán prune nonce hết hạn.
 *
 * Pure orchestration + policy: mọi I/O database đi qua port `QueryPool` (shape subset
 * của `pg.Pool`), mọi chờ đợi đi qua `Sleep` — composition root
 * (`apps/auth-nonce-prune-job/src/main.ts`) dựng pool `pg` từ Hyperdrive binding rồi
 * tiêm vào đây, không có adapter nào cần tách riêng.
 */

// ── Trần thuật toán — hằng số tập trung, KHÔNG override qua env ─────────────────────

export {
  BATCH_SIZE,
  CONNECT_TIMEOUT_SECONDS,
  LOCK_TIMEOUT_SECONDS,
  MAX_ATTEMPTS,
  MAX_BATCHES,
  MAX_SECONDS,
  STATEMENT_TIMEOUT_SECONDS,
  retryBackoffSeconds,
} from './prune-caps';

// ── Thuật toán prune — port TypeScript của PRUNE_SCRIPT, giữ nguyên toàn bộ biên ────

export {
  UnexpectedOutputError,
  defaultSleep,
  oneTargetExpected,
  pruneTarget,
  type PruneOutcome,
  type PruneRunResult,
  type PruneTarget,
  type PruneTargetRun,
  type QueryPool,
  type Sleep,
} from './prune';
