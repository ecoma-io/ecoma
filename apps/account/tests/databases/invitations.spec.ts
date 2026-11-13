/**
 * Database test cho kênh lời mời (ADR-0030) — schema `0012` + birth-guard
 * `0013` + transaction chấp nhận của `server/lib/invitation.ts` trên PostgreSQL
 * thật (testcontainers).
 *
 * Đo những thứ mà chỉ tầng database đo được:
 * - Bất biến giữ bởi ràng buộc: một-lời-mời-mở (partial UNIQUE), lifecycle
 *   forward-only (trigger), cặp accepted (CHECK), không DELETE cho runtime.
 * - Birth-guard của `0013`: runtime chỉ INSERT được `users` khi dữ liệu chấp
 *   nhận lời mời tồn tại trong transaction — và migrator đi qua không kiểm
 *   (bootstrap giữ nguyên).
 * - Transaction chấp nhận chạy trọn: Account + email verified + lời mời
 *   accepted + provenance + session cùng commit; mọi nhánh từ chối rollback
 *   sạch và không để lại hàng mồ côi.
 *
 * ⚠️ Suite bắt buộc Docker: probe hỏng thì `globalSetup` ném và toàn bộ lần chạy
 * đỏ (fail-loud, 06-testing.md §6).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Subject } from '@ecoma-io/account-domain';

import { startAccountDatabase, type AccountDatabase } from '../integrations/harness.ts';
import {
  acceptInvitationAndCreateAccount,
  INVITATION_AUDIT_TYPE,
  INVITATION_TTL_SECONDS,
  issueInvitation,
  recordAcceptanceRejection,
  type AcceptInvitationParams,
} from '../../server/lib/invitation';
import {
  emailAddressHash,
  normalizeAndHashEmail,
  normalizeEmailAddress,
} from '../../server/lib/otp';

/**
 * Subject hình dạng hợp lệ cho seed — `sub_` + 32 ký tự base32 viết thường.
 * Cast tường minh: giá trị hằng được kiểm hình dạng bằng chính `isSubject` qua
 * đường chấp nhận thật trong test.
 */
const SUBJECT_NEW = `sub_${'a'.repeat(32)}` as Subject;
const SUBJECT_OTHER = `sub_${'b'.repeat(32)}` as Subject;
const SUBJECT_STALE = `sub_${'e'.repeat(32)}` as Subject;
const ACTOR_SUB = `sub_${'c'.repeat(32)}`;
const ACTOR_STAFF_ID = 'stf_00000000-0000-0000-0000-000000000001';
const SESSION_ID_HASH = 'd'.repeat(64);
const SESSION_REF = 'session-ref-invitation-db-test';
const SESSION_ACR = 'urn:ecoma:acr:email-otp';

function hexHash(seed: string): string {
  // SHA-256 hex thật của địa chỉ — dùng cùng parity với serving path thay vì
  // một chuỗi hex giả: hash sai parity với `address_normalized` là chính thứ
  // mà `email_addresses_hash_shape_check` + app parity chặn.
  return Buffer.from(seed).toString('hex').padEnd(64, '0').slice(0, 64);
}

function sessionParams(): AcceptInvitationParams['session'] {
  const now = new Date();
  return {
    idHash: SESSION_ID_HASH,
    sessionRef: SESSION_REF,
    acr: SESSION_ACR,
    authnAt: now,
    expiresAt: new Date(now.getTime() + 12 * 3600 * 1000),
  };
}

/**
 * Hàng đầu tiên của một câu `RETURNING` — khẳng định đúng một hàng thay vì
 * `rows[0]!` (non-null assertion bị cấm): seed thiếu hàng là lỗi test riêng
 * biệt, đỏ tại đây với thông điệp rõ, không phải `undefined` lan xuống dưới.
 */
function first<T>(result: { rows: Array<T> }): T {
  expect(result.rows).toHaveLength(1);
  return result.rows[0] as T;
}

/**
 * Phát lời mời phải thành công trong các test này — bóp về nhánh `ok` sau khi
 * khẳng định, để đọc `issuedAt`/`expiresAt` không cần `expect` có điều kiện.
 */
function expectIssued(
  result: Awaited<ReturnType<typeof issueInvitation>>,
): Extract<typeof result, { ok: true }> {
  expect(result.ok).toBe(true);
  return result as Extract<typeof result, { ok: true }>;
}

/** Seed một lời mời mở + một challenge active cho địa chỉ — bằng credential runtime. */
async function seedOpenInvitationWithChallenge(
  runtime: import('pg').Client,
  addressHash: string,
  addressNormalized: string,
): Promise<{ invitationId: string; challengeId: string; correlationId: string }> {
  const correlationId = 'corr-' + addressHash.slice(0, 8);
  const invitation = await runtime.query<{ id: string }>(
    `INSERT INTO account.invitations
       (address_hash, address_normalized, actor_sub, actor_staff_id, correlation_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
     RETURNING id`,
    [addressHash, addressNormalized, ACTOR_SUB, ACTOR_STAFF_ID, correlationId],
  );
  const challenge = await runtime.query<{ id: string }>(
    `INSERT INTO account.otp_challenges
       (address_hash, code_digest, purpose, expires_at)
     VALUES ($1, $2, 'login', now() + interval '10 minutes')
     RETURNING id`,
    [addressHash, 'e'.repeat(64)],
  );
  return {
    invitationId: first(invitation).id,
    challengeId: first(challenge).id,
    correlationId,
  };
}

describe('invitations schema and grants on a real PostgreSQL', () => {
  let db: AccountDatabase;

  beforeAll(async () => {
    db = await startAccountDatabase();
  }, 180_000);

  beforeEach(async () => {
    // Container dùng chung cho các test trong describe — dọn sạch dữ liệu
    // giữa các test để sub/địa chỉ của test trước không rò vào test sau.
    await db?.truncateData();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('lets the runtime insert an open invitation but never delete one', async () => {
    const runtime = await db.asRuntime();
    try {
      const hash = hexHash('insert-open');
      const { rows } = await runtime.query<{ id: string }>(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, actor_staff_id, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
         RETURNING id`,
        [hash, 'insert-open@ecoma.io', ACTOR_SUB, ACTOR_STAFF_ID, 'corr-insert-open'],
      );
      expect(rows[0]?.id).toBeDefined();

      await expect(
        runtime.query(`DELETE FROM account.invitations WHERE address_hash = $1`, [hash]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('enforces at most one open invitation per address at the database level', async () => {
    const runtime = await db.asRuntime();
    try {
      const hash = hexHash('one-open');
      await runtime.query(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [hash, 'one-open@ecoma.io', ACTOR_SUB, 'corr-first'],
      );
      // INSERT thứ hai cùng hash, cùng trạng thái open → partial UNIQUE index
      // từ chối bất kể hai request cách nhau bao lâu; đây là anchor tuần tự hoá
      // của đường phát.
      await expect(
        runtime.query(
          `INSERT INTO account.invitations
             (address_hash, address_normalized, actor_sub, correlation_id, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
          [hash, 'one-open@ecoma.io', ACTOR_SUB, 'corr-second'],
        ),
      ).rejects.toThrow(
        // Chỉ một lời mời open/hash — lỗi unique của index từng phần.
        /invitations_open_hash_unique_idx|duplicate key/u,
      );
    } finally {
      await runtime.end();
    }
  });

  it('keeps the invitation lifecycle forward-only and terminal states terminal', async () => {
    const runtime = await db.asRuntime();
    try {
      const hash = hexHash('lifecycle');
      const inserted = await runtime.query<{ id: string }>(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id`,
        [hash, 'lifecycle@ecoma.io', ACTOR_SUB, 'corr-lifecycle'],
      );
      const id = first(inserted).id;

      // open → accepted: hợp lệ, kèm cặp accepted.
      await runtime.query(
        `UPDATE account.invitations
            SET status = 'accepted', accepted_at = now(), accepted_sub = $2
          WHERE id = $1`,
        [id, SUBJECT_NEW],
      );

      // accepted là kết thúc: mọi UPDATE bị trigger từ chối — single-use.
      await expect(
        runtime.query(`UPDATE account.invitations SET status = 'revoked' WHERE id = $1`, [id]),
      ).rejects.toThrow(/trang thai ket thuc/u);
      await expect(
        runtime.query(
          `UPDATE account.invitations SET expires_at = now() + interval '30 days' WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/trang thai ket thuc/u);

      // open → revoked rồi revoked là kết thúc.
      const second = await runtime.query<{ id: string }>(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id`,
        [hexHash('lifecycle-2'), 'lifecycle-2@ecoma.io', ACTOR_SUB, 'corr-2'],
      );
      await runtime.query(`UPDATE account.invitations SET status = 'revoked' WHERE id = $1`, [
        first(second).id,
      ]);
      await expect(
        runtime.query(`UPDATE account.invitations SET status = 'open' WHERE id = $1`, [
          first(second).id,
        ]),
      ).rejects.toThrow(/trang thai ket thuc/u);

      // Địa chỉ của lời mời không đổi được sau khi phát.
      const third = await runtime.query<{ id: string }>(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id`,
        [hexHash('lifecycle-3'), 'lifecycle-3@ecoma.io', ACTOR_SUB, 'corr-3'],
      );
      await expect(
        runtime.query(`UPDATE account.invitations SET address_hash = $2 WHERE id = $1`, [
          first(third).id,
          hexHash('lifecycle-changed'),
        ]),
      ).rejects.toThrow(/khong duoc doi/u);
    } finally {
      await runtime.end();
    }
  });

  it('rejects an accepted transition without the accepted pair (CHECK)', async () => {
    const runtime = await db.asRuntime();
    try {
      const pairRow = await runtime.query<{ id: string }>(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
         RETURNING id`,
        [hexHash('pair-check'), 'pair-check@ecoma.io', ACTOR_SUB, 'corr-pair'],
      );
      // accepted mà thiếu `accepted_sub` → CHECK cặp trạng thái từ chối.
      await expect(
        runtime.query(
          `UPDATE account.invitations SET status = 'accepted', accepted_at = now() WHERE id = $1`,
          [first(pairRow).id],
        ),
      ).rejects.toThrow(/invitations_accepted_pair_check/u);
    } finally {
      await runtime.end();
    }
  });
});

describe('users birth guard (0013) on a real PostgreSQL', () => {
  let db: AccountDatabase;

  beforeAll(async () => {
    db = await startAccountDatabase();
  }, 180_000);

  beforeEach(async () => {
    // Container dùng chung cho các test trong describe — dọn sạch dữ liệu
    // giữa các test để sub/địa chỉ của test trước không rò vào test sau.
    await db?.truncateData();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('keeps the migrator path unconditional (bootstrap intact)', async () => {
    const migrator = await db.asMigrator();
    try {
      // Không có lời mời nào cho sub này — bootstrap/migrator vẫn INSERT được:
      // guard chỉ ràng buộc principal runtime (ADR-0030 Quyết định 5).
      await migrator.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_OTHER]);
      const { rows } = await migrator.query<{ status: string }>(
        `SELECT status FROM account.users WHERE sub = $1`,
        [SUBJECT_OTHER],
      );
      expect(rows[0]?.status).toBe('active');
    } finally {
      await migrator.end();
    }
  });

  it('lets the runtime insert users only with invitation acceptance data in place', async () => {
    const runtime = await db.asRuntime();
    try {
      const address = 'guarded.birth@ecoma.io';
      const hash = await emailAddressHash(normalizeEmailAddress(address));
      const { invitationId, challengeId } = await seedOpenInvitationWithChallenge(
        runtime,
        hash,
        address,
      );

      // (a) Challenge đã consume nhưng lời mời chưa accepted → từ chối.
      await runtime.query(`UPDATE account.otp_challenges SET consumed_at = now() WHERE id = $1`, [
        challengeId,
      ]);
      await expect(
        runtime.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_NEW]),
      ).rejects.toThrow(/invitation-acceptance transaction/iu);

      // (b) Lời mời accepted mà challenge chưa consume → từ chối.
      await runtime.query(`UPDATE account.otp_challenges SET consumed_at = NULL WHERE id = $1`, [
        challengeId,
      ]);
      await runtime.query(
        `UPDATE account.invitations
            SET status = 'accepted', accepted_at = now(), accepted_sub = $2
          WHERE id = $1`,
        [invitationId, SUBJECT_NEW],
      );
      await expect(
        runtime.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_NEW]),
      ).rejects.toThrow(/invitation-acceptance transaction/iu);

      // (c) Cả hai điều kiện đủ (accepted cho sub + challenge consume sau khi
      // phát) → INSERT đi qua. Challenge consume bây giờ (sau accepted) vẫn thỏa
      // `consumed_at >= issued_at`.
      await runtime.query(`UPDATE account.otp_challenges SET consumed_at = now() WHERE id = $1`, [
        challengeId,
      ]);
      await runtime.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_NEW]);
      const { rows } = await runtime.query<{ status: string }>(
        `SELECT status FROM account.users WHERE sub = $1`,
        [SUBJECT_NEW],
      );
      expect(rows[0]?.status).toBe('active');

      // (d) Sub đã dùng không INSERT lại được — PRIMARY KEY của users chặn đường
      // "mượn" lời mời của sub khác cho lần INSERT thứ hai.
      await expect(
        runtime.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_NEW]),
      ).rejects.toThrow(/duplicate key/u);
    } finally {
      await runtime.end();
    }
  });

  it('rejects a challenge consumed before issuance as acceptance proof', async () => {
    // `consumed_at >= issued_at` là một nửa điều kiện guard: bằng chứng "kiểm
    // soát hộp thư" phải sinh ra SAU khi phát lời mời — challenge consume từ
    // một luồng cũ trước khi phát không đủ.
    const runtime = await db.asRuntime();
    try {
      const address = 'stale.challenge@ecoma.io';
      const hash = await emailAddressHash(normalizeEmailAddress(address));
      const { invitationId } = await seedOpenInvitationWithChallenge(runtime, hash, address);

      // Lời mời accepted nhưng challenge đã consume TRƯỚC issued_at: giả lập
      // bằng đẩy issued_at về sau consumed_at qua câu UPDATE trực tiếp. Trigger
      // lifecycle chặn đổi `issued_at` — đúng hành vi được test riêng — nên
      // seed bằng đường superuser (tắt trigger) chỉ cho kịch bản dữ liệu này.
      const challengeId = first(
        await runtime.query<{ id: string }>(
          `SELECT id FROM account.otp_challenges WHERE address_hash = $1 LIMIT 1`,
          [hash],
        ),
      ).id;
      await runtime.query(`UPDATE account.otp_challenges SET consumed_at = now() WHERE id = $1`, [
        challengeId,
      ]);
      await runtime.query(
        `UPDATE account.invitations
            SET status = 'accepted', accepted_at = now(), accepted_sub = $2
          WHERE id = $1`,
        [invitationId, SUBJECT_STALE],
      );
      const superuser = await db.connect();
      try {
        await superuser.query(
          `ALTER TABLE account.invitations DISABLE TRIGGER invitations_lifecycle_guard`,
        );
        await superuser.query(
          `UPDATE account.invitations SET issued_at = now() + interval '1 hour' WHERE id = $1`,
          [invitationId],
        );
      } finally {
        await superuser
          .query(`ALTER TABLE account.invitations ENABLE TRIGGER invitations_lifecycle_guard`)
          .catch(() => undefined);
        await superuser.end();
      }

      await expect(
        runtime.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_STALE]),
      ).rejects.toThrow(/invitation-acceptance transaction/iu);
    } finally {
      await runtime.end();
    }
  });
});

describe('issueInvitation transaction on a real PostgreSQL', () => {
  let db: AccountDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await startAccountDatabase();
    pool = await db.createRuntimePool();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await db?.stop();
  });

  it('issues an open invitation with TTL and attribution', async () => {
    const { normalized, hash } = await normalizeAndHashEmail('issue.fresh@ecoma.io');
    const issued = expectIssued(
      await issueInvitation(pool, {
        addressHash: hash,
        addressNormalized: normalized,
        attribution: { actorSub: ACTOR_SUB, actorStaffId: ACTOR_STAFF_ID },
        correlationId: 'corr-issue-fresh',
      }),
    );
    const ttlMs = issued.expiresAt.getTime() - issued.issuedAt.getTime();
    // TTL ghi đúng policy — biên ±5s cho hai đồng hồ DB/app.
    expect(Math.abs(ttlMs - INVITATION_TTL_SECONDS * 1000)).toBeLessThan(5000);
  });

  it('rejects a second open invitation for the same address', async () => {
    const { normalized, hash } = await normalizeAndHashEmail('issue.dup@ecoma.io');
    const firstIssuance = await issueInvitation(pool, {
      addressHash: hash,
      addressNormalized: normalized,
      attribution: { actorSub: ACTOR_SUB, actorStaffId: null },
      correlationId: 'corr-issue-dup-1',
    });
    expect(firstIssuance.ok).toBe(true);

    const second = await issueInvitation(pool, {
      addressHash: hash,
      addressNormalized: normalized,
      attribution: { actorSub: ACTOR_SUB, actorStaffId: null },
      correlationId: 'corr-issue-dup-2',
    });
    expect(second).toEqual({ ok: false, reason: 'invitation_already_open' });
  });

  it('rejects the canonical address with its own reason code', async () => {
    const { normalized, hash } = await normalizeAndHashEmail('SuperAdmin@Ecoma.IO ');
    expect(normalized).toBe('superadmin@ecoma.io');
    const result = await issueInvitation(pool, {
      addressHash: hash,
      addressNormalized: normalized,
      attribution: { actorSub: ACTOR_SUB, actorStaffId: null },
      correlationId: 'corr-issue-canonical',
    });
    expect(result).toEqual({ ok: false, reason: 'canonical_address_reserved' });
  });

  it('rejects an address already claimed by a pending or verified email row', async () => {
    // Seed bằng superuser (không runtime): INSERT `users` của runtime bị
    // birth-guard chặn khi không có dữ liệu chấp nhận — hàng giữ chỗ ở đây mô
    // phỏng dữ liệu đã tồn tại từ trước (bootstrap/luồng khác).
    const seed = await db.connect();
    try {
      await seed.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_OTHER]);
      await seed.query(
        `INSERT INTO account.email_addresses
           (user_sub, address_normalized, address_hash, status)
         VALUES ($1, $2, $3, 'pending')`,
        [SUBJECT_OTHER, 'issue.claimed@ecoma.io', await emailAddressHash('issue.claimed@ecoma.io')],
      );
    } finally {
      await seed.end();
    }

    const { normalized, hash } = await normalizeAndHashEmail('issue.claimed@ecoma.io');
    const result = await issueInvitation(pool, {
      addressHash: hash,
      addressNormalized: normalized,
      attribution: { actorSub: ACTOR_SUB, actorStaffId: null },
      correlationId: 'corr-issue-claimed',
    });
    expect(result).toEqual({ ok: false, reason: 'address_already_claimed' });
  });

  it('rejects an address that ever had a revoked email row', async () => {
    // Seed bằng superuser — cùng lý do với test giữ chỗ phía trên.
    const seed = await db.connect();
    try {
      await seed.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_NEW]);
      await seed.query(
        `INSERT INTO account.email_addresses
           (user_sub, address_normalized, address_hash, status, verified_at)
         VALUES ($1, $2, $3, 'revoked', NULL)`,
        [SUBJECT_NEW, 'issue.revoked@ecoma.io', await emailAddressHash('issue.revoked@ecoma.io')],
      );
    } finally {
      await seed.end();
    }

    const { normalized, hash } = await normalizeAndHashEmail('issue.revoked@ecoma.io');
    const result = await issueInvitation(pool, {
      addressHash: hash,
      addressNormalized: normalized,
      attribution: { actorSub: ACTOR_SUB, actorStaffId: null },
      correlationId: 'corr-issue-revoked',
    });
    expect(result).toEqual({ ok: false, reason: 'address_previously_revoked' });
  });
});

describe('acceptInvitationAndCreateAccount transaction on a real PostgreSQL', () => {
  let db: AccountDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await startAccountDatabase();
    pool = await db.createRuntimePool();
  }, 180_000);

  beforeEach(async () => {
    // Container dùng chung cho các test trong describe — dọn sạch dữ liệu
    // giữa các test để sub/địa chỉ của test trước không rò vào test sau.
    await db?.truncateData();
  });

  afterAll(async () => {
    await pool?.end();
    await db?.stop();
  });

  async function accept(
    address: string,
    challengeId: string,
    sub: Subject,
  ): Promise<{ ok: true; sub: Subject } | { ok: false; reason: string }> {
    const { normalized, hash } = await normalizeAndHashEmail(address);
    const invitation = await pool.query<{ correlation_id: string }>(
      `SELECT correlation_id FROM account.invitations
        WHERE address_hash = $1 AND status = 'open' LIMIT 1`,
      [hash],
    );
    return acceptInvitationAndCreateAccount(pool, {
      addressHash: hash,
      addressNormalized: normalized,
      challengeId,
      correlationId: invitation.rows[0]?.correlation_id ?? 'corr-accept',
      newSub: sub,
      session: sessionParams(),
    });
  }

  it('creates account + verified email + accepted invitation + provenance + session in one transaction', async () => {
    const address = 'accept.happy@ecoma.io';
    const { normalized, hash } = await normalizeAndHashEmail(address);
    const runtime = await db.asRuntime();
    const seeded = await seedOpenInvitationWithChallenge(runtime, hash, normalized);
    await runtime.end();

    const result = await accept(address, seeded.challengeId, SUBJECT_NEW);
    expect(result).toMatchObject({ ok: true, sub: SUBJECT_NEW });

    const client = await db.connect();
    try {
      // Account active.
      const user = await client.query<{ status: string }>(
        `SELECT status FROM account.users WHERE sub = $1`,
        [SUBJECT_NEW],
      );
      expect(user.rows[0]?.status).toBe('active');

      // Email verified, is_sign_in = true, verified_at đã ghi.
      const email = await client.query<{
        status: string;
        is_sign_in: boolean;
        verified_at: Date | null;
      }>(
        `SELECT status, is_sign_in, verified_at FROM account.email_addresses
          WHERE address_hash = $1`,
        [hash],
      );
      expect(email.rows[0]).toMatchObject({ status: 'verified', is_sign_in: true });
      expect(email.rows[0]?.verified_at).not.toBeNull();

      // Lời mời accepted với cặp accepted trỏ đúng sub.
      const invitation = await client.query<{
        status: string;
        accepted_sub: string | null;
      }>(`SELECT status, accepted_sub FROM account.invitations WHERE id = $1`, [
        seeded.invitationId,
      ]);
      expect(invitation.rows[0]).toMatchObject({ status: 'accepted', accepted_sub: SUBJECT_NEW });

      // Provenance `security_events` với metadata chỉ hash + id + correlation.
      const event = await client.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM account.security_events
          WHERE type = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [INVITATION_AUDIT_TYPE],
      );
      expect(event.rows[0]?.outcome).toBe('success');
      expect(event.rows[0]?.metadata).toMatchObject({
        address_hash: hash,
        correlation_id: seeded.correlationId,
        invitation_id: seeded.invitationId,
      });

      // Session ghi trong cùng transaction, thuộc sub mới với ACR email-otp.
      const session = await client.query<{ user_sub: string | null; acr: string | null }>(
        `SELECT user_sub, acr FROM account.account_sessions WHERE session_ref = $1`,
        [SESSION_REF],
      );
      expect(session.rows[0]).toMatchObject({ user_sub: SUBJECT_NEW, acr: SESSION_ACR });
    } finally {
      await client.end();
    }
  });

  it('rejects a second acceptance of the same invitation (single-use) and leaves no orphans', async () => {
    const address = 'accept.replay@ecoma.io';
    const { normalized, hash } = await normalizeAndHashEmail(address);
    const runtime = await db.asRuntime();
    const seeded = await seedOpenInvitationWithChallenge(runtime, hash, normalized);
    await runtime.end();

    const accepted = await accept(address, seeded.challengeId, SUBJECT_NEW);
    expect(accepted).toMatchObject({ ok: true });

    // Lần hai: lời mời đã accepted → invitation_not_open, challenge KHÔNG bị
    // consume (rollback sạch), không users/session mồ côi với sub mới.
    const secondChallenge = await pool.query<{ id: string }>(
      `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at)
       VALUES ($1, $2, 'login', now() + interval '10 minutes') RETURNING id`,
      [hash, 'f'.repeat(64)],
    );
    const second = await accept(address, first(secondChallenge).id, SUBJECT_OTHER);
    expect(second).toEqual({ ok: false, reason: 'invitation_not_open' });

    const client = await db.connect();
    try {
      const challenge = await client.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM account.otp_challenges WHERE id = $1`,
        [first(secondChallenge).id],
      );
      expect(challenge.rows[0]?.consumed_at).toBeNull();
      const orphan = await client.query<{ sub: string }>(
        `SELECT sub FROM account.users WHERE sub = $1`,
        [SUBJECT_OTHER],
      );
      expect(orphan.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('rejects acceptance when the address is already claimed and rolls back cleanly', async () => {
    const address = 'accept.claimed@ecoma.io';
    const { normalized, hash } = await normalizeAndHashEmail(address);
    const runtime = await db.asRuntime();
    const seeded = await seedOpenInvitationWithChallenge(runtime, hash, normalized);
    await runtime.end();
    // Giữ chỗ bằng hàng email pending sau khi phát — đúng lỗ giữ chỗ mà ADR
    // chấp nhận residual: giữ chỗ chỉ làm lời mời không chấp nhận được. Seed
    // bằng superuser vì birth-guard chặn runtime INSERT users ngoài transaction
    // chấp nhận.
    const seed = await db.connect();
    try {
      await seed.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUBJECT_OTHER]);
      await seed.query(
        `INSERT INTO account.email_addresses
           (user_sub, address_normalized, address_hash, status)
         VALUES ($1, $2, $3, 'pending')`,
        [SUBJECT_OTHER, normalized, hash],
      );
    } finally {
      await seed.end();
    }

    const result = await accept(address, seeded.challengeId, SUBJECT_NEW);
    expect(result).toEqual({ ok: false, reason: 'address_already_claimed' });

    // Rollback sạch: lời mời vẫn open, challenge chưa consume, không users mới.
    const client = await db.connect();
    try {
      const invitation = await client.query<{ status: string }>(
        `SELECT status FROM account.invitations WHERE id = $1`,
        [seeded.invitationId],
      );
      expect(invitation.rows[0]?.status).toBe('open');
      const challenge = await client.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM account.otp_challenges WHERE id = $1`,
        [seeded.challengeId],
      );
      expect(challenge.rows[0]?.consumed_at).toBeNull();
      const orphan = await client.query<{ sub: string }>(
        `SELECT sub FROM account.users WHERE sub = $1`,
        [SUBJECT_NEW],
      );
      expect(orphan.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('marks an expired invitation expired and rejects with its own reason', async () => {
    const address = 'accept.expired@ecoma.io';
    const { normalized, hash } = await normalizeAndHashEmail(address);
    const runtime = await db.asRuntime();
    // TTL đã trôi qua trước cả khi chấp nhận: cả `issued_at` lẫn `expires_at`
    // nằm trong quá khứ — CHECK `expires_at > issued_at` vẫn thỏa, còn đường
    // chấp nhận phải thấy "hết hạn" theo chính hàng này.
    await runtime.query(
      `INSERT INTO account.invitations
         (address_hash, address_normalized, actor_sub, correlation_id, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, now() - interval '8 days', now() - interval '1 minute')`,
      [hash, normalized, ACTOR_SUB, 'corr-accept-expired'],
    );
    const challenge = await runtime.query<{ id: string }>(
      `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at)
       VALUES ($1, $2, 'login', now() + interval '10 minutes') RETURNING id`,
      [hash, '0'.repeat(64)],
    );
    await runtime.end();

    const result = await accept(address, first(challenge).id, SUBJECT_NEW);
    expect(result).toEqual({ ok: false, reason: 'invitation_expired' });

    const client = await db.connect();
    try {
      const invitation = await client.query<{ status: string }>(
        `SELECT status FROM account.invitations WHERE address_hash = $1`,
        [hash],
      );
      expect(invitation.rows[0]?.status).toBe('expired');
    } finally {
      await client.end();
    }
  });

  it('records a failure audit row in its own transaction without throwing', async () => {
    const recorded = await recordAcceptanceRejection(pool, {
      reason: 'address_already_claimed',
      addressHash: 'a'.repeat(64),
      correlationId: 'corr-rejection-row',
    });
    expect(recorded).toBe(true);

    const client = await db.connect();
    try {
      const row = await client.query<{
        subject_sub: string | null;
        outcome: string;
        reason: string | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT subject_sub, outcome, reason, metadata FROM account.security_events
          WHERE type = $1 ORDER BY occurred_at DESC LIMIT 50`,
        [INVITATION_AUDIT_TYPE],
      );
      const found = row.rows.find(
        (candidate) => candidate.metadata.correlation_id === 'corr-rejection-row',
      );
      expect(found).toBeDefined();
      expect(found?.subject_sub).toBeNull();
      expect(found?.outcome).toBe('failure');
      expect(found?.reason).toBe('address_already_claimed');
    } finally {
      await client.end();
    }
  });
});
