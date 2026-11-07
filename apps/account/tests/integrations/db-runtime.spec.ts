/**
 * `server/utils/db.ts` trên PostgreSQL thật, bằng credential runtime thật.
 *
 * Trước đây **không** có test nào thực thi `selectAccountStatus` hay
 * `recordNonce` với database thật: mutation đổi `FROM account.users` thành
 * `FROM users` (chạy được nhờ superuser trong development, chết với
 * `relation "users" does not exist` trong production — role runtime không có
 * `users` trong `search_path`) vẫn xanh 86/86; mutation ghi `observed_at` thay
 * `expires_at` trong `recordNonce` cũng vậy. Unit test với mock pool chỉ kiểm
 * "có gọi query không", không kiểm câu SQL chạy được trên schema thật.
 *
 * File này dùng đúng object mà production dùng: `Pool` với credential
 * `ecoma_account_runtime` thật (qua {@link AccountDatabase.createRuntimePool}),
 * schema `account` đã apply bởi runner production (`applyAllMigrations`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordNonce, selectAccountStatus } from '../../server/utils/db';
import { type AccountDatabase, startAccountDatabase } from './harness.ts';
/** Sub hợp lệ theo định dạng `sub_` + 32 ký tự; giá trị cụ thể không quan trọng. */
const SUB_ACTIVE = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_SUSPENDED = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUB_MISSING = 'sub_cccccccccccccccccccccccccccccccc';

describe('server/utils/db on real PostgreSQL', () => {
  let db: AccountDatabase;

  beforeAll(async () => {
    db = await startAccountDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    const client = await db.connect();
    try {
      await client.query(
        `TRUNCATE account.internal_nonces, account.users RESTART IDENTITY CASCADE`,
      );
      await client.query(
        `INSERT INTO account.users (sub, status) VALUES
           ($1, 'active'), ($2, 'suspended')`,
        [SUB_ACTIVE, SUB_SUSPENDED],
      );
    } finally {
      await client.end();
    }
  });

  describe('selectAccountStatus', () => {
    it('reads a status through the schema-qualified table with the runtime role', async () => {
      const pool = await db.createRuntimePool();
      try {
        // `FROM users` (mutation bỏ schema) chết ở đây: search_path của role
        // runtime không chứa `account`, và credential thật — không phải
        // `SET ROLE` từ superuser — là thứ phản ánh đúng môi trường Worker.
        await expect(selectAccountStatus(pool, SUB_ACTIVE)).resolves.toBe('active');
        await expect(selectAccountStatus(pool, SUB_SUSPENDED)).resolves.toBe('suspended');
      } finally {
        await pool.end();
      }
    });

    it('returns null for an unknown sub, which the route maps to not_found', async () => {
      const pool = await db.createRuntimePool();
      try {
        await expect(selectAccountStatus(pool, SUB_MISSING)).resolves.toBeNull();
      } finally {
        await pool.end();
      }
    });
  });

  describe('recordNonce', () => {
    it('inserts the nonce with the caller-supplied expiry and reports the first write', async () => {
      const pool = await db.createRuntimePool();
      const expiryEpochSeconds = Math.floor(Date.now() / 1000) + 660;
      try {
        // Lần đầu: chưa có ⇒ `false` (chưa từng thấy). `ON CONFLICT DO NOTHING`
        // với `rowCount === 0` là "đã thấy".
        await expect(recordNonce(pool, 'nonce-db-runtime', expiryEpochSeconds)).resolves.toBe(
          false,
        );
        await expect(recordNonce(pool, 'nonce-db-runtime', expiryEpochSeconds)).resolves.toBe(true);
      } finally {
        await pool.end();
      }

      const client = await db.connect();
      try {
        const { rows } = await client.query<{ expires_at: Date }>(
          `SELECT expires_at FROM account.internal_nonces WHERE nonce = $1`,
          ['nonce-db-runtime'],
        );
        const stored = rows[0];
        if (stored === undefined) {
          throw new Error('recordNonce did not persist the nonce');
        }
        // `expires_at` phải là **giá trị caller truyền** (to_timestamp), không phải
        // `observed_at`, không phải `now()`: mutation đổi cột hoặc lệch vài giây
        // quá ngưỡng đều đỏ tại đây.
        const storedSeconds = stored.expires_at.getTime() / 1000;
        expect(Math.abs(storedSeconds - expiryEpochSeconds)).toBeLessThanOrEqual(2);
      } finally {
        await client.end();
      }
    });

    it('rejects every invalid expiry before writing: fail closed, no row with a wrong TTL (F-04B)', async () => {
      const pool = await db.createRuntimePool();
      const epochMilliseconds = Date.now();
      const invalid = [
        ['NaN', Number.NaN],
        ['+Infinity', Number.POSITIVE_INFINITY],
        ['-Infinity', Number.NEGATIVE_INFINITY],
        ['am', -1],
        ['khong (0)', 0],
        ['thap phan', 1_700_000_000.5],
        ['epoch mili giay', epochMilliseconds],
        ['qua tran', 4_102_444_801],
      ] as const;
      try {
        for (const [label, value] of invalid) {
          // Mỗi giá trị phải ném TRƯỚC khi câu INSERT chạy. Assert cả hai vế:
          // (1) ném, và (2) **không** hàng nào tồn tại sau đó — vế (2) mới là vế
          // chứng minh fail-closed. Chỉ assert `rejects` sẽ xanh cả khi hàm ném
          // *sau* khi đã chèn xong.
          await expect(recordNonce(pool, `nonce-invalid-${label}`, value)).rejects.toThrow(
            /nonce expiry/u,
          );
        }
      } finally {
        await pool.end();
      }

      const client = await db.connect();
      try {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM account.internal_nonces WHERE nonce LIKE 'nonce-invalid-%'`,
        );
        expect(rows[0]?.count).toBe('0');
      } finally {
        await client.end();
      }
    });

    it('accepts an expiry exactly at the ceiling, so the ceiling is not tightened by accident (F-04B)', async () => {
      const pool = await db.createRuntimePool();
      try {
        // `4_102_444_800` là 2100-01-01T00:00:00Z. Biên trên là chỗ dễ sửa thành
        // `<` thay vì `<=`, và một lần siết nhầm như vậy sẽ từ chối một TTL hợp lệ
        // ở production mà không test nào đỏ nếu ta chỉ kiểm các giá trị quá lớn.
        await expect(recordNonce(pool, 'nonce-at-ceiling', 4_102_444_800)).resolves.toBe(false);
        await expect(recordNonce(pool, 'nonce-at-ceiling', 4_102_444_800)).resolves.toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('a nonce written on the POOL survives a later business ROLLBACK (F-04A)', async () => {
      const pool = await db.createRuntimePool();
      try {
        const expiryEpochSeconds = Math.floor(Date.now() / 1000) + 660;
        await expect(
          recordNonce(pool, 'nonce-survives-rollback', expiryEpochSeconds),
        ).resolves.toBe(false);

        // Transaction nghiệp vụ đi sau thất bại ⇒ ROLLBACK. Nếu bản ghi nonce nằm
        // trong transaction đó thì rollback xoá nó, và replay guard mở lại trong
        // im lặng. Ghi trên pool là điều kiện để `ON CONFLICT` chống replay thật.
        const txClient = await db.connectAsRuntime();
        try {
          await txClient.query('BEGIN');
          await txClient.query(
            `INSERT INTO account.internal_nonces (nonce, expires_at) VALUES ($1, to_timestamp($2))`,
            ['nonce-inside-business-tx', expiryEpochSeconds],
          );
          await txClient.query('ROLLBACK');
        } finally {
          await txClient.end();
        }
      } finally {
        await pool.end();
      }

      const client = await db.connect();
      try {
        const { rows } = await client.query<{ nonce: string }>(
          `SELECT nonce FROM account.internal_nonces WHERE nonce IN ($1, $2) ORDER BY nonce`,
          ['nonce-survives-rollback', 'nonce-inside-business-tx'],
        );
        // Chỉ hàng ghi trên pool còn lại. Hàng ghi trong transaction đã biến mất —
        // đó chính là thứ sẽ xảy ra với nonce nếu nó được ghi qua `PoolClient`.
        expect(rows.map((row) => row.nonce)).toEqual(['nonce-survives-rollback']);
      } finally {
        await client.end();
      }

      // Và hệ quả bảo mật: nonce vẫn "đã thấy", nên envelope đó không phát lại được.
      const verifyPool = await db.createRuntimePool();
      try {
        const { rows } = await verifyPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM account.internal_nonces WHERE nonce = $1`,
          ['nonce-survives-rollback'],
        );
        expect(rows[0]?.count).toBe('1');
      } finally {
        await verifyPool.end();
      }
    });
  });
});
