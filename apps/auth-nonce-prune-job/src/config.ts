/**
 * Loader cấu hình của cron Worker `auth-nonce-prune-job` — wiring: đọc và kiểm `env`,
 * không chứa policy của thuật toán.
 *
 * ⚠️ **Fail-closed theo đúng hợp đồng của job cũ** (`.github/workflows/identity-nonce-prune.yaml`
 * — biến `missing` ở đầu `PRUNE_SCRIPT`): thiếu cấu hình là **đỏ mỗi lần chạy**, không phải
 * "bỏ qua run này". Đoạn comment đầu của `PRUNE_SCRIPT` đã khẳng định: một job dọn dữ
 * liệu không chạy được là
 * một lỗi cần thấy, không phải một lần bỏ qua. Ở Worker, "đỏ" là `throw` — lỗi của handler
 * `scheduled()` được Cron runtime ghi lại ở **Past events** của Cron dashboard (docs
 * `runtime-apis/handlers/scheduled/`: "the first waitUntil to fail is observed and recorded").
 *
 * ⚠️ Module này chỉ **đọc và kiểm** `env`; nó không log gì và không bao giờ giữ connection
 * string vào biến module scope nào ngoài giá trị trả về. Thông báo lỗi chỉ nêu **tên binding**
 * cấu hình, không bao giờ giá trị của nó — `connectionString` của Hyperdrive là admin-path
 * credential (migrator-level), đúng thứ bị cấm vào log (SR-001, invariant 9).
 *
 * Các cap của thuật toán sống ở application lib (`prune-caps.ts` của
 * `@ecoma-io/auth-nonce-prune-job-application`); loader chỉ **kiểm** chúng (bọc lỗi thành
 * `PruneJobConfigError`) rồi re-export để call-site cũ giữ nguyên đường import.
 *
 * Nguồn các tài liệu:
 * - `docs/applications/auth-nonce-prune-job/01-architecture.md` §6 (config, caps, outcomes)
 * - `docs/applications/auth/03-operations.md` §3.3 (cơ chế cũ mà job này thay thế)
 * - `docs/architecture/04-platform-facts.md` HD1–HD16 (đường Hyperdrive), WK4 (trần cron)
 */

import {
  BATCH_SIZE,
  CONNECT_TIMEOUT_SECONDS,
  LOCK_TIMEOUT_SECONDS,
  MAX_ATTEMPTS,
  MAX_BATCHES,
  MAX_SECONDS,
  STATEMENT_TIMEOUT_SECONDS,
} from '@ecoma-io/auth-nonce-prune-job-application';

/**
 * Pattern của `env` Worker: mapping của binding + biến cấu hình Workers, vậy nên
 * khai `unknown` — loader tự kiểm từng binding cần ở runtime.
 */
export type PruneJobEnv = Readonly<Record<string, unknown>>;

/** Lớp lỗi riêng của cấu hình — để composition root bắt khác với lỗi lớp statement. */
export class PruneJobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PruneJobConfigError';
  }
}

/** Tên Hyperdrive binding của `db-auth` — schema `auth`, role pruner `ecoma_auth_nonce_pruner`. */
export const DB_AUTH_BINDING = 'DB_AUTH';

/** Tên Hyperdrive binding của `db-account` — schema `account`, role `ecoma_account_nonce_pruner`. */
export const DB_ACCOUNT_BINDING = 'DB_ACCOUNT';

/**
 * Shape tối thiểu của một binding Hyperdrive ở `env` — chỉ phần mà `pg` cần.
 *
 * Kết nối được dựng bằng driver `pg` qua pool với `connectionString` của binding này —
 * pattern `apps/account/server/utils/db.ts`.
 */
export interface HyperdriveBindingLike {
  readonly connectionString: string;
}

// ── Cap của lô — hằng số của thuật toán, sống ở application lib ─────────────────────
// Toàn bộ cap (`BATCH_SIZE` / `MAX_BATCHES` / `MAX_SECONDS` / `MAX_ATTEMPTS` / các
// timeout / backoff) là **hằng số của thuật toán** — chúng được re-export từ
// `@ecoma-io/auth-nonce-prune-job-application` (`prune-caps.ts`) ở cuối module để
// call-site cũ và spec tiếp tục dùng đúng một nguồn.
// **Không** thêm env var nào cho override — một override chưa ai review là một ngân
// sách tự điền. Loader ở dưới vẫn kiểm từng cap ở mọi lần load: các mùa sau chỉnh
// hằng số là thay đổi thuật toán, phải qua review, và giá trị vô nghĩa bị từ chối
// trước khi chạy.

/**
 * Nạp và kiểm cấu hình của Worker: hai Hyperdrive binding bắt buộc.
 *
 * ⚠️ **Không default ngầm**: một binding missing không được rơi về "skip kho đó rồi trả
 * ok" — đúng kịch bản `outcome=not_configured` của script cũ muốn tránh. `throw` ở đây là
 * lỗi của handler `scheduled()` → cron invocation đỏ, thấy ở Past events.
 *
 * ⚠️ Validate cả cap, vì các mùa sau có thể chỉnh hằng số — chỉnh hằng số là thay đổi
 * thuật toán, phải được review. loader chỉ chức năng một việc: từ chối giá trị vô nghĩa
 * trước khi chạy — mỗi kho có cap trần riêng, không đổi theo env.
 *
 * @throws {PruneJobConfigError} Khi thiếu bất kỳ binding nào, hoặc cap vô nghĩa.
 */
export function loadPruneJobConfig(env: PruneJobEnv): {
  readonly dbAuth: HyperdriveBindingLike;
  readonly dbAccount: HyperdriveBindingLike;
} {
  assertPositiveWithConfigError(BATCH_SIZE, 'BATCH_SIZE');
  assertPositiveWithConfigError(MAX_BATCHES, 'MAX_BATCHES');
  assertPositiveWithConfigError(MAX_SECONDS, 'MAX_SECONDS');
  assertPositiveWithConfigError(MAX_ATTEMPTS, 'MAX_ATTEMPTS');
  assertPositiveWithConfigError(STATEMENT_TIMEOUT_SECONDS, 'STATEMENT_TIMEOUT_SECONDS');
  assertPositiveWithConfigError(LOCK_TIMEOUT_SECONDS, 'LOCK_TIMEOUT_SECONDS');
  assertPositiveWithConfigError(CONNECT_TIMEOUT_SECONDS, 'CONNECT_TIMEOUT_SECONDS');

  return {
    dbAuth: requireHyperdriveBinding(env, DB_AUTH_BINDING),
    dbAccount: requireHyperdriveBinding(env, DB_ACCOUNT_BINDING),
  };
}

/**
 * Đọc một Hyperdrive binding bắt buộc: phải là object mang `connectionString` là string
 * khác rỗng. Giá trị `connectionString` **không** được rơi ra log hay message lỗi — lỗi
 * chỉ nêu tên binding.
 *
 * Sự khác nhau giữa "binding missing" và "binding present nhưng sai shape" không phải hai
 * outcome riêng: cả hai đều là cấu hình thiếu/sai → `not_configured`, cùng `throw` —
 * không có đường "sai shape thì thử lần nữa" nào phải được trình bày.
 */
function requireHyperdriveBinding(env: PruneJobEnv, name: string): HyperdriveBindingLike {
  const bindingValue = env[name];
  if (typeof bindingValue !== 'object' || bindingValue === null) {
    throw new PruneJobConfigError(
      `${name} chua dc gan: Hyperdrive binding thieu trong env cua Worker`,
    );
  }
  const connectionString = (bindingValue as { connectionString?: unknown }).connectionString;
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new PruneJobConfigError(`${name} khong the doc connectionString (binding sai hinh)`);
  }
  return bindingValue as HyperdriveBindingLike;
}

/**
 * Kiểm một cap ở dạng số nguyên dương, throw lỗi cấu hình riêng của job — cùng shape
 * kiểm và cùng message trước đây của `assertPositive` khi cap còn sống ở module này.
 */
function assertPositiveWithConfigError(configured: number, name: string): void {
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new PruneJobConfigError(`${name} phai la so nguyen duong (>= 1)`);
  }
}

// ── Re-export của cap — cùng nguồn với thuật toán ───────────────────────────────────
// call-site cũ (`src/main.ts` không đọc cap trực tiếp nhưng spec so số) và bất kỳ
// consumer nào của app import cap từ đây như trước khi cap dời sang lib.

export {
  BATCH_SIZE,
  CONNECT_TIMEOUT_SECONDS,
  LOCK_TIMEOUT_SECONDS,
  MAX_ATTEMPTS,
  MAX_BATCHES,
  MAX_SECONDS,
  STATEMENT_TIMEOUT_SECONDS,
  retryBackoffSeconds,
} from '@ecoma-io/auth-nonce-prune-job-application';
