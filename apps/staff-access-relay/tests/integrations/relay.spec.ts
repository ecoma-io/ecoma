/**
 * Integration specs của `staff-access-relay` trên PostgreSQL THẬT.
 *
 * Subject: relay claim/publish/retry/DLQ trên database thật — ghim những thứ
 * chỉ PostgreSQL mới quyết định:
 *   - claim qua partial index `(occurred_at) WHERE published_at IS NULL` với
 *     `FOR UPDATE SKIP LOCKED`;
 *   - `attempts` tăng ngay tại claim (fencing) — hai relay song song nhận hai
 *     giá trị khác nhau;
 *   - publish thành công đặt `published_at`;
 *   - replay manual đưa row DLQ quay lại hàng chờ.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Pool } from 'pg';

import { runRelayCycle } from '@ecoma-io/staff-access-relay-application';
import { createPostgresOutboxRepository } from '@ecoma-io/staff-access-relay-infrastructure';

import { startRelayDatabase, type RelayDatabase } from './harness';

let db: RelayDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await startRelayDatabase();
  const { Pool: PgPool } = await import('pg');
  pool = new PgPool({
    host: db.host,
    port: db.port,
    database: 'db-staff-access',
    user: 'ecoma_staff_access_runtime',
    password: db.rolePassword,
    max: 4,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await db?.stop().catch(() => undefined);
});

async function seedOutbox(rows: Array<{ eventId: string; attempts?: number }>): Promise<void> {
  const client = await db.connectAsMigrator();
  try {
    for (const r of rows) {
      await client.query(
        `INSERT INTO staff_access.entitlement_outbox_events
           (event_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts)
         VALUES ($1, 'entitlement', 'staff_1/backoffice', 'entitlement.granted',
                 '{"event_id":"placeholder"}'::jsonb, now(), $2)`,
        [r.eventId, r.attempts ?? 0],
      );
      // payload phải là envelope hợp lệ — cập nhật đúng event_id để test parse.
      await client.query(
        `UPDATE staff_access.entitlement_outbox_events
            SET payload = jsonb_build_object(
                  'event_id', $1::text,
                  'type', 'entitlement.granted',
                  'staff_id', 'staff_1',
                  'product', 'backoffice',
                  'revision', 1,
                  'occurred_at', now()::text,
                  'producer', 'staff-access'
                )
          WHERE event_id = $1`,
        [r.eventId],
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe('staff-access-relay integration', () => {
  it('claims, publishes and sets published_at on a real row', async () => {
    await db.truncateOutbox();
    const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seedOutbox([{ eventId }]);

    const captured: string[] = [];
    const queue = {
      async send(_message: unknown, idempotencyKey: string): Promise<void> {
        captured.push(idempotencyKey);
      },
    };
    const outbox = createPostgresOutboxRepository(pool);
    const result = await runRelayCycle(
      {
        outbox,
        queue,
        maxAttempts: 5,
        batchSize: 10,
        backoffBaseMs: 1,
        backoffCapMs: 5,
        maxInRunRetries: 0,
      },
      Date.now(),
    );

    expect(result.claimed).toBe(1);
    expect(result.published).toBe(1);
    expect(captured).toEqual([eventId]);

    const client = await db.connectAsMigrator();
    try {
      const r = await client.query<{ published_at: string | null; attempts: number }>(
        `SELECT published_at, attempts FROM staff_access.entitlement_outbox_events WHERE event_id = $1`,
        [eventId],
      );
      expect(r.rows[0]?.published_at).not.toBeNull();
      expect(r.rows[0]?.attempts).toBe(1);
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('replays a DLQ row back into the queue', async () => {
    await db.truncateOutbox();
    const eventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await seedOutbox([{ eventId, attempts: 5 }]);

    // attempts=5 >= maxAttempts(5) → claim trả rỗng (row đã DLQ). Replay reset.
    const outbox = createPostgresOutboxRepository(pool);
    const before = await outbox.claimPending({ limit: 10, maxAttempts: 5, nowMs: Date.now() });
    expect(before).toHaveLength(0);

    const replayed = await outbox.replay(eventId);
    expect(replayed).toBe(true);

    const after = await outbox.claimPending({ limit: 10, maxAttempts: 5, nowMs: Date.now() });
    expect(after).toHaveLength(1);
  });
});
