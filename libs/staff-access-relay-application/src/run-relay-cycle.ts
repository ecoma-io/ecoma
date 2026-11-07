import type { OutboxRepository } from './outbox-repository';
import type { OutboxRow } from './records';
import type { QueuePublisher } from './queue-publisher';

export type RelayEventClass = 'high' | 'normal';

export const RELAY_EVENT_DEADLINES_MS: Readonly<Record<RelayEventClass, number>> = {
  high: 5_000,
  normal: 60_000,
};

export type EventClassForRow = (row: OutboxRow, envelope: unknown) => RelayEventClass;

/**
 * Deps của một lượt relay — mọi ngưỡng vận hành là tham số truyền vào, không
 * phải hằng số module scope (cùng lý lẽ với `PublishOutboxBatchConfig` của
 * transactional-mail): đổi ngưỡng là đổi config, không phải đổi thuật toán.
 */
export interface RelayCycleDeps {
  readonly outbox: OutboxRepository;
  readonly queue: QueuePublisher;
  /** Clock injection cho test — production dùng `Date.now()`. */
  readonly clock?: { now(): number };
  /**
   * Trần attempts của một row — claim `attempts` đã vượt ngưỡng này là DLQ
   * (không được claim lại; repository filter `attempts < maxAttempts`).
   */
  readonly maxAttempts: number;
  /** Số row tối đa một lượt claim. */
  readonly batchSize: number;
  /** Backoff exponential base giữa hai lần thử trong cùng run. */
  readonly backoffBaseMs: number;
  /** Cap backoff — không sleep vô hạn trong một invocation cron. */
  readonly backoffCapMs: number;
  /** Số lần retry trong cùng run sau lần thử đầu (tổng lần thử = 1 + maxInRunRetries). */
  readonly maxInRunRetries: number;
  /** Sleep injection for tests; production uses setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Resolves the deadline class without changing the frozen event envelope. */
  readonly eventClassForRow?: EventClassForRow;
  /** Deadline override for tests; production uses RELAY_EVENT_DEADLINES_MS. */
  readonly eventDeadlinesMs?: Readonly<Record<RelayEventClass, number>>;
}

/** Kết quả một lượt relay — đủ để log một dòng JSON từ composition root. */
export interface RelayCycleResult {
  readonly claimed: number;
  readonly published: number;
  /** Row hết lượt thử trong run mà chưa publish (sẽ được claim lại nếu còn attempts). */
  readonly failed: number;
  /** Row đạt trần attempts — KHÔNG còn được claim, chờ replay manual. */
  readonly dlq: number;
  readonly retried: number;
  /** Published rows whose producer-to-relay age already exceeded their class deadline. */
  readonly deadlineExceeded: number;
  readonly deadlineExceededByClass: Readonly<Record<RelayEventClass, number>>;
}

/**
 * Backoff exponential có cap — `attempt` bắt đầu từ 1 (lần retry thứ nhất).
 * Dùng cho retry trong cùng một run; backoff giữa hai *run* là việc của cron
 * nhịp, không phải của hàm này.
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, capMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Một lượt relay: claim batch → publish từng row (retry trong run) → ghi kết quả.
 *
 * ⚠️ **Contract với repository: `claimPending` tăng `attempts` NGAY TẠI CLAIM**
 * (fencing token — hai relay chạy song song nhận hai giá trị `attempts` khác
 * nhau trên cùng row, không double-publish lặng lẽ). `row.attempts` trong batch
 * trả về là giá trị POST-claim, nên:
 *   - publish thành công → `markPublished` đặt `published_at` (attempts giữ nguyên);
 *   - thất bại hết lượt thử trong run → `recordFailure` chỉ đặt `last_error`
 *     (không tăng lại attempts — đã tăng ở claim);
 *   - `row.attempts >= maxAttempts` → DLQ: repository filter
 *     `attempts < maxAttempts` không claim lại row này — replay manual là
 *     đường duy nhất đưa nó quay lại.
 *
 * ⚠️ Payload được **parse lại từ chuỗi đã commit** — chuỗi JSON là nguồn sự
 * thật; một hàng payload hỏng là `failed` với token `invalid_payload`, không
 * làm chết lượt của các row khác trong batch.
 */
export async function runRelayCycle(
  deps: RelayCycleDeps,
  nowMsOverride?: number,
): Promise<RelayCycleResult> {
  const nowMs = nowMsOverride ?? deps.clock?.now() ?? Date.now();
  const sleep = deps.sleep ?? defaultSleep;

  const eventClassForRow = deps.eventClassForRow ?? defaultEventClassForRow;
  const deadlines = deps.eventDeadlinesMs ?? RELAY_EVENT_DEADLINES_MS;

  const emptyResult = {
    claimed: 0,
    published: 0,
    failed: 0,
    dlq: 0,
    retried: 0,
    deadlineExceeded: 0,
    deadlineExceededByClass: { high: 0, normal: 0 },
  } as const;

  const claimed = await deps.outbox.claimPending({
    limit: deps.batchSize,
    maxAttempts: deps.maxAttempts,
    nowMs,
  });

  // No-op thuần khi không claim được gì — không network call nào phía dưới.
  if (claimed.length === 0) {
    return emptyResult;
  }

  let published = 0;
  let failed = 0;
  let dlq = 0;
  let retried = 0;
  let deadlineExceeded = 0;
  const deadlineExceededByClass: Record<RelayEventClass, number> = { high: 0, normal: 0 };

  // Tuần tự, không Promise.all — cùng lý lẽ với outbox-publisher của
  // transactional-mail: N lần Queue.send() song song trong một invocation là
  // thứ retry/backoff của Queue không thể kiểm soát từ đây, và batch size nhỏ
  // nên chi phí tuần tự không phải ràng buộc thực tế.
  for (const row of claimed) {
    const envelope = parseEnvelope(row);
    if (envelope === null) {
      // Dữ liệu hỏng, không phải lỗi Queue: không send, ghi token riêng.
      // attempts vẫn đã tăng ở claim nên row không claim lại vô tận —
      // đạt trần là DLQ, chờ sửa dữ liệu + replay.
      await deps.outbox.recordFailure({
        eventId: row.event_id,
        lastError: 'invalid_payload',
        nowMs,
      });
      failed += 1;
      if (row.attempts >= deps.maxAttempts) {
        dlq += 1;
      }
      continue;
    }

    const eventClass = eventClassForRow(row, envelope);
    const occurredAtMs = Date.parse(row.occurred_at);
    if (!Number.isFinite(occurredAtMs) || nowMs - occurredAtMs > deadlines[eventClass]) {
      deadlineExceeded += 1;
      deadlineExceededByClass[eventClass] += 1;
      await deps.outbox.recordFailure({
        eventId: row.event_id,
        lastError: 'delivery_deadline_exceeded',
        nowMs,
      });
      if (eventClass !== 'high') {
        failed += 1;
        if (row.attempts >= deps.maxAttempts) {
          dlq += 1;
        }
        continue;
      }
    }

    let succeeded = false;
    for (let tryIndex = 0; tryIndex <= deps.maxInRunRetries; tryIndex++) {
      if (tryIndex > 0) {
        retried += 1;
        await sleep(backoffDelayMs(tryIndex, deps.backoffBaseMs, deps.backoffCapMs));
      }
      try {
        await deps.queue.send(envelope, row.event_id);
        succeeded = true;
        break;
      } catch {
        // retry nếu còn lượt — lỗi cụ thể không log ở application layer:
        // composition root log tổng kết một dòng, chi tiết lỗi là việc của
        // transport (đúng pattern sanitize của mailer).
      }
    }

    if (succeeded) {
      const ok = await deps.outbox.markPublished({ eventId: row.event_id, nowMs });
      if (ok) {
        published += 1;
      } else {
        // Send thành công nhưng markPublished trả false (row đã bị replay
        // giữa chừng chẳng hạn): message đã vào Queue — duplicate chấp nhận
        // được (at-least-once, ưu tiên duplicate hơn mất message), nhưng lượt
        // này không tính published.
        failed += 1;
      }
      continue;
    }

    await deps.outbox.recordFailure({ eventId: row.event_id, lastError: 'publish_failed', nowMs });
    failed += 1;
    if (row.attempts >= deps.maxAttempts) {
      dlq += 1;
    }
  }

  return {
    claimed: claimed.length,
    published,
    failed,
    dlq,
    retried,
    deadlineExceeded,
    deadlineExceededByClass,
  };
}

function defaultEventClassForRow(row: OutboxRow): RelayEventClass {
  // The frozen envelope has no transport/risk field. Revocations are the
  // high-risk class; grants use the normal class until the contract evolves.
  return row.event_type === 'entitlement.revoked' ? 'high' : 'normal';
}

/**
 * Parse `payload` thành envelope object, hoặc `null` nếu chuỗi JSON hỏng.
 * Trả `null` thay vì ném: một hàng hỏng không được chặn lượt của các hàng tốt.
 */
function parseEnvelope(row: OutboxRow): unknown | null {
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    return null;
  }
}

export type { OutboxRow };
