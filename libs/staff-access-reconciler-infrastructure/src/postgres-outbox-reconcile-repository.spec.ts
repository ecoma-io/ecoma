import { describe, expect, it, vi } from 'vitest';

import { createPostgresOutboxReconcileRepository } from './postgres-outbox-reconcile-repository';

/**
 * `createPostgresOutboxReconcileRepository` — kiem **duong ong cua option xuong
 * driver**, khong can PostgreSQL. Pattern `libs/staff-access-infrastructure/src/postgres.spec.ts`:
 * vi driver that su mo socket, mot unit test chi co the kiem viec factory truyen dung tham
 * so va tu choi config sai — khong the kiem "ket noi duoc".
 */

const { queryCalls } = vi.hoisted(() => ({
  queryCalls: [] as Array<{ sql: string; params: readonly unknown[]; rows: readonly unknown[] }>,
}));

/** Fake Pool: ghi lại mỗi `query` call, trả rows do test queue. */
function fakePool(rows: readonly unknown[]): { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn<
    (sql: string, params: readonly unknown[]) => Promise<{ rows: readonly unknown[] }>
  >(async (sql: string, params: readonly unknown[]) => {
    queryCalls.push({ sql, params, rows });
    return { rows };
  });
  return { query };
}

/**
 * Helper: queue một row với `last_error` cho trước, trả về giá trị `last_error`
 * đã được adapter map (sau khi sanitize). Dùng để assert invariant sanitize ở infra
 * boundary mà không cần PostgreSQL thật.
 */
async function mapLastError(raw: unknown): Promise<string | null> {
  const pool = fakePool([
    {
      event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event_type: 'entitlement.revoked',
      occurred_at: '2026-10-30T00:00:00Z',
      published_at: '2026-10-30T00:00:10Z',
      attempts: 1,
      last_error: raw,
    },
  ]);
  const repo = createPostgresOutboxReconcileRepository(pool as unknown as import('pg').Pool);
  const [row] = await repo.listStalePublished({
    nowMs: 1_780_400_000_000,
    staleAfterMs: 300_000,
    limit: 100,
  });
  return row?.last_error ?? null;
}

async function mapRow(overrides: { attempts?: unknown; last_error?: unknown } = {}) {
  const pool = fakePool([
    {
      event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event_type: 'entitlement.revoked',
      occurred_at: '2026-10-30T00:00:00Z',
      published_at: '2026-10-30T00:00:10Z',
      attempts: 1,
      last_error: null,
      ...overrides,
    },
  ]);
  const repo = createPostgresOutboxReconcileRepository(pool as unknown as import('pg').Pool);
  const [row] = await repo.listStalePublished({
    nowMs: 1_780_400_000_000,
    staleAfterMs: 300_000,
    limit: 100,
  });
  return row;
}

describe('createPostgresOutboxReconcileRepository — boundary validation', () => {
  it('throws fail-closed on a negative staleAfterMs (never treats all rows as stale)', async () => {
    const repo = createPostgresOutboxReconcileRepository(
      fakePool([]) as unknown as import('pg').Pool,
    );
    await expect(
      repo.listStalePublished({ nowMs: 1_000, staleAfterMs: -1, limit: 10 }),
    ).rejects.toThrow('staleAfterMs must be a non-negative integer: -1');
  });

  it('throws fail-closed on a non-integer staleAfterMs', async () => {
    const repo = createPostgresOutboxReconcileRepository(
      fakePool([]) as unknown as import('pg').Pool,
    );
    await expect(
      repo.listStalePublished({ nowMs: 1_000, staleAfterMs: 1.5, limit: 10 }),
    ).rejects.toThrow('staleAfterMs must be a non-negative integer: 1.5');
  });

  it('still throws on an invalid limit (existing clamp, unchanged)', async () => {
    const repo = createPostgresOutboxReconcileRepository(
      fakePool([]) as unknown as import('pg').Pool,
    );
    await expect(
      repo.listStalePublished({ nowMs: 1_000, staleAfterMs: 1_000, limit: 0 }),
    ).rejects.toThrow('limit must be a positive integer: 0');
  });

  it('throws fail-closed on a limit exceeding MAX_RECONCILIATION_LIMIT', async () => {
    const repo = createPostgresOutboxReconcileRepository(
      fakePool([]) as unknown as import('pg').Pool,
    );
    await expect(
      repo.listStalePublished({ nowMs: 1_000, staleAfterMs: 1_000, limit: 10_001 }),
    ).rejects.toThrow('limit must not exceed');
  });

  it('throws fail-closed on a non-finite nowMs', async () => {
    const repo = createPostgresOutboxReconcileRepository(
      fakePool([]) as unknown as import('pg').Pool,
    );
    await expect(
      repo.listStalePublished({ nowMs: NaN, staleAfterMs: 300_000, limit: 10 }),
    ).rejects.toThrow('nowMs must be a finite number');
  });

  it('runs the query when both inputs are valid', async () => {
    queryCalls.length = 0;
    const pool = fakePool([
      {
        event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        event_type: 'entitlement.revoked',
        occurred_at: '2026-10-30T00:00:00Z',
        published_at: '2026-10-30T00:00:10Z',
        attempts: 1,
        last_error: null,
      },
    ]);
    const repo = createPostgresOutboxReconcileRepository(pool as unknown as import('pg').Pool);
    const result = await repo.listStalePublished({
      nowMs: 1_780_400_000_000,
      staleAfterMs: 300_000,
      limit: 100,
    });
    expect(result).toHaveLength(1);
    expect(queryCalls).toHaveLength(1);
    // ⚠️ cutoff = now - staleAfterMs (epoch ms → ISO 8601). Assert the computed
    // value rather than a hard-coded date so the test does not silently break
    // when the injected clock moves.
    expect(queryCalls[0]?.params[0]).toBe(new Date(1_780_400_000_000 - 300_000).toISOString());
    expect(queryCalls[0]?.params[1]).toBe(100);
  });
});

describe('createPostgresOutboxReconcileRepository — last_error sanitization', () => {
  it('passes null through unchanged', async () => {
    await expect(mapLastError(null)).resolves.toBeNull();
  });

  it('returns null for undefined input (never crashes on .replace)', async () => {
    await expect(mapLastError(undefined)).resolves.toBeNull();
  });

  it('passes a benign relay message through unchanged', async () => {
    await expect(mapLastError('queue publish timeout')).resolves.toBe('queue publish timeout');
  });

  it('redacts a raw SQL fragment (fail-closed, never leaks SQL into diagnostics)', async () => {
    await expect(
      mapLastError('SELECT * FROM staff_access.entitlement_outbox_events WHERE id = 1'),
    ).resolves.toBe('[redacted]');
  });

  it('redacts a stack trace pattern', async () => {
    await expect(mapLastError('Error: something blew up\n    at foo.js:10:5')).resolves.toBe(
      '[redacted]',
    );
  });

  it('redacts TypeError prefix', async () => {
    await expect(mapLastError('TypeError: cannot read property of null')).resolves.toBe(
      '[redacted]',
    );
  });

  it('redacts ReferenceError prefix', async () => {
    await expect(mapLastError('ReferenceError: x is not defined')).resolves.toBe('[redacted]');
  });

  it('redacts PostgreSQL schema error (column ... of relation ... does not exist)', async () => {
    await expect(mapLastError('column "email" of relation "users" does not exist')).resolves.toBe(
      '[redacted]',
    );
  });

  it('redacts PostgreSQL constraint error (duplicate key ... violates unique constraint ...)', async () => {
    await expect(
      mapLastError('duplicate key value violates unique constraint "users_email_key"'),
    ).resolves.toBe('[redacted]');
  });

  it('redacts a Python traceback', async () => {
    await expect(
      mapLastError(
        'Traceback (most recent call last):\n  File "app.py", line 10, in <module>\n    foo()',
      ),
    ).resolves.toBe('[redacted]');
  });

  it('redacts control-char-split SQL (denylist bypass defeated)', async () => {
    await expect(mapLastError('SEL\u0000ECT * FROM t')).resolves.toBe('[redacted]');
  });

  it('strips control characters (no log injection, single line)', async () => {
    await expect(mapLastError('ok\ninjected\tline')).resolves.toBe('ok injected line');
  });

  it('truncates overly long messages instead of leaking them into logs', async () => {
    const long = 'x'.repeat(500);
    const result = await mapLastError(long);
    expect(result).not.toBe(long);
    expect(result?.length).toBeLessThan(long.length);
    expect(result).toContain('…');
  });

  it('truncates at exactly MAX_RELAY_ERROR_LEN with … suffix', async () => {
    const exactly255 = 'a'.repeat(255);
    const result = await mapLastError(exactly255);
    expect(result).toBe(exactly255);
    const over255 = 'a'.repeat(256);
    const resultOver = await mapLastError(over255);
    expect(resultOver).toBe('a'.repeat(255) + '…');
  });

  it('throws fail-closed when attempts is non-numeric (NaN guard)', async () => {
    await expect(mapRow({ attempts: 'not-a-number' })).rejects.toThrow('attempts must be a number');
  });
});
