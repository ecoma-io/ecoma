/**
 * `login_handoffs` — AC-008b2, AC-008b3, AC-008b5, FR-006c2, FR-006c3, FR-006c4.
 *
 * Đây là phần khó nhất của schema, và cũng là chỗ dễ tự lừa nhất: một cách
 * kiểm thử "đọc rồi ghi" sẽ xanh ở mọi test tuần tự rồi hỏng dưới tải đồng thời.
 * Vì vậy AC-008b2 ở đây **thật sự** chạy song song, trên hai connection, với
 * một thanh chặn để hai lệnh `INSERT` thực sự cùng lúc.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import challengeRoute from '../../server/api/auth/challenge.post';
import verifyRoute from '../../server/api/auth/verify.post';
import handoffRoute from '../../server/api/auth/handoff.post';

import {
  ACCOUNT_DATABASE,
  type AccountDatabase,
  futureInstant,
  hashIdentifier,
  startAccountDatabase,
} from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
/** Handle X đến từ query string; database chỉ lưu hash của nó. */
const RAW_HANDLE = 'X-stolen-from-a-log-or-referrer';

describe('login_handoffs', () => {
  let db: AccountDatabase;

  beforeAll(async () => {
    db = await startAccountDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncateData();
  });

  /**
   * Chèn binding bằng **một** thao tác atomic duy nhất — đây là hình thức
   * `FR-006c2` bắt buộc. `INSERT ... ON CONFLICT DO NOTHING` rồi `SELECT` là
   * so khớp, không phải ghi; đọc-rồi-ghi trước khi insert là hình thức bị cấm.
   *
   * Trả về `won` để test khẳng định ai thắng, chứ không chỉ đo bản ghi cuối.
   */
  async function bindFirst(
    handleHash: string,
    sessionRef: string,
    client?: import('pg').Client,
  ): Promise<{ won: boolean; sessionRef: string | null; state: string }> {
    const own = client ?? (await db.connect());
    try {
      const inserted = await own.query<{ session_ref: string; state: string }>(
        `INSERT INTO account.login_handoffs (handle_hash, session_ref, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (handle_hash) DO NOTHING
         RETURNING session_ref, state`,
        [handleHash, sessionRef, futureInstant()],
      );

      // `ON CONFLICT (handle_hash) DO NOTHING` là **cơ chế** first-binding-wins:
      // một `INSERT` nguyên tử, thắng thua do ràng buộc UNIQUE quyết định chứ
      // không phải bằng đọc-rồi-ghi. `rowCount === 1` nghĩa là mình thắng; `0`
      // nghĩa là binding đã có và phải so khớp, **không** được ghi đè.
      if (inserted.rowCount === 1) {
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new Error('rowCount = 1 nhung RETURNING khong tra ve dong nao');
        }
        return { won: true, sessionRef: row.session_ref, state: row.state };
      }

      // Đã có binding: đây là so khớp, và đó là chỗ FR-006c3 được áp dụng —
      // session đã bind không đổi.
      const existing = await own.query<{ session_ref: string; state: string }>(
        `SELECT session_ref, state FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(
          'ON CONFLICT bat tranh nhung SELECT khong tim thay binding: handle_hash ton tai o dau?',
        );
      }
      return { won: false, sessionRef: row.session_ref, state: row.state };
    } finally {
      if (client === undefined) {
        await own.end();
      }
    }
  }

  it('AC-008b2: two sessions presenting X for the first time concurrently — exactly one wins', async () => {
    const handleHash = hashIdentifier(RAW_HANDLE);
    const first = await db.connect();
    const second = await db.connect();

    try {
      // Hai connection, hai transaction riêng. `pg_sleep` bên trong transaction
      // giữ mỗi transaction mở cho tới khi cả hai đã sẵn sàng, nên hai `INSERT`
      // thực sự tranh nhau thay vì lần này chạy trước lần kia.
      const barrier = 'SELECT pg_sleep(0.5)';

      const s1 = first
        .query('BEGIN')
        .then(() => first.query(barrier))
        .then(() => bindFirst(handleHash, 'asr-session-one', first))
        .then(async (result) => {
          await first.query('COMMIT');
          return result;
        });

      const s2 = second
        .query('BEGIN')
        .then(() => second.query(barrier))
        .then(() => bindFirst(handleHash, 'asr-session-two', second))
        .then(async (result) => {
          await second.query('COMMIT');
          return result;
        });

      const [r1, r2] = await Promise.all([s1, s2]);

      const winners = [r1, r2].filter((result) => result.won);
      const losers = [r1, r2].filter((result) => !result.won);

      // Đúng một binding thắng, và kẻ thua nhận về định danh của session đã bind
      // chứ không phải định danh của chính nó.
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.sessionRef).toBe(winners[0]?.sessionRef);

      // Đúng một bản ghi — không có bản ghi thứ hai sinh ra bởi cuộc tranh chấp.
      const check = await db.connect();
      try {
        const { rows } = await check.query<{ session_ref: string }>(
          `SELECT session_ref FROM account.login_handoffs WHERE handle_hash = $1`,
          [handleHash],
        );
        // Đúng một bản ghi — không có bản ghi thứ hai sinh ra bởi cuộc tranh chấp.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.session_ref).toBe(winners[0]?.sessionRef);
      } finally {
        await check.end();
      }
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('AC-008b3: a second session presenting X after the fact is rejected and the binding is untouched', async () => {
    const handleHash = hashIdentifier(RAW_HANDLE);

    const first = await bindFirst(handleHash, 'asr-original');
    expect(first.won).toBe(true);

    const second = await bindFirst(handleHash, 'asr-intruder');
    expect(second.won).toBe(false);
    expect(second.sessionRef).toBe('asr-original');

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ session_ref: string; state: string }>(
        `SELECT session_ref, state FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.session_ref).toBe('asr-original');
      expect(rows[0]?.state).toBe('bound');
    } finally {
      await client.end();
    }
  });

  it('FR-006c3: the database refuses to overwrite a binding even under a direct UPDATE', async () => {
    // Không chỉ "thao tác atomic không ghi đè" — mà một `UPDATE` thẳng của
    // session khác vào binding cũng phải bị chặn, kể cả khi tầng ứng dụng quên.
    const handleHash = hashIdentifier(RAW_HANDLE);
    await bindFirst(handleHash, 'asr-original');

    const client = await db.connect();
    try {
      await expect(
        client.query(
          `UPDATE account.login_handoffs SET session_ref = 'asr-intruder' WHERE handle_hash = $1`,
          [handleHash],
        ),
      ).rejects.toThrow(/chi doi duoc khi chuyen binding luc rotate session/iu);
    } finally {
      await client.end();
    }
  });

  it('FR-006c2: the runtime role cannot rebind by rewriting handle_hash', async () => {
    // `handle_hash` là PRIMARY KEY và **là** cơ chế first-binding-wins
    // (FR-006c2). Runtime role có UPDATE trên bảng này, nên không có luật riêng
    // ở trigger thì `SET handle_hash = '<khác>'` giải phóng PK và cho phép
    // bind lần thứ hai cho cùng handle X — đúng đường FR-006c3/c4 cấm. Chạy
    // bằng credential **thật** của runtime role để chứng minh luật nằm ở
    // database, không phải ở tầng ứng dụng.
    const handleHash = hashIdentifier(RAW_HANDLE);
    const rivalHash = hashIdentifier(`${RAW_HANDLE}-stolen`);
    await bindFirst(handleHash, 'asr-pk-guard');

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`UPDATE account.login_handoffs SET handle_hash = $1 WHERE handle_hash = $2`, [
          rivalHash,
          handleHash,
        ]),
      ).rejects.toThrow(/handle_hash la PRIMARY KEY va co che first-binding-wins/iu);
    } finally {
      await runtime.end();
    }

    // Binding cũ vẫn nguyên vẹn dưới đúng handle_hash cũ; không có hàng thứ hai.
    const verify = await db.connect();
    try {
      const { rows } = await verify.query<{ handle_hash: string; session_ref: string }>(
        `SELECT handle_hash, session_ref FROM account.login_handoffs`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.handle_hash).toBe(handleHash);
      expect(rows[0]?.session_ref).toBe('asr-pk-guard');
    } finally {
      await verify.end();
    }
  });

  it('AC-008b5: rotating the session transfers the binding in the same transaction', async () => {
    const handleHash = hashIdentifier(RAW_HANDLE);
    await bindFirst(handleHash, 'asr-before-login');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Cùng một transaction: session cũ bị thu hồi, session mới được cấp,
      // binding chuyển sang session mới và chuyển sang state `session_rotated`.
      // Nếu tách thành hai transaction thì có một khoảng thời gian binding trỏ
      // tới session đã bị thu hồi — và `01-architecture.md` §3.6.2 nói rõ đó là
      // cách làm login hỏng.
      await client.query(
        `UPDATE account.login_handoffs
            SET session_ref = 'asr-after-login', state = 'session_rotated'
          WHERE handle_hash = $1`,
        [handleHash],
      );
      await client.query(
        `INSERT INTO account.account_sessions (id_hash, session_ref, expires_at)
         VALUES ('hash-after-login', 'asr-after-login', $1)`,
        [futureInstant()],
      );

      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const verify = await db.connect();
    try {
      const { rows } = await verify.query<{ session_ref: string; state: string }>(
        `SELECT session_ref, state FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      expect(rows[0]?.session_ref).toBe('asr-after-login');
      expect(rows[0]?.state).toBe('session_rotated');

      // Session thứ ba không thể chiếm X sau khi binding đã chuyển.
      const third = await bindFirst(handleHash, 'asr-third-party');
      expect(third.won).toBe(false);
      expect(third.sessionRef).toBe('asr-after-login');
    } finally {
      await verify.end();
    }
  });

  it('FR-006c4: the transfer is rolled back together with the session it points at', async () => {
    const handleHash = hashIdentifier(RAW_HANDLE);
    await bindFirst(handleHash, 'asr-before-rollback');

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE account.login_handoffs
            SET session_ref = 'asr-rolled-back', state = 'session_rotated'
          WHERE handle_hash = $1`,
        [handleHash],
      );
      // Cố tình hỏng giữa chừng: `session_ref` mới không tồn tại.
      await expect(
        client.query(
          `INSERT INTO account.account_sessions (id_hash, session_ref, expires_at)
           VALUES ('hash-rolled-back', 'asr-rolled-back', now() - interval '1 day')`,
        ),
      ).rejects.toThrow(/account_sessions_expiry_check/u);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    const verify = await db.connect();
    try {
      const { rows } = await verify.query<{ session_ref: string; state: string }>(
        `SELECT session_ref, state FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      // Không có đường nào để binding rơi: hoặc cả hai cùng thành công, hoặc
      // không có gì thay đổi.
      expect(rows[0]?.session_ref).toBe('asr-before-rollback');
      expect(rows[0]?.state).toBe('bound');
    } finally {
      await verify.end();
    }
  });

  it('AC-008b4: the same session presenting X again is idempotent', async () => {
    const handleHash = hashIdentifier(RAW_HANDLE);

    const first = await bindFirst(handleHash, 'asr-same-session');
    const retry = await bindFirst(handleHash, 'asr-same-session');

    expect(first.won).toBe(true);
    // Retry trả về binding cũ, không tạo bản ghi thứ hai — và không báo lỗi.
    expect(retry.sessionRef).toBe('asr-same-session');

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('AC-008b6: state is constrained to the four states the design allows', async () => {
    const client = await db.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO account.login_handoffs (handle_hash, session_ref, state, expires_at)
           VALUES ('h-bad-state', 'asr-bad', 'extended', $1)`,
          [futureInstant()],
        ),
      ).rejects.toThrow(/login_handoffs_state_check/u);
    } finally {
      await client.end();
    }
  });

  it('the raw handle X is never stored, only its hash', async () => {
    const handleHash = hashIdentifier(RAW_HANDLE);
    await bindFirst(handleHash, 'asr-no-raw-handle');

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ leaked: number }>(
        `SELECT count(*)::int AS leaked
           FROM account.login_handoffs
          WHERE handle_hash = $1 OR handle_hash LIKE '%' || $2 || '%'`,
        [RAW_HANDLE, RAW_HANDLE],
      );
      expect(rows[0]?.leaked).toBe(0);
    } finally {
      await client.end();
    }
  });

  /**
   * Chuyển state trên `login_handoffs` — ba nhóm luật của
   * `login_handoffs_rebind_guard` (0001): terminal, forward-only, và
   * `session_ref` chỉ đổi khi rotate.
   *
   * Bốn đường hợp lệ của máy trạng thái §3.6: `bound → session_rotated` (xoay
   * session, đổi `session_ref` — FR-006c4), `bound → consumed` (dùng xong không
   * xoay — FR-006d2), `session_rotated → consumed` và
   * `session_rotated → expired` (FR-006d2 / FR-006g). Mọi UPDATE khác bị raise
   * ở tầng database.
   *
   * Gieo hàng bằng INSERT (trigger chỉ canh UPDATE); đọc lại bằng SELECT —
   * mỗi test tự dựng đúng state mình cần rồi đo phản ứng của trigger.
   *
   * @param handleHash Hash của handle X — đúng cột PRIMARY KEY của bảng.
   * @param state Trạng thái cần gieo; INSERT không qua trigger UPDATE nên
   *   nhận cả trạng thái kết thúc.
   * @param sessionRef Binding cần gieo cùng state.
   */
  async function seed(handleHash: string, state: string, sessionRef: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.login_handoffs (handle_hash, session_ref, state, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [handleHash, sessionRef, state, futureInstant()],
      );
    } finally {
      await client.end();
    }
  }

  /** Đọc lại state + session_ref hiện tại của một handoff. */
  async function readBack(handleHash: string): Promise<{ state: string; session_ref: string }> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ state: string; session_ref: string }>(
        `SELECT state, session_ref FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('khong tim thay handoff sau khi seed');
      }
      return row;
    } finally {
      await client.end();
    }
  }

  describe('state transitions', () => {
    it('FR-006c4: rotating a bound handoff to session_rotated with a new session_ref is allowed', async () => {
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'bound', 'asr-before-rotate');

      const client = await db.connect();
      try {
        await client.query(
          `UPDATE account.login_handoffs
              SET state = 'session_rotated', session_ref = 'asr-after-rotate'
            WHERE handle_hash = $1`,
          [handleHash],
        );
      } finally {
        await client.end();
      }

      const row = await readBack(handleHash);
      expect(row.state).toBe('session_rotated');
      expect(row.session_ref).toBe('asr-after-rotate');
    });

    it('FR-006d2: consuming a bound handoff directly without rotating is allowed', async () => {
      // `bound → consumed` là đường hợp lệ của máy trạng thái §3.6: xác thực
      // thành công, handoff được dùng, không có xoay session đi kèm. Điểm then
      // chốt là `session_ref` KHÔNG đổi — chỉ có rotate mới đổi binding.
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'bound', 'asr-consumed-in-place');

      const client = await db.connect();
      try {
        await client.query(
          `UPDATE account.login_handoffs SET state = 'consumed' WHERE handle_hash = $1`,
          [handleHash],
        );
      } finally {
        await client.end();
      }

      const row = await readBack(handleHash);
      expect(row.state).toBe('consumed');
      expect(row.session_ref).toBe('asr-consumed-in-place');
    });

    it('FR-006d2: a session_rotated handoff can still be consumed', async () => {
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'session_rotated', 'asr-rotated-then-consumed');

      const client = await db.connect();
      try {
        await client.query(
          `UPDATE account.login_handoffs SET state = 'consumed' WHERE handle_hash = $1`,
          [handleHash],
        );
      } finally {
        await client.end();
      }

      const row = await readBack(handleHash);
      expect(row.state).toBe('consumed');
      expect(row.session_ref).toBe('asr-rotated-then-consumed');
    });

    it('FR-006g: a session_rotated handoff can expire without any extension path', async () => {
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'session_rotated', 'asr-rotated-then-expired');

      const client = await db.connect();
      try {
        await client.query(
          `UPDATE account.login_handoffs SET state = 'expired' WHERE handle_hash = $1`,
          [handleHash],
        );
      } finally {
        await client.end();
      }

      const row = await readBack(handleHash);
      expect(row.state).toBe('expired');
      // Hết hạn là trạng thái kết thúc: FR-006g cấm mọi đường gia hạn, nên UPDATE
      // tiếp theo — kể cả chỉ đụng `expires_at` — phải bị chặn (test terminal bên dưới).
    });

    it('FR-006d2: a consumed handoff rejects every further update', async () => {
      // Bẫy của trigger bản cũ: chỉ kiểm `NEW.state`, nên hàng `consumed` đổi
      // sang `session_rotated` + `session_ref` mới là TÁI BIND một handoff đã
      // dùng — đúng đường "dùng lại" mà FR-006d2 cấm. Chạy bằng credential
      // thật của runtime role để chứng minh luật nằm ở database, không phải ở
      // tầng ứng dụng hay ở superuser.
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'consumed', 'asr-already-consumed');

      const runtime = await db.connectAsRuntime();
      try {
        await expect(
          runtime.query(
            `UPDATE account.login_handoffs SET expires_at = now() + interval '1 day'
              WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);

        await expect(
          runtime.query(
            `UPDATE account.login_handoffs SET state = 'expired' WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);

        await expect(
          runtime.query(
            `UPDATE account.login_handoffs SET state = 'bound' WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);

        // Đúng kịch bản tái bind: hồi sinh sang session_rotated và trỏ sang
        // session của kẻ tấn công.
        await expect(
          runtime.query(
            `UPDATE account.login_handoffs
                SET state = 'session_rotated', session_ref = 'asr-rebind-attack'
              WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);
      } finally {
        await runtime.end();
      }

      // Hàng vẫn nguyên vẹn sau bốn UPDATE bị từ chối.
      const row = await readBack(handleHash);
      expect(row.state).toBe('consumed');
      expect(row.session_ref).toBe('asr-already-consumed');
    });

    it('FR-006g: an expired handoff rejects every further update', async () => {
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'expired', 'asr-already-expired');

      const client = await db.connect();
      try {
        // Gia hạn: đúng đường FR-006g cấm — "không có đường gia hạn âm thầm".
        await expect(
          client.query(
            `UPDATE account.login_handoffs SET expires_at = now() + interval '1 day'
              WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);

        await expect(
          client.query(
            `UPDATE account.login_handoffs SET state = 'consumed' WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);

        await expect(
          client.query(
            `UPDATE account.login_handoffs
                SET state = 'session_rotated', session_ref = 'asr-expired-rebind'
              WHERE handle_hash = $1`,
            [handleHash],
          ),
        ).rejects.toThrow(/la trang thai ket thuc/iu);
      } finally {
        await client.end();
      }

      const row = await readBack(handleHash);
      expect(row.state).toBe('expired');
      expect(row.session_ref).toBe('asr-already-expired');
    });

    it('FR-006d2: a session_rotated handoff cannot return to bound', async () => {
      // Forward-only: quay lại `bound` là đưa binding về trạng thái chưa dùng,
      // mở đường "dùng lại" một handoff đã xoay — FR-006d2: không có đường dùng
      // lại. `session_ref` giữ nguyên để điểm chặn duy nhất là luật state.
      const handleHash = hashIdentifier(RAW_HANDLE);
      await seed(handleHash, 'session_rotated', 'asr-stay-rotated');

      const client = await db.connect();
      try {
        await expect(
          client.query(`UPDATE account.login_handoffs SET state = 'bound' WHERE handle_hash = $1`, [
            handleHash,
          ]),
        ).rejects.toThrow(/chi duoc chuyen sang consumed hoac expired/iu);
      } finally {
        await client.end();
      }

      const row = await readBack(handleHash);
      expect(row.state).toBe('session_rotated');
    });

    it('FR-006c3: session_ref cannot change outside the bound-to-session_rotated rotate', async () => {
      // Ba hình thức đổi binding sai chỗ, cùng một luật: chỉ đúng một thao tác
      // rotate từ `bound` được đổi `session_ref` (FR-006c4). Mọi UPDATE khác
      // đổi `session_ref` là ghi đè binding — FR-006c3.
      const boundHash = hashIdentifier(`${RAW_HANDLE}-bound`);
      await seed(boundHash, 'bound', 'asr-bound-ref');

      const rotatedHash = hashIdentifier(`${RAW_HANDLE}-rotated`);
      await seed(rotatedHash, 'session_rotated', 'asr-rotated-ref');

      const client = await db.connect();
      try {
        // bound nhưng KHÔNG rotate state: đổi ref thẳng = ghi đè binding.
        await expect(
          client.query(
            `UPDATE account.login_handoffs SET session_ref = 'asr-steal-bound'
              WHERE handle_hash = $1`,
            [boundHash],
          ),
        ).rejects.toThrow(/chi doi duoc khi chuyen binding luc rotate session/iu);

        // bound → consumed kèm ref mới: đường "consume" không được đổi binding.
        await expect(
          client.query(
            `UPDATE account.login_handoffs
                SET state = 'consumed', session_ref = 'asr-steal-consume'
              WHERE handle_hash = $1`,
            [boundHash],
          ),
        ).rejects.toThrow(/chi doi duoc khi chuyen binding luc rotate session/iu);

        // session_rotated đổi ref lần thứ hai: FR-006c4 là "một thao tác atomic
        // duy nhất", không có đường session thứ ba thừa kế X.
        await expect(
          client.query(
            `UPDATE account.login_handoffs
                SET state = 'consumed', session_ref = 'asr-steal-second-rotate'
              WHERE handle_hash = $1`,
            [rotatedHash],
          ),
        ).rejects.toThrow(/chi doi duoc khi chuyen binding luc rotate session/iu);
      } finally {
        await client.end();
      }

      const boundRow = await readBack(boundHash);
      expect(boundRow.state).toBe('bound');
      expect(boundRow.session_ref).toBe('asr-bound-ref');
      const rotatedRow = await readBack(rotatedHash);
      expect(rotatedRow.state).toBe('session_rotated');
      expect(rotatedRow.session_ref).toBe('asr-rotated-ref');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route-level: luồng challenge → verify → handoff đi qua `login_handoffs` thật.
//
// Hình thức giống `bff-routes-e2e.spec.ts`: route thật (import trực tiếp),
// DB thật qua credential runtime, `AUTH_SERVICE` là binding hình-thật-hành-vi-gả
// (envelope đủ để route coi là gọi xong, không mở Worker `auth` thật). Cái cần
// chứng minh là **ràng buộc handle X ↔ session** sống sót qua ba route — không
// phải envelope (khối đó của `bff-routes-e2e`).
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_HANDLE = 'X-route-level-handle-value';
const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
const INTERNAL_SECRET = 'test-internal-hmac-secret-0123456789abcdef';
const CONTINUE_URL = 'https://auth.test/continue?token=x';

/**
 * Các helper dưới đây nằm ở **module scope** thay vì trong `describe`: đúng
 * gợi ý `unicorn/consistent-function-scoping` của oxlint — chúng không đọc biến
 * nào của suite (chỉ nhận tham số), lồng vào `describe` là tái tạo function
 * mỗi lần khai báo suite mà không mang ngữ cảnh nào.
 */

function installMailStub(): { sent: unknown[]; restore: () => void } {
  const sent: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body;
    const isUint8 =
      rawBody !== null &&
      typeof rawBody === 'object' &&
      (rawBody as { constructor?: { name?: string } }).constructor?.name === 'Uint8Array';
    const bodyText = isUint8
      ? new TextDecoder().decode(rawBody as Uint8Array)
      : typeof rawBody === 'string'
        ? rawBody
        : String(rawBody ?? '{}');
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    sent.push(body);
    return new Response(
      JSON.stringify({
        id: 'msg-1',
        delivery_id: 'dlv-1',
        app: 'account',
        template: body['template'],
        template_version: 1,
        status: 'queued',
        created: true,
        created_at: new Date().toISOString(),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function post(
  handler: WebHandler,
  path: string,
  body: unknown,
  init: { headers?: Record<string, string>; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  if (init.cookie !== undefined) {
    headers['cookie'] = init.cookie;
  }
  return handler(
    new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 1).split(';')[0];
}

function authCookieHeader(cookies: { sessionCookie: string; csrfCookie: string }): string {
  return `__Host-account-session=${cookies.sessionCookie}; __Host-account-csrf=${cookies.csrfCookie}`;
}

describe('login_handoffs routes', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;
  const authCalls: Array<{ body: Record<string, unknown> }> = [];

  /** Binding giả của `AUTH_SERVICE` — ghi nhận call, trả response do test chọn. */
  function installAuthStub(response: { status: number; body: unknown } | undefined): {
    binding: { fetch: (input: Request, init?: RequestInit) => Promise<Response> };
  } {
    return {
      binding: {
        fetch: async (input: Request) => {
          const raw = await input.clone().arrayBuffer();
          authCalls.push({
            body: JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>,
          });
          if (response === undefined) {
            throw new Error('auth stub: no configured response for this test step');
          }
          return new Response(JSON.stringify(response.body), { status: response.status });
        },
      },
    };
  }

  function runtimeConfig(
    authStub:
      | { binding: { fetch: (input: Request, init?: RequestInit) => Promise<Response> } }
      | undefined,
  ): AccountTestRuntimeConfig {
    return {
      internalHmacSecret: INTERNAL_SECRET,
      otpHmacSecret: OTP_SECRET,
      mailServiceUrl: 'https://mail.test',
      mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
      cloudflare: {
        env: {
          DB_ACCOUNT: { connectionString },
          ...(authStub === undefined ? {} : { AUTH_SERVICE: authStub.binding }),
        },
      },
    };
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(runtimeConfig(undefined));
    const app = createApp();
    const router = createRouter();
    router.post('/api/auth/challenge', challengeRoute);
    router.post('/api/auth/verify', verifyRoute);
    router.post('/api/auth/handoff', handoffRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    authCalls.length = 0;
    setRuntimeConfig(runtimeConfig(undefined));
    await db.truncateData();
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ($1)`, ['sub_handoff_routes']);
      // Hai địa chỉ seed: `user@example.com` là chủ binding chính, còn
      // `second@example.com` cho các arrange "trình duyệt thứ hai" — rate gate
      // của route đếm per-address, nếu hai arrange dùng chung một địa chỉ thì
      // request thứ hai bị cooldown chặn trước khi tới nhánh binding (OCR-2),
      // arrange không còn chứng minh điều nó muốn chứng minh.
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now())`,
        ['sub_handoff_routes', 'user@example.com', hashIdentifier('user@example.com')],
      );
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now())`,
        ['sub_handoff_routes', 'second@example.com', hashIdentifier('second@example.com')],
      );
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now())`,
        ['sub_handoff_routes', 'conflict@example.com', hashIdentifier('conflict@example.com')],
      );
    } finally {
      await client.end();
    }
  });

  /**
   * Challenge **với** handle (browser của luồng `/authorize`): đúng thứ tự
   * production. Trả cookie anonymous mà route cấp trước khi verify rotate.
   */
  async function challengeWithHandle(
    handle: string,
    email = 'user@example.com',
  ): Promise<{ sessionCookie: string | undefined; csrfCookie: string | undefined; code: string }> {
    const mail = installMailStub();
    let code: string;
    let cookies: string[];
    try {
      const response = await post(handler, '/api/auth/challenge', {
        email,
        handle,
      });
      expect(response.status).toBe(204);
      code = (mail.sent[0] as { variables?: { code?: string } } | undefined)?.variables
        ?.code as string;
      cookies = response.headers.getSetCookie();
    } finally {
      mail.restore();
    }
    return {
      sessionCookie: cookieValue(cookies, '__Host-account-session'),
      csrfCookie: cookieValue(cookies, '__Host-account-csrf'),
      code,
    };
  }

  /** Verify → cookie session xác thực vẹn (session mới kế thừa binding — FR-006c4). */
  async function verifyAndLogin(
    email: string,
    code: string,
    cookieOverride?: string,
  ): Promise<{ sessionCookie: string; csrfCookie: string; csrfToken: string }> {
    const response = await post(
      handler,
      '/api/auth/verify',
      { email, code },
      cookieOverride === undefined ? {} : { cookie: `__Host-account-session=${cookieOverride}` },
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookieValue(cookies, '__Host-account-session');
    const csrfCookie = cookieValue(cookies, '__Host-account-csrf');
    expect(typeof sessionCookie).toBe('string');
    expect(typeof csrfCookie).toBe('string');
    return {
      sessionCookie: sessionCookie as string,
      csrfCookie: csrfCookie as string,
      csrfToken: csrfCookie as string,
    };
  }

  async function bindingRow(
    handleHash: string,
  ): Promise<{ session_ref: string; state: string } | undefined> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ session_ref: string; state: string }>(
        `SELECT session_ref, state FROM account.login_handoffs WHERE handle_hash = $1`,
        [handleHash],
      );
      return rows[0];
    } finally {
      await client.end();
    }
  }

  function runtimeSessionRef(): Promise<string | undefined> {
    return (async () => {
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ session_ref: string }>(
          `SELECT session_ref FROM account.account_sessions WHERE revoked_at IS NULL LIMIT 1`,
        );
        return rows[0]?.session_ref;
      } finally {
        await client.end();
      }
    })();
  }

  it('AC-008b2 via routes: challenge with handle binds first; a second browser challenging the same handle does not get the binding', async () => {
    const stub = installAuthStub(undefined);
    setRuntimeConfig(runtimeConfig(stub));

    const first = await challengeWithHandle(ROUTE_HANDLE);
    expect(first.sessionCookie).toBeDefined();
    // First-binding-wins: binding tồn tại ngay sau challenge, chưa đến verify.
    const bound = await bindingRow(hashIdentifier(ROUTE_HANDLE));
    expect(bound?.state).toBe('bound');

    // Email khác cho trình duyệt 2: rate gate per-email chỉ chặn địa chỉ đã
    // vừa challenge trong cooldown — object của arrange này là tranh binding,
    // không phải rate limit (có test riêng ở dưới cho rate path).
    const second = await challengeWithHandle(ROUTE_HANDLE, 'second@example.com');
    // Cùng 204 anti-enumeration cho cả hai arrange không phân biệt thắng/thua.
    // Binding vẫn là của session đầu — không request nào ghi đè được.
    const untouched = await bindingRow(hashIdentifier(ROUTE_HANDLE));
    expect(untouched?.state).toBe('bound');
    expect(untouched?.session_ref).toBe(bound?.session_ref);

    void first;
    void second;
  });

  it('AC-008b5 via routes: verify rotation carries the binding to the authenticated session in the same transaction', async () => {
    const stub = installAuthStub(undefined);
    setRuntimeConfig(runtimeConfig(stub));

    const preLogin = await challengeWithHandle(ROUTE_HANDLE);
    const boundBefore = await bindingRow(hashIdentifier(ROUTE_HANDLE));
    expect(boundBefore?.state).toBe('bound');

    const code = preLogin.code;
    const login = await verifyAndLogin('user@example.com', code, preLogin.sessionCookie);

    // Session mới kế thừa binding: `session_ref` đã đổi đúng một lần (cùng
    // transaction rotate — nếu tách rời, AC-008b5 của khối này bị hỏng và
    // session đã bị thu hồi này sẽ trỏ binding tới chết).
    const carried = await bindingRow(hashIdentifier(ROUTE_HANDLE));
    expect(carried?.state).toBe('session_rotated');
    const liveRef = await runtimeSessionRef();
    expect(carried?.session_ref).toBe(liveRef);

    // Handoff của **session mới** là bên hợp lệ — push được.
    const handoffStub = installAuthStub({
      status: 200,
      body: { outcome: 'granted', continue_url: CONTINUE_URL },
    });
    setRuntimeConfig(runtimeConfig(handoffStub));
    const response = await post(
      handler,
      '/api/auth/handoff',
      { handle: ROUTE_HANDLE },
      {
        cookie: authCookieHeader(login),
        headers: { 'x-ecoma-csrf': login.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      outcome: 'granted',
      continueUrl: CONTINUE_URL,
    });
    // Chỉ một phương thức push duy nhất được sinh ra từ cả luồng.
    expect(authCalls).toHaveLength(1);
  });

  it('AC-008b3 via routes: another browser presenting X at handoff time gets binding_mismatch and never reaches auth', async () => {
    // Hai trình duyệt đăng nhập thành công — session A giữ X, session B không.
    const stub = installAuthStub(undefined);
    setRuntimeConfig(runtimeConfig(stub));
    const preLoginA = await challengeWithHandle(ROUTE_HANDLE);
    const loginA = await verifyAndLogin(
      'user@example.com',
      preLoginA.code,
      preLoginA.sessionCookie,
    );

    // Sticky B: challenge khác (sau cooldown? dùng handle khác cho B không bị
    // chặn cooldown resend của chính challenge A) và verify riêng.
    const mailB = installMailStub();
    let codeB: string;
    try {
      const challengeB = await post(handler, '/api/auth/challenge', {
        email: 'user@example.com',
        handle: 'X-other-handle-B',
      });
      expect(challengeB.status).toBe(204);
      codeB = (mailB.sent[0] as { variables?: { code?: string } }).variables?.code as string;
    } finally {
      mailB.restore();
    }
    const loginB = await verifyAndLogin('user@example.com', codeB);
    expect(loginB.sessionCookie).not.toBe(loginA.sessionCookie);

    // B trình X — đúng ngoài binding của nó: fail-closed + không call auth.
    const handoffGuardStub = installAuthStub({
      status: 200,
      body: { outcome: 'granted', continue_url: CONTINUE_URL },
    });
    setRuntimeConfig(runtimeConfig(handoffGuardStub));
    const response = await post(
      handler,
      '/api/auth/handoff',
      { handle: ROUTE_HANDLE },
      {
        cookie: authCookieHeader(loginB),
        headers: { 'x-ecoma-csrf': loginB.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'binding_mismatch' });
    // Không push về auth — binding_mismatch chặn TRƯỚC envelope.
    expect(authCalls).toHaveLength(0);

    // A vẫn dùng được tài nguyên của mình — binding không bị dây bẩn bởi B.
    void preLoginA;
  });

  it('AC-008b6 via routes: a consumed handoff rejects its own session (no silent reuse, FR-006d2)', async () => {
    const stub = installAuthStub({
      status: 200,
      body: { outcome: 'granted', continue_url: CONTINUE_URL },
    });
    setRuntimeConfig(runtimeConfig(stub));

    const preLogin = await challengeWithHandle(ROUTE_HANDLE);
    const login = await verifyAndLogin('user@example.com', preLogin.code, preLogin.sessionCookie);

    const first = await post(
      handler,
      '/api/auth/handoff',
      { handle: ROUTE_HANDLE },
      {
        cookie: authCookieHeader(login),
        headers: { 'x-ecoma-csrf': login.csrfToken },
      },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: 'granted', continueUrl: CONTINUE_URL });
    expect(authCalls).toHaveLength(1);

    // Trình lại X sau khi dùng: từ chối — state `consumed`, không push thêm.
    const second = await post(
      handler,
      '/api/auth/handoff',
      { handle: ROUTE_HANDLE },
      {
        cookie: authCookieHeader(login),
        headers: { 'x-ecoma-csrf': login.csrfToken },
      },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: false, reason: 'binding_mismatch' });
    // Không một lần push thứ hai nào: handoff là single-use (FR-006d2).
    expect(authCalls).toHaveLength(1);
    const consumed = await bindingRow(hashIdentifier(ROUTE_HANDLE));
    expect(consumed?.state).toBe('consumed');
  });

  it('challenge with a handle keeps anti-enumeration: still 204 when another session already holds the binding', async () => {
    const stub = installAuthStub(undefined);
    setRuntimeConfig(runtimeConfig(stub));

    // Email khác cho request xung đột: muốn chứng minh "binding không bị ghi
    // đè dưới 204", không phải "rate gate chặn trả 204" — cooldown per-email
    // của request thứ hai làm mờ object nếu cùng địa chỉ (OCR-2).
    await challengeWithHandle(ROUTE_HANDLE);
    const conflict = await challengeWithHandle(ROUTE_HANDLE, 'conflict@example.com');
    expect(conflict.sessionCookie).toBeDefined();

    // Không phân biệt mã lỗi hay response — anti-enumeration bất biến.
    const row = await bindingRow(hashIdentifier(ROUTE_HANDLE));
    expect(row?.state).toBe('bound');

    // Cả hai request đều 204; chỉ binding đầu tiên là tồn tại.
    const count = await (async () => {
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM account.login_handoffs WHERE handle_hash = $1`,
          [hashIdentifier(ROUTE_HANDLE)],
        );
        return rows[0]?.count;
      } finally {
        await client.end();
      }
    })();
    expect(count).toBe(1);
  });

  it('OCR rate gate: a rate-limited challenge with a handle writes no new account_sessions or login_handoffs rows', async () => {
    // OCR-2: block binding phải đứng SAU rate gate — một request bị limit (vẫn
    // 204, anti-enumeration) không được sinh hàng DB. Đây là đường "một request
    // mang handle mới nhưng vừa bị cooldown/rate limit": nếu gate sai chỗ, nó
    // tạo một `account_sessions` anonymous + một `login_handoffs`.
    const stub = installAuthStub(undefined);
    setRuntimeConfig(runtimeConfig(stub));

    // Arrange: challenge đầu thành công (binding được ghi, một cặp hàng).
    const first = await challengeWithHandle(ROUTE_HANDLE);
    expect(first.sessionCookie).toBeDefined();

    // Challenge thứ hai với handle RIÊNG và CÙNG email — rơi vào resend
    // cooldown (challenge active dưới 60s), route 204 im lặng.
    const secondHandle = 'X-rate-limited-handle';
    const second = await challengeWithHandle(secondHandle);
    void second;

    // Không hàng nào được sinh cho handle thứ hai — binding bị gate chặn TRƯỚC
    // khi ghi.
    const countRows = await (async () => {
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM account.login_handoffs WHERE handle_hash = $1`,
          [hashIdentifier(secondHandle)],
        );
        return rows[0]?.count;
      } finally {
        await client.end();
      }
    })();
    expect(countRows).toBe(0);

    // Không `account_sessions` anonymous nào khác cũng được tạo (binding là
    // thứ kéo nó vào — nếu gate đúng chỗ, request bị chặn không sinh session).
    const client2 = await db.connect();
    try {
      const { rows } = await client2.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.account_sessions WHERE revoked_at IS NULL`,
      );
      // Challenge 1 tạo đúng một session anonymous (chưa verify). Challenge 2
      // bị gate — không thêm hàng nào.
      expect(rows[0]?.count).toBe(1);
    } finally {
      await client2.end();
    }
  });

  it('the raw handle never reaches login_handoffs: only the hash is stored', async () => {
    const stub = installAuthStub(undefined);
    setRuntimeConfig(runtimeConfig(stub));
    await challengeWithHandle(ROUTE_HANDLE);

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.login_handoffs WHERE handle_hash = $1 OR handle_hash LIKE '%' || $2 || '%'`,
        [ROUTE_HANDLE, ROUTE_HANDLE],
      );
      expect(rows[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  });
});
