/**
 * Kênh lời mời — phát, tra cứu và chấp nhận lời mời tạo Account ngoài bootstrap
 * (ADR-0030, accepted PR #214; FR-002b của domain model §9.1).
 *
 * ## Biên của module này
 *
 * Policy thời gian (TTL) là hằng số export để test khoá và call site không tự
 * ghép số. I/O (PostgreSQL, entropy, đồng hồ) do caller truyền vào. Không import
 * `node:*`, không giữ state ở module scope — cùng biên với `server/lib/otp.ts`
 * và `server/lib/session.ts` (`runtime:edge` cấm Node builtin và node-local
 * state).
 *
 * ## Hai đường, một bảng
 *
 * - **Phát** (`insertInvitation` qua route `/internal/account/invitations`):
 *   authorization record cho việc sinh MỘT Account cho MỘT địa chỉ. Không tạo
 *   Account, không tạo hàng email, không gửi thư (ADR-0030 Quyết định 1).
 * - **Chấp nhận** (`acceptInvitationAndCreateAccount`): người được mời đi qua
 *   đúng luồng email-OTP đăng nhập hiện có; khi verify thành công, TOÀN BỘ việc
 *   sinh Account (`users` active), email `verified`, chuyển lời mời sang
 *   `accepted`, provenance `security_events` và phát hành session diễn ra trong
 *   **một** transaction của `db-account` (ADR-0030 Quyết định 2). Bất biến
 *   "runtime chỉ được INSERT `users` trong transaction này" được migration
 *   `0013` ràng buộc bằng dữ liệu ở tầng database — function này là đường code
 *   duy nhất sắp xếp đúng thứ tự các statement đó (consume challenge → accept
 *   invitation → INSERT users).
 *
 * ## Fail-closed khi địa chỉ không được nhận độc quyền
 *
 * Tại cả hai thời điểm phát và chấp nhận: địa chỉ đã có hàng email còn sống
 * (`pending`/`verified`), đã từng có hàng `revoked`, hay trùng địa chỉ canonical
 * đều bị từ chối với mã lý do riêng — không chọn hộ, không "đoán chủ"
 * (ADR-0030 Quyết định 2). Lỗ giữ chỗ `pending` qua `POST /api/emails` giữ
 * nguyên hành vi: giữ chỗ chỉ làm lời mời không chấp nhận được, không bao giờ
 * làm người giữ chỗ nhận được Account nào.
 *
 * ⚠️ Không log địa chỉ trần; `address_hash` đủ để điều tra (cùng quy ước SR-001
 * với mọi đường OTP khác). Metadata của provenance chỉ chứa hash, không chứa
 * địa chỉ (ADR-0030 Quyết định 5).
 */

import { base32Encode, createSubject, type Subject } from '@ecoma-io/account-domain';

import { consumeChallenge, isUniqueViolation } from './otp';
import { writeAuthenticatedSessionStatements } from './session';

/**
 * Địa chỉ canonical bị loại trừ khỏi kênh lời mời (ADR-0030 Quyết định 1).
 *
 * ⚠️ Giá trị phải bằng đúng `BOOTSTRAP_EMAIL` của `db/bootstrap.mts` — hằng
 * được giữ ở hai file vì `bootstrap.mts` import `node:url` và bị cấm khỏi bundle
 * Worker (`runtime:edge`), nên serving path không import trực tiếp được. Test
 * `invitation.spec.ts` pin hai hằng bằng nhau; lệch giá trị là test đỏ trước khi
 * kịp thành lỗ hổng.
 */
export const INVITATION_EXCLUDED_ADDRESS = 'superadmin@ecoma.io';

/** TTL của lời mời (giây) — 7 ngày. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Giá trị `type` của provenance chấp nhận lời mời trong `security_events`
 * (ADR-0030 Quyết định 5 — tên cụ thể do Delivery chốt, phân biệt rõ với
 * `bootstrap_account_provisioned`). Trigger của `0011` chỉ chặn runtime ghi
 * loại bootstrap, nên loại này do serving path ghi hợp lệ.
 */
export const INVITATION_AUDIT_TYPE = 'invitation_account_provisioned';

/** Số byte entropy của `sub` mới — 160 bit, encode base32 thành đúng 32 ký tự. */
export const INVITED_SUBJECT_ENTROPY_BYTES = 20;

/** Mã lý do từ chối riêng của kênh lời mời — danh sách đóng, không chuỗi tự do. */
export type InvitationRejectionReason =
  | 'canonical_address_reserved'
  | 'invitation_already_open'
  | 'invitation_not_open'
  | 'invitation_expired'
  | 'address_already_claimed'
  | 'address_previously_revoked'
  | 'challenge_already_consumed';

/** Hàng lời mời mở mà đường challenge/chấp nhận cần. */
export interface OpenInvitationRow {
  readonly id: string;
  readonly address_hash: string;
  readonly address_normalized: string;
  readonly expires_at: Date;
  /** Id tương quan của lần phát — đi vào provenance chấp nhận (ADR-0030 Quyết định 5). */
  readonly correlation_id: string;
}

// -------------------------------------------------------------------------------------------
// Entropy — sub của Account sinh ra từ lời mời
// -------------------------------------------------------------------------------------------

/**
 * Sinh `sub` mới bằng entropy CSPRNG — đường duy nhất tạo subject cho Account
 * do lời mời sinh ra (ADR-0030 Quyết định 2: "sinh `sub` bằng `createSubject`
 * với entropy CSPRNG").
 *
 * `createSubject` của `account-domain` không tự sinh entropy (ranh giới không
 * I/O của tầng domain), nên việc rút byte random nằm ở đây: 20 byte từ
 * `crypto.getRandomValues` — 160 bit, encode thành đúng 32 ký tự base32 không
 * đệm (20 chia hết cho 5). ⚠️ `base32Encode` trả về chữ HOA theo RFC 4648, còn
 * `createSubject` đòi base32 viết thường (sub không phụ thuộc case-folding) —
 * `toLowerCase()` là bước bắt buộc của đường nối này, không phải tuỳ chọn.
 * Hàm nhận nguồn random qua tham số để test tất định hoá được đường sinh.
 */
export function createInvitedSubject(random?: (array: Uint8Array<ArrayBuffer>) => void): Subject {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(INVITED_SUBJECT_ENTROPY_BYTES);
  (
    random ??
    ((array: Uint8Array<ArrayBuffer>): void => {
      crypto.getRandomValues(array);
    })
  )(bytes);
  return createSubject(base32Encode(bytes).toLowerCase());
}

// -------------------------------------------------------------------------------------------
// Persistence — tra cứu và phát
// -------------------------------------------------------------------------------------------

/** Pool hoặc client của transaction caller — cùng hình với `insertAnonymousSession`. */
type Queryable = import('pg').Pool | import('pg').PoolClient;

/**
 * Lời mời còn mở cho một địa chỉ — hoặc `null`.
 *
 * "Còn mở" là điều kiện đủ để một challenge OTP cho địa chỉ chưa tồn tại trở
 * thành "có thật" (mã được gửi thật — ADR-0030 Quyết định 2), nên phép tra cứu
 * này là cổng của route `challenge`. Hàng hết hạn bị **khoá lười** (chuyển
 * `expired` bằng một UPDATE nguyên tử — cùng hình `expireChallengeIfExpired`)
 * rồi trả `null`: trạng thái DB khớp máy trạng thái mà không cần job dọn.
 *
 * ⚠️ Không lọc theo `expires_at` trong SELECT rồi tin kết quả qua đồng hồ
 * Worker: mốc hết hạn được so bằng chính hàng vừa khoá (`expires_at` của DB),
 * phép mark-expired dùng cùng mốc đó — hai đồng hồ Worker/DB lệch vài giây
 * không đổi kết quả của TTL bảy ngày.
 */
export async function findOpenInvitation(
  pool: Queryable,
  addressHash: string,
): Promise<OpenInvitationRow | null> {
  const result = await pool.query<{
    id: string;
    address_hash: string;
    address_normalized: string;
    expires_at: Date;
    correlation_id: string;
  }>(
    `SELECT id, address_hash, address_normalized, expires_at, correlation_id
       FROM account.invitations
      WHERE address_hash = $1 AND status = 'open'
      ORDER BY issued_at DESC
      LIMIT 1`,
    [addressHash],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  if (row.expires_at.getTime() <= Date.now()) {
    const expired = await pool.query(
      `UPDATE account.invitations
          SET status = 'expired'
        WHERE id = $1 AND status = 'open' AND expires_at <= $2`,
      [row.id, new Date(Date.now())],
    );
    if ((expired.rowCount ?? 0) > 0) {
      return null;
    }
    // UPDATE khớp 0 hàng: một request cạnh tranh vừa chuyển trạng thái (accepted
    // hoặc expired). Trả hàng theo trạng thái đọc được thay vì đoán — caller
    // (đường chấp nhận) sẽ khoá lại FOR UPDATE và tự quyết; đường challenge sẽ
    // coi như còn mở cho tới lần đọc kế tiếp. Không có nhánh nào gửi mail cho
    // lời mời đã hết hạn: verify là nơi quyết bằng hàng đã khoá.
    return row;
  }
  return row;
}

/** Attribution của người phát, lấy từ credential đã xác thực của request phát. */
export interface InvitationIssuanceAttribution {
  /** `sub` của operator — từ envelope HMAC của request nội bộ, không từ body. */
  readonly actorSub: string;
  /** Staff identity của operator do phía staff-access phân giải khi cho phép. */
  readonly actorStaffId: string | null;
}

/** Phát thành công: hàng lời mời vừa commit, trạng thái `open`. */
export type InvitationIssuanceSuccess = {
  readonly ok: true;
  readonly id: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
};

/** Phát bị từ chối: mã lý do riêng — route đổi thành 409 với cùng mã. */
export type InvitationIssuanceRejection = {
  readonly ok: false;
  readonly reason: Extract<
    InvitationRejectionReason,
    | 'canonical_address_reserved'
    | 'invitation_already_open'
    | 'address_already_claimed'
    | 'address_previously_revoked'
  >;
};

export type InvitationIssuanceResult = InvitationIssuanceSuccess | InvitationIssuanceRejection;

/**
 * Phát một lời mời — các phép kiểm exclusivity và INSERT trong **một**
 * transaction, đúng điều ADR-0030 đòi ở thời điểm phát: địa chỉ chưa được nhận
 * độc quyền và chưa có lời mời mở.
 *
 * ## Thứ tự trong transaction
 *
 *  1. **Địa chỉ canonical** — từ chối ngay, không mở rộng phép đọc nào phía sau
 *     (ADR-0030 Quyết định 1: loại trừ ở thời điểm phát).
 *  2. **Hàng email còn sống** (`pending`/`verified`) cho hash ⇒
 *     `address_already_claimed` — địa chỉ đã thuộc một Account (hoặc đang trong
 *     cửa sổ giữ chỗ), phát thêm là tạo đường Account thứ hai cho một địa chỉ.
 *  3. **Hàng `revoked`** từng tồn tại ⇒ `address_previously_revoked` — cùng cách
 *     đọc với bootstrap (ADR-0021 Quyết định 2): revoked là từ chối vĩnh viễn
 *     của địa chỉ đó, lời mời không mở lại cửa.
 *  4. **Lời mời còn mở** cho hash ⇒ `invitation_already_open` — bất biến
 *     "tối đa một lời mời mở" có partial UNIQUE index giữ ở tầng DB, phép đọc
 *     ở đây chỉ để trả 409 từ đường tuần tự thường; race thật vẫn bị index
 *     chặn (23505 ↦ cùng mã lý do).
 *  5. **INSERT** — anchor tuần tự hoá thật sự là partial UNIQUE index
 *     `(address_hash) WHERE status = 'open'`: hai lần phát cạnh nhau cho cùng
 *     địa chỉ chỉ một cái commit được (request thua nhận 23505, map về
 *     `invitation_already_open`), cùng mô hình hai anchor của `insertChallenge`.
 *
 * Route gọi hàm này sau enforcement permission — enforcement KHÔNG nằm trong
 * transaction (verdict của staff-access là network call, không bao giờ giữ
 * connection DB qua nó).
 */
export async function issueInvitation(
  pool: import('pg').Pool,
  params: {
    readonly addressHash: string;
    readonly addressNormalized: string;
    readonly attribution: InvitationIssuanceAttribution;
    readonly correlationId: string;
  },
): Promise<InvitationIssuanceResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (params.addressNormalized === INVITATION_EXCLUDED_ADDRESS) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'canonical_address_reserved' };
    }

    const liveClaim = await client.query<{ user_sub: string }>(
      `SELECT user_sub FROM account.email_addresses
        WHERE address_hash = $1 AND status IN ('pending', 'verified')
        LIMIT 1`,
      [params.addressHash],
    );
    if (liveClaim.rows[0] !== undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'address_already_claimed' };
    }

    const revokedClaim = await client.query<{ id: string }>(
      `SELECT id FROM account.email_addresses
        WHERE address_hash = $1 AND status = 'revoked'
        LIMIT 1`,
      [params.addressHash],
    );
    if (revokedClaim.rows[0] !== undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'address_previously_revoked' };
    }

    const openInvitation = await client.query<{ id: string }>(
      `SELECT id FROM account.invitations
        WHERE address_hash = $1 AND status = 'open'
        LIMIT 1`,
      [params.addressHash],
    );
    if (openInvitation.rows[0] !== undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invitation_already_open' };
    }

    const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
    const result = await client.query<{ id: string; issued_at: Date; expires_at: Date }>(
      `INSERT INTO account.invitations
         (address_hash, address_normalized, actor_sub, actor_staff_id, correlation_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, issued_at, expires_at`,
      [
        params.addressHash,
        params.addressNormalized,
        params.attribution.actorSub,
        params.attribution.actorStaffId,
        params.correlationId,
        expiresAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('invitations: insert returned no row');
    }

    await client.query('COMMIT');
    return {
      ok: true,
      id: row.id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Race thật giữa hai lần phát cạnh nhau: partial UNIQUE index từ chối INSERT
    // thứ hai bằng 23505 — cùng mã lý do với đường tuần tự ở bước 4, caller
    // (route) không phân biệt được và cũng không cần phân biệt.
    if (isUniqueViolation(error)) {
      return { ok: false, reason: 'invitation_already_open' };
    }
    throw error;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------------------------------------
// Persistence — chấp nhận: một transaction sinh Account
// -------------------------------------------------------------------------------------------

/** Tham số session của đường chấp nhận — caller đã hash identifier trước khi gọi. */
export interface AcceptanceSessionMaterial {
  readonly idHash: string;
  readonly sessionRef: string;
  readonly acr: string;
  readonly authnAt: Date;
  readonly expiresAt: Date;
  /**
   * `session_ref` của session anonymous đang cầm binding handoff — bị thu hồi
   * trong cùng transaction (rotate FR-004a). Session CÓ `user_sub` KHÔNG được
   * truyền vào đây: chấp nhận lời mời không hợp nhất vào Account đang đăng nhập,
   * phiên cũ của Account khác không bị thay đổi (ADR-0030 Quyết định 2).
   */
  readonly revokeSessionRef?: string;
  /** Binding handoff cần chuyển sang session mới trong cùng transaction (FR-006c4). */
  readonly carryHandoffFromSessionRef?: string;
}

/** Tham số của một lần chấp nhận — mọi thứ trên một client, một commit. */
export interface AcceptInvitationParams {
  readonly addressHash: string;
  readonly addressNormalized: string;
  /** Hàng challenge đang sống mà verify vừa so khớp digest thành công. */
  readonly challengeId: string;
  readonly correlationId: string;
  /** `sub` mới đã sinh trước khi mở transaction (entropy CSPRNG). */
  readonly newSub: Subject;
  readonly session: AcceptanceSessionMaterial;
}

/** Kết quả chấp nhận thành công: sub vừa sinh ra. */
export type AcceptInvitationSuccess = {
  readonly ok: true;
  readonly sub: Subject;
};

/** Kết quả bị từ chối: mã lý do riêng — không bao giờ đi ra response public. */
export type AcceptInvitationRejection = {
  readonly ok: false;
  readonly reason: InvitationRejectionReason;
};

/**
 * Chấp nhận lời mời — Account + email `verified` + lời mời `accepted` +
 * provenance + session trong **một** transaction của `db-account`.
 *
 * ## Thứ tự statement trong transaction (mỗi bước một lý do)
 *
 *  1. **Khoá hàng lời mời** `SELECT … WHERE status = 'open' FOR UPDATE` — anchor
 *     tuần tự hoá của cả transaction: hai lần verify cạnh nhau dùng cùng lời mời
 *     chỉ một cái thắng, và mọi phép đọc phía dưới đứng sau khóa thấy trạng thái
 *     ổn định. Không có hàng mở ⇒ `invitation_not_open` (đã được chấp nhận concurrently).
 *  2. **Hết hạn** — so `expires_at` của hàng vừa khoá; quá hạn thì mark `expired`
 *     trong transaction và từ chối `invitation_expired`.
 *  3. **Địa chỉ canonical** — từ chối `canonical_address_reserved`, fail-closed
 *     dù đường phát đã chặn (phòng thủ depth hai tầng: phát và chấp nhận cùng
 *     kiểm, ADR-0030 Quyết định 1 + 2).
 *  4. **Exclusivity** — hàng email còn sống (`pending`/`verified`) cho hash ⇒
 *     `address_already_claimed`; hàng `revoked` từng tồn tại ⇒
 *     `address_previously_revoked` (cùng cách đọc của bootstrap, ADR-0021
 *     Quyết định 2).
 *  5. **Consume challenge** trong transaction — single-use của mã là một phần
 *     của atomicity chấp nhận: consume commit cùng mọi hàng khác, không có khoảng
 *     chết "mã đã dùng mà Account chưa ra đời". Thua consume ⇒
 *     `challenge_already_consumed`.
 *  6. **Chuyển lời mời sang `accepted`** với `accepted_sub`/`accepted_at` — ĐỨNG
 *     TRƯỚC `INSERT users` vì trigger birth-guard của `0013` (SECURITY INVOKER,
 *     chạy dưới principal runtime) đọc chính hàng này để cho phép INSERT. Trigger
 *     còn đòi challenge đã tiêu thụ sau `issued_at` — bước 5 đứng trước thoả
 *     điều kiện đó.
 *  7. **INSERT `users`** (`active`) — qua guard của `0013`.
 *  8. **INSERT `email_addresses`** (`verified`, `is_sign_in = true`,
 *     `verified_at = now()`) — bằng chứng là OTP thật vừa consume, không phải
 *     assertion (ADR-0030 Quyết định 2). Partial UNIQUE `verified_hash` của
 *     `0005` là ràng buộc cuối cùng chống hai `verified` cùng hash.
 *  9. **Provenance `security_events`** — `invitation_account_provisioned`,
 *     metadata chỉ hash + id + attribution (không địa chỉ trần).
 * 10. **Session statements** — thu hồi session anonymous (nếu có) + chuyển
 *     binding handoff + INSERT session mới, trong cùng transaction rotate
 *     (FR-004a / §3.6.2).
 *
 * Mọi nhánh từ chối `ROLLBACK` — không còn nửa vời nào: challenge vẫn còn,
 * lời mời vẫn `open`, không có hàng `users`/email/session mồ côi. Row audit
 * `failure` cho nhánh từ chối được caller ghi SAU rollback trong transaction
 * riêng ({@link recordAcceptanceRejection}) — cùng bài học với row `denied` của
 * ADR-0023 Quyết định 6: row audit sống trong transaction bị abort là mất dấu vết.
 */
export async function acceptInvitationAndCreateAccount(
  pool: import('pg').Pool,
  params: AcceptInvitationParams,
): Promise<AcceptInvitationSuccess | AcceptInvitationRejection> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Khoá hàng lời mời mở — anchor tuần tự hoá.
    const locked = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at
         FROM account.invitations
        WHERE address_hash = $1 AND status = 'open'
        ORDER BY issued_at DESC
        LIMIT 1
        FOR UPDATE`,
      [params.addressHash],
    );
    const invitation = locked.rows[0];
    if (invitation === undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invitation_not_open' };
    }

    // 2. Hết hạn — mốc của hàng vừa khoá, không phải đồng hồ Worker.
    if (invitation.expires_at.getTime() <= Date.now()) {
      await client.query(
        `UPDATE account.invitations SET status = 'expired'
          WHERE id = $1 AND status = 'open' AND expires_at <= $2`,
        [invitation.id, new Date(Date.now())],
      );
      await client.query('COMMIT');
      return { ok: false, reason: 'invitation_expired' };
    }

    // 3. Địa chỉ canonical — fail-closed ở cả hai thời điểm.
    if (params.addressNormalized === INVITATION_EXCLUDED_ADDRESS) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'canonical_address_reserved' };
    }

    // 4. Exclusivity — hàng còn sống hoặc từng revoked cho hash này.
    const liveClaim = await client.query<{ user_sub: string }>(
      `SELECT user_sub FROM account.email_addresses
        WHERE address_hash = $1 AND status IN ('pending', 'verified')
        LIMIT 1`,
      [params.addressHash],
    );
    if (liveClaim.rows[0] !== undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'address_already_claimed' };
    }
    const revokedClaim = await client.query<{ id: string }>(
      `SELECT id FROM account.email_addresses
        WHERE address_hash = $1 AND status = 'revoked'
        LIMIT 1`,
      [params.addressHash],
    );
    if (revokedClaim.rows[0] !== undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'address_previously_revoked' };
    }

    // 5. Consume challenge trong transaction — single-use là một phần của commit.
    //    Truyền `client` (không `pool`): consume commit cùng mọi hàng khác của
    //    lần chấp nhận — xem JSDoc của `consumeChallenge` về lý do hình tham số.
    const consumed = await consumeChallenge(client, params.challengeId);
    if (!consumed) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'challenge_already_consumed' };
    }

    // 6. Chuyển lời mời sang accepted — khoá đang giữ nên điều kiện luôn khớp;
    //    mọi nhánh khác đã trả về phía trên.
    await client.query(
      `UPDATE account.invitations
          SET status = 'accepted', accepted_at = now(), accepted_sub = $2
        WHERE id = $1 AND status = 'open'`,
      [invitation.id, params.newSub],
    );

    // 7. INSERT users — birth-guard của 0013 cho phép vì bước 6 + bước 5 đã ghi
    //    đủ dữ liệu điều kiện trong chính transaction này.
    await client.query(`INSERT INTO account.users (sub) VALUES ($1)`, [params.newSub]);

    // 8. Email verified — bằng chứng là OTP vừa consume.
    await client.query(
      `INSERT INTO account.email_addresses
         (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
       VALUES ($1, $2, $3, 'verified', true, now())`,
      [params.newSub, params.addressNormalized, params.addressHash],
    );

    // 9. Provenance — cặp phát/chấp nhận trả lời được "ai mời, ai nhận, bằng
    //    chứng gì" (ADR-0030 Quyết định 5).
    await client.query(
      `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
       VALUES ($1, $2, 'success', $3::jsonb)`,
      [
        params.newSub,
        INVITATION_AUDIT_TYPE,
        JSON.stringify({
          address_hash: params.addressHash,
          correlation_id: params.correlationId,
          invitation_id: invitation.id,
        }),
      ],
    );

    // 10. Session trong cùng transaction rotate.
    await writeAuthenticatedSessionStatements(client, {
      idHash: params.session.idHash,
      sessionRef: params.session.sessionRef,
      userSub: params.newSub,
      acr: params.session.acr,
      authnAt: params.session.authnAt,
      expiresAt: params.session.expiresAt,
      revokeSessionRef: params.session.revokeSessionRef,
      carryHandoffFromSessionRef: params.session.carryHandoffFromSessionRef,
    });

    await client.query('COMMIT');
    return { ok: true, sub: params.newSub };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ghi row audit `failure` của một lần chấp nhận bị từ chối — trong **transaction
 * riêng**, sau khi transaction chấp nhận đã rollback.
 *
 * Cùng lý do cấu trúc với row `denied` của ADR-0023 Quyết định 6: row audit
 * ghi trong transaction bị abort thì cuốn theo rollback, và lần từ chối trở
 * thành không có dấu vết. `subject_sub` cố ý NULL: `sub` đã sinh cho nhánh bị
 * từ chối bị vứt bỏ và không bao giờ tái sử dụng (FR-001), ghi nó vào audit là
 * gắn một định danh không tồn tại với một sự kiện; `metadata.address_hash` đủ
 * để điều tra. Hàm không bao giờ ném — audit không nằm trên serving path
 * (NFR-004, cùng hợp đồng với `appendSecurityEvent` của data domain).
 */
export async function recordAcceptanceRejection(
  pool: import('pg').Pool,
  params: {
    readonly reason: InvitationRejectionReason;
    readonly addressHash: string;
    readonly correlationId: string;
  },
): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO account.security_events (subject_sub, type, outcome, reason, metadata)
       VALUES (NULL, $1, 'failure', $2, $3::jsonb)`,
      [
        INVITATION_AUDIT_TYPE,
        params.reason,
        JSON.stringify({
          address_hash: params.addressHash,
          correlation_id: params.correlationId,
        }),
      ],
    );
    return true;
  } catch {
    return false;
  }
}
