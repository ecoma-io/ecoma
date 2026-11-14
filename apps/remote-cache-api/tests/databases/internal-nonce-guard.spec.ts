/**
 * Database-level test cho guard phạm vi DELETE của kho nonce
 * (`remote_cache.internal_nonces`, migration 0008 — issue #202): trigger
 * `internal_nonce_delete_guard` chỉ cho xoá nonce ĐÃ hết hạn, nên credential
 * runtime bị xâm hại không thể xoá nonce còn trong cửa sổ replay để phát lại
 * envelope cũ. Đồng thời khẳng định statement claim nguyên tử (prune hết hạn
 * + insert nonce mới) vẫn chạy bình thường dưới trigger.
 *
 * Chạy bằng credential THẬT của `ecoma_remote_cache_runtime` — đúng principal
 * Worker dùng, không phải superuser — để kiểm chứng cả grant lẫn trigger.
 *
 * ⚠️ Docker là phụ thuộc cứng — vắng Docker là đỏ, không skip (06-testing.md §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type RemoteCacheDatabase, startRemoteCacheDatabase } from '../integrations/harness.ts';

let db: RemoteCacheDatabase;

beforeAll(async () => {
  db = await startRemoteCacheDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.truncateData();
});

describe('internal_nonces delete guard (database behavior)', () => {
  it('rejects deleting a nonce that is still inside its replay window', async () => {
    const client = await db.connectAsRuntime();
    try {
      await client.query(
        `INSERT INTO remote_cache.internal_nonces (nonce, expires_at)
         VALUES ($1, now() + interval '10 minutes')`,
        ['live-nonce'],
      );
      await expect(
        client.query('DELETE FROM remote_cache.internal_nonces WHERE nonce = $1', ['live-nonce']),
      ).rejects.toMatchObject({ code: '23000' });
      // Guard phải bảo toàn trạng thái: nonce vẫn còn sau DELETE bị chặn.
      const { rows } = await client.query<{ nonce: string }>(
        'SELECT nonce FROM remote_cache.internal_nonces WHERE nonce = $1',
        ['live-nonce'],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it('rejects an unconditional DELETE that would wipe live nonces', async () => {
    const client = await db.connectAsRuntime();
    try {
      await client.query(
        `INSERT INTO remote_cache.internal_nonces (nonce, expires_at)
         VALUES ($1, now() + interval '10 minutes')`,
        ['live-nonce'],
      );
      // Đây chính là thao tác của credential bị xâm hại: DELETE không WHERE.
      await expect(client.query('DELETE FROM remote_cache.internal_nonces')).rejects.toMatchObject({
        code: '23000',
      });
      const { rows } = await client.query('SELECT nonce FROM remote_cache.internal_nonces');
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it('allows deleting a nonce whose replay window has expired', async () => {
    const client = await db.connectAsRuntime();
    try {
      await client.query(
        `INSERT INTO remote_cache.internal_nonces (nonce, expires_at)
         VALUES ($1, now() - interval '1 hour')`,
        ['expired-nonce'],
      );
      const result = await client.query(
        'DELETE FROM remote_cache.internal_nonces WHERE nonce = $1',
        ['expired-nonce'],
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('keeps the atomic claim statement working: prune expired, insert new, detect replay', async () => {
    const client = await db.connectAsRuntime();
    try {
      await client.query(
        `INSERT INTO remote_cache.internal_nonces (nonce, expires_at)
         VALUES ($1, now() - interval '1 hour')`,
        ['stale-nonce'],
      );
      const expiresAt = Math.floor(Date.now() / 1000) + 360;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const claim = `WITH deleted AS (
                       DELETE FROM remote_cache.internal_nonces
                        WHERE expires_at <= to_timestamp($3)
                          AND expires_at <= now()
                     )
                     INSERT INTO remote_cache.internal_nonces (nonce, expires_at)
                     VALUES ($1, to_timestamp($2))
                     ON CONFLICT (nonce) DO NOTHING
                     RETURNING nonce`;

      // Lần claim đầu: nonce mới được ghi (1 hàng trả về), nonce hết hạn bị prune.
      const first = await client.query<{ nonce: string }>(claim, [
        'fresh-nonce',
        expiresAt,
        nowSeconds,
      ]);
      expect(first.rows).toHaveLength(1);
      const { rows: stale } = await client.query(
        'SELECT nonce FROM remote_cache.internal_nonces WHERE nonce = $1',
        ['stale-nonce'],
      );
      expect(stale).toHaveLength(0);

      // Claim lại cùng nonce: 0 hàng trả về = replay bị phát hiện.
      const replay = await client.query<{ nonce: string }>(claim, [
        'fresh-nonce',
        expiresAt,
        nowSeconds,
      ]);
      expect(replay.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
