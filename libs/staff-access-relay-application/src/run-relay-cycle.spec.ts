/**
 * Specs của use case `runRelayCycle` — fakes in-memory, không dependency thật.
 *
 * Ghim các hành vi cốt lõi của relay (issue #449):
 *   - no-op thuần khi không claim được row nào (không `send()` nào);
 *   - publish thành công → `markPublished`, kết quả đếm đúng;
 *   - retry trong run với backoff exponential có cap, rồi thành công;
 *   - hết lượt thử → `recordFailure` (attempts KHÔNG tăng thêm ở đây — đã tăng
 *     ở claim), đạt trần `maxAttempts` là DLQ;
 *   - idempotency key của `send()` là `event_id` của outbox row — consumer
 *     dedupe theo key này (FR của account_outbox_events, áp dụng nguyên văn);
 *   - một hàng payload hỏng không chặn các hàng khác trong batch.
 */

import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  runRelayCycle,
  type OutboxRepository,
  type OutboxRow,
  type QueuePublisher,
  type RelayCycleDeps,
} from './index';

/** Fake outbox in-memory — khớp contract `claimPending` tăng attempts tại claim. */
class FakeOutbox implements OutboxRepository {
  private rows: OutboxRow[];

  constructor(rows: OutboxRow[]) {
    this.rows = rows.map((r) => ({ ...r }));
  }

  async claimPending(input: { limit: number; maxAttempts: number }): Promise<readonly OutboxRow[]> {
    const claimable = this.rows
      .filter((r) => r.published_at === null && r.attempts < input.maxAttempts)
      .slice(0, input.limit);
    // Fencing: attempts tăng ngay tại claim (contract với infra thật).
    for (const row of claimable) {
      row.attempts += 1;
    }
    return claimable.map((r) => ({ ...r }));
  }

  async markPublished(input: { eventId: string }): Promise<boolean> {
    const row = this.rows.find((r) => r.event_id === input.eventId);
    if (row === undefined || row.published_at !== null) return false;
    this.rows[row ? this.rows.indexOf(row) : -1] = {
      ...row,
      published_at: new Date(input.nowMs ?? Date.now()).toISOString(),
    };
    return true;
  }

  async recordFailure(input: { eventId: string; lastError: string }): Promise<boolean> {
    const row = this.rows.find((r) => r.event_id === input.eventId);
    if (row === undefined) return false;
    this.rows[this.rows.indexOf(row)] = { ...row, last_error: input.lastError };
    return true;
  }

  async replay(eventId: string): Promise<boolean> {
    const row = this.rows.find((r) => r.event_id === eventId);
    if (row === undefined) return false;
    this.rows[this.rows.indexOf(row)] = {
      ...row,
      published_at: null,
      attempts: 0,
      last_error: null,
      settle_status: null,
    };
    return true;
  }

  async markSettled(input: { eventId: string }): Promise<boolean> {
    const row = this.rows.find((r) => r.event_id === input.eventId);
    if (row === undefined) return false;
    this.rows[this.rows.indexOf(row)] = { ...row, settle_status: 'applied' };
    return true;
  }

  /** Trạng thái hiện hành của một row (để assert). */
  snapshot(eventId: string): OutboxRow | undefined {
    return this.rows.find((r) => r.event_id === eventId);
  }
}

/** Fake queue ghi lại mọi lần gọi send. */
class FakeQueue implements QueuePublisher {
  readonly sent: Array<{ message: unknown; idempotencyKey: string }> = [];
  /** Số lần send phải throw trước khi thành công, theo idempotency key. */
  readonly failFirstN = new Map<string, number>();

  async send(message: unknown, idempotencyKey: string): Promise<void> {
    const pending = this.failFirstN.get(idempotencyKey) ?? 0;
    if (pending > 0) {
      this.failFirstN.set(idempotencyKey, pending - 1);
      throw new Error('queue_send_failed');
    }
    this.sent.push({ message, idempotencyKey });
  }
}

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    aggregate_type: 'entitlement',
    aggregate_id: 'staff_1/backoffice',
    event_type: 'entitlement.granted',
    payload: JSON.stringify({
      event_id: '11111111-1111-4111-8111-111111111111',
      type: 'entitlement.granted',
      staff_id: 'staff_1',
      product: 'backoffice',
      revision: 3,
      occurred_at: '2026-10-30T00:00:00Z',
      producer: 'staff-access',
    }),
    occurred_at: '2026-10-30T00:00:00Z',
    published_at: null,
    settle_status: null,
    attempts: 0,
    last_error: null,
    ...overrides,
  };
}

function makeDeps(
  outbox: OutboxRepository,
  queue: QueuePublisher,
  overrides: Partial<RelayCycleDeps> = {},
): RelayCycleDeps {
  return {
    outbox,
    queue,
    maxAttempts: 3,
    batchSize: 10,
    backoffBaseMs: 1,
    backoffCapMs: 5,
    maxInRunRetries: 2,
    sleep: async () => undefined,
    eventDeadlinesMs: { high: Number.MAX_SAFE_INTEGER, normal: Number.MAX_SAFE_INTEGER },
    ...overrides,
  };
}

describe('runRelayCycle', () => {
  it('is a pure no-op when no pending rows exist', async () => {
    const outbox = new FakeOutbox([]);
    const queue = new FakeQueue();
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      dlq: 0,
      retried: 0,
      deadlineExceeded: 0,
      deadlineExceededByClass: { high: 0, normal: 0 },
    });
    expect(queue.sent).toHaveLength(0);
  });

  it('publishes a claimed row and marks it published', async () => {
    const outbox = new FakeOutbox([makeRow()]);
    const queue = new FakeQueue();
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dlq).toBe(0);
    expect(queue.sent).toHaveLength(1);
    const snapshot = outbox.snapshot('11111111-1111-4111-8111-111111111111');
    expect(snapshot?.published_at).not.toBeNull();
  });

  it('reports class-specific deadline breaches without blocking publication', async () => {
    const row = makeRow({
      event_type: 'entitlement.revoked',
      occurred_at: '2026-10-30T00:00:00Z',
      payload: JSON.stringify({
        event_id: '11111111-1111-4111-8111-111111111111',
        type: 'entitlement.revoked',
        staff_id: 'staff_1',
        product: 'backoffice',
        revision: 3,
        occurred_at: '2026-10-30T00:00:00Z',
        producer: 'staff-access',
      }),
    });
    const outbox = new FakeOutbox([row]);
    const queue = new FakeQueue();
    const result = await runRelayCycle(
      makeDeps(outbox, queue, { eventDeadlinesMs: { high: 5_000, normal: 60_000 } }),
      Date.parse('2026-10-30T00:00:06Z'),
    );
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deadlineExceededByClass).toEqual({ high: 1, normal: 0 });
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.idempotencyKey).toBe(row.event_id);
    expect(outbox.snapshot(row.event_id)?.published_at).not.toBeNull();
    expect(outbox.snapshot(row.event_id)?.last_error).toBe('delivery_deadline_exceeded');
  });

  it('uses event_id as the queue idempotency key', async () => {
    // Idempotency key = event_id của outbox row — consumer dedupe theo key này.
    const outbox = new FakeOutbox([makeRow()]);
    const queue = new FakeQueue();
    await runRelayCycle(makeDeps(outbox, queue));
    expect(queue.sent[0]?.idempotencyKey).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('sends the parsed envelope, not the raw JSON string', async () => {
    const outbox = new FakeOutbox([makeRow()]);
    const queue = new FakeQueue();
    await runRelayCycle(makeDeps(outbox, queue));
    const message = queue.sent[0]?.message as { producer?: string; revision?: number };
    expect(message.producer).toBe('staff-access');
    expect(message.revision).toBe(3);
  });

  it('retries within the run and succeeds on a later attempt', async () => {
    const row = makeRow();
    const outbox = new FakeOutbox([row]);
    const queue = new FakeQueue();
    queue.failFirstN.set(row.event_id, 1); // lần 1 throw, lần 2 thành công
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result.published).toBe(1);
    expect(result.retried).toBe(1);
    expect(queue.sent).toHaveLength(1);
  });

  it('records failure and reports DLQ when attempts reach maxAttempts', async () => {
    // attempts=2 pre-claim → post-claim 3 = maxAttempts → claim được lần cuối,
    // thất bại hết retry là DLQ (không claim lại nữa).
    const row = makeRow({ attempts: 2 });
    const outbox = new FakeOutbox([row]);
    const queue = new FakeQueue();
    queue.failFirstN.set(row.event_id, 99); // mọi lần đều throw
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result.claimed).toBe(1);
    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.dlq).toBe(1);
    const snapshot = outbox.snapshot(row.event_id);
    expect(snapshot?.last_error).toBe('publish_failed');
    expect(snapshot?.published_at).toBeNull();
  });

  it('records failure without DLQ when attempts are still below the cap', async () => {
    // attempts=0 pre-claim → post-claim 1 < 3 → failed nhưng còn claim lại được.
    const row = makeRow();
    const outbox = new FakeOutbox([row]);
    const queue = new FakeQueue();
    queue.failFirstN.set(row.event_id, 99);
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result.failed).toBe(1);
    expect(result.dlq).toBe(0);
  });

  it('counts a row as DLQ without sending when payload is invalid JSON', async () => {
    // Payload hỏng là dữ liệu hỏng, không phải lỗi Queue: không send nào chạy,
    // row ghi invalid_payload và — với attempts đạt trần — vào DLQ.
    const row = makeRow({ attempts: 2, payload: '{not-json' });
    const outbox = new FakeOutbox([row]);
    const queue = new FakeQueue();
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(queue.sent).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(result.dlq).toBe(1);
    expect(outbox.snapshot(row.event_id)?.last_error).toBe('invalid_payload');
  });

  it('does not let one bad row block the rest of the batch', async () => {
    const good = makeRow({ event_id: '22222222-2222-4222-8222-222222222222' });
    const bad = makeRow({ event_id: '33333333-3333-4333-8333-333333333333', payload: 'nope' });
    const outbox = new FakeOutbox([bad, good]);
    const queue = new FakeQueue();
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result.claimed).toBe(2);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.idempotencyKey).toBe(good.event_id);
  });

  it('excludes already-published and max-attempt rows from claiming', async () => {
    const publishedRow = makeRow({
      event_id: '44444444-4444-4444-8444-444444444444',
      published_at: '2026-10-30T01:00:00Z',
    });
    const exhaustedRow = makeRow({ event_id: '55555555-5555-4555-8555-555555555555', attempts: 3 });
    const freshRow = makeRow({ event_id: '66666666-6666-4666-8666-666666666666' });
    const outbox = new FakeOutbox([publishedRow, exhaustedRow, freshRow]);
    const queue = new FakeQueue();
    const result = await runRelayCycle(makeDeps(outbox, queue));
    expect(result.claimed).toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.idempotencyKey).toBe(freshRow.event_id);
  });
});

describe('backoffDelayMs', () => {
  it('doubles exponentially from the base', () => {
    expect(backoffDelayMs(1, 10, 1000)).toBe(10);
    expect(backoffDelayMs(2, 10, 1000)).toBe(20);
    expect(backoffDelayMs(3, 10, 1000)).toBe(40);
  });

  it('caps at the configured ceiling', () => {
    expect(backoffDelayMs(10, 10, 50)).toBe(50);
  });

  it('treats a non-positive attempt as the first attempt', () => {
    expect(backoffDelayMs(0, 10, 1000)).toBe(10);
  });
});
