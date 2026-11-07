/**
 * Implement {@link JobStatePort} trên D1 `push-job` — **bốn nhóm** FR-022.
 *
 * ⚠️ **Idempotency là thứ được *chứng minh* ở đây, không phải ở call site.** `beginAttempt` trả
 * `false` khi `(delivery_id, attempt)` đã tồn tại, và caller **không** được bỏ qua kết quả đó —
 * đó là điều kiện đủ để Queue redelivery (W1, W4) và hai worker cùng consume cùng một message
 * không sinh state mâu thuẫn. Cơ chế là `INSERT OR IGNORE` + `meta.changes`: một write vô
 * hiệu vì vi phạm UNIQUE **không** phải read-then-write, đúng `docs/architecture/04-platform-facts.md`
 * DB3.
 *
 * ⚠️ **Envelope được ghi đúng một lần** (lần consume đầu). `beginAttempt` chỉ `INSERT` vào
 * `push_jobs` khi row chưa có; lần sau nó chỉ **chạm** `last_consumed_at`/`consume_count`. Nếu
 * nó overwrite envelope thì job reconciliation sẽ re-deliver envelope của lần consume **thứ
 * n**, và mọi thay đổi giữa hai lần đó (payload materialize khác) sẽ biến một "re-deliver
 * chính xác" thành một message khác — đúng thứ FR-022 cấm.
 *
 * ⚠️ **Không** có logical delivery state ở đây. `terminal_outcome` là kết cục **của job**
 * (việc tôi đã xong), không phải `Push Delivery.status` của control plane; delivery đó được
 * ghi qua `DeliveryRuntimePort.writeOutcome` với fencing token.
 */

import type {
  AttemptOutcome,
  AttemptPhase,
  AttemptRecord,
  JobRecord,
  JobStatePort,
  StoredDeliveryEnvelope,
} from '@ecoma-io/web-push-notification-job-application';

import type { D1DatabaseLike, D1ResultSet } from './d1-surface';

/** Cột của `push_jobs` đọc trong `SELECT`. */
const JOB_COLUMNS =
  'delivery_id, envelope_version, notification_id, subscription_id, provider_id, transport, ' +
  'payload_json, consume_count, last_consumed_at, consumed_at, processed, terminal_outcome, ' +
  'created_at, updated_at';

/** Cột của `push_job_attempts` đọc trong `SELECT`. */
const ATTEMPT_COLUMNS =
  'delivery_id, attempt, outcome, phase, http_status, retry_after_ms, state, started_at, updated_at';

/** Row thô của `push_jobs` — `payload_json` là TEXT, còn lại là scalar. */
interface JobRow {
  readonly delivery_id: string;
  readonly envelope_version: number;
  readonly notification_id: string;
  readonly subscription_id: string;
  readonly provider_id: string;
  readonly transport: string;
  readonly payload_json: string;
  readonly consume_count: number;
  readonly last_consumed_at: number;
  readonly consumed_at: number;
  readonly processed: number;
  readonly terminal_outcome: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Row thô của `push_job_attempts`. */
interface AttemptRow {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly outcome: string;
  readonly phase: string;
  readonly http_status: number | null;
  readonly retry_after_ms: number | null;
  readonly state: string;
  readonly started_at: number;
  readonly updated_at: number;
}

/** Lỗi khi một hàng `push-job` không đọc được — đây là dữ liệu bền vững, hỏng là hỏng thật. */
export class MalformedJobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedJobStateError';
  }
}

export interface D1JobStateRepositoryOptions {
  readonly db: D1DatabaseLike;
}

export class D1JobStateRepository implements JobStatePort {
  readonly #db: D1DatabaseLike;

  constructor(options: D1JobStateRepositoryOptions) {
    this.#db = options.db;
  }

  /**
   * Ghi envelope lần consume đầu (nếu chưa có) + attempt record idempotent.
   *
   * ⚠️ **Thứ tự hai write là cố ý**: attempt được `INSERT OR IGNORE` **trước** để phím
   * idempotency của nhóm (1) được thiết lập trước khi có bất kỳ write nào khác — nếu write
   * thứ hai (touch `push_jobs`) ném, một redelivery vẫn nhận diện được `attempt` này là đã
   * thấy chứ không tạo attempt mới. Và `push_jobs` được `INSERT OR IGNORE` chứ không phải
   * `UPDATE`: overwrite envelope là sai (xem JSDoc lớp).
   */
  async beginAttempt(input: {
    readonly envelope: StoredDeliveryEnvelope;
    readonly attempt: number;
    readonly nowMs: number;
  }): Promise<boolean> {
    const { envelope, attempt, nowMs } = input;
    const payloadJson = serializePayload(envelope);

    const attemptInsert = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO push_job_attempts
           (delivery_id, attempt, outcome, phase, http_status, retry_after_ms, state, started_at, updated_at)
         VALUES (?, ?, 'consumed', 'not_sent', NULL, NULL, 'open', ?, ?)`,
      )
      .bind(envelope.delivery_id, attempt, nowMs, nowMs)
      .run();
    const attemptCreated = attemptInsert.meta.changes === 1;

    // Envelope lần consume đầu — `INSERT OR IGNORE` nên lần sau **không** ghi đè.
    const jobInsert = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO push_jobs
           (delivery_id, envelope_version, notification_id, subscription_id, provider_id,
            transport, payload_json, consume_count, last_consumed_at, consumed_at,
            processed, terminal_outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, NULL, ?, ?)`,
      )
      .bind(
        envelope.delivery_id,
        envelope.version,
        envelope.notification_id,
        envelope.subscription_id,
        envelope.provider_id,
        envelope.transport,
        payloadJson,
        nowMs,
        nowMs,
        nowMs,
        nowMs,
      )
      .run();
    const jobCreated = jobInsert.meta.changes === 1;

    // Chạm "đã nhận lúc nào" — nền của ngưỡng "kẹt" của job reconciliation.
    //
    // ⚠️ **Chỉ tăng `consume_count` khi row ĐÃ có sẵn.** Lần đầu `INSERT` đã ghi
    // `consume_count = 1`, nên một `UPDATE ... + 1` vô điều kiện sẽ ghi một lần consume đầu
    // thành **2** — và `consume_count` là số quan sát được trong job state (FR-022 nhóm 4), nên
    // một lệch một ở đó là một con số sai đọc ra ngoài. `consume_count` là bộ đếm *consume*, còn
    // `attempts` là bộ đếm *attempt* — hai thứ khác nhau, và `attempts` mới là thứ cần tăng kể
    // cả khi lần consume đó là attempt trùng.
    await this.#db
      .prepare(
        `UPDATE push_jobs
            SET consume_count = consume_count + ?, last_consumed_at = ?, updated_at = ?
          WHERE delivery_id = ?`,
      )
      .bind(jobCreated ? 0 : 1, nowMs, nowMs, envelope.delivery_id)
      .run();

    return attemptCreated;
  }

  /**
   * Đóng attempt đang mở.
   *
   * ⚠️ Ghi đè `outcome`/`phase` là **có chủ đích**: attempt là một lần **thử**, và nếu có một
   * retry đã ghi trước rồi một execution sau hoàn thành, thì attempt đó kết thúc ở kết cục
   * cuối. Lệnh có predicate `state = 'open'` để một `completeAttempt` lặp lại không tạo một
   * attempt thứ hai — và `updated_at >= started_at` trong schema giữ tính thứ tự.
   */
  async completeAttempt(input: {
    readonly deliveryId: string;
    readonly attempt: number;
    readonly outcome: AttemptOutcome;
    readonly phase: AttemptPhase;
    readonly httpStatus: number | null;
    readonly retryAfterMs: number | null;
    readonly nowMs: number;
  }): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE push_job_attempts
            SET outcome = ?, phase = ?, http_status = ?, retry_after_ms = ?,
                state = 'completed', updated_at = ?
          WHERE delivery_id = ? AND attempt = ? AND state = 'open'`,
      )
      .bind(
        input.outcome,
        input.phase,
        input.httpStatus,
        input.retryAfterMs,
        input.nowMs,
        input.deliveryId,
        input.attempt,
      )
      .run();
  }

  /**
   * Đặt processed marker.
   *
   * ⚠️ Guarded bằng `processed = 0`: đặt marker là một quyết định **một lần**. Điều này chặn một
   * race đáng kể — W4 (persist rồi crash trước ACK) khiến redelivery đi qua nhánh này lần
   * nữa với kết cục y hệt, và một write không guard sẽ bump `updated_at` mỗi lần, làm một job
   * đã xong trông như vừa bị chạm (nhiễu ngưỡng "kẹt").
   */
  async markProcessed(input: {
    readonly deliveryId: string;
    readonly terminalOutcome: 'delivered' | 'failed' | 'expired';
    readonly nowMs: number;
  }): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE push_jobs
            SET processed = 1, terminal_outcome = ?, updated_at = ?
          WHERE delivery_id = ? AND processed = 0`,
      )
      .bind(input.terminalOutcome, input.nowMs, input.deliveryId)
      .run();
  }

  async findByDeliveryId(deliveryId: string): Promise<JobRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${JOB_COLUMNS} FROM push_jobs WHERE delivery_id = ?`)
      .bind(deliveryId)
      .first<JobRow>();
    if (row === null) {
      return null;
    }
    const lastAttempt = await this.#latestAttemptRow(deliveryId);
    const openAttempt = await this.#openAttemptRow(deliveryId);
    return toJobRecord(row, lastAttempt, openAttempt);
  }

  /**
   * Job **chưa** processed mà `last_consumed_at` cũ hơn ngưỡng.
   *
   * ⚠️ Lọc `processed = 0` **trong SQL**, không lọc ở bộ nhớ: một bảng job đủ lớn mà
   * `LIMIT` áp sau khi lọc thì trả về `limit` job **không** kẹt và bỏ sót job kẹt thật. Đây
   * là lý do `push_jobs_stuck_idx` là partial index trên `processed = 0` — nó phục vụ đúng
   * câu truy vấn này.
   *
   * ⚠️ `WHERE last_consumed_at <= ?` với ngưỡng tính bằng `nowMs - stuckAfterMs`: job vừa
   * nhận không kẹt, job nhận từ lâu thì kẹt. Dùng `<=` nên một job đúng bằng ngưỡng cũng
   * được coi là kẹt — đây là lựa chọn **fail-safe**: sweep sớm hơn một chút chỉ tốn một lần
   * claim thừa (claim atomic nên lần thừa đó là no-op), còn sweep muộn là mất việc.
   */
  async listStuck(input: {
    readonly stuckAfterMs: number;
    readonly nowMs: number;
    readonly limit: number;
    readonly maxAttempts?: number;
  }): Promise<readonly JobRecord[]> {
    const threshold = input.nowMs - input.stuckAfterMs;
    // Ngân sách attempt: job đã bị consume quá `maxAttempts` lần thì **không** nằm trong danh
    // sách kẹt — đó là việc đã kiệt, không được reconciliation hồi sinh. Lọc **trong SQL**
    // (không phải sau `LIMIT`) để không bỏ sót job kẹt thật: nếu áp `LIMIT` trước khi lọc
    // thì `limit` job đầu tiên có thể toàn là job kiệt và job kẹt thật bị cắt mất.
    //
    // ⚠️ Điều kiện kiệt: `consume_count >= maxAttempts` (số lần consume) **hoặc** tồn tại
    // attempt row có `attempt >= maxAttempts` (số lần Queue redeliver). Hai con số khác nhau
    // (`consume_count` là consume, `attempt` là attempt), nên cả hai đều phải kiểm.
    const maxAttempts = input.maxAttempts;
    const budgetClause =
      maxAttempts === undefined
        ? ''
        : 'AND consume_count < ? AND NOT EXISTS (SELECT 1 FROM push_job_attempts a WHERE a.delivery_id = push_jobs.delivery_id AND a.attempt = (SELECT MAX(b.attempt) FROM push_job_attempts b WHERE b.delivery_id = push_jobs.delivery_id) AND a.attempt >= ?)';
    const sql = `SELECT ${JOB_COLUMNS} FROM push_jobs
          WHERE processed = 0 AND last_consumed_at <= ?
          ${budgetClause}
          ORDER BY last_consumed_at ASC
          LIMIT ?`;
    const bindings: unknown[] = [threshold];
    if (maxAttempts !== undefined) {
      bindings.push(maxAttempts, maxAttempts);
    }
    bindings.push(input.limit);
    const result = await this.#db
      .prepare(sql)
      .bind(...bindings)
      .all<JobRow>();
    const rows = result.results;
    const records: JobRecord[] = [];
    for (const row of rows) {
      const lastAttempt = await this.#latestAttemptRow(row.delivery_id);
      const openAttempt = await this.#openAttemptRow(row.delivery_id);
      records.push(toJobRecord(row, lastAttempt, openAttempt));
    }
    return records;
  }

  async #latestAttemptRow(deliveryId: string): Promise<AttemptRow | null> {
    return this.#db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM push_job_attempts
          WHERE delivery_id = ? ORDER BY attempt DESC LIMIT 1`,
      )
      .bind(deliveryId)
      .first<AttemptRow>();
  }

  async #openAttemptRow(deliveryId: string): Promise<AttemptRow | null> {
    return this.#db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM push_job_attempts
          WHERE delivery_id = ? AND state = 'open'
          ORDER BY attempt DESC LIMIT 1`,
      )
      .bind(deliveryId)
      .first<AttemptRow>();
  }
}

/* -------------------------------------------------------------------------------------- */
/* Decode                                                                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Chuyển row thô → {@link JobRecord}.
 *
 * ⚠️ **Mọi hỏng đều `throw`, không bị bỏ âm thầm.** Đây là dữ liệu bền vững đọc từ D1; một
 * `payload_json` không parse được là một hàng hỏng mà cần người đọc, và trả `null` biến nó
 * thành "delivery không có job record" — tức đúng cái mà job reconciliation dùng để kết luận
 * "không việc nào kẹt" (§14.10).
 */
function toJobRecord(
  row: JobRow,
  lastAttemptRow: AttemptRow | null,
  openAttemptRow: AttemptRow | null,
): JobRecord {
  const payload = parsePayload(row.payload_json, row.delivery_id);
  const processed = row.processed === 1;
  const terminalOutcome = row.terminal_outcome;
  if (processed && terminalOutcome === null) {
    throw new MalformedJobStateError(
      `push_jobs ${row.delivery_id}: processed marker khong co terminal_outcome.`,
    );
  }
  return {
    deliveryId: row.delivery_id,
    envelope: {
      version: row.envelope_version,
      delivery_id: row.delivery_id,
      notification_id: row.notification_id,
      subscription_id: row.subscription_id,
      provider_id: row.provider_id,
      transport: row.transport,
      payload,
    },
    consumeCount: row.consume_count,
    openAttempt:
      openAttemptRow === null
        ? null
        : { attempt: openAttemptRow.attempt, startedAt: openAttemptRow.started_at },
    lastAttempt: lastAttemptRow === null ? null : toAttemptRecord(lastAttemptRow),
    processed,
    terminalOutcome: readTerminalOutcome(terminalOutcome, row.delivery_id),
    lastConsumedAt: row.last_consumed_at,
    updatedAt: row.updated_at,
  };
}

function toAttemptRecord(row: AttemptRow): AttemptRecord {
  return {
    deliveryId: row.delivery_id,
    attempt: row.attempt,
    outcome: row.outcome as AttemptOutcome,
    phase: row.phase as AttemptPhase,
    httpStatus: row.http_status,
    retryAfterMs: row.retry_after_ms,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Serialize payload của envelope lưu trong D1.
 *
 * ⚠️ `JSON.stringify` có thể ném khi `payload.data` chứa tham chiếu vòng — mà `payload.data`
 * là **opaque** với worker và chỉ được ràng buộc bởi JSON-compatibility ở control plane. Nếu
 * serialize ném ở đây thì toàn bộ việc ghi job state hỏng; nhưng nếu nuốt lỗi và ghi chuỗi rỗng
 * thì envelope lưu **không tái dựng được** — mất đúng thứ mà job reconciliation cần. Vì vậy lỗi
 * ở đây là lỗi contract dữ liệu và phải lộ ra, không phải lỗi hạ tầng để nuốt.
 */
function serializePayload(envelope: StoredDeliveryEnvelope): string {
  try {
    return JSON.stringify(envelope.payload);
  } catch {
    throw new MalformedJobStateError(
      `Envelope ${envelope.delivery_id}: payload khong serialize duoc thanh JSON.`,
    );
  }
}

/** Parse `payload_json` — lỗi parse là hàng hỏng, không phải "không có job record". */
function parsePayload(json: string, deliveryId: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new MalformedJobStateError(`push_jobs ${deliveryId}: payload_json khong parse duoc.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MalformedJobStateError(`push_jobs ${deliveryId}: payload_json khong phai object.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function readTerminalOutcome(
  value: string | null,
  deliveryId: string,
): 'delivered' | 'failed' | 'expired' | null {
  if (value === null) {
    return null;
  }
  if (value === 'delivered' || value === 'failed' || value === 'expired') {
    return value;
  }
  throw new MalformedJobStateError(
    `push_jobs ${deliveryId}: terminal_outcome ngoai tap closed (${value}).`,
  );
}

/** Kết quả của một `all()`/`run()` chưa dùng — giữ type helper cho thao tác chẳng hạn. */
export type { D1ResultSet };
