import {
  base64UrlToBytes,
  bytesToBase64Url,
  type AuthorizationTransactionState,
} from '@ecoma-io/auth-domain';

import type { AuthorizationCodeRow } from './authorization-code-cas';
import type { NewAuthorizationCode, NewAuthorizationTransaction } from '@ecoma-io/auth-application';
import type { PostgresClientLike, Queryable } from './postgres';

/**
 * Adapter cho `auth.authorization_transactions` và `auth.authorization_codes`
 * (C1 — #298).
 *
 * ⚠️ Đây là phần HẸP cần để chứng minh hợp đồng persistence trên PostgreSQL
 * thật — KHÔNG phải một repository tổng quát cho mọi bảng của `db-auth`. Mỗi
 * hàm ở đây bọc đúng MỘT câu SQL, và câu SQL là bản chép của quy ước trong
 * migration (`0002`/`0011` cho transaction, `0004` cho code) — lệch tên cột
 * chỉ lộ ra khi chạy với schema thật, nên integration test áp chính các file
 * migration đó.
 *
 * ⚠️ **Codec duy nhất giữa `bytea` và base64url.** Domain trả mọi hash dưới
 * dạng chuỗi base64url; cột `handle_*`/`browser_binding_hash`/`event_payload_hash`
 * của schema là `bytea`. Bốn hướng chuyển đổi đều đi qua `bytesToBase64Url`/
 * `base64UrlToBytes` của domain — KHÔNG có module nào tự encode thứ hai, vì
 * hai bản codec là hai chỗ có thể lệch nhau và chỗ lệch là một so khớp hash
 * sai âm thầm.
 *
 * ⚠️ **Mapper duy nhất row → DTO.** `mapTransactionRow` là chỗ DUY NHẤT dịch
 * hàng PostgreSQL thành `AuthorizationTransactionRecord` của application.
 * Sửa hình dạng DTO mà quên mapper là lỗi typecheck ngay, đúng ý C1.
 */

/** Cột `bytea` đọc về phải là Buffer/Uint8Array — hình dạng postgres.js trả. */
function byteaToBase64Url(value: unknown, column: string): string {
  // postgres.js decode `bytea` thành Buffer (kế thừa Uint8Array). Bất kỳ hình
  // dạng khác là lỗi hợp đồng của driver, không phải dữ liệu xấu — ném thay
  // vì diễn giải.
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`cot ${column} phai la bytea (Uint8Array), nhan duoc hinh dang khac`);
  }
  return bytesToBase64Url(value);
}

function base64UrlToBytea(value: string): Uint8Array {
  // `base64UrlToBytes` ném `AuthConfigurationError` cho chuỗi sai format —
  // đúng hành vi: hash sai format là lỗi của caller, không phải dữ liệu DB.
  return base64UrlToBytes(value);
}

/** Hàng thô của `authorization_transactions` như postgres.js trả về. */
interface RawTransactionRow {
  transaction_id: string;
  handle_hash_x: Uint8Array;
  state: string;
  client_id: string;
  redirect_uri: string;
  requested_scopes: string[];
  code_challenge: string;
  code_challenge_method: string;
  browser_binding_hash: Uint8Array;
  key_version: number;
  expires_at: Date;
  sub: string | null;
  acr: string | null;
  authn_at: Date | null;
  account_session_ref: string | null;
  client_state: string | null;
  nonce: string | null;
  // Cột idempotency — đọc về để handler phân biệt replay với event mới
  // (§5.1.5a). NULL khi chưa có event nào được ghi lên hàng.
  event_id: string | null;
  event_payload_hash: Uint8Array | null;
}

/**
 * Mapper DUY NHẤT row PostgreSQL → `AuthorizationTransactionRecord`.
 *
 * ⚠️ `state` được cast qua `AuthorizationTransactionState` sau khi CHECK của
 * schema đã chặn giá trị lạ (`0011`). Một hàng lọt qua CHECK sai (không thể,
 * trừ khi constraint bị drop) sẽ giữ nguyên chuỗi của nó — tầng application
 * sẽ từ chối tại `assertBrowserConfirmed`/`canTransition` thay vì im lặng.
 */
function mapTransactionRow(row: RawTransactionRow): AuthorizationTransactionRowDto {
  return {
    transaction_id: row.transaction_id,
    handle_hash_x: byteaToBase64Url(row.handle_hash_x, 'handle_hash_x'),
    state: row.state as AuthorizationTransactionState,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    requested_scopes: row.requested_scopes,
    code_challenge: row.code_challenge,
    code_challenge_method: row.code_challenge_method,
    browser_binding_hash: byteaToBase64Url(row.browser_binding_hash, 'browser_binding_hash'),
    key_version: row.key_version,
    expires_at: row.expires_at,
    sub: row.sub,
    acr: row.acr,
    authn_at: row.authn_at,
    account_session_ref: row.account_session_ref,
    client_state: row.client_state,
    nonce: row.nonce,
    event_id: row.event_id,
    event_payload_hash:
      row.event_payload_hash === null
        ? null
        : byteaToBase64Url(row.event_payload_hash, 'event_payload_hash'),
  };
}

/** Re-export dạng type public để caller không import từ application hai lần. */
export type AuthorizationTransactionRowDto =
  import('@ecoma-io/auth-application').AuthorizationTransactionRecord;

/**
 * Tạo transaction mới.
 *
 * Cột `created_at` nhận DEFAULT `now()` của DB — không truyền thời gian từ
 * caller, vì mốc tạo thuộc về database (đồng hồ duy nhất mọi hàng cùng nhìn).
 */
export async function insertTransaction(
  client: PostgresClientLike,
  record: NewAuthorizationTransaction,
): Promise<void> {
  await client.unsafe(
    `
      INSERT INTO auth.authorization_transactions (
        transaction_id, state, handle_hash_x, browser_binding_hash, key_version,
        client_id, redirect_uri, requested_scopes, client_state, nonce,
        code_challenge, code_challenge_method, expires_at
      )
      VALUES (
        $1, 'pending_browser', $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12
      )
    `,
    [
      record.transaction_id,
      base64UrlToBytea(record.handle_hash_x),
      base64UrlToBytea(record.browser_binding_hash),
      record.key_version,
      record.client_id,
      record.redirect_uri,
      record.requested_scopes,
      record.client_state,
      record.nonce,
      record.code_challenge,
      record.code_challenge_method,
      record.expires_at,
    ],
  );
}

/**
 * Tìm transaction theo BĂM handle X.
 *
 * ⚠️ KHÔNG lọc theo `handle_x_consumed_at` hay `expires_at` ở đây: việc "còn
 * dùng được" là điều kiện CỦA TỪNG hành động (confirm, consume), không phải
 * của việc tra cứu — lọc sớm ở tra cứu là biến một lý do từ chối có tên
 * ("đã dùng", "hết hạn") thành "không tìm thấy", mất khả năng trả lỗi đúng.
 */
export async function findTransactionByHandleX(
  client: PostgresClientLike,
  params: { handleXHash: string },
): Promise<AuthorizationTransactionRowDto | undefined> {
  const rows = await client.unsafe<RawTransactionRow>(
    `
      SELECT transaction_id, handle_hash_x, state, client_id, redirect_uri,
             requested_scopes, code_challenge, code_challenge_method,
             browser_binding_hash, key_version, expires_at, sub, acr,
             authn_at, account_session_ref, client_state, nonce,
             event_id, event_payload_hash
        FROM auth.authorization_transactions
       WHERE handle_hash_x = $1
    `,
    [base64UrlToBytea(params.handleXHash)],
  );
  const row = rows[0];
  return row === undefined ? undefined : mapTransactionRow(row);
}

/**
 * Chuyển trạng thái CÓ ĐIỀU KIỆN — CAS của transaction.
 *
 * ⚠️ `expires_at > $4` nằm TRONG cùng câu UPDATE: một transaction hết hạn
 * KHÔNG được chuyển sang trạng thái cho phép tiếp tục (§5.1.2 hàng 12). Kiểm
 * expiry ở tầng đọc trước rồi mới UPDATE là hai câu — giữa chúng một request
 * khác đã có thể chuyển trạng thái.
 *
 * ⚠️ Trả `false` cho 0 hàng: trạng thái khác CAS từ chối, hoặc hết hạn, hoặc
 * ID không tồn tại. Caller ánh xạ cả ba thành một lỗi duy nhất — phân biệt ở
 * đây là oracle cho client dò ID.
 */
export async function transitionTransaction(
  client: PostgresClientLike,
  params: {
    transactionId: string;
    from: AuthorizationTransactionState;
    to: AuthorizationTransactionState;
    at: Date;
  },
): Promise<boolean> {
  const updated = await client.unsafe<{ transaction_id: string }>(
    `
      UPDATE auth.authorization_transactions
         SET state = $2
       WHERE transaction_id = $1
         AND state = $3
         AND expires_at > $4
      RETURNING transaction_id
    `,
    [params.transactionId, params.to, params.from, params.at],
  );
  return updated.length === 1;
}

/**
 * Ghi authorization code mới.
 *
 * Cột được liệt kê TÊN và khớp `0004_authorization_codes.sql`: `code_hash`,
 * `authorization_transaction_id`, `sub`, `client_id`, `redirect_uri`,
 * `code_challenge`, `code_challenge_method`, `granted_scopes` (text[]),
 * `nonce` (nullable), `expires_at`. `id` nhận DEFAULT của DB; `issued_at` và
 * `consumed_at`/`consumed_by` mặc định đúng trạng thái "chưa tiêu thụ".
 */
export async function insertAuthorizationCode(
  client: PostgresClientLike,
  code: NewAuthorizationCode,
): Promise<void> {
  await client.unsafe(
    `
      INSERT INTO auth.authorization_codes (
        code_hash, authorization_transaction_id, sub, client_id, redirect_uri,
        code_challenge, code_challenge_method, granted_scopes, nonce, expires_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10
      )
    `,
    [
      code.code_hash,
      code.authorization_transaction_id,
      code.sub,
      code.client_id,
      code.redirect_uri,
      code.code_challenge,
      code.code_challenge_method,
      code.granted_scopes,
      code.nonce,
      code.expires_at,
    ],
  );
}

export type { AuthorizationCodeRow };

/**
 * Kết quả của một lần CAS tiêu thụ handle X.
 *
 * ⚠️ `won` là CAS thắng: hàng được chuyển trạng thái VÀ `sub`/`acr`/`authn_at`/
 * `account_session_ref` được ghi CÙNG một câu — `0012` đã đổi `authn_level` thành
 * `acr`, đây là bản chép cột mới.
 */
export interface ConsumeHandleXOutcome {
  readonly won: boolean;
  readonly transaction: AuthorizationTransactionRowDto | undefined;
}

/**
 * CAS 1 của `0002` — tiêu thụ handle X và bind danh tính trong MỘT câu UPDATE.
 *
 * ⚠️ **Cùng một câu** là điều kiện của thiết kế (`0002` comment CAS 1, §5.1.2 bước
 * 10): "X bị tiêu thụ" và "danh tính được bind" là MỘT sự kiện. Tách thành
 * transition rồi UPDATE bind là hai câu — giữa chúng một request khác có thể thấy
 * transaction đã `browser_confirmed` nhưng sub còn NULL, và đọc một hàng nửa vời.
 *
 * ⚠️ Điều kiện `state = 'browser_confirmed'` nằm trong WHERE, không phải kiểm tra
 * trước: §5.1.0 điều kiện 2 — request tới khi transaction chưa được browser xác
 * nhận phải bị từ chối TRƯỚC KHI đọc bất kỳ trường nào khác, và việc CAS từ chối
 * là cách chặn không cho hai request cùng thắng.
 */
export async function consumeHandleXAndBindIdentity(
  client: PostgresClientLike,
  params: {
    readonly handleXHash: string;
    readonly sub: string;
    readonly acr: string;
    readonly authnAt: Date;
    readonly accountSessionRef: string;
    readonly eventId: string;
    readonly payloadHash: string;
    readonly outcome: 'success' | 'failure' | 'error';
    readonly now: Date;
  },
): Promise<ConsumeHandleXOutcome> {
  const updated = await client.unsafe<RawTransactionRow>(
    `
      UPDATE auth.authorization_transactions
         SET handle_x_consumed_at = $2,
             sub = $3,
             acr = $4,
             authn_at = $5,
             account_session_ref = $6,
             event_id = $7,
             event_payload_hash = $8,
             event_outcome = $9,
             event_processed_at = $10
       WHERE handle_hash_x = $1
         AND handle_x_consumed_at IS NULL
         AND state = 'browser_confirmed'
         AND expires_at > $2
      RETURNING transaction_id, handle_hash_x, state, client_id, redirect_uri,
                requested_scopes, code_challenge, code_challenge_method,
                browser_binding_hash, key_version, expires_at, sub, acr,
                authn_at, account_session_ref, client_state, nonce,
                event_id, event_payload_hash
    `,
    [
      base64UrlToBytea(params.handleXHash),
      params.now,
      params.sub,
      params.acr,
      params.authnAt,
      params.accountSessionRef,
      params.eventId,
      base64UrlToBytea(params.payloadHash),
      params.outcome,
      params.now,
    ],
  );
  const row = updated[0];
  return row === undefined
    ? { won: false, transaction: undefined }
    : { won: true, transaction: mapTransactionRow(row) };
}

/**
 * Đánh dấu transaction sang trạng thái consent/complete KÈ handle Y hoặc Z —
 * bước 11/14 của §5.1.2.
 *
 * ⚠️ Một câu UPDATE với CAS trạng thái: `awaiting_consent` bắt buộc có handle Y
 * (CHECK `authorization_transactions_handle_y_state_check` của `0002`), nên caller
 * không thể "quên" derive Y khi chuyển sang trạng thái đó — schema từ chối.
 *
 * Tham số là {@link Queryable} chứ không phải {@link PostgresClientLike}: hàm này
 * chạy BÊN TRONG transaction nghiệp vụ của consent `decide` (bắt buộc để
 * "advance" và "consume Y" là MỘT sự kiện — xem `consent-handler.ts`), nên hình
 * dạng đúng là cái mà callback của `client.begin` truyền ra. Khác với
 * `recordNonce` (chỉ chạy trên pool — brand chặn việc ghi idempotency vào một tx
 * có thể bị rollback), CỐT LÕI của hàm này chính là việc ghi bên trong tx.
 */
export async function advanceTransactionWithHandle(
  client: Queryable,
  params: {
    readonly transactionId: string;
    readonly from: AuthorizationTransactionState;
    readonly to: 'awaiting_consent' | 'ready_to_complete' | 'denied';
    /** Hash của handle Y (khi `to = 'awaiting_consent'`) hoặc Z. */
    readonly handleHash: string;
    /**
     * ⚠️ KHÔNG ghi cột `event_*` nào — cả bốn (`event_id`, `event_payload_hash`,
     * `event_outcome`, `event_processed_at`) là khối idempotency CỦA EVENT PUSH
     * account→auth (CHECK `event_all_or_none` ghim chúng thành một nguyên khối,
     * comment cột 0002: "idempotency key của event account -> auth (NFR-006)"),
     * đã được `consumeHandleXAndBindIdentity` ghi MỘT lần duy nhất. Advance ở
     * đây là bước consent (mint Y hay decide → Z/denied) — định danh riêng của
     * nó là handle Y/Z CAS + `oauth_consent_decisions`, không đụng khối push.
     * Ghi đè `event_id` ở đây làm replay §5.1.5a dòng 2 của push không còn khớp.
     */
    readonly eventId: string;
    readonly payloadHash: string;
    readonly outcome: 'success' | 'failure' | 'error';
    readonly now: Date;
  },
): Promise<boolean> {
  const isConsent = params.to === 'awaiting_consent';
  const updated = await client.unsafe<{ transaction_id: string }>(
    `
      UPDATE auth.authorization_transactions
         SET state = $2,
             handle_hash_y = CASE WHEN $3 THEN $4 ELSE handle_hash_y END,
             handle_hash_z = CASE WHEN NOT $3 THEN $4 ELSE handle_hash_z END
       WHERE transaction_id = $1
         AND state = $5
         AND expires_at > $6
      RETURNING transaction_id
    `,
    [
      params.transactionId,
      params.to,
      isConsent,
      base64UrlToBytea(params.handleHash),
      params.from,
      params.now,
    ],
  );
  return updated.length === 1;
}

/**
 * Tìm transaction theo BĂM handle Y — contract `/internal/consent/*`.
 *
 * ⚠️ Không lọc `handle_y_consumed_at`: "còn dùng được" là điều kiện của từng hành
 * động (CAS consume trong `consumeHandleY`), cùng lý do với
 * `findTransactionByHandleX` — lọc sớm biến "đã dùng" thành "không tồn tại" và
 * mất khả năng trả `invalid_grant` xác định cho replay.
 */
export async function findTransactionByHandleY(
  client: PostgresClientLike,
  params: { readonly handleYHash: string },
): Promise<AuthorizationTransactionRowDto | undefined> {
  const rows = await client.unsafe<RawTransactionRow>(
    `
      SELECT transaction_id, handle_hash_x, state, client_id, redirect_uri,
             requested_scopes, code_challenge, code_challenge_method,
             browser_binding_hash, key_version, expires_at, sub, acr,
             authn_at, account_session_ref, client_state, nonce,
             event_id, event_payload_hash
        FROM auth.authorization_transactions
       WHERE handle_hash_y = $1
    `,
    [base64UrlToBytea(params.handleYHash)],
  );
  const row = rows[0];
  return row === undefined ? undefined : mapTransactionRow(row);
}

/**
 * CAS 2 của `0002` — tiêu thụ handle Y và ghi kết quả consent (idempotency (b) của
 * §5.1.5). Ghi `oauth_consent_decisions` PHẢI đi trước trong CÙNG transaction
 * `db-auth` (`client.begin`) — caller truyền tx vào đây; đứng một mình, hàm này chỉ
 * CAS và ghi idempotency.
 *
 * ⚠️ WHERE chép nguyên văn khối canonical CAS 2 của
 * `apps/auth/migrations/0002_authorization_transactions.sql:305-331`, gồm
 * `account_session_ref = $2 AND sub = $3` — ràng buộc PHIÊN: handle Y nằm trong URL
 * redirect, có thể lọt sang người khác (referer leak, lịch sử trình duyệt), nên kết
 * quả consent chỉ được ghi bởi đúng phiên sở hữu transaction. Tham số lấy từ hàng
 * transaction đã load, không từ request — caller (`consent-handler.ts` decide) đã
 * dồn chúng về dạng string non-null trước khi gọi; một caller bỏ qua kiểm app-layer
 * giờ bị CAS chặn ở tầng database thay vì tự tin consume hộ người khác.
 *
 * Tham số là {@link Queryable}: hình dạng đúng của tx từ callback `begin` —
 * cùng lý do với `advanceTransactionWithHandle` ở trên.
 */
export async function consumeHandleY(
  client: Queryable,
  params: {
    readonly handleYHash: string;
    readonly accountSessionRef: string;
    readonly sub: string;
    readonly decision: 'approve' | 'deny';
    /**
     * ⚠️ KHÔNG ghi cột `event_*` nào — khối bốn cột là idempotency key của
     * event PUSH account→auth (comment cột 0002 + §5.1.5a: event_id định danh
     * MỘT lần xác thực, "không định danh consent decision"), đã được
     * `consumeHandleXAndBindIdentity` ghi một lần. Ghi đè ở đây làm replay
     * cùng `event_id` của push rơi vào nhánh "X đã consume bởi event khác" —
     * sai hoàn toàn hợp đồng retry. Định danh riêng của consent decision là
     * `oauth_consent_decisions` + CAS consume-Y của chính câu này; `eventId`/
     * `payloadHash` còn ở signature để caller ghi `oauth_consent_decisions`
     * cùng tx (một nguồn sự thật cho tham số, tránh hai bản lệch nhau).
     */
    readonly eventId: string;
    readonly payloadHash: string;
    readonly now: Date;
  },
): Promise<AuthorizationTransactionRowDto | undefined> {
  const updated = await client.unsafe<RawTransactionRow>(
    `
      UPDATE auth.authorization_transactions
         SET handle_y_consumed_at = $4
       WHERE handle_hash_y = $1
         AND handle_y_consumed_at IS NULL
         AND expires_at > $4
         AND account_session_ref = $2
         AND sub = $3
      RETURNING transaction_id, handle_hash_x, state, client_id, redirect_uri,
                requested_scopes, code_challenge, code_challenge_method,
                browser_binding_hash, key_version, expires_at, sub, acr,
                authn_at, account_session_ref, client_state, nonce,
                event_id, event_payload_hash
    `,
    [base64UrlToBytea(params.handleYHash), params.accountSessionRef, params.sub, params.now],
  );
  const row = updated[0];
  return row === undefined ? undefined : mapTransactionRow(row);
}
