/**
 * Tombstone — AC-005, AC-008l, FR-001, FR-012c, FR-012d, FR-012e, invariant 7.
 *
 * Tombstone là **nhóm dữ liệu (1)** của `01-architecture.md` §7.1: nhóm duy
 * nhất được giữ lâu dài, và chỉ vì lý do kỹ thuật. Hai điều phải đúng cùng
 * lúc: nó giữ `sub` để `sub` không bao giờ bị tái phát hành, **và** nó không
 * giữ gì định danh.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type AccountDatabase, startAccountDatabase } from './harness.ts';
describe('users and the tombstone', () => {
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

  it('AC-005: a sub that has been tombstoned cannot be issued again', async () => {
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ('sub-ac005')`);
      await client.query(
        `UPDATE account.users SET status = 'deleted', deleted_at = now() WHERE sub = 'sub-ac005'`,
      );

      // FR-001 / FR-012d: identifier reuse bị từ chối bởi chính PRIMARY KEY.
      await expect(
        client.query(`INSERT INTO account.users (sub) VALUES ('sub-ac005')`),
      ).rejects.toThrow(/duplicate key|unique/iu);

      // Và một "sub mới" cho account mới vẫn khác `sub` cũ.
      await client.query(`INSERT INTO account.users (sub) VALUES ('sub-ac005-new')`);
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.users`,
      );
      expect(rows[0]?.count).toBe(2);
    } finally {
      await client.end();
    }
  });

  it('AC-005: the tombstone row survives the delete and is never removed', async () => {
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ('sub-ac005-keep')`);
      await client.query(
        `UPDATE account.users SET status = 'deleted', deleted_at = now() WHERE sub = 'sub-ac005-keep'`,
      );

      const { rows } = await client.query<{ sub: string; status: string }>(
        `SELECT sub, status FROM account.users WHERE sub = 'sub-ac005-keep'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('deleted');
    } finally {
      await client.end();
    }
  });

  it('FR-001: the runtime role has no DELETE on users, so a tombstone cannot be freed', async () => {
    // Tombstone là nhóm (1), nhóm duy nhất được giữ vĩnh viễn
    // (`01-architecture.md` §7.1). DELETE trên `users` giải phóng PK `sub` —
    // mở lại đường tái phát hành identifier mà FR-001 / FR-012d cấm — nên
    // `0002` cố ý **không** cấp `DELETE` cho runtime role. Chạy bằng credential
    // **thật** (không `SET ROLE`) để đo đúng lớp grant, không phải tầng ứng dụng.
    const seeder = await db.connect();
    try {
      await seeder.query(`INSERT INTO account.users (sub) VALUES ('sub-no-delete')`);
      await seeder.query(
        `UPDATE account.users SET status = 'deleted', deleted_at = now() WHERE sub = 'sub-no-delete'`,
      );
    } finally {
      await seeder.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`DELETE FROM account.users WHERE sub = 'sub-no-delete'`),
      ).rejects.toThrow(/permission denied for table users/iu);
    } finally {
      await runtime.end();
    }

    // Hàng tombstone vẫn còn: không có DELETE nào lọt qua.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM account.users WHERE sub = 'sub-no-delete'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('deleted');
    } finally {
      await client.end();
    }
  });

  it('FR-012d: a tombstoned row rejects every UPDATE, so it cannot be resurrected', async () => {
    // CHECK `users_deleted_at_check` chỉ giữ cặp (status, deleted_at) nhất quán:
    // `deleted → active` kèm xóa deleted_at là cặp **hợp lệ** theo DB. Runtime
    // role có UPDATE trên `users` (FR-012 suspend cần), nên chặn "hồi sinh" phải
    // là trigger `users_tombstone_immutable` ở tầng database — đúng mẫu mà
    // `security_events_append_only` dùng cho audit.
    const seeder = await db.connect();
    try {
      await seeder.query(`INSERT INTO account.users (sub) VALUES ('sub-resurrect')`);
    } finally {
      await seeder.end();
    }

    const runtime = await db.asRuntime();
    try {
      // Đường hợp lệ trước: active → deleted vẫn là UPDATE bình thường.
      await runtime.query(
        `UPDATE account.users SET status = 'deleted', deleted_at = now() WHERE sub = 'sub-resurrect'`,
      );

      // Hồi sinh: cặp status/deleted_at hợp lệ theo CHECK — chỉ trigger chặn.
      await expect(
        runtime.query(
          `UPDATE account.users SET status = 'active', deleted_at = NULL WHERE sub = 'sub-resurrect'`,
        ),
      ).rejects.toThrow(/khong duoc UPDATE/iu);

      // Mọi UPDATE khác trên row tombstone cũng bị chặn, kể cả cột không phải
      // status: tombstone là dấu vết cuối cùng, không cột nào được sửa.
      await expect(
        runtime.query(`UPDATE account.users SET updated_at = now() WHERE sub = 'sub-resurrect'`),
      ).rejects.toThrow(/khong duoc UPDATE/iu);
    } finally {
      await runtime.end();
    }

    // Row vẫn là tombstone nguyên vẹn.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ status: string; deleted_at: Date | null }>(
        `SELECT status, deleted_at FROM account.users WHERE sub = 'sub-resurrect'`,
      );
      expect(rows[0]?.status).toBe('deleted');
      expect(rows[0]?.deleted_at).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  it('FR-012e: the tombstone holds only sub, status and the deletion timestamp', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'account' AND table_name = 'users'
          ORDER BY column_name`,
      );

      // FR-012e đòi tombstone giữ **tối thiểu**. Vì bảng này vốn đã là toàn bộ
      // dữ liệu của nhóm (1), hình dạng cột là bằng chứng cho tuyên bố đó: một
      // cột định danh thừa ở đây là một cột phải được biện minh riêng, và
      // không có lý do nào được chấp nhận.
      expect(rows.map((row) => row.column_name)).toEqual([
        'created_at',
        'deleted_at',
        'status',
        'sub',
        'updated_at',
      ]);
    } finally {
      await client.end();
    }
  });

  it('FR-012e: no column anywhere in the schema holds an email, display name or profile', async () => {
    // AC-008l quét tombstone "không có trường nhận diện hay dữ liệu chức năng".
    // Quét tên cột trên **toàn schema** thay vì chỉ `users`, vì một cột định danh
    // đặt sai bảng vẫn là dữ liệu định danh.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ column_name: string; table_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'account'
            AND (
              column_name ~* 'email|name|display|profile|avatar|phone|address'
              OR data_type = 'inet'
            )
          ORDER BY table_name, column_name`,
      );

      // Ngoại lệ **có chủ đích** và phải được nêu tên từng cột — thêm một cột
      // định danh mới mà không ghi vào đây là test đỏ, buộc việc thêm đó phải
      // được biện minh:
      // - `security_events.ip`: audit phải giữ IP + user-agent
      //   (`01-architecture.md` §3.2); retention nhóm (3) là quyết định còn mở.
      // - `email_addresses.address_normalized|address_hash` và
      //   `otp_challenges.address_hash`: luồng đăng nhập email-OTP (0005/0006)
      //   cần địa chỉ đã xác minh của chính chủ tài khoản — đây là nhà duy nhất
      //   của dữ liệu địa chỉ trong schema, còn tombstone `users` vẫn giữ đúng
      //   sub/status/deleted_at như test phía trên khẳng định. `otp_challenges`
      //   chỉ giữ **hash** (không lưu địa chỉ thô), còn `email_addresses` giữ cả
      //   hai: hash để tra cứu, dạng chuẩn hoá để chủ tài khoản xem được địa chỉ
      //   của mình.
      // - `user_profiles.display_name|avatar_url` và
      //   `user_preferences.locale|timezone`: data domain v1 (`0008`) — tên
      //   hiển thị, avatar và preference là dữ liệu định nghĩa của nhóm (2),
      //   theo docs §3.2/§3.3. Bảng tombstone `users` không đổi.
      const namedExceptions = new Set([
        'security_events.ip',
        'email_addresses.address_normalized',
        'email_addresses.address_hash',
        'otp_challenges.address_hash',
        'user_profiles.display_name',
        'user_profiles.avatar_url',
        'user_preferences.locale',
        'user_preferences.timezone',
      ]);
      const unexpected = rows.filter(
        (row) => !namedExceptions.has(`${row.table_name}.${row.column_name}`),
      );

      expect(unexpected).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('FR-012: status is constrained to the three states in the design', async () => {
    const client = await db.connect();
    try {
      await expect(
        client.query(`INSERT INTO account.users (sub, status) VALUES ('sub-bad', 'banned')`),
      ).rejects.toThrow(/users_status_check/u);
    } finally {
      await client.end();
    }
  });

  it('FR-012e: a deleted row must carry its deletion timestamp, and a live one must not', async () => {
    const client = await db.connect();
    try {
      // `deleted` mà không có mốc thời gian thì tombstone mất đúng thứ duy nhất
      // nó giữ ngoài `sub`.
      await expect(
        client.query(`INSERT INTO account.users (sub, status) VALUES ('sub-x', 'deleted')`),
      ).rejects.toThrow(/users_deleted_at_check/u);

      // `active` mà có mốc xoá thì trạng thái tự mâu thuẫn với chính nó.
      await expect(
        client.query(
          `INSERT INTO account.users (sub, status, deleted_at)
           VALUES ('sub-y', 'active', now())`,
        ),
      ).rejects.toThrow(/users_deleted_at_check/u);
    } finally {
      await client.end();
    }
  });

  it('invariant 6: the outbox row is written in the same transaction as the state change', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO account.users (sub) VALUES ('sub-outbox')`);
      await client.query(
        `INSERT INTO account.account_outbox_events
           (event_id, aggregate_id, event_type, payload)
         VALUES ('evt-1', 'sub-outbox', 'user.created', '{"acr":null}')`,
      );
      await client.query('COMMIT');

      const { rows } = await client.query<{ event_id: string; published_at: Date | null }>(
        `SELECT event_id, published_at FROM account.account_outbox_events WHERE aggregate_id = 'sub-outbox'`,
      );
      expect(rows).toHaveLength(1);
      // Chưa publish — đó là bước "sau" của invariant 6, và nó phải là việc của
      // relay, không phải việc ghi trạng thái.
      expect(rows[0]?.published_at).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('FR-006n: the outbox idempotency key is unique, so a retry cannot duplicate an event', async () => {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.account_outbox_events (event_id, aggregate_id, event_type)
         VALUES ('evt-idem', 'sub-idem', 'user.suspended')`,
      );
      await expect(
        client.query(
          `INSERT INTO account.account_outbox_events (event_id, aggregate_id, event_type)
           VALUES ('evt-idem', 'sub-idem', 'user.suspended')`,
        ),
      ).rejects.toThrow(/duplicate key|unique/iu);
    } finally {
      await client.end();
    }
  });

  it('NFR-001: every timestamp column is timestamptz', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'account'
            AND (
              column_name LIKE '%_at'
              OR column_name IN ('expires_at', 'revoked_at', 'deleted_at', 'bound_at', 'published_at')
            )
          ORDER BY table_name, column_name`,
      );

      expect(rows.length).toBeGreaterThan(0);
      // `timestamptz` là cách lưu UTC ở tầng PostgreSQL: giá trị luôn là một
      // mốc thời gian tuyệt đối, hiển thị theo `TimeZone` của session chứ không
      // lưu một giờ địa phương.
      const nonUtc = rows.filter((row) => row.data_type !== 'timestamp with time zone');
      expect(nonUtc).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('NFR-001: a timestamp is stored identically regardless of the session TimeZone', async () => {
    // Kiểm chứng thật của NFR-001, không chỉ kiểm kiểu cột: cùng một mốc thời
    // gian phải đọc ra cùng một giá trị bất kể session đặt `TimeZone` thế nào.
    const client = await db.connect();
    try {
      await client.query(`SET TIME ZONE 'UTC'`);
      await client.query(`INSERT INTO account.users (sub) VALUES ('sub-tz')`);
      const utc = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM account.users WHERE sub = 'sub-tz'`,
      );

      await client.query(`SET TIME ZONE 'Asia/Ho_Chi_Minh'`);
      const local = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM account.users WHERE sub = 'sub-tz'`,
      );

      expect(local.rows[0]?.created_at.toISOString()).toBe(utc.rows[0]?.created_at.toISOString());
    } finally {
      await client.end();
    }
  });

  it('every table in the schema has exactly the indexes its constraints justify', async () => {
    const client = await db.connect();
    try {
      // Không có index "cho chắc": mỗi index phải trả lời được cho một truy vấn
      // hoặc một ràng buộc cụ thể (`01-architecture.md` §3.2). Test này liệt kê
      // index của bảng không có index nào thừa, để thêm index phải sửa cả danh
      // sách này.
      // Đọc cờ `indisprimary`/`indisunique` thay vì phân tích chuỗi `indexdef`:
      // PostgreSQL render PRIMARY KEY thành `CREATE UNIQUE INDEX <t>_pkey`, nên
      // `indexdef` không bao giờ chứa "primary key" — parse text sẽ đếm sai.
      const { rows } = await client.query<{
        table_name: string;
        is_primary: boolean;
        is_unique: boolean;
      }>(
        // `relname` chứ không phải `indrelid::regclass::text`: `regclass::text`
        // ghi kèm schema khi schema không nằm trên `search_path`, nên khóa
        // bản đồ sẽ là `account.login_handoffs` chứ không phải `login_handoffs`.
        `SELECT c.relname::text   AS table_name,
                i.indisprimary    AS is_primary,
                i.indisunique    AS is_unique
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'account'
            AND c.relkind IN ('r', 'p')
          ORDER BY c.relname, i.indexrelid`,
      );

      const perTable = new Map<string, { primary: number; unique: number; plain: number }>();
      for (const row of rows) {
        const kind = row.is_primary ? 'primary' : row.is_unique ? 'unique' : 'plain';
        const current = perTable.get(row.table_name) ?? { primary: 0, unique: 0, plain: 0 };
        current[kind] += 1;
        perTable.set(row.table_name, current);
      }

      const summary = Object.fromEntries(perTable);

      // `login_handoffs`: PRIMARY KEY (handle_hash) là cơ chế first-binding-wins
      // nên **không** có thêm UNIQUE trùng lặp; chỉ một index thường, gắn với
      // câu DELETE dọn hết hạn.
      expect(summary['login_handoffs']).toEqual({ primary: 1, unique: 0, plain: 1 });
      // `account_sessions`: PK, UNIQUE của session_ref, và index phục vụ
      // truy vấn session theo sub.
      expect(summary['account_sessions']).toEqual({ primary: 1, unique: 1, plain: 1 });
      // `users` và `security_events` không có cột nào cần index thứ hai: PK của
      // `users`, và index theo `subject_sub` của audit.
      expect(summary['users']).toEqual({ primary: 1, unique: 0, plain: 0 });
      expect(summary['security_events']).toEqual({ primary: 1, unique: 0, plain: 1 });
      // Outbox: PK là idempotency key, và một partial index cho relay.
      expect(summary['account_outbox_events']).toEqual({ primary: 1, unique: 0, plain: 1 });
      // Kho nonce: PK là trọng tài của phep "kiểm tra và ghi" của `claimNonce`, và
      // một index thường chỉ phục vụ câu prune theo `expires_at`.
      expect(summary['internal_nonces']).toEqual({ primary: 1, unique: 0, plain: 1 });
      // Địa chỉ email: PK, UNIQUE partial của ownership (verified-hash), và index
      // theo user_sub cho truy vấn "mọi email của một sub".
      expect(summary['email_addresses']).toEqual({ primary: 1, unique: 1, plain: 1 });
      // Challenge OTP: PK, UNIQUE partial của one-active-challenge (đồng thời là
      // index tra cứu active), và index (address_hash, created_at) cho rate-limit.
      expect(summary['otp_challenges']).toEqual({ primary: 1, unique: 1, plain: 1 });
    } finally {
      await client.end();
    }
  });
});
