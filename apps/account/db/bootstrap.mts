/**
 * `npx tsx --tsconfig tsconfig.db.json db/bootstrap.mts provision|verify` — bước
 * A1 (create-or-resolve) và A2 (đọc lại) của bootstrap first-administrator cho
 * `db-account` ([ADR-0021](../../../docs/domains/staff-access/adr/0021-first-admin-bootstrap-path.md)
 * Quyết định 2, [ADR-0024](../../../docs/domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md)
 * Quyết định 1, 2, 4, 6).
 *
 * ## Bề mặt offline, không phải serving path
 *
 * Script chạy bằng credential migrator/owner của `db-account` trên CI runner hoặc
 * ops box, **không** chạy trong Worker: bước tuần tự hoá duy nhất của đường này là
 * `pg_advisory_xact_lock`, mà Hyperdrive không hỗ trợ (`docs/architecture/04-platform-facts.md`
 * HD6). Không có route, không flag, không cron, và không có code path nào trong
 * bundle của Worker import file này.
 *
 * Bootstrap **không** phát hành session/token/cookie: nó là thao tác ghi database,
 * không phải một principal (ADR-0024 Quyết định 2). Superadmin vẫn đăng nhập bằng
 * luồng email-OTP hiện có.
 *
 * ## A1 — một transaction, một khoá toàn cục
 *
 * `BEGIN` → `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` → advisory xact lock
 * trên một khoá **hằng** (`BOOTSTRAP_LOCK_KEY`, không phải khoá theo `address_hash`:
 * chỉ có một địa chỉ canonical nên một khoá toàn cục là đủ và không phụ thuộc dữ
 * liệu đầu vào) → enumerate → quyết định → ghi audit trong **cùng** transaction →
 * `COMMIT`. Mọi nhánh từ chối `ROLLBACK` rồi ném {@link BootstrapDenialError} mang
 * mã lý do ổn định.
 *
 * ## Không bao giờ suy quyền từ địa chỉ một mình
 *
 * Một hàng `verified` không tự chứng minh Account đó do bootstrap tạo: bất kỳ
 * Account nào cũng có thể mang đúng địa chỉ canonical. Vì vậy nhánh hội tụ đòi
 * đồng thời: địa chỉ khớp hằng canonical, Account `active`, `sub` đó không còn hàng
 * `verified` **khác**, và có đúng một bootstrap audit event `status = 'created'`
 * cùng `subject_sub` với `metadata.address_hash` khớp (ADR-0021 Quyết định 2,
 * ADR-0024 Quyết định 4). Row audit `status = 'converged'` là dấu vết của lần xác
 * nhận lại, không phải bằng chứng nguồn gốc — xem {@link countCreationProofEvents}.
 *
 * ## Không log địa chỉ, không log hash
 *
 * Library này không ghi log gì. CLI chỉ in `sub` và trạng thái; địa chỉ trần,
 * `address_hash`, credential và `DATABASE_URL` không bao giờ đi ra stdout/stderr.
 */

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { base32Encode } from '@ecoma-io/account-domain/src/base32.ts';
import { createSubject } from '@ecoma-io/account-domain/src/subject.ts';

import { emailAddressHash, normalizeEmailAddress } from '../server/lib/otp.ts';

/**
 * Địa chỉ canonical duy nhất mà bootstrap được phép ghi `verified`.
 *
 * Hằng trong code, **không** phải giá trị cấu hình: `ECOMA_BOOTSTRAP_EMAIL` chỉ
 * được **assert** lại giá trị này (ADR-0021 Quyết định 1, ADR-0024 Quyết định 4).
 * Không có nhánh nào dùng cấu hình làm giá trị cần ghi.
 */
export const BOOTSTRAP_EMAIL = 'superadmin@ecoma.io';

/** Loại `security_events` của một lần A1 — vế chứng minh nguồn gốc bootstrap. */
export const BOOTSTRAP_AUDIT_TYPE = 'bootstrap_account_provisioned';

/**
 * Khoá advisory **toàn cục cố định** của đường bootstrap.
 *
 * Không derive từ `address_hash`: chỉ có một địa chỉ canonical, nên một khoá hằng
 * tuần tự hoá mọi lần chạy và không biến dữ liệu đầu vào thành một phần của khoá.
 * Được hash phía server bằng `hashtext($1)` như migration runner.
 */
export const BOOTSTRAP_LOCK_KEY = 'account.bootstrap_superadmin';

/** `application_name` của connection — thấy được trong `pg_stat_activity`. */
export const BOOTSTRAP_APPLICATION_NAME = 'ecoma-account-bootstrap';

/** Stage của A1 trong output CLI. */
export const STAGE_PROVISION = 'account.provision';

/** Stage của A2 trong output CLI. */
export const STAGE_VERIFY = 'account.verify';

/**
 * Mã lý do từ chối ổn định (machine-readable) của A1/A2.
 *
 * Đây là hợp đồng cho orchestrator: mã không đổi theo thông báo, ngôn ngữ hay
 * chi tiết lỗi. `no_bootstrap_account` là mã riêng của A2 cho database hoàn toàn
 * trống — A2 là read-only nên nó không tạo gì; A1 mới là bước tạo.
 */
export const BOOTSTRAP_DENIAL_REASONS = [
  'address_revoked',
  'address_ambiguous',
  'address_multiple_live_rows',
  'address_pending_conflict',
  'address_not_bootstrap_proven',
  'account_not_active',
  'account_has_other_verified_address',
  'account_database_not_empty',
  'no_bootstrap_account',
] as const;

/** Một mã lý do từ chối của procedure (A1/A2). */
export type BootstrapDenialReason = (typeof BOOTSTRAP_DENIAL_REASONS)[number];

/**
 * Mã lý do mà **CLI** có thể in ra: mã procedure cộng bốn nhánh chỉ tồn tại ở
 * biên process (input sai, không kết nối được, cấu hình lệch, lỗi ngoài hợp đồng).
 *
 * Bốn nhánh sau không phải trạng thái database, nên không nằm trong
 * {@link BOOTSTRAP_DENIAL_REASONS} — nhưng chúng dùng **cùng** shape output để
 * orchestrator chỉ cần đọc một trường `reason`.
 */
export type BootstrapCliFailureReason =
  | BootstrapDenialReason
  | 'bootstrap_email_mismatch'
  | 'invalid_input'
  | 'database_unreachable'
  | 'internal_error';

/**
 * Từ chối có kiểu của A1/A2 — mang mã lý do, không mang địa chỉ hay hash.
 *
 * CLI đổi nó thành `{ "stage": ..., "status": "denied", "reason": ... }` trên
 * stderr và exit 1. Không catch để "đi tiếp": mọi nhánh từ chối đã `ROLLBACK`.
 */
export class BootstrapDenialError extends Error {
  readonly reason: BootstrapDenialReason;

  constructor(reason: BootstrapDenialReason) {
    super(`bootstrap denied: ${reason}`);
    this.name = 'BootstrapDenialError';
    this.reason = reason;
  }
}

/** Cấu hình bootstrap sai — hiện chỉ có một trường hợp: địa chỉ assert lệch hằng. */
export class BootstrapConfigurationError extends Error {
  readonly reason = 'bootstrap_email_mismatch' as const;

  constructor() {
    super('ECOMA_BOOTSTRAP_EMAIL does not match the canonical bootstrap address; refusing to run');
    this.name = 'BootstrapConfigurationError';
  }
}

/** Đầu vào A1 — attribution tự khai, không phải danh tính đã xác minh. */
export interface BootstrapAccountInput {
  /** Correlation id của procedure, ghi vào audit cùng `staff-access`. */
  readonly correlationId: string;
  /**
   * `operator_ref` tự khai — không chứng minh danh tính người chạy, nhưng **bắt
   * buộc có giá trị**: ADR-0021 Quyết định 6 đòi audit mang một tham chiếu người
   * thực thi, và A1 commit trước S1/S2 nên một lần ghi rỗng không sửa lại được.
   */
  readonly operatorRef: string;
}

/** Kết quả A1 — `sub` là giá trị duy nhất đi xuyên sang `staff-access`. */
export interface BootstrapAccountResult {
  readonly stage: 'account.provision';
  readonly status: 'created' | 'converged';
  readonly sub: string;
}

/**
 * Kết quả A2 khi state đúng là trạng thái hội tụ.
 *
 * Database trống **không** phải một kết quả của A2: A2 read-only nên nó ném
 * {@link BootstrapDenialError} với `no_bootstrap_account`, để orchestrator fail
 * nhanh trước A1 mà không cần credential database của riêng nó.
 */
export interface BootstrapAccountVerification {
  readonly status: 'converged';
  readonly sub: string;
}

/** Một hàng `email_addresses` của địa chỉ canonical, kèm trạng thái Account. */
interface AddressRow {
  readonly id: string;
  readonly user_sub: string;
  readonly status: string;
  readonly address_normalized: string;
  readonly verified_at: Date | null;
  readonly is_sign_in: boolean;
  readonly account_status: string | null;
}

/** Nhánh quyết định sau khi enumerate: tạo mới hay hội tụ vào `sub` đã có. */
type ExistingState =
  | { readonly kind: 'create' }
  | { readonly kind: 'converge'; readonly sub: string };

function deny(reason: BootstrapDenialReason): never {
  throw new BootstrapDenialError(reason);
}

/**
 * Assert `ECOMA_BOOTSTRAP_EMAIL` (nếu có) bằng đúng hằng canonical.
 *
 * Chuẩn hoá **cả hai phía** trước khi so (`normalizeEmailAddress` của luồng OTP)
 * để `SuperAdmin@ECOMA.io ` không bị coi là một địa chỉ khác. Cấu hình chỉ assert:
 * giá trị ghi xuống database luôn là {@link BOOTSTRAP_EMAIL}.
 *
 * @throws {BootstrapConfigurationError} khi giá trị khác hằng.
 */
export function assertConfiguredBootstrapEmail(configured: string | undefined): void {
  if (configured === undefined || configured === '') {
    return;
  }
  if (normalizeEmailAddress(configured) !== BOOTSTRAP_EMAIL) {
    throw new BootstrapConfigurationError();
  }
}

/**
 * Sinh entropy cho `sub`: 20 byte CSPRNG → đúng 32 ký tự base32 RFC 4648 viết
 * thường, không padding (160 bit).
 *
 * Dùng WebCrypto toàn cục (`crypto.getRandomValues`) — không import `node:crypto`,
 * cùng lý do với `server/lib/otp.ts`: file này phải giữ được biên "không kéo Node
 * builtin vào bất kỳ bundle nào". Địa chỉ email **không bao giờ** trở thành `sub`.
 */
function generateSubjectEntropy(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes).replace(/=+$/u, '').toLowerCase();
}

/** Đọc **mọi** hàng của `address_hash`, kể cả `revoked` — quyết định mới lọc. */
async function readAddressRows(client: Client, addressHash: string): Promise<AddressRow[]> {
  const result = await client.query<AddressRow>(
    `SELECT e.id, e.user_sub, e.status, e.address_normalized, e.verified_at, e.is_sign_in,
            u.status AS account_status
       FROM account.email_addresses e
       LEFT JOIN account.users u ON u.sub = e.user_sub
      WHERE e.address_hash = $1
      ORDER BY e.created_at`,
    [addressHash],
  );
  return result.rows;
}

/** Số hàng `users` — điều kiện "database còn trống" của cả A1 lẫn A2. */
async function countUsers(client: Client): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM account.users`,
  );
  return result.rows[0]?.count ?? 0;
}

/** Số hàng `verified` **khác** của cùng `sub` — điều kiện "không có đường vào khác". */
async function countOtherVerifiedAddresses(
  client: Client,
  sub: string,
  addressHash: string,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM account.email_addresses
      WHERE user_sub = $1 AND status = 'verified' AND address_hash <> $2`,
    [sub, addressHash],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Số bootstrap audit event **chứng minh lần tạo** của hàng email.
 *
 * ⚠️ Lọc `metadata->>'status' = 'created'` là điều kiện để hai yêu cầu của
 * ADR-0024 cùng đúng: (a) nhánh hội tụ đòi **đúng một** bootstrap audit event
 * chứng minh nguồn gốc, và (b) hội tụ vẫn ghi audit row của chính nó
 * (`status = 'converged'`). Nếu đếm mọi `type = 'bootstrap_account_provisioned'`
 * thì lần chạy thứ ba — và A2 sau một lần chạy lại — sẽ thấy hai row và từ chối
 * một trạng thái hoàn toàn hợp lệ. Row `created` là bằng chứng "Account này do
 * bootstrap tạo"; row `converged` chỉ là dấu vết của một lần xác nhận lại.
 *
 * ⚠️ **Giới hạn của bằng chứng này (accepted threat model, ADR-0024 Quyết định
 * 3).** `ecoma_account_runtime` có `INSERT` trên `security_events` — nó cần cho
 * audit của serving path — nên nó *có thể* ghi một row `status = 'created'`.
 * Database không phân biệt được row do CLI bootstrap (credential migrator) ghi
 * với row do runtime role ghi: bảng không có cột nguồn ghi và không có trigger
 * chặn theo `type`. Hệ quả chính xác: một người đã chiếm được credential runtime
 * của `account` **trước** lần bootstrap đầu tiên có thể dựng sẵn `users` +
 * `email_addresses` `verified` + row audit này, và một lần bootstrap do người
 * vận hành chạy sau đó sẽ hội tụ vào `sub` do họ chọn. Đó là leo thang từ
 * credential của `account` sang administrator của `staff-access`, nên nó không
 * được bỏ qua khi đọc kết quả.
 *
 * Không có đường nào trong phạm vi Issue #17 đóng được lỗ này mà không thêm một
 * kiểm soát ở tầng database (trigger chặn `type` này cho runtime role, hoặc thu
 * hẹp grant) — một thay đổi làm ADR-0024 Quyết định 3 không còn đúng nguyên văn.
 * Kiểm soát bù hiện tại: custody credential `account` (runtime role chỉ sống
 * trong Worker, không phải credential người vận hành), và sau một lần bootstrap
 * thành công thì `admins_ever > 0` làm nhánh hội tụ không còn đi tới được. Đây
 * là **giả định tin cậy đã ghi nhận**, không phải một bảo đảm của code.
 */
async function countCreationProofEvents(
  client: Client,
  sub: string,
  addressHash: string,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM account.security_events
      WHERE type = $1 AND subject_sub = $2 AND metadata->>'address_hash' = $3
        AND metadata->>'status' = 'created'`,
    [BOOTSTRAP_AUDIT_TYPE, sub, addressHash],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Kiểm bốn vế hội tụ trên **một** hàng `verified` duy nhất.
 *
 * Thứ tự kiểm là thứ tự mã lý do: địa chỉ khớp hằng → Account `active` → không có
 * hàng `verified` khác → audit provenance. Trả `sub` khi mọi vế đúng; ném
 * {@link BootstrapDenialError} khi bất kỳ vế nào sai.
 */
async function assertConvergedRow(
  client: Client,
  row: AddressRow,
  addressHash: string,
): Promise<string> {
  if (row.address_normalized !== BOOTSTRAP_EMAIL) {
    deny('address_not_bootstrap_proven');
  }
  if (row.account_status !== 'active') {
    deny('account_not_active');
  }
  if ((await countOtherVerifiedAddresses(client, row.user_sub, addressHash)) > 0) {
    deny('account_has_other_verified_address');
  }
  if ((await countCreationProofEvents(client, row.user_sub, addressHash)) !== 1) {
    deny('address_not_bootstrap_proven');
  }
  return row.user_sub;
}

/**
 * Quyết định từ các hàng **còn sống** (`pending`/`verified`) của địa chỉ canonical.
 *
 * Hàng `revoked` đã được caller loại riêng vì nó là dấu hiệu "đã có người từng
 * chạm địa chỉ" — procedure dừng, không tự xoá/revoke gì. Không bao giờ chọn một
 * hàng trong trạng thái nhoè: nhiều `sub`, nhiều hàng còn sống của cùng `sub`, hay
 * một hàng `pending` đều fail-closed.
 */
async function classifyLiveRows(
  client: Client,
  live: readonly AddressRow[],
  addressHash: string,
): Promise<ExistingState> {
  const subs = new Set(live.map((row) => row.user_sub));
  if (subs.size > 1) {
    deny('address_ambiguous');
  }
  if (live.length === 0) {
    return { kind: 'create' };
  }
  if (live.length > 1) {
    deny('address_multiple_live_rows');
  }
  const only = live[0];
  if (only === undefined) {
    deny('address_multiple_live_rows');
  }
  if (only.status === 'pending') {
    deny('address_pending_conflict');
  }
  return { kind: 'converge', sub: await assertConvergedRow(client, only, addressHash) };
}

/** Ghi audit bootstrap — **ném** khi insert hỏng, không nuốt lỗi. */
async function writeBootstrapAuditEvent(
  client: Client,
  params: {
    readonly sub: string;
    readonly addressHash: string;
    readonly correlationId: string;
    readonly operatorRef: string;
    readonly status: 'created' | 'converged';
  },
): Promise<void> {
  await client.query(
    `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
     VALUES ($1, $2, 'success', $3::jsonb)`,
    [
      params.sub,
      BOOTSTRAP_AUDIT_TYPE,
      JSON.stringify({
        address_hash: params.addressHash,
        correlation_id: params.correlationId,
        mode: 'bootstrap',
        verification_source: 'trusted_bootstrap',
        operator_ref: params.operatorRef,
        status: params.status,
      }),
    ],
  );
}

/**
 * A1 — create-or-resolve Account đầu tiên (ADR-0021 Quyết định 2, ADR-0024 Quyết định 1).
 *
 * Client phải có quyền DML của `db-account` (migrator/owner) và **không** đang ở
 * trong một transaction: hàm tự mở/commit/rollback. Hai lần chạy đồng thời trên
 * hai connection được tuần tự hoá bởi advisory xact lock; lần thứ hai thấy hàng đã
 * commit và đi nhánh hội tụ.
 *
 * Ghi trong cùng transaction: `account.users` (`active`), `account.email_addresses`
 * (`verified`, `verified_at = now()`, `is_sign_in = true`) và một
 * `account.security_events` `bootstrap_account_provisioned`. Audit hỏng ⇒ toàn bộ
 * transaction rollback — không có Account nào "thành công" mà không audit.
 *
 * @throws {BootstrapDenialError} mọi nhánh fail-closed, sau khi đã `ROLLBACK`.
 * @throws {TypeError} khi `correlationId` rỗng — audit không được phép thiếu neo.
 */
export async function provisionBootstrapAccount(
  client: Client,
  input: BootstrapAccountInput,
): Promise<BootstrapAccountResult> {
  if (typeof input.correlationId !== 'string' || input.correlationId.length === 0) {
    throw new TypeError('bootstrap correlationId must be a non-empty string');
  }
  if (typeof input.operatorRef !== 'string' || input.operatorRef.trim() === '') {
    throw new TypeError('bootstrap operatorRef must be a non-empty string');
  }

  const addressHash = await emailAddressHash(normalizeEmailAddress(BOOTSTRAP_EMAIL));

  await client.query('BEGIN');
  try {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BOOTSTRAP_LOCK_KEY]);

    const rows = await readAddressRows(client, addressHash);
    if (rows.some((row) => row.status === 'revoked')) {
      deny('address_revoked');
    }
    const live = rows.filter((row) => row.status === 'pending' || row.status === 'verified');
    const state = await classifyLiveRows(client, live, addressHash);

    if (state.kind === 'converge') {
      await writeBootstrapAuditEvent(client, {
        sub: state.sub,
        addressHash,
        correlationId: input.correlationId,
        operatorRef: input.operatorRef,
        status: 'converged',
      });
      await client.query('COMMIT');
      return { stage: 'account.provision', status: 'converged', sub: state.sub };
    }

    // Không có hàng còn sống: chỉ được tạo khi database chưa có Account nào.
    if ((await countUsers(client)) > 0) {
      deny('account_database_not_empty');
    }

    const sub = createSubject(generateSubjectEntropy());
    await client.query(`INSERT INTO account.users (sub, status) VALUES ($1, 'active')`, [sub]);
    await client.query(
      `INSERT INTO account.email_addresses
         (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
       VALUES ($1, $2, $3, 'verified', true, now())`,
      [sub, BOOTSTRAP_EMAIL, addressHash],
    );
    await writeBootstrapAuditEvent(client, {
      sub,
      addressHash,
      correlationId: input.correlationId,
      operatorRef: input.operatorRef,
      status: 'created',
    });
    await client.query('COMMIT');
    return { stage: 'account.provision', status: 'created', sub };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * A2 — đọc lại và xác nhận `sub` (ADR-0021 Quyết định 2, ADR-0024 Quyết định 4).
 *
 * **Strictly read-only**: không lock, không transaction, không audit row. Chỉ trả
 * `sub` khi state đúng là trạng thái hội tụ, gồm cả vế chứng minh nguồn gốc
 * bootstrap. Database trống ném `no_bootstrap_account` (A2 không tạo gì); database
 * không trống nhưng không có hàng canonical ném `account_database_not_empty`.
 *
 * @throws {BootstrapDenialError} mọi trạng thái khác trạng thái hội tụ.
 */
export async function verifyBootstrapAccount(
  client: Client,
): Promise<BootstrapAccountVerification> {
  const addressHash = await emailAddressHash(normalizeEmailAddress(BOOTSTRAP_EMAIL));

  const rows = await readAddressRows(client, addressHash);
  if (rows.some((row) => row.status === 'revoked')) {
    deny('address_revoked');
  }
  const live = rows.filter((row) => row.status === 'pending' || row.status === 'verified');

  if (live.length === 0) {
    if ((await countUsers(client)) > 0) {
      deny('account_database_not_empty');
    }
    deny('no_bootstrap_account');
  }

  const state = await classifyLiveRows(client, live, addressHash);
  if (state.kind === 'create') {
    // Không thể xảy ra: `live.length > 0` ở trên. Giữ nhánh fail-closed thay vì
    // giả định, để một thay đổi sau này ở `classifyLiveRows` không biến A2 thành
    // đường ghi.
    deny('no_bootstrap_account');
  }
  return { status: 'converged', sub: state.sub };
}

// -------------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------------

/** Đọc toàn bộ stdin — input của CLI, không bao giờ là command-line argument. */
async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

/**
 * Parse input A1 từ stdin JSON: `{"correlation_id":"...","operator_ref":"..."}`.
 *
 * Cả hai trường đều bắt buộc: `correlation_id` là neo nối audit giữa hai
 * database, `operator_ref` là tham chiếu người thực thi mà ADR-0021 Quyết định 6
 * đòi có trong audit. Nhận `operator_ref` rỗng ở đây sẽ tạo một Account mà audit
 * của nó không có attribution, và A1 đã commit nên không sửa lại được.
 */
function parseProvisionInput(raw: string): BootstrapAccountInput {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('stdin JSON must be an object');
  }
  const correlationId = (value as { correlation_id?: unknown }).correlation_id;
  const operatorRef = (value as { operator_ref?: unknown }).operator_ref;
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    throw new TypeError('correlation_id must be a non-empty string');
  }
  if (typeof operatorRef !== 'string' || operatorRef.trim() === '') {
    throw new TypeError('operator_ref must be a non-empty string');
  }
  return { correlationId, operatorRef };
}

/** In một dòng JSON lý do từ chối trên stderr — không kèm địa chỉ, hash hay DSN. */
function emitDenial(stage: string, reason: BootstrapCliFailureReason): void {
  console.error(JSON.stringify({ stage, status: 'denied', reason }));
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'provision' && command !== 'verify') {
    console.error('Usage: tsx db/bootstrap.mts <provision|verify> (A1/A2 input arrives on stdin).');
    process.exitCode = 1;
    return;
  }
  const stage = command === 'provision' ? STAGE_PROVISION : STAGE_VERIFY;

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Run this from a CI runner or ops box with the db-account migrator/owner credentials; the password belongs in the connection string, never in argv.',
    );
    process.exitCode = 1;
    return;
  }

  if (command === 'provision') {
    try {
      assertConfiguredBootstrapEmail(process.env['ECOMA_BOOTSTRAP_EMAIL']);
    } catch (error) {
      if (error instanceof BootstrapConfigurationError) {
        emitDenial(stage, error.reason);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  let input: BootstrapAccountInput | undefined;
  if (command === 'provision') {
    try {
      input = parseProvisionInput(await readStdin());
    } catch {
      emitDenial(stage, 'invalid_input');
      process.exitCode = 1;
      return;
    }
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: BOOTSTRAP_APPLICATION_NAME,
  });

  try {
    await client.connect();
  } catch {
    emitDenial(stage, 'database_unreachable');
    process.exitCode = 1;
    return;
  }

  try {
    if (command === 'provision' && input !== undefined) {
      const result = await provisionBootstrapAccount(client, input);
      console.log(JSON.stringify({ stage: result.stage, status: result.status, sub: result.sub }));
    } else {
      const result = await verifyBootstrapAccount(client);
      console.log(JSON.stringify({ stage: STAGE_VERIFY, status: result.status, sub: result.sub }));
    }
  } catch (error) {
    if (error instanceof BootstrapDenialError) {
      emitDenial(stage, error.reason);
    } else {
      // Lỗi ngoài hợp đồng: vẫn giữ đúng shape output, không rò chi tiết có thể
      // chứa giá trị cột (driver `pg` chèn giá trị vào message của một số lỗi).
      emitDenial(stage, 'internal_error');
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main();
  } catch {
    // Ngay cả `client.end()` cũng có thể ném; mọi lỗi thoát khỏi `main` vẫn phải
    // ra ngoài dưới dạng mã máy đọc, không phải message thô của driver.
    emitDenial(process.argv[2] === 'verify' ? STAGE_VERIFY : STAGE_PROVISION, 'internal_error');
    process.exitCode = 1;
  }
}
