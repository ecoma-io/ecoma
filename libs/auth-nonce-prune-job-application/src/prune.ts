/**
 * Thuật toán prune nonce hết hạn cho một database — port TypeScript của `PRUNE_SCRIPT`
 * trong workflow cũ (`.github/workflows/identity-nonce-prune.yaml`), giữ nguyên **toàn bộ**
 * biên và bất biến của nó:
 *
 *   (1) Ranh giới service kiểm **ở phía server** trước khi xoá hàng nào: identity preflight
 *       hỏi `current_user` + `has_table_privilege(..., 'DELETE')`, rồi so với identity mong
 *       đợi của kho. DSN dán nhầm service bị chặn ở `identity_mismatch`, không âm thầm prune
 *       nhầm database.
 *   (2) Vị từ canonical không được nới: `expires_at < now()` với `now()` của PostgreSQL.
 *       Dấu `<` (không `<=`): hàng có `expires_at` đúng bằng `now()` vẫn còn sống. Không
 *       `TRUNCATE`, không xoá theo tuổi cố định, không sửa `expires_at`.   (3) **Bounded**: xoá theo lô đã commit (`BEGIN; SET LOCAL …; DELETE …; COMMIT` —
 *       `SET LOCAL` sống trong transaction theo HD5, một lô một transaction riêng), ba trần
 *       `BATCH_SIZE` / `MAX_BATCHES` / `MAX_SECONDS`, cộng `statement_timeout` +
 *       `lock_timeout` cho từng lô. Dừng bình thường là lô trả 0 hàng, hoặc lô cuối trả
 *       dưới `BATCH_SIZE`.
 *   (4) Chạm trần phải **kiểm chứng** còn backlog: một phép `EXISTS` rẻ (đi qua index
 *       `expires_at`) — còn backlog → `cap_hit` + **throw** để cron đỏ (không backlog →
 *       xoá vừa đủ lúc chạm trần → vẫn `ok`).
 *   (5) Retry **chỉ** cho lỗi transport (`05N01`/`05P01`/`08000`/`08003`/`08006`/`08001`/
 *       `08004`/`57P01`/`57P02`/`57P03` — connection-failure class của PostgreSQL) tối đa
 *       `MAX_ATTEMPTS`, backoff tuyến tính 5 s × lần thử. Lỗi khác (statement_failed, thiếu
 *       quyền, `statement_timeout` hết) dừng ngay — thử lại chúng chỉ kéo dài giữ khoá.
 *   (6) Log chỉ có service, outcome, số nonce đã dọn, số lô, thời lượng, số lần thử.
 *       **Không** nonce, không connection string, không thân request: câu DELETE bọc trong
 *       CTE `RETURNING 1` + `count(*)`, giá trị nonce không bao giờ rời database.
 *   (7) Idempotency giữa run: mỗi lô là một transaction riêng, chọn hàng theo `expires_at`,
 *       không có trạng thái tiến độ nào để hỏng — run đứt giữa đường chạy lại vẫn an toàn.
 *
 * ⚠️ Không advisory lock, không `PREPARE`/`EXECUTE`, không `SET` cấp connection: HD6
 * (Hyperdrive không hỗ trợ) và invariant 13 (`apps/account/server/utils/db.ts`). Mọi
 * timeout là `SET LOCAL` **trong** transaction của từng lô.
 */

import type { Pool } from 'pg';

import {
  BATCH_SIZE,
  CONNECT_TIMEOUT_SECONDS,
  LOCK_TIMEOUT_SECONDS,
  MAX_ATTEMPTS,
  MAX_BATCHES,
  MAX_SECONDS,
  STATEMENT_TIMEOUT_SECONDS,
  retryBackoffSeconds,
} from './prune-caps';

/**
 * Mã lỗi của PostgreSQL mang tính **hỏng hóc tạm thời** — duy nhất nhóm này được retry.
 *
 * Lấy theo SQLSTATE connection/operation-failure class của PostgreSQL (đo trên PostgreSQL
 * 17 — cùng lớp "psql exit 2" mà script cũ nghĩa là "mất kết nối"):
 *   `08000` connection_exception  ·  `08003` connection_does_not_exist
 *   `08001` sqlclient_unable_to_establish_sqlconnection
 *   `08004` sqlserver_rejected_establishment_of_sqlconnection
 *   `08006` connection_failure    ·  `08007` transaction_resolution_unknown
 *   `05P01` lock-not-available — statement hết `lock_timeout`: khoá đang bị giữ bởi
 *           transaction khác; thử lại sau backoff là đúng hành vi chờ lô. Script cũ
 *           **không** retry nó (psql exit 1), vì statement_timeout/lock_timeout về tầng
 *           nào cũng trả exit 1 trong psql. Ở đây phân loại theo SQLSTATE chính xác hơn:
 *           `lock_timeout` là một sự cố *tạm thời* (tình trạng khoá hiện tại của DB), và
 *           retry là an toàn vì lô bị ROLLBACK — không có lô nào dở dang chưa commit.
 *   `57P01`/`57P02`/`57P03` terminating_connection_due_to_administrators_command ·
 *           administrator_directive · operator_intervention — DB được admin kill connection.
 *
 * Lỗi **không** retry: `23502`, `23505` (ràng buộc), `42501` (thiếu quyền), `57014`
 * (`statement_timeout` hiện hành — dùng `statement_timeout`: bao gồm statement chạy
 * chậm đã vượt trần 60s, không phải lỗi transport) và mọi SQLSTATE khác.
 */
const TRANSPORT_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '05P01',
  '57P01',
  '57P02',
  '57P03',
]);

/**
 * Kết quả phân loại của một exception driver — được call-site map thành outcome:
 * `transport` được retry cho tới khi hết `MAX_ATTEMPTS` rồi đọc outcome là
 * `db_unreachable`; `statement` đọc outcome là `statement_failed` và không retry.
 *
 * Script cũ phân loại bằng **mã exit của psql**: `1` là statement_failed, `2` là
 * `db_unreachable`. Driver `pg` ở đây throw một exception — phân loại theo SQLSTATE của
 * nó (`code`): exception mang SQLSTATE nhảy theo bảng `TRANSPORT_SQLSTATES`; exception
 * KHÔNG mang SQLSTATE là lỗi ở mức driver/connect → transport.
 */
export type PruneOutcome =
  | 'ok'
  | 'cap_hit'
  | 'db_unreachable'
  | 'statement_failed'
  | 'identity_mismatch'
  | 'not_configured'
  | 'unexpected_output';

/**
 * Khoảng trần của một lần gọi — script cũ chốt là
 * `MAX_ATTEMPTS × (connect 10s + statement 60s + lock 30s) + backoff 5+10 = 225s`.
 * Dùng cho bảng tính thời gian ở `01-architecture.md §6` (tổng ≤ `MAX_SECONDS + 450`
 * < 900s WK4). Hằng số này để bảng tính ở `config.ts` và spec đối chiếu được với cùng
 * một con số, không phải dẫn lại chú thích script cũ.
 */
const ONE_CALL_WORST_CASE_SECONDS =
  MAX_ATTEMPTS * (CONNECT_TIMEOUT_SECONDS + STATEMENT_TIMEOUT_SECONDS) +
  retryBackoffSeconds(1) +
  retryBackoffSeconds(2);

/**
 * Callback sleep của vòng retry — tiêm từ composition root.
 *
 * ⚠️ Phải là **setTimeout thật**, KHÔNG busy-loop: backoff tuyến tính không giữ CPU một
 * isolate Worker mãi; WK4 tính trần theo wall-clock nên một busy-loop ở đây đốt đúng thứ
 * cron giới hạn. Giá trị `Ms` là **ms** (ký tự thứ hai của script cũ `sleep 5` là giây).
 */
export interface Sleep {
  (ms: number): Promise<void>;
}

/** Thực hiện fallback `setTimeout` — dùng cho composition root; spec gắn fake clock. */
export const defaultSleep: Sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Shape `pg` mà thuật toán cần — vốn là subset của `Pool`.
 *
 * ⚠️ Khai hẹp — không khai `pg.Pool` đầy đủ: đúng tính chất "thiếu một method được dùng
 * là lỗi compile" mà `apps/web-push-notification-job/src/env.ts` đã áp. Interface này
 * chỉ sich phục cho một spec fake pool của `pg` thật có thể thay chỗ mà không phải dựng
 * cả `pg.Pool` thật.
 */
export interface QueryPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
  connect(): Promise<{
    query(
      text: string,
      values?: unknown[],
    ): Promise<{
      rows: Record<string, unknown>[];
      rowCount: number | null;
    }>;
    release(err?: boolean | Error): void;
  }>;
}

/* -------------------------------------------------------------------------------------------- *
 * Kho — thư mục cấu hình cho một database mà một run prune sẽ chạm.
 * -------------------------------------------------------------------------------------------- */

/** Cấu hình của MỘT kho — cùng hình dạng cho hai service, mọi biến từ config + caller. */
export interface PruneTarget {
  /** Nhãn service cho log và dòng kết quả (`auth` / `account`). */
  readonly service: string;
  /** Schema chứa bảng `internal_nonces` (`auth` / `account`). */
  readonly schema: string;
  /**
   * Identity mong đợi — hình dạng `<role>|<trạng thái LEFT>` (giống `EXPECTED_IDENTITY`
   * của script cũ): role pruner có quyền `DELETE` trên kho nonce của chính service.
   * Sai (DSN dán nhầm service, credential sai, bảng thiếu) là điều kiện dừng sớm nhất.
   */
  readonly expectedIdentity: string;
  /** Pool `pg` đã dựng qua Hyperdrive binding tương ứng của kho (pattern `apps/account`). */
  readonly pool: Pool;
}

/** Kết quả prune của MỘT kho — đủ để log một dòng JSON và so quét theo service. */
export interface PruneTargetRun {
  readonly service: string;
  readonly outcome: PruneOutcome;
  /** Hàng đã xoá thật (đếm CSE — kể cả khi lô thứ N hỏng sau khi các lô trước đã commit). */
  readonly pruned: number;
  readonly batches: number;
  /** Thời lượng tổng kể từ khi handler bắt đầu — giây nguyên, cùng mốc với script cũ. */
  readonly duration_s: number;
  readonly retries: number;
  /** Lý do chạm trần (`batches` | `seconds`) — chỉ khi `capped` từng xảy ra. */
  readonly cap?: 'batches' | 'seconds';
}

/** Kết quả tổng của một run `Promise.all` — một dòng log JSON cho mỗi kho. */
export interface PruneRunResult {
  readonly auth: PruneTargetRun;
  readonly account: PruneTargetRun;
}

/**
 * Lỗi khi output của một statement không đúng shape đã ghim — `count(*)` của lô không
 * phải số, `EXISTS` không phải boolean, dòng identity thiếu/garbled.
 *
 * ⚠️ Mang `code = 'UNEXPECTED_OUTPUT'` — một mã **không** thuộc `TRANSPORT_SQLSTATES`, nên
 * `outcomeFromError` phân loại nó là `statement` → **không** retry. Học thuyết script cũ:
 * output sai hình là lỗi ở cấp câu/chương trình (`outcome=unexpected_output`, exit 1),
 * thử lại chỉ lặp lại cùng một shape sai.
 */
export class UnexpectedOutputError extends Error {
  readonly code = 'UNEXPECTED_OUTPUT';

  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedOutputError';
  }
}

/**
 * Phân loại một exception driver `pg` thành lớp lỗi.
 *
 * Ba lớp được phân biệt theo field `code` của exception `pg`:
 *
 *   - SQLSTATE **thuộc** `TRANSPORT_SQLSTATES` → transport (retry): đúng nhóm tình huống
 *     "psql exit 2" của script cũ.
 *   - SQLSTATE **không** thuộc nhóm đó (42501 thiếu quyền, 57014 `statement_timeout`, …)
 *     → statement (không retry): lỗi ở cấp câu, thử lại chỉ kéo dài giữ khoá.
 *   - **Không phải SQLSTATE** — hai nhánh con:
 *       * `UNEXPECTED_OUTPUT` (class {@link UnexpectedOutputError} ở trên) → statement:
 *         output sai shape đúng như psql `unexpected_output`;
 *       * còn lại → transport (retry). Driver `pg` throw connect-failure ở tầng socket
 *         với `code` là **errno hệ thống** — không phải SQLSTATE (`ENOTFOUND` mất DNS,
 *         `ECONNREFUSED` server không nghe, `ETIMEDOUT` đường chết ngang, `ECONNRESET` —
 *         cùng tình huống "psql exit 2", cùng lớp retry). Một exception `pg` không mang
 *         SQLSTATE nào cũng là lỗi ở mức kết nối/protocol, chưa chạm statement nào.
 */
function outcomeFromError(error: unknown): 'transport' | 'statement' {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    const code = (error as { code: string }).code;
    if (code === 'UNEXPECTED_OUTPUT') {
      return 'statement';
    }
    return TRANSPORT_SQLSTATES.has(code) ? 'transport' : 'statement';
  }
  return 'transport';
}

/* -------------------------------------------------------------------------------------------- *
 * Retry một lần gọi — chỉ cho transport, tối đa MAX_ATTEMPTS.
 * -------------------------------------------------------------------------------------------- */

/**
 * Thực hiện một callback chỉ đến khi SQLSTATE thuộc lớp transport; không phải, `throw` ngay.
 *
 * ⚠️ **Backoff tuyến tính `attempt * 5` giây** (giữ nguyên từ script cũ: `sleep 5`, sau đó
 * `sleep 10`). Đó là backoff bằng `setTimeout` thật được {@link Sleep} tiêm vào KHÔNG
 * busy-loop quay lại.
 */
async function callWithRetry<T>(
  what: string,
  cfg: { readonly maxAttempts: number },
  sleep: Sleep,
  logRetry: (what: string, attempt: number) => void,
  callback: () => Promise<T>,
): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await callback();
    } catch (error) {
      if (outcomeFromError(error) === 'statement' || attempt >= cfg.maxAttempts) {
        // Bọc lại với what=`what` để call-site phân biệt được WHERE của lỗi — không kể nó
        // lặp scope nào: identity / lô / probe dùng chung helper này của đúng một dòng.
        throw error;
      }
      // Transport-class error còn lượt thử: log tiến độ rồi đợi backoff tuyến tính.
      logRetry(what, attempt);
      await sleep(retryBackoffSeconds(attempt) * 1000);
      attempt += 1;
    }
  }
}

/* -------------------------------------------------------------------------------------------- *
 * Câu SQL — hình dạng giữ nguyên từ script cũ, tham số hoá qua schema.
 * -------------------------------------------------------------------------------------------- */

/**
 * Câu DELETE một lô — hình dạng đếm được từ `docs/applications/auth/03-operations.md` §3.3:
 *   `WITH deleted AS (DELETE … WHERE nonce = ANY (ARRAY(SELECT … LIMIT n)) RETURNING 1)
 *    SELECT count(*) FROM deleted`
 *
 * ⚠️ **`RETURNING 1` + `count(*)`:** giá trị `nonce` (dữ liệu nhạy cảm của envelope) KHÔNG
 * bao giờ ra tới client/log — bất biến (6) của workflow cũ. `WHERE nonce = ANY (ARRAY(…))`
 * ghim plan: planner chọn InitPlan ở SELECT con (limit n), rồi Index Scan
 * `internal_nonces_pkey` — đo được ở script cũ, trong khi hình dạng hiển nhiên
 * `DELETE … USING (SELECT … LIMIT n) b` để planner tự chọn `Hash Join + Seq Scan` TOÀN BẢNG
 * thành vế ngoài (mỗi lô quét cả bảng — tổng chi phí O(N²) đúng lúc backlog lớn nhất).
 */
function buildBatchSQL(schema: string, batchSize: number): string {
  return `
    WITH deleted AS (
      DELETE FROM ${schema}.internal_nonces
       WHERE nonce = ANY (ARRAY(
               SELECT nonce
                 FROM ${schema}.internal_nonces
                WHERE expires_at < now()
                LIMIT ${batchSize}
             ))
      RETURNING 1
    )
    SELECT count(*) FROM deleted;`;
}

/**
 * Phép `EXISTS` rẻ cho nhánh chạm trần: `SELECT EXISTS(… WHERE expires_at < now())` —
 * dừng ở hàng hết hạn đầu tiên qua index `expires_at`, không quét cả bảng, rẻ hơn `count(*)`
 * nhiều khi kho hàng trăm nghìn row nhưng chỉ cần trả lời đúng câu hỏi "còn backlog không".
 */
function buildExistsSQL(schema: string): string {
  return `SELECT EXISTS(SELECT 1 FROM ${schema}.internal_nonces WHERE expires_at < now());`;
}

/**
 * Identity preflight — giữ nguyên học thuyết bất biến (1):
 *
 *   `current_user || '|' || CASE
 *      WHEN to_regclass('<schema>.internal_nonces') IS NULL      THEN 'missing'
 *      WHEN has_table_privilege(to_regclass(…), 'DELETE') THEN 'deletable'
 *      ELSE 'no-delete'
 *    END`
 *
 * So kết quả server với `expectedIdentity`. `to_regclass` trả NULL (không lỗi) khi
 * schema/bảng không tồn tại, và `has_table_privilege` là STRICT → NULL regclass cũng trả
 * NULL — CASE không bao giờ ném vì bảng thiếu. Cố ý KHÔNG so tên database: DSN là
 * credential, và tên database không xuất hiện ở đâu trong repo để ghim; ranh giới service
 * nằm ở role + sự tồn tại của kho nonce, cả hai hỏi được từ server.
 */
function buildIdentitySQL(schema: string): string {
  return `SELECT current_user || '|' || CASE
      WHEN to_regclass('${schema}.internal_nonces') IS NULL THEN 'missing'
      WHEN has_table_privilege(to_regclass('${schema}.internal_nonces'), 'DELETE') THEN 'deletable'
      ELSE 'no-delete'
    END AS identity`;
}

/* -------------------------------------------------------------------------------------------- *
 * Prune MỘT kho — hình dạng của chính `PRUNE_SCRIPT`, viết thành hằng số của code.
 * -------------------------------------------------------------------------------------------- */

/**
 * Dựng phần cấu hình theo-kho — chỉ để đoạn run log có thể đọc thêm từ bên ngoài.
 *
 * ⚠️ Dùng chung với spec: mọi phép thử của spec đi qua đây hoặc là bản cấu hình đã biết
 * ở trên hoặc không thêm một hình dạng nào khác.
 */
export function oneTargetExpected(t: PruneTarget): string {
  return t.expectedIdentity;
}

/**
 * Chạy một lô — một transaction riêng đã commit:
 *
 *   `BEGIN; SET LOCAL statement_timeout=…; SET LOCAL lock_timeout=…; <batch CTE>; COMMIT`
 *
 * ⚠️ Mọi lô tự `BEGIN`/`COMMIT` — pattern của script cũ. Nhánh lỗi phải `ROLLBACK` trước
 * khi `release()`, để một trạng thái transaction lỗi không rò sang lần connect kế; không
 * advisory lock hay `PREPARE` ở đây — HD6 cấm trên mọi client Hyperdrive.
 */
async function runBatch(
  target: PruneTarget,
  statementTimeoutSeconds: number,
  lockTimeoutSeconds: number,
): Promise<number> {
  const client = await target.pool.connect();
  try {
    // BEGIN
    await client.query('BEGIN');
    try {
      // `SET LOCAL` sống trong transaction (HD5) — SET cấp connection bị RESET khi
      // connection trả về pool, tức tuyệt đối không đặt timeout ở cấp pool client;
      // SET LOCAL cùng transaction với DELETE là cách duy nhất trần được chắc chắn.
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutSeconds * 1000};`);
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutSeconds * 1000};`);
      // BATCH_SIZE/schema là constant config (không phải user input), nên nối SQL trực
      // tiếp là an toàn — mọi hình dạng tập ở hai buildBatchSQL/buildIdentitySQL, không
      // có đường nối nào khác.
      const sql = buildBatchSQL(target.schema, BATCH_SIZE);
      const result = await client.query(sql);
      const value = result.rows[0]?.['count'];
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new UnexpectedOutputError(`unexpected batch delete output: ${String(value)}`);
      }
      const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new UnexpectedOutputError(`unexpected batch delete output: ${String(value)}`);
      }
      await client.query('COMMIT');
      return parsed;
    } catch (error) {
      // ROLLBACK trước khi trả connection về pool — trạng thái transaction lỗi bắn sạch
      // (aborted transaction trong PostgreSQL trở nên lỗi ngay câu query kế tiếp nếu
      // không rollback). ROLLBACK tự fail trên connection đã chết cũng là chuyện bình
      // thường — release() vẫn trả connection, và error gốc bay ra ngoài.
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore — ROLLBACK trên connection hỏng là chuyện vào đúng cơ chế.
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Probe backlog còn lại — chỉ chạy khi chạm trần, giữ nguyên học thuyết bất biến (4):
 * trần chỉ chứng minh ta dừng sớm, không chứng minh còn backlog. Kho đã sạch báo đỏ
 * mỗi ngày cũng là tín hiệu sai (chiều ngược lại), nên gọi thẳng database xác nhận.
 */
async function backlogRemains(target: PruneTarget): Promise<boolean> {
  const result = await target.pool.query(buildExistsSQL(target.schema));
  const value = result.rows[0]?.['exists'];
  if (typeof value !== 'boolean') {
    throw new UnexpectedOutputError(`unexpected backlog probe output: ${String(value)}`);
  }
  return value;
}

/* -------------------------------------------------------------------------------------------- *
 * Run một kho — đúng PRUNE_SCRIPT từ dòng đầu tới dòng cuối.
 * -------------------------------------------------------------------------------------------- */
interface RetryBookkeeping {
  /** Đếm tổng các lần thử lại — đúng shape `retries=$(cat "$retry_file")` của script cũ. */
  retries: number;
}

/**
 * Prune MỘT kho, trả outcome với đủ counters hoặc **throw** ở đúng những đường mà
 * workflow cũ `exit 1` (fail closed — Cron Past events đỏ).
 *
 * ⚠️ `outcome=cap_hit` **throw**: một backlog chưa drain hết không được báo xanh. Kịch bản
 * quay lại của một lần "throw rồi chạy tiếp từ chỗ còn lại" là đúng học thuyết của job:
 * lần chạy kế tiếp tiếp tục từ chỗ còn backlog.
 *
 * ⚠️ Identity mismatch throw **trước** khi một DELETE nào được gọi — bất
 * biến (1). Spec ghim điều này bằng pool fake đếm số `query` DELETE từng được gọi.
 */
export async function pruneTarget(
  target: PruneTarget,
  opts: {
    /** Sleep của vòng retry — chỉ để spec gắn fake clock; không thay đổi thứ tự chạy. */
    sleep?: Sleep;
    /** Log một lần thử lại — production gắn `console.log` JSON một dòng; spec gắn fake. */
    logRetry?: (what: string, attempt: number) => void;
    /**
     * Mốc thời điểm bắt đầu run của handler — góc nhìn chung của cả hai kho, truyền
     * từ caller (`main.ts`); hình dạng nguyên bản của script cũ (`SECONDS - started`).
     */
    startedAtMs: number;
    /** `Date.now()` của isolate — inject để spec dùng fake clock, không đổi chỗ nào khác. */
    now?: () => number;
  },
): Promise<PruneTargetRun> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const started = opts.startedAtMs;
  const retries: RetryBookkeeping = { retries: 0 };
  const maxAttempts = { maxAttempts: MAX_ATTEMPTS };
  const logRetry =
    opts.logRetry ??
    ((w: string, n: number): void => {
      void w;
      void n;
      // Mặc định câm — production gắn bằng `console.log` JSON một dòng ở composition root,
      // spec gắn một fake. Việc này khác script cũ ở chỗ một lần retry là một dòng log
      // riêng, giống `::warning::` của script cũ — hình dạng tương tự, kênh khác.
    });

  // Trần của một call ≤ 225s (một call retry thêm trần backoff nữa). Preflight và lô
  // đều qua `callWithRetry`, nên trần này bao được tất cả; `ONE_CALL_WORST_CASE_SECONDS`
  // chỉ để bảng tính ở `config.ts` không phải tự nhắc đến script cũ — dùng dưới dạng
  // reference trong spec.
  void ONE_CALL_WORST_CASE_SECONDS;

  // ── Preflight: đúng role, và role đó THẬT SỰ có `DELETE` ─────────────────────
  // Sai identity → `identity_mismatch` + throw, KHÔNG xoá hàng nào.
  const identityRow = await callWithRetry(
    'identity_check',
    maxAttempts,
    sleep,
    (what, attempt) => {
      retries.retries += 1;
      logRetry(what, attempt);
    },
    async () => {
      const result = await target.pool.query(buildIdentitySQL(target.schema));
      const row = result.rows[0];
      if (row === undefined) {
        throw new UnexpectedOutputError('unexpected identity output: no row');
      }
      const value = row['identity'];
      if (typeof value !== 'string') {
        throw new UnexpectedOutputError(`unexpected identity output: ${String(value)}`);
      }
      return value;
    },
  );
  if (identityRow !== target.expectedIdentity) {
    // `connected_as` là role + trạng thái quyền hỏi từ chính server, không phải giá trị
    // DSN — ghi ra được mà không lộ credential.
    throw new Error(
      `service=${target.service} outcome=identity_mismatch connected_as=${identityRow} expected=${target.expectedIdentity} pruned=0 batches=0 duration_s=${Math.floor((now() - started) / 1000)} retries=${retries.retries}`,
    );
  }

  // ── Vòng lặp có biên ────────────────────────────────────────────────────────
  // Mỗi vòng là một transaction riêng đã commit (runBatch), nên một run bị ngắt giữa
  // đường vẫn để lại tiến độ thật và lần chạy sau tiếp tục từ chỗ còn lại: điều kiện
  // chọn hàng theo thời gian, không theo trạng thái tiến độ nào để hỏng.
  let batches = 0;
  let deletedTotal = 0;
  let capped: 'batches' | 'seconds' | undefined;
  let outcome: PruneOutcome = 'ok';

  for (;;) {
    const elapsed = Math.floor((now() - started) / 1000);
    // Trần kiểm TRƯỚC mỗi lô, tính từ khi run bắt đầu (giống `SECONDS - started` của
    // script cũ — phí của preflight được TRỪNG từ trần của vòng lô).
    if (batches >= MAX_BATCHES) {
      capped = 'batches';
      break;
    }
    if (elapsed >= MAX_SECONDS) {
      capped = 'seconds';
      break;
    }

    const deleted = await callWithRetry(
      'batch_delete',
      maxAttempts,
      sleep,
      (what, attempt) => {
        retries.retries += 1;
        logRetry(what, attempt);
      },
      () => runBatch(target, STATEMENT_TIMEOUT_SECONDS, LOCK_TIMEOUT_SECONDS),
    );

    // 0 hàng = đã drain hết. Điều kiện dừng bình thường, không phải lỗi: chạy lại trên
    // một kho đã sạch phải thành công.
    if (deleted === 0) {
      break;
    }

    deletedTotal += deleted;
    batches += 1;

    // Lô cuối luôn nhỏ hơn kích thước lô; dừng luôn thay vì thêm một vòng chắc chắn trả 0.
    if (deleted < BATCH_SIZE) {
      break;
    }
  }

  // ── Chạm trần — kiểm chứng còn backlog bằng EXISTS ──────────────────────────
  let capReason: 'batches' | 'seconds' | undefined;
  if (capped !== undefined) {
    capReason = capped;
    const remains = await callWithRetry(
      'backlog_probe',
      maxAttempts,
      sleep,
      (what, attempt) => {
        retries.retries += 1;
        logRetry(what, attempt);
      },
      () => backlogRemains(target),
    );
    if (remains) {
      throw new Error(
        `service=${target.service} outcome=cap_hit cap=${capReason} pruned=${deletedTotal} batches=${batches} duration_s=${Math.floor((now() - started) / 1000)} retries=${retries.retries} backlog_remains=true`,
      );
    }
    // Chạm trần nhưng đã drain hết: xoá xong là thành công, không phải lỗi — cùng
    // lập luận "báo đỏ sẽ buộc người trực điều tra một run đã sạch".
    outcome = 'ok';
  }

  return {
    service: target.service,
    outcome,
    pruned: deletedTotal,
    batches,
    duration_s: Math.floor((now() - started) / 1000),
    retries: retries.retries,
    ...(capReason === undefined ? {} : { cap: capReason }),
  };
}
