import type { OutboxRow } from './records';

export interface ClaimPendingInput {
  readonly limit: number;
  readonly maxAttempts: number;
  readonly nowMs: number;
}

export interface MarkPublishedInput {
  readonly eventId: string;
  readonly nowMs: number;
}

export interface RecordFailureInput {
  readonly eventId: string;
  readonly lastError: string;
  readonly nowMs: number;
}

export interface MarkSettledInput {
  readonly eventId: string;
  readonly revision: number;
  readonly appliedAtMs: number;
}

export interface OutboxRepository {
  /** Claim một lô row chưa publish, tăng `attempts` như fencing token. */
  claimPending(input: ClaimPendingInput): Promise<readonly OutboxRow[]>;
  /** Đánh dấu đã publish; trả true nếu row còn pending và được đóng. */
  markPublished(input: MarkPublishedInput): Promise<boolean>;
  /** Ghi lỗi; trả true nếu row còn tồn tại. */
  recordFailure(input: RecordFailureInput): Promise<boolean>;
  /** Replay một event: reset published_at, attempts, last_error. */
  replay(eventId: string): Promise<boolean>;
  /**
   * Settlement reconciler pass: mark an outbox row `settle_status = 'applied'`
   * from a consumer receipt. Returns true if the row existed and was updated.
   * Only the settlement reconciler (never the publish path) writes this column.
   */
  markSettled(input: MarkSettledInput): Promise<boolean>;
}
