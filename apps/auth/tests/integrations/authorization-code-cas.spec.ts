import postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redeemAuthorizationCode } from '@ecoma-io/auth-infrastructure';
import { startAuthDatabase, type AuthDatabase } from './harness';

/**
 * CAS của authorization code trên PostgreSQL THẬT.
 *
 * Suite này thuộc `apps/auth` (app sở hữu `db-auth`) thay vì colocated trong
 * `libs/auth-infrastructure` — 06-testing.md §9 cấm "spec colocated boot
 * database thật"; đã chuyển theo đúng ý #298 PR-C.
 *
 * ⚠️ Vì sao test này phải có PostgreSQL thật mà không thay bằng fake: tính
 * đúng đắn của CAS KHÔNG nằm trong câu SQL của ta. Nó nằm ở hành vi khoá hàng
 * của PostgreSQL dưới `READ COMMITTED` khi hai transaction cùng chạy một
 * `UPDATE` có điều kiện. Một fake có thể cho đúng một winner bằng một `Map` và
 * vẫn hoàn toàn sai về điều nó dạy ta tin — cụ thể là tin rằng `SELECT` rồi
 * `UPDATE` là atomic.
 *
 * Docker là phụ thuộc cứng (fail-loud qua docker-probe của config integration
 * — không skip với exit 0).
 *
 * ⚠️ **Test này áp `apps/auth/migrations/*.sql` THẬT, không khai một bảng riêng.**
 * Lý do là đo được: bản test trước dựng bảng có cột `code_id`/`scope` và xanh
 * trong khi schema thật có `id uuid`/`code_hash`/`granted_scopes text[]`. Một
 * bảng do test tự chế là một schema thứ hai, và test xanh trên schema thứ hai
 * KHÔNG nói được gì về production. Giờ DDL của test và DDL của production là
 * cùng một tập file.
 *
 * ⚠️ Hai role, và sự tách biệt là một phần của test:
 * - `ecoma_auth_migrator` tạo schema — role runtime KHÔNG được `CREATE`.
 * - `ecoma_auth_runtime` chạy CAS — đúng role production dùng.
 * Nếu CAS chạy được bằng superuser thì test không chứng minh được gì về
 * production: nó chỉ chứng minh rằng superuser làm được mọi thứ.
 *
 * ⚠️ Database PostgreSQL đến từ **testcontainers**, dựng một container riêng cho
 * chính file này (`startAuthDatabase`): schema được dựng một lần lúc container
 * lên, migration chạy bằng đúng credential migrator thật. Không còn database dùng
 * chung qua biến môi trường, nên advisory lock của hình thức cũ không còn gì để
 * bảo vệ và đã bị xoá.
 */
let db: AuthDatabase;

function base() {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    prepare: false,
  } as const;
}

/** Kết nối bằng role runtime — role production thật sự dùng. */
function connectRuntime(max = 10): postgres.Sql {
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max,
  });
}

/** Kết nối bằng role DDL, dọn dữ liệu giữa các test. */
function connectMigrator(): postgres.Sql {
  return postgres({
    ...base(),
    user: db.migratorUser,
    password: db.migratorPassword,
    max: 1,
  });
}

/** Dựng container + schema rồi trả về cặp client runtime/migrator đã sẵn sàng. */
async function setup(): Promise<{ runtime: postgres.Sql; migrator: postgres.Sql }> {
  return { runtime: connectRuntime(), migrator: connectMigrator() };
}

/**
 * Seed một code đã cấp.
 *
 * ⚠️ Insert bằng role DDL để không phụ thuộc quyền `INSERT` của runtime vào
 * đúng câu test này — role isolation có một test riêng bên dưới.
 */
async function seedCode(
  migrator: postgres.Sql,
  values: {
    hash: string;
    sub?: string;
    clientId?: string;
    ttlSeconds?: number;
    transactionTtlSeconds?: number;
  },
): Promise<void> {
  const clientId = values.clientId ?? 'client-cas-test';
  const sub = values.sub ?? 'sub-cas-test';

  // ⚠️ Cột, ràng buộc và giá trị hợp lệ lấy từ `0001`/`0002`, không tự chế.
  // Những gì dưới đây KHÔNG phải chi tiết hình thức — mỗi cái là một CHECK
  // hoặc UNIQUE của migration đang bảo vệ một tính chất bảo mật:
  //   - `client_type='public'` đi kèm `client_secret_hash IS NULL`
  //     (client công khai không mang secret — không có secret để lộ);
  //   - `acr='urn:ecoma:acr:email-otp'` bắt buộc khi có `sub`
  //     (`identity_is_complete_check`: không được biết ai mà không biết họ
  //     xác thực với assurance nào);
  //   - `handle_hash_x` UNIQUE (mỗi transaction một handle X);
  //   - `code_challenge_method='S256'` (FR-010).
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${clientId}, 'CAS test client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;

  // ⚠️ `handle_hash_x` là `bytea` UNIQUE nên mỗi seed cần một giá trị khác nhau —
  //    dùng chuỗi `code_hash` đã có, đổi sang `bytea` bằng `convert_to`. KHÔNG
  //    dùng `digest()`: nó thuộc pgcrypto, và migration cấm `CREATE EXTENSION`
  //    trong `db-auth` (bề mặt mở rộng không cần thiết). Test phải sống trong
  //    cùng ràng buộc đó.
  //
  // ⚠️ `transaction_id` phải truyền TƯỜNG MINH: `0011` đổi cột sang `text` và
  //    DROP default `gen_random_uuid()` — application là bên mint id (43 ký tự
  //    base64url), database không tự sinh nữa. Chuỗi `tx-` + hash chỉ cần
  //    UNIQUE theo seed, không có CHECK format ở cột này.
  const transactionId = await migrator<{ id: string }[]>`
    INSERT INTO auth.authorization_transactions (
      transaction_id, state, client_id, redirect_uri, code_challenge,
      code_challenge_method, requested_scopes, client_state, handle_hash_x,
      browser_binding_hash, sub, key_version, expires_at, acr, authn_at
    )
    VALUES (
      ${`tx-${values.hash}`}, 'completed', ${clientId}, 'https://app.example.com/cb',
      'challenge-cas', 'S256', ARRAY['openid'], 'state-cas',
      convert_to(${`x-${values.hash}`}, 'UTF8'), convert_to(${`b-${values.hash}`}, 'UTF8'),
      ${sub}, 1,
      now() + make_interval(secs => ${values.transactionTtlSeconds ?? 600}),
      'urn:ecoma:acr:email-otp', now()
    )
    RETURNING transaction_id AS id
  `;

  await migrator`
    INSERT INTO auth.authorization_codes
      (code_hash, authorization_transaction_id, sub, client_id, redirect_uri,
       code_challenge, granted_scopes, expires_at)
    VALUES (
      ${values.hash}, ${transactionId[0]?.id as string}, ${sub}, ${clientId},
      'https://app.example.com/cb', 'challenge-cas', ARRAY['openid'],
      now() + make_interval(secs => ${values.ttlSeconds ?? 600})
    )
  `;
}

/**
 * Dọn dữ liệu của một lần seed.
 *
 * ⚠️ Xoá transaction **sau khi** xoá code: `authorization_codes` có FK
 * `ON DELETE RESTRICT` sang transaction, và `authorization_transactions` có
 * UNIQUE trên `handle_hash_x`. Bỏ qua bước này thì lần chạy thứ hai của cùng
 * một test va vào UNIQUE — tức là một suite chỉ xanh lần đầu, đúng cái loại lỗi
 * mà `nx cache` che thêm một tầng nữa.
 */
async function cleanSeed(migrator: postgres.Sql, hashes: string[]): Promise<void> {
  await migrator`
    DELETE FROM auth.authorization_codes WHERE code_hash IN ${migrator(hashes)}
  `;
  await migrator`
    DELETE FROM auth.authorization_transactions
     WHERE handle_hash_x IN ${migrator(hashes.map((h) => `x-${h}`))}
  `;
}

describe('redeemAuthorizationCode — on real PostgreSQL', () => {
  // Container riêng của file này, dựng một lần cho cả suite; các test tự mở
  // cặp client qua `setup()` và tự đóng trong `finally`.
  beforeAll(async () => {
    db = await startAuthDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  describe('schema', () => {
    it('the adapter matches the migration: it has every column the migration declares', async () => {
      // ⚠️ Test này chốt lại chính lớp lỗi đã gặp: câu SQL của adapter tham
      // chiếu một cột mà migration không có, và mọi test khác vẫn có thể xanh
      // nếu chúng không chạy SQL đó. Ở đây ta hỏi database, không hỏi code.
      const { runtime, migrator } = await setup();
      try {
        await seedCode(migrator, { hash: 'hash-schema-probe' });

        const result = await redeemAuthorizationCode(runtime as never, {
          codeHash: 'hash-schema-probe',
          consumedBy: 'test/schema-probe',
          now: new Date(),
        });

        expect(result.outcome).toBe('won');
      } finally {
        await cleanSeed(migrator, ['hash-schema-probe']);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('single-winner under contention', () => {
    it('TWO requests hit the same code — exactly ONE wins', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedCode(migrator, { hash: 'hash-race-1' });

        // Gọi SONG SONG, không await lần lượt. Đây là toàn bộ điểm của test —
        // và `max: 10` ở `connectRuntime` là điều kiện để hai transaction thật
        // sự chạy song song thay vì xếp hàng trên một connection.
        const outcomes = await Promise.all([
          redeemAuthorizationCode(runtime as never, {
            codeHash: 'hash-race-1',
            consumedBy: 'test/a',
            now: new Date(),
          }),
          redeemAuthorizationCode(runtime as never, {
            codeHash: 'hash-race-1',
            consumedBy: 'test/b',
            now: new Date(),
          }),
        ]).then((results) => results.map((r) => r.outcome));

        // ⚠️ KHÔNG assert thứ tự `['won','lost']`. Ai thắng là KẾT QUẢ của
        // race ở tầng PostgreSQL, không phải hợp đồng của hệ thống — một test
        // ghim thứ tự đó là một test chạy đôi lần sẽ đỏ ngẫu nhiên, và người
        // đọc sẽ tưởng có race trong CAS. Hợp đồng chỉ là: **đúng MỘT** thắng.
        expect(outcomes.toSorted()).toEqual(['lost', 'won']);
        // Chỉ MỘT lần consume được ghi nhận, và nó ghi đúng `consumed_by` của
        // người thắng — cột này là đường điều tra, nên phải trỏ về request thật.
        const rows = await migrator<{ consumed_by: string | null }[]>`
          SELECT consumed_by FROM auth.authorization_codes WHERE code_hash = 'hash-race-1'
        `;
        expect(['test/a', 'test/b']).toContain(rows[0]?.consumed_by);
      } finally {
        await cleanSeed(migrator, ['hash-race-1']);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('THREE requests hit it — STILL exactly ONE wins', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedCode(migrator, { hash: 'hash-race-3' });

        const outcomes = await Promise.all(
          ['test/1', 'test/2', 'test/3'].map((who) =>
            redeemAuthorizationCode(runtime as never, {
              codeHash: 'hash-race-3',
              consumedBy: who,
              now: new Date(),
            }),
          ),
        ).then((results) => results.map((r) => r.outcome).toSorted());

        expect(outcomes).toEqual(['lost', 'lost', 'won']);
      } finally {
        await cleanSeed(migrator, ['hash-race-3']);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('an expired code — nobody wins, and it is indistinguishable from one already consumed', async () => {
      const { runtime, migrator } = await setup();
      try {
        // ⚠️ Transaction vẫn còn hạn; CHỈ code hết hạn. Migration có CHECK
        // `expires_at > created_at` cho transaction, nên hạm hết hạn ở cả hai
        // là seed sai — và một seed sai làm test đo thứ khác với thứ nó tưởng.
        await seedCode(migrator, {
          hash: 'hash-expired',
          ttlSeconds: -60,
          transactionTtlSeconds: 600,
        });
        // Code đã bị consume trước, để so sánh hai trường hợp "không thắng".
        await seedCode(migrator, { hash: 'hash-consumed' });
        const first = await redeemAuthorizationCode(runtime as never, {
          codeHash: 'hash-consumed',
          consumedBy: 'test/first',
          now: new Date(),
        });
        expect(first.outcome).toBe('won');

        const expired = await redeemAuthorizationCode(runtime as never, {
          codeHash: 'hash-expired',
          consumedBy: 'test/expired',
          now: new Date(),
        });
        const replayed = await redeemAuthorizationCode(runtime as never, {
          codeHash: 'hash-consumed',
          consumedBy: 'test/replay',
          now: new Date(),
        });
        const unknown = await redeemAuthorizationCode(runtime as never, {
          codeHash: 'hash-khong-ton-tai',
          consumedBy: 'test/unknown',
          now: new Date(),
        });

        // ⚠️ Cả ba PHẢI giống hệt nhau. Phân biệt chúng là oracle: client biết
        // code có tồn tại không, và từ đó dò được code của người khác.
        expect(expired.outcome).toBe('lost');
        expect(replayed.outcome).toBe('lost');
        expect(unknown.outcome).toBe('lost');
        expect(expired.row).toBeUndefined();
        expect(replayed.row).toBeUndefined();
        expect(unknown.row).toBeUndefined();

        // ⚠️ Và code hết hạn KHÔNG bị đánh dấu consumed — `expires_at > $2`
        // nằm trong cùng câu UPDATE. Đánh dấu nó là burn một code vốn đã chết.
        const rows = await migrator<{ consumed_at: Date | null }[]>`
          SELECT consumed_at FROM auth.authorization_codes WHERE code_hash = 'hash-expired'
        `;
        expect(rows[0]?.consumed_at).toBeNull();
      } finally {
        await cleanSeed(migrator, ['hash-expired', 'hash-consumed']);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('the runtime role must not be created by migration — DDL belongs to the migrator', async () => {
      // ⚠️ Không có test này thì "runtime role bị giới hạn quyền" chỉ là lời
      // hứa trong tài liệu. Nó phải là một khẳng định của suite.
      const { runtime, migrator } = await setup();
      try {
        await expect(runtime.unsafe('CREATE TABLE should_not_work (x int)')).rejects.toThrow(
          /permission denied/u,
        );
      } finally {
        await migrator.unsafe('DROP TABLE IF EXISTS should_not_work');
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('permission grants', () => {
    it('the runtime cannot CREATE a table in the auth schema', async () => {
      // Thay cho marker test cũ của hình thức chia sẻ database qua biến môi
      // trường ("set … to run the single-winner tests") — marker ấy hết ý nghĩa
      // khi database tự dựng bằng testcontainers. Vị trí của nó giờ là một assert
      // thật về ranh quyền: role runtime chỉ DML, và đây là lớp enforce thật
      // (catalog), không phải một quy ước trong review.
      const { runtime, migrator } = await setup();
      try {
        await expect(
          runtime.unsafe('CREATE TABLE should_not_work (id text PRIMARY KEY)'),
        ).rejects.toThrow(/permission denied/iu);
        const rows = await migrator<
          { n: string }[]
        >`SELECT count(*)::text AS n FROM information_schema.tables
           WHERE table_schema = 'auth' AND table_name = 'should_not_work'`;
        expect(rows[0]?.n).toBe('0');
      } finally {
        await migrator.unsafe('DROP TABLE IF EXISTS should_not_work');
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });
});
