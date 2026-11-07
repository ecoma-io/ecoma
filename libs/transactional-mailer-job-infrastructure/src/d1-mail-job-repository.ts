import {
  MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS,
  MAIL_JOB_PERSISTABLE_STATUS_VALUES,
  MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS,
  MAIL_JOB_REPORTABLE_STATE_VALUES,
  assertBoundedOptionalString,
  assertBoundedString,
  assertClosedValue,
  assertLeaseOwner,
  assertPositiveInteger,
  assertSafeInteger,
  classifyBudgetExhaustedDenial,
  classifyAmbiguityBlockedDenial,
  classifyGenerationAdvanceDenial,
  classifyLeaseOwnershipDenial,
  classifyReportCompletionDenial,
  classifyReportLeaseDenial,
  classifySameGenerationClaimDenial,
  classifyProviderCallBoundaryDenial,
  sanitizeErrorToken,
  type AcquireReportLeaseParams,
  type AcquireReportLeaseResult,
  type BlockedBacklogSweepItem,
  type ClaimGenerationAdvanceParams,
  type ClaimGenerationAdvanceResult,
  type ClaimSameGenerationParams,
  type ClaimSameGenerationResult,
  type CompleteReportParams,
  type CompleteReportResult,
  type CreatePendingJobParams,
  type CreatePendingJobResult,
  type FindBlockedBacklogCandidatesParams,
  type FindReportSweepCandidatesParams,
  type FindStaleLeaseCandidatesParams,
  type KeepReportPendingParams,
  type KeepReportPendingResult,
  type MailJobRecord,
  type MailJobRepository,
  type MarkBlockedBudgetExhaustedParams,
  type MarkBlockedBudgetExhaustedResult,
  type PersistExecutionResultParams,
  type PersistExecutionResultResult,
  type MarkProviderCallBoundaryParams,
  type MarkProviderCallBoundaryResult,
  type MarkProviderAmbiguityBlockedParams,
  type MarkProviderAmbiguityBlockedResult,
  type RecordLookupErrorParams,
  type RecordLookupErrorResult,
  type ReleaseExecutionLeaseParams,
  type ReleaseExecutionLeaseResult,
  type RenewExecutionLeaseParams,
  type RenewExecutionLeaseResult,
  type ReportSweepItem,
  type StaleLeaseSweepItem,
} from '@ecoma-io/transactional-mailer-job-application';

import { readChanges, type D1DatabaseLike } from './d1-database-like';
import { decodeMailJobRow, MAIL_JOB_COLUMNS } from './mail-job-row';

const COLUMNS = MAIL_JOB_COLUMNS.join(', ');

export type D1MailJobRepositoryOptions = {
  readonly db: D1DatabaseLike;
};

/**
 * Guard dùng chung cho mọi conditional UPDATE bảo vệ execution lease (§9.2.2):
 * `delivery_id` + `lease_owner` + `execution_generation`, cộng `dispatch_generation`
 * ở các transition ghi kết quả/release.
 *
 * Validate ở đây là lớp cuối trước khi giá trị chạm parameter của D1 (§6): một caller
 * không tin cậy không thể đưa status hay attempt counter vào (port không nhận hai field
 * đó), và các field định danh/ownership phải đúng kiểu, không rỗng, generation >= 1.
 */
type LeaseTokenGuardParams = {
  readonly deliveryId: string;
  readonly owner: string;
  readonly executionGeneration: number;
  readonly nowMs: number;
};

type LeaseGuardParams = LeaseTokenGuardParams & {
  readonly dispatchGeneration: number;
};

type ReportGuardParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
};

function assertLeaseTokenGuard(params: LeaseTokenGuardParams): void {
  assertBoundedString(params.deliveryId, 'deliveryId');
  assertLeaseOwner(params.owner, 'owner');
  assertPositiveInteger(params.executionGeneration, 'executionGeneration');
  assertSafeInteger(params.nowMs, 'nowMs');
}

function assertLeaseGuard(params: LeaseGuardParams): void {
  assertLeaseTokenGuard(params);
  assertPositiveInteger(params.dispatchGeneration, 'dispatchGeneration');
}

function assertReportGuard(params: ReportGuardParams): void {
  assertBoundedString(params.deliveryId, 'deliveryId');
  assertLeaseOwner(params.owner, 'owner');
  assertPositiveInteger(params.dispatchGeneration, 'dispatchGeneration');
  assertSafeInteger(params.nowMs, 'nowMs');
}

export class D1MailJobRepository implements MailJobRepository {
  readonly #db: D1DatabaseLike;

  constructor(options: D1MailJobRepositoryOptions) {
    this.#db = options.db;
  }

  async #read(deliveryId: string): Promise<MailJobRecord | null> {
    const row = await this.#db
      .prepare<Record<string, unknown>>(`SELECT ${COLUMNS} FROM mail_jobs WHERE delivery_id = ?`)
      .bind(deliveryId)
      .first();
    return row === null ? null : decodeMailJobRow(row);
  }

  async loadJobByDeliveryId(deliveryId: string): Promise<MailJobRecord | null> {
    return this.#read(deliveryId);
  }

  async createPendingJob(params: CreatePendingJobParams): Promise<CreatePendingJobResult> {
    assertBoundedString(params.deliveryId, 'deliveryId');
    assertPositiveInteger(params.dispatchGeneration, 'dispatchGeneration');
    assertSafeInteger(params.createdAt, 'createdAt');
    assertSafeInteger(params.updatedAt, 'updatedAt');

    const result = await this.#db
      .prepare(
        `INSERT INTO mail_jobs
           (delivery_id, message_id, dispatch_generation, execution_generation, status, attempts, outcome_report_state, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'processing', 0, 'none', ?, ?)
         ON CONFLICT (delivery_id) DO NOTHING`,
      )
      .bind(
        params.deliveryId,
        assertBoundedOptionalString(params.messageId, 'messageId'),
        params.dispatchGeneration,
        params.createdAt,
        params.updatedAt,
      )
      .run();
    return (readChanges(result) ?? 0) > 0 ? { kind: 'created' } : { kind: 'duplicate' };
  }

  async claimSameGeneration(params: ClaimSameGenerationParams): Promise<ClaimSameGenerationResult> {
    assertBoundedString(params.deliveryId, 'deliveryId');
    assertLeaseOwner(params.owner, 'owner');
    assertPositiveInteger(params.dispatchGeneration, 'dispatchGeneration');
    assertPositiveInteger(params.leaseMs, 'leaseMs');
    assertPositiveInteger(params.maxExecutionAttempts, 'maxExecutionAttempts');
    assertSafeInteger(params.nowMs, 'nowMs');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET execution_generation = execution_generation + 1,
                attempts = attempts + 1,
                lease_owner = ?,
                lease_expires_at = ?,
                status = 'processing',
                outcome_report_state = 'none',
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND attempts < ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND status NOT IN ('sent', 'failed', 'blocked')`,
      )
      .bind(
        params.owner,
        params.nowMs + params.leaseMs,
        params.nowMs,
        params.deliveryId,
        params.dispatchGeneration,
        params.maxExecutionAttempts,
        params.nowMs,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        // Row vừa được ghi nhưng đọc lại không thấy: không bao giờ báo "claimed".
        throw new Error('claim updated a row that could not be read back');
      }
      return { kind: 'claimed', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifySameGenerationClaimDenial(record, params) };
  }

  async claimGenerationAdvance(
    params: ClaimGenerationAdvanceParams,
  ): Promise<ClaimGenerationAdvanceResult> {
    assertBoundedString(params.deliveryId, 'deliveryId');
    assertLeaseOwner(params.owner, 'owner');
    assertPositiveInteger(params.newDispatchGeneration, 'newDispatchGeneration');
    assertPositiveInteger(params.leaseMs, 'leaseMs');
    assertSafeInteger(params.nowMs, 'nowMs');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET dispatch_generation = ?,
                execution_generation = execution_generation + 1,
                attempts = 1,
                lease_owner = ?,
                lease_expires_at = ?,
                status = 'processing',
                outcome_report_state = 'none',
                blocked_at = NULL,
                report_lease_owner = NULL,
                report_lease_expires_at = NULL,
                report_attempts = 0,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation < ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND status NOT IN ('sent', 'failed')`,
      )
      .bind(
        params.newDispatchGeneration,
        params.owner,
        params.nowMs + params.leaseMs,
        params.nowMs,
        params.deliveryId,
        params.newDispatchGeneration,
        params.nowMs,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('generation-advance updated a row that could not be read back');
      }
      return { kind: 'claimed', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyGenerationAdvanceDenial(record, params) };
  }

  async markBlockedBudgetExhausted(
    params: MarkBlockedBudgetExhaustedParams,
  ): Promise<MarkBlockedBudgetExhaustedResult> {
    assertBoundedString(params.deliveryId, 'deliveryId');
    assertPositiveInteger(params.dispatchGeneration, 'dispatchGeneration');
    assertPositiveInteger(params.maxExecutionAttempts, 'maxExecutionAttempts');
    assertSafeInteger(params.nowMs, 'nowMs');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET status = 'blocked',
                blocked_at = ?,
                last_error_class = ?,
                outcome_report_state = 'pending',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND attempts >= ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND status NOT IN ('sent', 'failed', 'blocked')`,
      )
      .bind(
        params.nowMs,
        MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS,
        params.nowMs,
        params.deliveryId,
        params.dispatchGeneration,
        params.maxExecutionAttempts,
        params.nowMs,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('blocked transition updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyBudgetExhaustedDenial(record, params) };
  }

  async renewExecutionLease(params: RenewExecutionLeaseParams): Promise<RenewExecutionLeaseResult> {
    // Renewal guard canonical (§9.2.1) chỉ có `lease_owner` + `execution_generation`:
    // token là monotonic nên owner + token đã hàm ý đúng generation, không cần so thêm.
    assertLeaseTokenGuard(params);
    assertPositiveInteger(params.leaseMs, 'leaseMs');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET lease_expires_at = ?,
                updated_at = ?
          WHERE delivery_id = ?
            AND lease_owner = ?
            AND execution_generation = ?
            AND status = 'processing'
            AND outcome_report_state = 'none'`,
      )
      .bind(
        params.nowMs + params.leaseMs,
        params.nowMs,
        params.deliveryId,
        params.owner,
        params.executionGeneration,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('lease renewal updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyLeaseOwnershipDenial(record) };
  }

  /**
   * Statement (e) — ghi `provider_call_at` lần đầu cho delivery này. Marker per-delivery:
   * first-write-only, tồn tại xuyên attempt-chain và xuyên generation (không đường nào
   * reset nó — kể cả statement (b)); `already-marked` không tự cấp quyền gọi provider,
   * caller tự đánh giá cửa sổ an toàn trên record kèm denial.
   *
   * Conditional UPDATE duy nhất, first-write-only: WHERE là guard ownership chuẩn cộng
   * `provider_call_at IS NULL`. Marker chạy **trước** lần đầu request rời khỏi Worker cho
   * delivery này (§9.2.1 re-validate đã xong; call ở ngay sau):
   *
   * - Guard `already-marked` (`providerCallAt !== null` sau UPDATE): statement bỏ qua một
   *   cách có chủ ý (`IS NULL` trong WHERE) ⇒ `already-marked` ⇒ thời điểm đầu tiên giữ
   *   nguyên, vì cửa sổ mơ hồ được đếm từ request ĐẦU TIÊN có thể đã rời worker — không
   *   phải request muộn nhất.
   * - NOT clear khi bị deny với `already-marked`: đó là hành vi mong muốn của marker
   *   durable, không phải một lỗi.
   */
  async markProviderCallBoundary(
    params: MarkProviderCallBoundaryParams,
  ): Promise<MarkProviderCallBoundaryResult> {
    assertLeaseGuard(params);

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET provider_call_at = ?,
                updated_at = ?
          WHERE delivery_id = ?
            AND lease_owner = ?
            AND execution_generation = ?
            AND dispatch_generation = ?
            AND status = 'processing'
            AND outcome_report_state = 'none'
            AND provider_call_at IS NULL`,
      )
      .bind(
        params.nowMs,
        params.nowMs,
        params.deliveryId,
        params.owner,
        params.executionGeneration,
        params.dispatchGeneration,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('provider-call boundary updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return {
      kind: 'denied',
      reason: classifyProviderCallBoundaryDenial(record, {
        owner: params.owner,
        executionGeneration: params.executionGeneration,
        dispatchGeneration: params.dispatchGeneration,
      }),
      record,
    };
  }

  /**
   * Statement (g) — chốt operator-needed cho ambiguity ngoài cửa sổ an toàn.
   *
   * **Không** kế thừa guard ngân sách của đường (c): nguyên nhân chốt là **tuổi marker**
   * (`provider_call_at IS NOT NULL` — định đề khai báo của statement), không phải
   * `attempts`. Chỉ ngân sách làm điều kiện sẽ để ambiguity ngoài cửa sổ tại attempt còn
   * ngân sách lọt qua denial `budget-not-exhausted` → RETRY → redelivery gọi provider lại
   * ngoài cửa sổ — đúng hazard mà statement này tồn tại để chặn. Điều kiện còn lại giữ
   * row kế thừa được: cùng `dispatch_generation`, không lease hiệu lực, chưa terminal/
   * blocked. Không có lỗi provider nào ghi vào `last_error` (ambiguity là trạng thái
   * worker, không phải lỗi provider). `IS NOT NULL` là lớp cuối chống misuse ở tầng
   * persistence: caller phải tự đánh giá cửa sổ trước (`isWithinProviderSafeWindow`), nhưng
   * statement này không bao giờ chốt `provider-ambiguous-outcome` cho một job chưa từng
   * chạm ranh giới gọi provider.
   */
  async markProviderAmbiguityBlocked(
    params: MarkProviderAmbiguityBlockedParams,
  ): Promise<MarkProviderAmbiguityBlockedResult> {
    assertBoundedString(params.deliveryId, 'deliveryId');
    assertPositiveInteger(params.dispatchGeneration, 'dispatchGeneration');
    assertSafeInteger(params.nowMs, 'nowMs');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET status = 'blocked',
                blocked_at = ?,
                last_error_class = ?,
                outcome_report_state = 'pending',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND status NOT IN ('sent', 'failed', 'blocked')
            AND provider_call_at IS NOT NULL`,
      )
      .bind(
        params.nowMs,
        MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS,
        params.nowMs,
        params.deliveryId,
        params.dispatchGeneration,
        params.nowMs,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('ambiguity blocked transition updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return {
      kind: 'denied',
      reason: classifyAmbiguityBlockedDenial(record, {
        dispatchGeneration: params.dispatchGeneration,
        nowMs: params.nowMs,
      }),
      record,
    };
  }

  async persistExecutionResult(
    params: PersistExecutionResultParams,
  ): Promise<PersistExecutionResultResult> {
    assertLeaseGuard(params);
    // Outcome là closed set: một status tùy ý không bao giờ được ghi xuống D1 (§6),
    // thay vì để CHECK constraint của bảng trả lỗi sau khi statement đã chạy.
    const outcome = assertClosedValue(
      params.outcome,
      MAIL_JOB_PERSISTABLE_STATUS_VALUES,
      'outcome',
    );
    const lastError =
      params.lastError === undefined ? null : sanitizeErrorToken(params.lastError, 'lastError');
    const lastErrorClass =
      params.lastErrorClass === undefined
        ? null
        : sanitizeErrorToken(params.lastErrorClass, 'lastErrorClass');

    // Parity `blocked_at` (0001): `blocked_at IS NOT NULL` đúng khi và chỉ khi
    // `status = 'blocked'` (§9.2.2 hàng 3). Guard của statement này đòi status
    // đang là 'processing' nên `blocked_at` đang NULL; chỉ outcome 'blocked'
    // được điền nó, hai outcome còn lại giữ NULL.
    const blockedAt = outcome === 'blocked' ? params.nowMs : null;

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET status = ?,
                blocked_at = ?,
                outcome_report_state = 'pending',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = ?,
                last_error_class = ?,
                provider_message_id = ?,
                updated_at = ?
          WHERE delivery_id = ?
            AND lease_owner = ?
            AND execution_generation = ?
            AND dispatch_generation = ?
            AND status = 'processing'
            AND outcome_report_state = 'none'`,
      )
      .bind(
        outcome,
        blockedAt,
        lastError,
        lastErrorClass,
        assertBoundedOptionalString(params.providerMessageId, 'providerMessageId'),
        params.nowMs,
        params.deliveryId,
        params.owner,
        params.executionGeneration,
        params.dispatchGeneration,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('result persist updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyLeaseOwnershipDenial(record) };
  }

  async releaseExecutionLease(
    params: ReleaseExecutionLeaseParams,
  ): Promise<ReleaseExecutionLeaseResult> {
    assertLeaseGuard(params);
    const lastError =
      params.lastError === undefined ? null : sanitizeErrorToken(params.lastError, 'lastError');
    const lastErrorClass =
      params.lastErrorClass === undefined
        ? null
        : sanitizeErrorToken(params.lastErrorClass, 'lastErrorClass');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = ?,
                last_error_class = ?,
                updated_at = ?
          WHERE delivery_id = ?
            AND lease_owner = ?
            AND execution_generation = ?
            AND dispatch_generation = ?
            AND status = 'processing'
            AND outcome_report_state = 'none'`,
      )
      .bind(
        lastError,
        lastErrorClass,
        params.nowMs,
        params.deliveryId,
        params.owner,
        params.executionGeneration,
        params.dispatchGeneration,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('lease release updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyLeaseOwnershipDenial(record) };
  }

  async recordLookupError(params: RecordLookupErrorParams): Promise<RecordLookupErrorResult> {
    assertBoundedString(params.deliveryId, 'deliveryId');
    assertSafeInteger(params.dispatchGeneration, 'dispatchGeneration');
    assertSafeInteger(params.nowMs, 'nowMs');
    const lastErrorClass = sanitizeErrorToken(params.lastErrorClass, 'lastErrorClass');

    // Không guard bằng lease token: đường lookup chạy TRƯỚC claim, execution này chưa từng
    // giữ lease (JSDoc của port). Predicate chỉ là trạng thái row — row đã terminal hay đang
    // dở report thì không ghi, giữ nguyên state của execution/report khác.
    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET last_error = NULL,
                last_error_class = ?,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND status = 'processing'
            AND outcome_report_state = 'none'`,
      )
      .bind(lastErrorClass, params.nowMs, params.deliveryId, params.dispatchGeneration)
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('lookup error updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    return { kind: 'skipped' };
  }

  async acquireReportLease(params: AcquireReportLeaseParams): Promise<AcquireReportLeaseResult> {
    assertReportGuard(params);
    assertPositiveInteger(params.reportLeaseMs, 'reportLeaseMs');

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET report_lease_owner = ?,
                report_lease_expires_at = ?,
                report_attempts = report_attempts + 1,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND outcome_report_state = 'pending'
            AND (report_lease_expires_at IS NULL OR report_lease_expires_at <= ?)`,
      )
      .bind(
        params.owner,
        params.nowMs + params.reportLeaseMs,
        params.nowMs,
        params.deliveryId,
        params.dispatchGeneration,
        params.nowMs,
      )
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('report-lease acquire updated a row that could not be read back');
      }
      return { kind: 'acquired', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyReportLeaseDenial(record, params) };
  }

  async completeReport(params: CompleteReportParams): Promise<CompleteReportResult> {
    assertReportGuard(params);
    const disposition = assertClosedValue(
      params.disposition,
      MAIL_JOB_REPORTABLE_STATE_VALUES,
      'disposition',
    );

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET outcome_report_state = ?,
                report_lease_owner = NULL,
                report_lease_expires_at = NULL,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND outcome_report_state = 'pending'
            AND report_lease_owner = ?`,
      )
      .bind(disposition, params.nowMs, params.deliveryId, params.dispatchGeneration, params.owner)
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('report completion updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyReportCompletionDenial(record, params) };
  }

  async keepReportPending(params: KeepReportPendingParams): Promise<KeepReportPendingResult> {
    assertReportGuard(params);

    const result = await this.#db
      .prepare(
        `UPDATE mail_jobs
            SET report_lease_owner = NULL,
                report_lease_expires_at = NULL,
                updated_at = ?
          WHERE delivery_id = ?
            AND dispatch_generation = ?
            AND outcome_report_state = 'pending'
            AND report_lease_owner = ?`,
      )
      .bind(params.nowMs, params.deliveryId, params.dispatchGeneration, params.owner)
      .run();

    if ((readChanges(result) ?? 0) > 0) {
      const record = await this.#read(params.deliveryId);
      if (record === null) {
        throw new Error('report keep-pending updated a row that could not be read back');
      }
      return { kind: 'applied', record };
    }

    const record = await this.#read(params.deliveryId);
    return { kind: 'denied', reason: classifyReportCompletionDenial(record, params) };
  }

  async findStaleLeaseCandidates(
    params: FindStaleLeaseCandidatesParams,
  ): Promise<readonly StaleLeaseSweepItem[]> {
    assertSafeInteger(params.nowMs, 'nowMs');
    assertPositiveInteger(params.limit, 'limit');

    const { results } = await this.#db
      .prepare<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM mail_jobs
          WHERE status = 'processing'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          ORDER BY lease_expires_at ASC
          LIMIT ?`,
      )
      .bind(params.nowMs, params.limit)
      .all();
    return (results ?? []).map((row) => decodeMailJobRow(row));
  }

  async findReportSweepCandidates(
    params: FindReportSweepCandidatesParams,
  ): Promise<readonly ReportSweepItem[]> {
    assertSafeInteger(params.nowMs, 'nowMs');
    assertPositiveInteger(params.maxReportAttempts, 'maxReportAttempts');
    assertPositiveInteger(params.limit, 'limit');

    const { results } = await this.#db
      .prepare<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM mail_jobs
          WHERE outcome_report_state = 'pending'
            AND (report_lease_expires_at IS NULL OR report_lease_expires_at <= ?)
            AND report_attempts < ?
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .bind(params.nowMs, params.maxReportAttempts, params.limit)
      .all();
    return (results ?? []).map((row) => decodeMailJobRow(row));
  }

  async findBlockedBacklogCandidates(
    params: FindBlockedBacklogCandidatesParams,
  ): Promise<readonly BlockedBacklogSweepItem[]> {
    assertSafeInteger(params.cutoffMs, 'cutoffMs');
    assertPositiveInteger(params.limit, 'limit');

    const { results } = await this.#db
      .prepare<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM mail_jobs
          WHERE status = 'blocked'
            AND blocked_at IS NOT NULL
            AND blocked_at <= ?
          ORDER BY blocked_at ASC
          LIMIT ?`,
      )
      .bind(params.cutoffMs, params.limit)
      .all();
    return (results ?? []).map((row) => decodeMailJobRow(row));
  }
}
