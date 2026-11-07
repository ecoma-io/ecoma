/**
 * Integration test cho audit hook — chạy trên PostgreSQL thật qua
 * `ecoma_backoffice_runtime` (đúng credential Worker): audit INSERT được qua
 * runtime role, CHECK secret-key của schema chặn context lạ, append-only
 * chặn UPDATE/DELETE, và failure propagate (I-08) lên caller trong pipeline
 * đầy đủ {@link recordDecision}.
 *
 * Bám harness của workstream A (`./harness.ts`) — không dựng runner thứ hai.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { type BackofficeDatabase, startBackofficeDatabase } from './harness';
import { recordDecision } from '@ecoma-io/backoffice-infrastructure';

const ACTOR = 'sub_' + 'a'.repeat(32);
const TARGET = 'sub_' + 'c'.repeat(32);
const DENIED_DECISION = {
  allowed: false,
  denial: 'permission_not_granted',
  stale: false,
  riskClass: 'normal',
} as const;

describe('authorization audit through the runtime role', () => {
  let db: BackofficeDatabase;
  let runtime: Client;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
    runtime = await db.asRuntime();
  }, 180_000);

  afterAll(async () => {
    await runtime?.end();
    await db?.stop();
  });

  it('SR-013: records a denial row with the seven fields through the runtime role', async () => {
    await recordDecision(runtime, {
      actorSub: ACTOR,
      targetSub: TARGET,
      permission: 'delivery.redrive',
      decision: DENIED_DECISION,
      requestId: 'req-it-1',
      correlationId: 'corr-it-1',
    });

    const { rows } = await runtime.query<{
      actor_sub: string;
      target_sub: string;
      action: string;
      outcome: string;
      reason_code: string;
      request_id: string;
      correlation_id: string;
      context: Record<string, unknown>;
    }>(
      `SELECT actor_sub, target_sub, action, outcome, reason_code, request_id,
              correlation_id, context
         FROM backoffice.authorization_audit WHERE actor_sub = $1`,
      [ACTOR],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.target_sub).toBe(TARGET);
    expect(row.action).toBe('delivery.redrive');
    expect(row.outcome).toBe('denied');
    expect(row.reason_code).toBe('normal:permission_not_granted');
    expect(row.request_id).toBe('req-it-1');
    expect(row.correlation_id).toBe('corr-it-1');
    // SR-014: context không mang key nào trong danh sách secret.
    expect(Object.keys(row.context).toSorted()).toEqual(['mode', 'riskClass', 'stale']);
    expect(row.context['mode']).toBe('read');
  });

  it('SR-014: rejects an audit context carrying a secret-looking key (DB CHECK)', async () => {
    await expect(
      runtime.query(
        `INSERT INTO backoffice.authorization_audit
           (actor_sub, action, outcome, context)
         VALUES ($1, 'delivery.redrive', 'denied', $2::jsonb)`,
        [ACTOR, JSON.stringify({ token: 'leak-me' })],
      ),
    ).rejects.toThrow(/authorization_audit_no_secret_keys/u);
  });

  it('SR-015: the runtime role cannot UPDATE or DELETE the audit row', async () => {
    await recordDecision(runtime, {
      actorSub: ACTOR,
      permission: 'delivery.redrive',
      decision: DENIED_DECISION,
    });

    await expect(
      runtime.query(
        `UPDATE backoffice.authorization_audit SET outcome = 'success' WHERE actor_sub = $1`,
        [ACTOR],
      ),
    ).rejects.toThrow(/permission denied for table authorization_audit/u);

    await expect(
      runtime.query(`DELETE FROM backoffice.authorization_audit WHERE actor_sub = $1`, [ACTOR]),
    ).rejects.toThrow(/permission denied for table authorization_audit/u);
  });

  it('I-08: a failed audit insert propagates to the caller instead of resolving', async () => {
    // Client đã end() — mọi query của nó reject driver error; hook phải ném
    // lên chứ không nuốt (mutation: bọc try/catch trong recordDecision là
    // test này đỏ).
    const deadClient = await db.asRuntime();
    await deadClient.query('SET ROLE ecoma_backoffice_runtime');
    await deadClient.end();

    await expect(
      recordDecision(deadClient, {
        actorSub: ACTOR,
        permission: 'delivery.redrive',
        decision: DENIED_DECISION,
      }),
    ).rejects.toThrow(/Client was closed and is not queryable/u);
  });
});
