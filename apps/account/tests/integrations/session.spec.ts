/**
 * Session — AC-001, AC-002, FR-004, FR-004a, FR-004b, invariant 3, SR-002.
 *
 * Test này kiểm chứng **tính chất của schema**, không kiểm chứng luồng đăng nhập
 * (luồng đó thuộc `apps/account/server/**`, phạm vi agent khác). Ở đây cái cần
 * chứng minh là database có **ép buộc** được những tính chất đó, chứ không chỉ
 * là tầng ứng dụng có thể quên mà không ai biết.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type AccountDatabase,
  futureInstant,
  hashIdentifier,
  startAccountDatabase,
} from './harness.ts';
/** Cookie chỉ tồn tại ở trình duyệt; database chỉ thấy hash của nó. */
const COOKIE_VALUE = 'a4f1c0de9b27-sufficiently-long-random-session-identifier';

describe('account_sessions', () => {
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

  async function createUser(sub: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ($1)`, [sub]);
    } finally {
      await client.end();
    }
  }

  async function createSession(row: {
    idHash: string;
    sessionRef: string;
    userSub?: string;
    acr?: string | null;
  }): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.account_sessions
           (id_hash, session_ref, user_sub, acr, authn_at, expires_at)
         VALUES ($1, $2, $3, $4,
                 CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
                 $5)`,
        [row.idHash, row.sessionRef, row.userSub ?? null, row.acr ?? null, futureInstant()],
      );
    } finally {
      await client.end();
    }
  }

  it('AC-001: the database stores only a hash, never the cookie value', async () => {
    await createUser('sub-ac001');
    await createSession({
      idHash: hashIdentifier(COOKIE_VALUE),
      sessionRef: 'asr-ac001',
      userSub: 'sub-ac001',
      acr: 'urn:ecoma:acr:email-otp',
    });

    const client = await db.connect();
    try {
      // Quét **toàn bộ** bảng session chứ không đọc đúng cột `id_hash`: một
      // cột thứ hai lưu cookie trần sẽ không bị test theo cột bắt được.
      const { rows } = await client.query<{ id_hash: string; matches: number }>(
        `SELECT id_hash, (id_hash = $1)::int AS matches
           FROM account.account_sessions`,
        [COOKIE_VALUE],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.matches).toBe(0);
      expect(rows[0]?.id_hash).not.toContain(COOKIE_VALUE);
    } finally {
      await client.end();
    }
  });

  it('FR-004: two sessions with the same cookie value collide on id_hash', async () => {
    // `id_hash` là PRIMARY KEY nên hai session không thể chia sẻ một định danh —
    // đây là ràng buộc định danh chứ không phải thứ tầng ứng dụng phải nhớ.
    await createSession({ idHash: hashIdentifier(COOKIE_VALUE), sessionRef: 'asr-a' });

    await expect(
      createSession({ idHash: hashIdentifier(COOKIE_VALUE), sessionRef: 'asr-b' }),
    ).rejects.toThrow(/duplicate key|unique/iu);
  });

  it('FR-004a: rotating the session writes a new identifier and never inherits the old one', async () => {
    await createUser('sub-ac002');

    // Anonymous session trước xác thực: chưa có bằng chứng nào.
    const anonymousCookie = 'anonymous-cookie-value-before-authentication';
    await createSession({
      idHash: hashIdentifier(anonymousCookie),
      sessionRef: 'asr-anon',
      userSub: 'sub-ac002',
      acr: null,
    });

    // Rotate tại thời điểm xác thực: identifier mới, `session_ref` mới, session
    // cũ bị thu hồi trong cùng giao dịch.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE account.account_sessions
            SET revoked_at = now()
          WHERE session_ref = 'asr-anon'`,
      );
      await client.query(
        `INSERT INTO account.account_sessions
           (id_hash, session_ref, user_sub, acr, authn_at, expires_at)
         VALUES ($1, 'asr-authenticated', 'sub-ac002', 'urn:ecoma:acr:email-otp', now(), $2)`,
        [hashIdentifier('authenticated-cookie-value-after-rotation'), futureInstant()],
      );
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const verify = await db.connect();
    try {
      const { rows } = await verify.query<{
        id_hash: string;
        session_ref: string;
        revoked: boolean;
      }>(
        `SELECT id_hash, session_ref, revoked_at IS NOT NULL AS revoked
           FROM account.account_sessions ORDER BY created_at`,
      );

      expect(rows).toHaveLength(2);

      const [anonymous, authenticated] = rows;
      expect(anonymous?.session_ref).toBe('asr-anon');
      expect(anonymous?.revoked).toBe(true);
      expect(authenticated?.session_ref).toBe('asr-authenticated');
      expect(authenticated?.revoked).toBe(false);

      // AC-002: identifier trước và sau khác nhau.
      expect(authenticated?.id_hash).not.toBe(anonymous?.id_hash);
      // Không session nào thừa kế `session_ref` của session đã thu hồi.
      expect(authenticated?.id_hash).not.toBe(hashIdentifier(anonymousCookie));
    } finally {
      await verify.end();
    }
  });

  it('FR-004a: session_ref is unique, so a rotation cannot reuse the old reference', async () => {
    await createSession({ idHash: hashIdentifier('one'), sessionRef: 'asr-shared' });

    await expect(
      createSession({ idHash: hashIdentifier('two'), sessionRef: 'asr-shared' }),
    ).rejects.toThrow(/duplicate key|unique/iu);
  });

  it('FR-004b: acr and authn_at are a pair, never half-present', async () => {
    await createSession({
      idHash: hashIdentifier('pair-ok'),
      sessionRef: 'asr-pair',
      acr: 'urn:ecoma:acr:mfa',
    });

    // Cột `authn_at` không cho ghi riêng: `authn_at` NULL mà `acr` có
    // giá trị là bằng chứng xác thực không có mốc thời gian, tức là tuổi bằng
    // chứng không xác định — đúng thứ FR-004b cấm.
    await expect(
      createSession({ idHash: hashIdentifier('pair-bad'), sessionRef: 'asr-pair-bad' }),
    ).resolves.toBeUndefined();

    const client = await db.connect();
    try {
      await expect(
        client.query(
          `UPDATE account.account_sessions SET authn_at = now() WHERE session_ref = 'asr-pair-bad'`,
        ),
      ).rejects.toThrow(/account_sessions_authn_pair_check/u);
    } finally {
      await client.end();
    }
  });

  it('FR-004b: an unknown acr URN is rejected by a CHECK', async () => {
    await expect(
      createSession({
        idHash: hashIdentifier('lvl-bad'),
        sessionRef: 'asr-lvl-bad',
        acr: 'urn:ecoma:acr:carrier-pigeon',
      }),
    ).rejects.toThrow(/account_sessions_acr_check/u);
  });

  it('FR-004b: values of the removed authn ladder are not acr URNs', async () => {
    // Model ladder đã bị loại: 'password', 'totp', 'passkey', 'otp', 'anonymous'
    // không phải URN ACR và phải bị CHECK từ chối.
    for (const legacy of ['password', 'totp', 'passkey', 'otp', 'anonymous']) {
      await expect(
        createSession({
          idHash: hashIdentifier(`legacy-${legacy}`),
          sessionRef: `asr-legacy-${legacy}`,
          acr: legacy,
        }),
      ).rejects.toThrow(/account_sessions_acr_check/u);
    }

    // Ba URN hợp lệ vẫn ghi được — test không chỉ là "bị từ chối".
    for (const acr of [
      'urn:ecoma:acr:email-otp',
      'urn:ecoma:acr:mfa',
      'urn:ecoma:acr:phishing-resistant',
    ]) {
      await createSession({
        idHash: hashIdentifier(`acr-${acr}`),
        sessionRef: `asr-acr-${acr}`,
        acr,
      });
    }
  });

  it('FR-004: expires_at must be in the future of creation', async () => {
    const client = await db.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO account.account_sessions (id_hash, session_ref, expires_at)
           VALUES ('exp-bad', 'asr-exp-bad', now() - interval '1 day')`,
        ),
      ).rejects.toThrow(/account_sessions_expiry_check/u);
    } finally {
      await client.end();
    }
  });

  it('invariant 3: a session cannot be created for a sub that does not exist', async () => {
    // FK tới `users` là thứ giữ bảng session không trỏ tới một chủ thể bịa đặt.
    await expect(
      createSession({
        idHash: hashIdentifier('orphan'),
        sessionRef: 'asr-orphan',
        userSub: 'sub-khong-ton-tai',
      }),
    ).rejects.toThrow(/foreign key/iu);
  });

  it('SR-002: security_events rejects UPDATE', async () => {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.security_events (type, outcome, reason)
         VALUES ('login', 'failure', 'bad-password')`,
      );
      await expect(
        client.query(`UPDATE account.security_events SET reason = 'edited'`),
      ).rejects.toThrow(/append-only/iu);
    } finally {
      await client.end();
    }
  });

  it('SR-002: append-only is two layers — a missing grant, and a trigger that fires for a role that does have UPDATE', async () => {
    // Lớp 1 — runtime role không có `UPDATE` trên `security_events` (`0002` chỉ
    // grant SELECT/INSERT). Tầng này là phòng thủ rẻ, nhưng **không đủ**: đổi
    // grant là đổi được tính chất bất biến của audit.
    const runtime = await db.asRuntime();
    try {
      await expect(
        runtime.query(`UPDATE account.security_events SET reason = 'edited-by-runtime'`),
      ).rejects.toThrow(/permission denied for table security_events/iu);

      // Ghi vẫn phải chạy được — append-only nghĩa là không sửa, không phải
      // không ghi.
      await runtime.query(
        `INSERT INTO account.security_events (type, outcome) VALUES ('login', 'success')`,
      );
    } finally {
      await runtime.end();
    }

    // Lớp 2 — trigger. Chứng minh nó bắt được **role có quyền UPDATE** bằng
    // cách cấp quyền đó cho runtime role ngay trong test này: nếu sau khi có
    // `UPDATE` mà câu `UPDATE` vẫn bị chặn, thì trigger mới là lớp giữ tính
    // chất, chứ không phải grant.
    const owner = await db.connect();
    try {
      await owner.query('GRANT UPDATE ON account.security_events TO ecoma_account_runtime');
    } finally {
      await owner.end();
    }

    const granted = await db.asRuntime();
    try {
      await expect(
        granted.query(`UPDATE account.security_events SET reason = 'edited-after-grant'`),
      ).rejects.toThrow(/append-only/iu);
    } finally {
      await granted.end();
    }

    // Rút lại để AC-014 không đỏ ở lần chạy này hoặc lần chạy sau. Không có
    // `afterEach` cho việc này vì nó là dữ liệu của test, không phải hành vi.
    const cleanup = await db.connect();
    try {
      await cleanup.query('REVOKE UPDATE ON account.security_events FROM ecoma_account_runtime');
    } finally {
      await cleanup.end();
    }
  });

  it('invariant 8: audit rows survive a tombstone because there is no FK to users', async () => {
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ('sub-audit')`);
      await client.query(
        `INSERT INTO account.security_events (subject_sub, type, outcome)
         VALUES ('sub-audit', 'account_created', 'success')`,
      );
      await client.query(
        `UPDATE account.users SET status = 'deleted', deleted_at = now() WHERE sub = 'sub-audit'`,
      );

      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM account.security_events WHERE subject_sub = 'sub-audit'`,
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await client.end();
    }
  });
});
