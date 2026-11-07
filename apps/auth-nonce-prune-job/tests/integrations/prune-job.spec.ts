/**
 * Integration specs của `auth-nonce-prune-job` trên PostgreSQL THẬT.
 *
 * Subject của suite này là **JOB**, không phải store: store (`auth.internal_nonces`)
 * đã được phủ bởi `apps/auth/tests/integrations/internal-nonces.spec.ts` và
 * bản twin bên account. Ở đây ta ghim những thứ chỉ PostgreSQL mới quyết định:
 *
 *   - preflight identity `ecoma_auth_nonce_pruner|deletable` chạy được với đúng grant
 *     mà `0014_nonce_pruner_role.sql` cấp;
 *   - prune xoá nonce hết hạn, giữ nonce còn hiệu lực, và biên `expires_at < now()`;
 *   - idempotency giữa hai run liên tiếp (run thứ hai xoá 0 hàng);
 *   - hai run song song trên cùng kho: không double-delete, không lỗi, trạng thái cuối
 *     nhất quán (thuật toán không advisory lock theo HD6 — an toàn nằm ở mỗi lô là
 *     một transaction riêng + vị từ chọn hàng theo thời gian);
 *   - prune không chạm bảng nào khác trong cùng schema (append-only tables);
 *   - ranh quyền thật của role pruner: SELECT/DELETE có, INSERT/UPDATE/TRUNCATE không,
 *     và không chạm bảng của service khác.
 *
 * ⚠️ Thuật toán prune không được sửa ở PR này — suite này chứng minh hợp đồng của
 * `pruneTarget` (application lib `@ecoma-io/auth-nonce-prune-job-application`) trên
 * dependency thật, không thay đổi nó. Crash giữa run để lại trạng
 * thái nhất quán là hệ quả của "mỗi lô là một transaction riêng đã commit" (unit suite
 * `prune.spec.ts` của lib ghim ROLLBACK/release); integration suite ở đây ghim idempotency
 * giữa các run liên tiếp trên PostgreSQL thật.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from 'pg';

import type { Pool } from 'pg';

import { pruneTarget, type PruneTarget } from '@ecoma-io/auth-nonce-prune-job-application';

import { createPrunerPool, startPruneJobDatabase, type PruneJobDatabase } from './harness';

/** Identity mà server phải trả khi preflight chạy bằng role pruner thật. */
const EXPECTED_IDENTITY = 'ecoma_auth_nonce_pruner|deletable';

let db: PruneJobDatabase;
let pool: Pool;

beforeAll(async () => {
  db = await startPruneJobDatabase();
  pool = createPrunerPool(db);
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await db?.stop().catch(() => undefined);
});

/** Mở một client `pg` đơn bằng credential migrator — caller tự `end()`. */
async function connectMigrator(): Promise<Client> {
  return db.connectMigrator();
}

/** Xoá sạch kho nonce giữa các test — nonce là PRIMARY KEY nên phải dọn. */
async function clearNonces(): Promise<void> {
  const client = await connectMigrator();
  try {
    await client.query('DELETE FROM auth.internal_nonces');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Chèn `count` nonce hết hạn (hết hạn `hours` giờ trước) — migrator có quyền DML. */
async function seedExpired(count: number, hours = 1): Promise<void> {
  const client = await connectMigrator();
  try {
    await client.query(
      `INSERT INTO auth.internal_nonces (nonce, expires_at)
         SELECT 'expired-' || i, now() - ($2::text || ' hours')::interval
           FROM generate_series(1, $1) AS i`,
      [count, String(hours)],
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Chèn `count` nonce còn hiệu lực (hết hạn `hours` giờ sau). */
async function seedAlive(count: number, hours = 1): Promise<void> {
  const client = await connectMigrator();
  try {
    await client.query(
      `INSERT INTO auth.internal_nonces (nonce, expires_at)
         SELECT 'alive-' || i, now() + ($2::text || ' hours')::interval
           FROM generate_series(1, $1) AS i`,
      [count, String(hours)],
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Đếm hàng của kho nonce. */
async function countNonces(): Promise<number> {
  const client = await connectMigrator();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth.internal_nonces`,
    );
    return Number(result.rows[0]?.count ?? '0');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Đếm hàng của hai bảng append-only trong `auth`. */
async function appendOnlyCounts(): Promise<{ audit: number; revocations: number }> {
  const client = await connectMigrator();
  try {
    const result = await client.query<{ audit: string; revocations: string }>(
      `SELECT (SELECT count(*) FROM auth.authorization_audit_events)::text AS audit,
              (SELECT count(*) FROM auth.token_revocations)::text        AS revocations`,
    );
    return {
      audit: Number(result.rows[0]?.audit ?? '0'),
      revocations: Number(result.rows[0]?.revocations ?? '0'),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function makeTarget(targetPool: Pool): PruneTarget {
  return {
    service: 'auth',
    schema: 'auth',
    expectedIdentity: EXPECTED_IDENTITY,
    pool: targetPool,
  };
}

describe('prune job — correctness on real PostgreSQL', () => {
  it('deletes expired nonces and keeps live ones', async () => {
    await clearNonces();
    await seedExpired(5);
    await seedAlive(3);

    const run = await pruneTarget(makeTarget(pool), {
      startedAtMs: Date.now(),
      now: Date.now,
    });

    expect(run.outcome).toBe('ok');
    expect(run.pruned).toBe(5);
    expect(run.batches).toBe(1);
    expect(await countNonces()).toBe(3);

    await clearNonces();
  });

  it('keeps a nonce whose expiry is in the future and deletes one in the past (strict <)', async () => {
    // Biên chính xác `expires_at == now()` không thể ghim tất định khi vị từ dùng
    // `now()` của chính transaction prune (thời điểm prune luôn sau thời điểm ghi).
    // Store suite (`internal-nonces.spec.ts`) ghim biên đó với vị từ cùng hình dạng
    // bằng mốc cố định; ở đây ta ghim hướng của dấu `<` với biên đủ xa để không bị
    // race đồng hồ, và chứng minh job chạy được trên PostgreSQL thật.
    await clearNonces();
    await seedExpired(1, 1);
    await seedAlive(1, 1);

    const run = await pruneTarget(makeTarget(pool), {
      startedAtMs: Date.now(),
      now: Date.now,
    });

    expect(run.outcome).toBe('ok');
    expect(run.pruned).toBe(1);
    expect(await countNonces()).toBe(1);

    await clearNonces();
  });

  it('is idempotent: a second run deletes nothing and stays ok', async () => {
    await clearNonces();
    await seedExpired(4);
    await seedAlive(2);

    const first = await pruneTarget(makeTarget(pool), {
      startedAtMs: Date.now(),
      now: Date.now,
    });
    expect(first.outcome).toBe('ok');
    expect(first.pruned).toBe(4);

    const second = await pruneTarget(makeTarget(pool), {
      startedAtMs: Date.now(),
      now: Date.now,
    });
    expect(second.outcome).toBe('ok');
    expect(second.pruned).toBe(0);
    // Dừng bình thường là lô đầu trả 0 hàng — KHÔNG có vòng thứ hai chắc chắn trống
    // (hợp đồng "dừng luôn thay vì thêm một vòng chắc chắn trả 0" của script cũ).
    expect(second.batches).toBe(0);
    expect(await countNonces()).toBe(2);

    await clearNonces();
  });

  it('two concurrent runs do not double-delete and leave consistent state', async () => {
    await clearNonces();
    await seedExpired(50);
    await seedAlive(5);

    const [first, second] = await Promise.all([
      pruneTarget(makeTarget(pool), { startedAtMs: Date.now(), now: Date.now }),
      pruneTarget(makeTarget(pool), { startedAtMs: Date.now(), now: Date.now }),
    ]);

    // Thuật toán không advisory lock (HD6): hai run đều chạy. Kết quả cho phép một bên
    // xoá hết và bên kia thấy kho sạch — cả hai phải kết thúc `ok`, không ném.
    expect(first.outcome).toBe('ok');
    expect(second.outcome).toBe('ok');
    // Không double-delete: tổng số hàng đã xoá thật đúng bằng số hàng hết hạn đã seed.
    expect(first.pruned + second.pruned).toBe(50);
    expect(await countNonces()).toBe(5);

    await clearNonces();
  });

  it('does not touch append-only tables in the same schema', async () => {
    await clearNonces();
    const migrator = await connectMigrator();
    try {
      await migrator.query(
        `INSERT INTO auth.internal_nonces (nonce, expires_at)
           VALUES ('nonce-expired', now() - interval '1 hour')`,
      );
      await migrator.query(
        `INSERT INTO auth.authorization_audit_events (event_type) VALUES ('token_issued')`,
      );
      await migrator.query(
        `INSERT INTO auth.token_revocations (level, subject_ref, reason)
           VALUES ('subject', 'sub-prune-guard', 'prune-guard')`,
      );
    } finally {
      await migrator.end().catch(() => undefined);
    }

    const before = await appendOnlyCounts();
    expect(before.audit).toBeGreaterThan(0);
    expect(before.revocations).toBeGreaterThan(0);

    const run = await pruneTarget(makeTarget(pool), {
      startedAtMs: Date.now(),
      now: Date.now,
    });
    expect(run.outcome).toBe('ok');
    expect(run.pruned).toBe(1);

    const after = await appendOnlyCounts();
    expect(after).toEqual(before);
    expect(await countNonces()).toBe(0);

    // dọn audit/revocation rows đã gieo để không ảnh hưởng suite khác (container riêng
    // nên không bắt buộc, nhưng giữ vệ sinh).
    const cleanup = await connectMigrator();
    try {
      await cleanup.query(
        `DELETE FROM auth.authorization_audit_events WHERE event_type = 'token_issued'`,
      );
      await cleanup.query(`DELETE FROM auth.token_revocations WHERE reason = 'prune-guard'`);
    } finally {
      await cleanup.end().catch(() => undefined);
    }
    await clearNonces();
  });
});

describe('prune job — privilege boundary of ecoma_auth_nonce_pruner', () => {
  it('preflight succeeds (identity matches) under the real grants of 0014', async () => {
    // Nếu grant SELECT/DELETE thiếu, identity preflight trả `no-delete` hoặc `missing`
    // và pruneTarget ném `identity_mismatch` TRƯỚC khi xoá hàng nào. Test này chỉ cần
    // run thành công là đủ để chứng minh ranh quyền.
    await clearNonces();
    await seedExpired(2);

    const run = await pruneTarget(makeTarget(pool), {
      startedAtMs: Date.now(),
      now: Date.now,
    });
    expect(run.outcome).toBe('ok');
    expect(run.pruned).toBe(2);

    await clearNonces();
  });

  it('pruner has SELECT and DELETE but not INSERT, UPDATE or TRUNCATE', async () => {
    const client = new Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.prunerUser,
      password: db.prunerPassword,
    });
    await client.connect();
    try {
      // SELECT phải chạy được.
      await client.query('SELECT nonce FROM auth.internal_nonces LIMIT 1');

      // INSERT bị chặn — pruner không được ghi nonce (chỉ serving path mới ghi).
      await expect(
        client.query(
          `INSERT INTO auth.internal_nonces (nonce, expires_at) VALUES ('x', now() + interval '1 hour')`,
        ),
      ).rejects.toThrow(/permission denied/iu);

      // UPDATE bị chặn — nới `expires_at` là nới cửa sổ replay.
      await expect(
        client.query(`UPDATE auth.internal_nonces SET expires_at = now() + interval '1 year'`),
      ).rejects.toThrow(/permission denied/iu);

      // TRUNCATE bị chặn — xoá sạch kho, kể cả nonce còn hiệu lực.
      await expect(client.query('TRUNCATE auth.internal_nonces')).rejects.toThrow(
        /permission denied/iu,
      );

      // DELETE được phép (đường prune thật).
      await client.query('DELETE FROM auth.internal_nonces WHERE expires_at < now()');
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('pruner cannot touch append-only or unrelated tables', async () => {
    const client = new Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.prunerUser,
      password: db.prunerPassword,
    });
    await client.connect();
    try {
      await expect(
        client.query('SELECT count(*) FROM auth.authorization_audit_events'),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        client.query(
          `INSERT INTO auth.token_revocations (level, subject_ref, reason) VALUES ('subject', 'x', 'y')`,
        ),
      ).rejects.toThrow(/permission denied/iu);
      await expect(client.query('SELECT count(*) FROM auth.oidc_state')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});
