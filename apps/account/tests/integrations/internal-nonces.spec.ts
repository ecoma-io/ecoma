/**
 * `internal_nonces` — kho bền cho replay guard của đường nội bộ.
 *
 * Đây là bảng mà `verifyRequest` (`libs/internal-auth-contracts/src/internal-auth.ts`)
 * gọi qua callback `claimNonce`. Vì vậy test ở đây không kiểm tra SQL cho vui:
 * chúng kiểm tra **tính chất mà `verifyRequest` dựa vào**, và tính chất đó có
 * hai mặt dễ tự lừa:
 *
 *   * `claimNonce` phải là "kiểm tra **và** ghi", không phải "kiểm tra". Một store
 *     cài bằng `SELECT` rồi `INSERT` ở câu khác sẽ xanh mọi test tuần tự rồi hỏng
 *     dưới tải đồng thời — cùng cái lỗi mà FR-006c2 cấm ở `login_handoffs`.
 *   * Nonce phải sống **qua** cửa sổ replay của envelope — mốc
 *     `timestamp + skew`, sau đó envelope bị `bad_timestamp`. TTL ngắn hơn thì
 *     prune xoá nonce còn hiệu lực và replay thành công ngay trong cửa sổ.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  INTERNAL_NONCE_BUFFER_SECONDS,
  INTERNAL_SKEW_SECONDS,
  nonceExpiry,
} from '../../db/migrate.mts';
import { makeNonceGuard } from '../../server/middleware/internal-auth';
import { type AccountDatabase, startAccountDatabase } from './harness.ts';
describe('internal_nonces', () => {
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
      await client.query('DELETE FROM account.internal_nonces');
    } finally {
      await client.end();
    }
  });

  /**
   * Cài đúng `claimNonce`: một câu `INSERT … ON CONFLICT DO NOTHING`, rồi đếm số
   * hàng trả về.
   *
   * Trả `true` nghĩa là nonce **đã** có → `verifyRequest` từ chối. Trả `false`
   * nghĩa là nonce mới và đã được ghi.
   */
  async function claimNonce(nonce: string, client?: import('pg').Client): Promise<boolean> {
    const own = client ?? (await db.connectAsRuntime());
    try {
      const result = await own.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, nonceExpiry(Math.floor(Date.now() / 1000))],
      );
      return result.rowCount === 0;
    } finally {
      if (client === undefined) {
        await own.end();
      }
    }
  }

  it('agrees with the skew the contract library enforces', async () => {
    // `INTERNAL_SKEW_SECONDS` trong `db/migrate.mts` là bản **lặp lại** của
    // `DEFAULT_SKEW_SECONDS` trong lib, vì vitest config của app không resolve
    // được `@ecoma-io/*`. Test này đọc file nguồn của lib để hai bên không trôi
    // xa nhau — không import vì chính lý do trên, và dùng `import` sẽ biến lỗi
    // resolution thành lỗi test.
    //
    // Nếu không có test này thì đổi `DEFAULT_SKEW_SECONDS` trong lib sẽ âm thầm
    // làm TTL của bảng lệch, và mọi test hành vi ở trên vẫn xanh.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const source = readFileSync(
      resolve(import.meta.dirname, '../../../../libs/internal-auth-contracts/src/internal-auth.ts'),
      'utf8',
    );
    const declared = /DEFAULT_SKEW_SECONDS = (\d+)/u.exec(source);

    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(INTERNAL_SKEW_SECONDS);
  });

  it('agrees with the nonce TTL buffer the serving tier declares', async () => {
    // `NONCE_TTL_BUFFER_SECONDS` của lib (`libs/internal-auth-contracts`) là hằng giao thức
    // duy nhất; middleware import thẳng nó. `INTERNAL_NONCE_BUFFER_SECONDS` trong
    // `db/migrate.mts` vẫn là một bản lặp lại vì runner là script Node đọc `node:fs` và
    // không thể import lib (kéo `node:fs` vào bundle Worker). Hai nơi đều được kiểm
    // bằng cross-check đọc nguồn: lệch buffer thì TTL middleware và formula `nonceExpiry`
    // không còn là một công thức, và không test hành vi nào bắt được — cả hai vẫn "đủ
    // lâu" theo kiểu riêng của chúng.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const middlewareSource = readFileSync(
      resolve(import.meta.dirname, '../../server/middleware/internal-auth.ts'),
      'utf8',
    );
    // Middleware import thẳng hằng canonical; không tự khai một giá trị mới.
    const middlewareImported = /NONCE_TTL_BUFFER_SECONDS/u.test(middlewareSource);
    expect(middlewareImported).toBe(true);
    expect(/INTERNAL_NONCE_BUFFER_SECONDS = \d+/u.test(middlewareSource)).toBe(false);

    const migrateSource = readFileSync(
      resolve(import.meta.dirname, '../../db/migrate.mts'),
      'utf8',
    );
    const declared = /INTERNAL_NONCE_BUFFER_SECONDS = (\d+)/u.exec(migrateSource);

    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(INTERNAL_NONCE_BUFFER_SECONDS);
  });

  it('accepts a nonce once and rejects every later presentation of it', async () => {
    expect(await claimNonce('nonce-first-time')).toBe(false);
    expect(await claimNonce('nonce-first-time')).toBe(true);
    expect(await claimNonce('nonce-first-time')).toBe(true);
  });

  it('AC-008b2 shape: two callers presenting the same nonce concurrently — exactly one is accepted', async () => {
    // Hình thức kiểm thử này cố ý giống hệt AC-008b2 của `login_handoffs`: hai
    // connection thật, hai transaction riêng, `pg_sleep` làm thanh chặn. Chạy
    // tuần tự thì race condition của đọc-rồi-ghi không bao giờ lộ ra.
    const first = await db.connectAsRuntime();
    const second = await db.connectAsRuntime();

    try {
      const barrier = 'SELECT pg_sleep(0.5)';

      const s1 = first
        .query('BEGIN')
        .then(() => first.query(barrier))
        .then(() => claimNonce('nonce-concurrent', first))
        .then(async (seen) => {
          await first.query('COMMIT');
          return seen;
        });

      const s2 = second
        .query('BEGIN')
        .then(() => second.query(barrier))
        .then(() => claimNonce('nonce-concurrent', second))
        .then(async (seen) => {
          await second.query('COMMIT');
          return seen;
        });

      const [one, two] = await Promise.all([s1, s2]);

      // `claimNonce` trả `false` = được chấp nhận. Đúng **một** cái.
      expect([one, two].filter((seen) => !seen)).toHaveLength(1);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('stores expires_at from the caller, so a rejected nonce cannot be immortal', async () => {
    // `expires_at` KHÔNG có `DEFAULT now()`: nó là `timestamp của envelope + skew +
    // buffer`, tức dữ liệu người gọi kiểm soát. Nếu database tự điền thì nonce sống
    // mãi và replay guard vô hiệu hoá — nên test này assert giá trị lưu đi đúng bao
    // nhiêu so với skew, thay vì chỉ assert cột "không null".
    const nowSeconds = Math.floor(Date.now() / 1000);
    const client = await db.connectAsRuntime();
    try {
      await client.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at) VALUES ($1, $2)`,
        ['nonce-ttl', nonceExpiry(nowSeconds)],
      );
      const { rows } = await client.query<{ expires_at: Date; observed_at: Date }>(
        `SELECT expires_at, observed_at FROM account.internal_nonces WHERE nonce = $1`,
        ['nonce-ttl'],
      );

      const stored = rows[0];
      if (stored === undefined) {
        throw new Error('vua insert nonce-ttl nhung SELECT khong tra ve dong nao');
      }

      const ttlSeconds = (stored.expires_at.getTime() - stored.observed_at.getTime()) / 1000;
      // Cùng phép tính với tầng ứng dụng: skew + buffer — nonce sống qua hết cửa
      // sổ replay của envelope (`timestamp + skew`) rồi thêm buffer cho prune chạy
      // theo lô (xem `nonceExpiry`). Trần trên chỉ để không đỏ vì sai số đồng hồ
      // giữa test và database; công thức cũ (`2 × skew + buffer`) vượt trần này.
      expect(ttlSeconds).toBeGreaterThan(INTERNAL_SKEW_SECONDS);
      expect(ttlSeconds).toBeLessThan(INTERNAL_SKEW_SECONDS + INTERNAL_NONCE_BUFFER_SECONDS + 5);
    } finally {
      await client.end();
    }
  });

  it('has no column default on expires_at, so a caller cannot leave a nonce immortal', async () => {
    // ⚠️ Test trên **không** bắt được `DEFAULT now()`, vì nó luôn truyền
    // `expires_at` tường minh nên default không bao giờ kích hoạt. Đây là chỗ dễ
    // tự lừa nhất của cả suite: thêm default vào SQL làm một test xanh hơn và
    // làm replay guard vô hiệu hoá hoàn toàn.
    //
    // Vì vậy test này assert **cấu trúc cột**, đọc thẳng từ `pg_attribute` chứ
    // không dựa vào một câu `INSERT` có chủ đích.
    const client = await db.connect();
    try {
      // `pg_typeof(atthasdef)` trên PostgreSQL 17 là `boolean`, **không** phải
      // `"char"` — driver `pg` parse nó thành `boolean` thật. Đo trên database thật
      // sau khi một lần assert sai: nếu khai báo `string` và so `'f'` thì test đỏ
      // với `expected false to be 'f'` dù SQL hoàn toàn đúng.
      const { rows } = await client.query<{ has_default: boolean; not_null: boolean }>(
        `SELECT a.atthasdef AS has_default, a.attnotnull AS not_null
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'account'
            AND c.relname = 'internal_nonces'
            AND a.attname = 'expires_at'
            AND a.attnum > 0
            AND NOT a.attisdropped`,
      );
      const column = rows[0];
      if (column === undefined) {
        throw new Error('khong tim thay cot account.internal_nonces.expires_at');
      }
      expect(column.has_default).toBe(false);
      expect(column.not_null).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('never stores an expiry inside the envelope validity window', async () => {
    // Hằng của giao thức, không phải tuỳ chọn: nonce phải sống qua hết cửa sổ replay
    // của envelope — `verifyRequest` chấp nhận khi `|now − timestamp| ≤ skew`, nên
    // cửa sổ kết thúc tại `timestamp + skew` và TTL của nonce phải vượt mốc đó
    // (cộng buffer cho prune chạy theo lô). Không test nào khác bắt được điều này —
    // nó chỉ lộ ra khi prune chạy đúng lúc đó.
    //
    // ⚠️ Bản cũ của test này query một bảng `beforeEach` vừa truncate, không có
    // INSERT nào trước — mutation `WHERE 1=1 OR …` vẫn xanh vì "0 hàng xấu"
    // luôn đúng trên dữ liệu rỗng. Vì vậy test này chủ động ghi:
    //   1. một nonce **cố ý sai** (hết hạn ngay trong cửa sổ replay, trước mốc
    //      `timestamp + skew`), và
    //   2. một nonce đi qua **hàm production** (`makeNonceGuard` với pool
    //      credential runtime thật) — không phải SQL viết lại trong test;
    // rồi assert predicate bắt đúng hàng sai và chỉ hàng sai.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const seeder = await db.connect();
    try {
      await seeder.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at)
         VALUES ('nonce-bad-ttl', now() + make_interval(secs => $1))`,
        [INTERNAL_SKEW_SECONDS - 10],
      );
    } finally {
      await seeder.end();
    }

    const pool = await db.createRuntimePool();
    try {
      // Đường production: `makeNonceGuard` tính TTL = timestamp + skew + buffer với
      // timestamp của envelope (ở đây là `nowSeconds`). Trả về `false` = nonce mới
      // được ghi (chưa từng thấy).
      const seen = await makeNonceGuard(pool, INTERNAL_SKEW_SECONDS)('nonce-good-ttl', nowSeconds);
      expect(seen).toBe(false);
    } finally {
      await pool.end();
    }

    const checker = await db.connect();
    try {
      // Cửa sổ so là `skew` — đúng mốc hết hạn của envelope tại `timestamp + skew`.
      // Nonce tốt (`timestamp + skew + buffer`) phải vượt mốc này nên không rơi vào
      // kết quả; nonce xấu (`timestamp + skew − 10`) phải rơi vào. So bằng
      // `2 × skew` thì cả hai cùng qua (vì buffer > 0) và test mất sức bắt mutation
      // thiếu buffer.
      const { rows } = await checker.query<{ nonce: string }>(
        `SELECT nonce FROM account.internal_nonces
          WHERE expires_at <= observed_at + make_interval(secs => $1)
          ORDER BY nonce`,
        [INTERNAL_SKEW_SECONDS],
      );
      expect(rows.map((row) => row.nonce)).toEqual(['nonce-bad-ttl']);
    } finally {
      await checker.end();
    }
  });

  it('gives the runtime role no UPDATE, so a stored window cannot be widened', async () => {
    // Nới `expires_at` của nonce đã ghi là nới cửa sổ replay. Đây là hình thức
    // "sửa dữ liệu kiểm soát bảo mật", nên phải bị chặn ở tầng grant chứ không
    // hy vọng tầng ứng dụng không làm.
    const runtime = await db.asRuntime();
    try {
      await expect(
        runtime.query(`UPDATE account.internal_nonces SET expires_at = now() + interval '1 year'`),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('prunes expired nonces without touching the audit table', async () => {
    // Prune là `DELETE` theo `expires_at`. Test này ghép một hàng sắp hết hạn với
    // một hàng audit để chứng minh hai vòng đời độc lập — đó là lý do 0003 tách bảng
    // riêng thay vì dùng `security_events`.
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at)
         VALUES ($1, now() - interval '1 minute'), ($2, now() + interval '10 minutes')`,
        ['nonce-expired', 'nonce-alive'],
      );
      await runtime.query(
        `INSERT INTO account.security_events (type, outcome) VALUES ('test.prune', 'success')`,
      );
    } finally {
      await runtime.end();
    }

    // ⚠️ Đếm audit **trước** khi prune rồi so với sau, thay vì so với một con số cứng.
    // Một con số cứng là một phép khẳng định về lịch chạy (suite nào đã ghi gì), không
    // về hành vi của prune; và nó đọc ra như thể đang chứng minh điều nó không chứng
    // minh. Cùng lúc, chốt `> 0` để phép so không phải là 0 = 0.
    const auditor = await db.connect();
    let auditBefore: number;
    try {
      const { rows } = await auditor.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account.security_events WHERE type = 'test.prune'`,
      );
      auditBefore = Number(rows[0]?.count ?? '0');
    } finally {
      await auditor.end();
    }
    expect(auditBefore).toBeGreaterThan(0);

    // Prune chạy bằng **credential migrator** — đúng principal mà job định kỳ dùng
    // (`prune-account` truyền `DB_ACCOUNT_MIGRATOR_URL`), không phải runtime. Runtime
    // có `DELETE` trên bảng này (ngoại lệ ở `0003`), nhưng đó không phải đường mà
    // lịch chạy đi qua, nên chạy test bằng runtime chỉ chứng minh một quyền mà workflow
    // không dùng. Quyền của runtime vẫn được ghim riêng ở các test phía trên.
    const pruner = await db.asMigrator();
    try {
      const pruned = await pruner.query(
        `DELETE FROM account.internal_nonces WHERE expires_at < now() RETURNING nonce`,
      );
      expect(pruned.rows.map((row: { nonce: string }) => row.nonce)).toEqual(['nonce-expired']);
    } finally {
      await pruner.end();
    }

    const client = await db.connect();
    try {
      const nonces = await client.query<{ nonce: string }>(
        `SELECT nonce FROM account.internal_nonces ORDER BY nonce`,
      );
      expect(nonces.rows.map((row) => row.nonce)).toEqual(['nonce-alive']);

      // Audit phải còn nguyên: prune nonce không được làm mất dòng audit.
      const events = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account.security_events WHERE type = 'test.prune'`,
      );
      expect(Number(events.rows[0]?.count ?? '0')).toBe(auditBefore);
    } finally {
      await client.end();
    }
  });

  it('does not prune a nonce whose expiry falls exactly on the cut-off (strict <)', async () => {
    // ⚠️ Bài toán biên, và biên ở đây là bất biến replay: `<=` xoá thêm đúng lớp nonce
    // vừa mới hết hạn — lớp còn sát cửa sổ replay nhất, và cũng là lớp mà một lệch
    // đồng hồ nhỏ giữa hai máy đẩy vào. Không test tuần tự nào khác đỏ khi đổi `<` thành `<=`.
    //
    // Mốc so sánh ghim bằng literal chứ không `now()`: `now()` là thời điểm transaction,
    // nó nhích giữa câu ghi và câu prune, nên một hàng đặt đúng `now()` không bao giờ
    // "đúng bằng" mốc prune và bài test không chạm tới biên.
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at) VALUES
           ('nonce-boundary-before', TIMESTAMPTZ '2000-01-01 00:00:00+00' - interval '1 microsecond'),
           ('nonce-boundary-exact',  TIMESTAMPTZ '2000-01-01 00:00:00+00'),
           ('nonce-boundary-after',  TIMESTAMPTZ '2000-01-01 00:00:00+00' + interval '1 microsecond')`,
      );
    } finally {
      await runtime.end();
    }

    const pruner = await db.asMigrator();
    try {
      const pruned = await pruner.query<{ nonce: string }>(
        `DELETE FROM account.internal_nonces
          WHERE expires_at < TIMESTAMPTZ '2000-01-01 00:00:00+00'
      RETURNING nonce`,
      );
      expect(pruned.rows.map((row) => row.nonce)).toEqual(['nonce-boundary-before']);
    } finally {
      await pruner.end();
    }

    const client = await db.connect();
    try {
      const nonces = await client.query<{ nonce: string }>(
        `SELECT nonce FROM account.internal_nonces ORDER BY nonce`,
      );
      expect(nonces.rows.map((row) => row.nonce)).toEqual([
        'nonce-boundary-after',
        'nonce-boundary-exact',
      ]);
    } finally {
      await client.end();
    }
  });

  it('is idempotent: a second prune over the same window deletes nothing', async () => {
    // Prune chạy theo lịch, chạy tay, và retry sau lỗi transport — nên "chạy hai lần trên
    // cùng một kho" là chuyện thường. Lần thứ hai phải trả **0 hàng** và không ném: không
    // còn gì hết hạn là thành công, không phải lỗi.
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at)
         VALUES ($1, now() - interval '1 minute'), ($2, now() + interval '10 minutes')`,
        ['nonce-expired', 'nonce-alive'],
      );
    } finally {
      await runtime.end();
    }

    const pruner = await db.asMigrator();
    try {
      const first = await pruner.query<{ nonce: string }>(
        `DELETE FROM account.internal_nonces WHERE expires_at < now() RETURNING nonce`,
      );
      expect(first.rows.map((row) => row.nonce)).toEqual(['nonce-expired']);

      const second = await pruner.query<{ nonce: string }>(
        `DELETE FROM account.internal_nonces WHERE expires_at < now() RETURNING nonce`,
      );
      expect(second.rows).toHaveLength(0);
    } finally {
      await pruner.end();
    }

    const client = await db.connect();
    try {
      const nonces = await client.query<{ nonce: string }>(
        `SELECT nonce FROM account.internal_nonces ORDER BY nonce`,
      );
      expect(nonces.rows.map((row) => row.nonce)).toEqual(['nonce-alive']);
    } finally {
      await client.end();
    }
  });

  it('grants the runtime role exactly SELECT, INSERT and DELETE on the nonce store', async () => {
    // Grant là lớp enforce; `verifyRequest` không hề biết có grant nào tồn
    // tại. Nếu sau này ai đó thêm `UPDATE` vào `0003`, mọi test hành vi vẫn xanh
    // và chỉ mất bảo vệ — nên test này giữ ranh giới đó ở đúng tầng nó được
    // enforce. `AC-014` trong `roles.spec.ts` assert cùng thứ bằng con đường khác.
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.internal_nonces (nonce, expires_at)
         VALUES ('nonce-superuser-guard', now() + interval '1 hour')`,
      );
      const { rows } = await client.query<{ privileges: string[] }>(
        `SELECT array_agg(privilege_type)::text[] AS privileges
           FROM information_schema.role_table_grants
          WHERE table_name = 'internal_nonces' AND grantee = 'ecoma_account_runtime'`,
      );
      expect([...(rows[0]?.privileges ?? [])].toSorted()).toEqual(['DELETE', 'INSERT', 'SELECT']);
    } finally {
      await client.end();
    }
  });
});
