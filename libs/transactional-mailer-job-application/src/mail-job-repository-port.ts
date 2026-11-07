/**
 * Repository port cho `mail_jobs` (execution + outcome reporting) và `quarantine`.
 *
 * Nguồn canonical: `docs/applications/transactional-mailer-job/01-architecture.md` §9.2.1
 * (sáu statement conditional UPDATE), §9.6 (statement (e)+(g)), §9.2.2 (ma trận transition),
 * §9.5 (vòng đời báo outcome), §10 (ba đường sweep).
 *
 * Nguyên tắc chung của mọi operation:
 * - Mọi thao tác ghi là **một conditional UPDATE duy nhất** — không read-then-write;
 *   kết quả trả về phân biệt tường minh `applied`/`claimed`/`acquired` vs
 *   `denied` kèm lý do. Affected rows = 0 KHÔNG BAO GIỜ gộp thành thành công.
 * - Khi UPDATE trả 0 row, implementation đọc lại tối thiểu số trường cần thiết và
 *   phân loại bằng classifier thuần ở `mail-job-rules` (Xem `classify*Denial`).
 * - `dispatch_generation` truyền vào claim/advance là **authority đọc từ control plane**
 *   qua private interface — command Queue KHÔNG mang generation và không bao giờ
 *   là nguồn của tham số này (§9.2.1, FR-008).
 * - Port không có I/O; repository không gọi provider, không HTTP, không quyết định
 *   ack/retry — đó là việc của J2/J3 sau này.
 */
import type { MailJobRecord, QuarantineRecord } from './mail-job-model';
import type {
  AmbiguityBlockedDenial,
  BudgetExhaustedDenial,
  GenerationAdvanceDenial,
  LeaseOwnershipDenial,
  ProviderCallBoundaryDenial,
  ReportCompletionDenial,
  ReportLeaseDenial,
  SameGenerationClaimDenial,
} from './mail-job-rules';

export type CreatePendingJobParams = {
  readonly deliveryId: string;
  readonly messageId?: string;
  readonly dispatchGeneration: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * Kết quả insert row chưa giữ lease (§9.2.1).
 *
 * `duplicate` nghĩa là `INSERT ... ON CONFLICT (delivery_id) DO NOTHING` đã không ghi row
 * nào vì row **đã tồn tại** — tình huống bình thường khi hai execution cùng xử lý một
 * command, hoặc khi job được recovery lại. Nó **không** phải lỗi, và nó **không** là
 * bằng chứng hàng đợi đã được xử lý: caller phải claim lại bằng đường (a)/(b).
 */
export type CreatePendingJobResult = { readonly kind: 'created' } | { readonly kind: 'duplicate' };

export type ClaimSameGenerationParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
  readonly leaseMs: number;
  readonly maxExecutionAttempts: number;
};

export type ClaimSameGenerationSuccess = {
  readonly kind: 'claimed';
  readonly record: MailJobRecord;
};

export type ClaimSameGenerationResult =
  | ClaimSameGenerationSuccess
  | { readonly kind: 'denied'; readonly reason: SameGenerationClaimDenial };

export type ClaimGenerationAdvanceParams = {
  readonly deliveryId: string;
  readonly newDispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
  readonly leaseMs: number;
};

export type ClaimGenerationAdvanceSuccess = {
  readonly kind: 'claimed';
  readonly record: MailJobRecord;
};

export type ClaimGenerationAdvanceResult =
  | ClaimGenerationAdvanceSuccess
  | { readonly kind: 'denied'; readonly reason: GenerationAdvanceDenial };

export type MarkBlockedBudgetExhaustedParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
  readonly maxExecutionAttempts: number;
};

export type MarkBlockedBudgetExhaustedResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'denied'; readonly reason: BudgetExhaustedDenial };

export type RenewExecutionLeaseParams = {
  readonly deliveryId: string;
  readonly owner: string;
  readonly executionGeneration: number;
  readonly nowMs: number;
  readonly leaseMs: number;
};

export type RenewExecutionLeaseResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'denied'; readonly reason: LeaseOwnershipDenial };

export type ExecutionResultOutcome = 'sent' | 'failed' | 'blocked';

/**
 * Tham số của lần persist kết quả provider (§9.2.2 hàng 1–4).
 *
 * Statement release execution lease trong **cùng** UPDATE, nên ở đây **không** có
 * `leaseMs`: không còn lease nào để gia hạn sau khi kết quả đã persist.
 *
 * `lastError`/`lastErrorClass` là hai token đã sanitize (`errorCode`/`errorClass` của
 * §11.1). Chúng được ghi **đúng như caller truyền**: một `sent` không mang lỗi thì hai
 * cột này là NULL, không giữ lại lỗi của attempt trước — bản ghi terminal phải mô tả
 * chính attempt đã kết thúc generation này, không phải lịch sử.
 */
export type PersistExecutionResultParams = {
  readonly deliveryId: string;
  readonly owner: string;
  readonly executionGeneration: number;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
  readonly outcome: ExecutionResultOutcome;
  readonly providerMessageId?: string;
  readonly lastError?: string;
  readonly lastErrorClass?: string;
};

export type PersistExecutionResultResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'denied'; readonly reason: LeaseOwnershipDenial };

/**
 * Tham số của lần release execution lease **không** kèm kết quả provider (§9.2.2 hàng 6, 7).
 *
 * Dùng cho đường retryable: execution kết thúc attempt mà không có gì để chốt terminal —
 * ví dụ private API không sẵn sàng **trước** provider call (hàng 7), hoặc provider trả
 * lỗi retryable (hàng 6). `attempts` **không** tăng ở đây (nó đã tăng lúc claim), và
 * `status` vẫn `processing` để execution kế tiếp claim lại được ngay.
 *
 * `lastError`/`lastErrorClass` ghi lý do attempt này kết thúc, cùng semantics với
 * {@link PersistExecutionResultParams}: caller truyền gì thì ghi đúng cái đó, bỏ trống
 * nghĩa là attempt này không ghi lỗi nào.
 */
export type ReleaseExecutionLeaseParams = {
  readonly deliveryId: string;
  readonly owner: string;
  readonly executionGeneration: number;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
  readonly lastError?: string;
  readonly lastErrorClass?: string;
};

export type ReleaseExecutionLeaseResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'denied'; readonly reason: LeaseOwnershipDenial };

/**
 * Tham số của statement (e) — ghi marker ranh giới gọi provider (migration `0003`).
 *
 * Bắt buộc gọi **ngay trước** khi request tới provider trong một attempt: statement là
 * first-write-only (`provider_call_at IS NULL` trong WHERE), nên lần gọi thứ hai là
 * no-op idempotent trả `already-marked`, không ghi đè mốc cũ. Guard lease/
 * `execution_generation` như statement persist — một execution mất claim không ghi được
 * marker của generation khác.
 *
 * Phạm vi marker là **per-delivery**: không có đường nào reset nó giữa các attempt hay
 * kể cả khi redrive tăng `dispatch_generation` (statement (b) không đụng cột này), nên
 * `already-marked` hoàn toàn có thể do một attempt-chain **trước đó** của cùng delivery
 * ghi — mốc giữ nguyên từ lần gọi đầu tiên.
 */
export type MarkProviderCallBoundaryParams = {
  readonly deliveryId: string;
  readonly owner: string;
  readonly executionGeneration: number;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
};

export type MarkProviderCallBoundaryResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  /**
   * `already-marked` là kết quả **bình thường** khi marker đã có mặt — record kèm theo
   * là record **mới nhất** mà UPDATE không áp vì guard `provider_call_at IS NULL`, và
   * `providerCallAt` của nó chính là mốc mà caller bắt buộc phải đánh giá cửa sổ an toàn
   * (quyết định có được gọi lại provider không thuộc về caller, gọi qua
   * `isWithinProviderSafeWindow`). KHÔNG được gọi provider chỉ vì nhận được `already-marked`.
   * Ba nhánh còn lại (`missing-job`/`lease-lost`/`inconsistent`) nghĩa là KHÔNG gọi
   * provider; `inconsistent` thử lại từ đầu. `record` có thể null trên `missing-job`
   * (row không tồn tại nên không có gì để đính kèm).
   */
  | {
      readonly kind: 'denied';
      readonly reason: ProviderCallBoundaryDenial;
      readonly record: MailJobRecord | null;
    };

/**
 * Tham số của statement (g) — chốt trạng thái operator-needed cho ambiguity ngoài cửa
 * sổ (issue #37).
 *
 * Điều kiện chốt là **tuổi marker** (`provider_call_at IS NOT NULL`, không phụ thuộc
 * `attempts`): mơ hồ ngoài cửa sổ phải chốt được ở **bất kỳ** attempt nào, vì gọi lại
 * provider ngoài cửa sổ không còn chống duplicate. Guard còn lại giữ trạng thái hợp lệ:
 * cùng `dispatch_generation`, không lease hiệu lực, chưa terminal/blocked.
 */
export type MarkProviderAmbiguityBlockedParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
};

export type MarkProviderAmbiguityBlockedResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | {
      readonly kind: 'denied';
      readonly reason: AmbiguityBlockedDenial;
      readonly record: MailJobRecord | null;
    };

/**
 * Tham số của đường ghi `last_error_class` cho lỗi **trước claim** (§9.2.2 hàng 19 — lookup
 * `401`/`400`). Execution chưa giữ lease nào nên **không** có token owner: predicate của
 * statement chỉ là trạng thái row.
 */
export type RecordLookupErrorParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
  readonly lastErrorClass: string;
};

/**
 * Kết quả của {@link MailJobRepository.recordLookupError}: `applied` = row còn ở trạng thái
 * `processing`/`none` và đã nhận `last_error_class`; `skipped` = row đổi trạng thái giữa lúc
 * đọc và lúc ghi — không có gì được ghi, và đó là kết quả hợp lệ (execution khác đã chốt).
 */
export type RecordLookupErrorResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'skipped' };

export type AcquireReportLeaseParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
  readonly reportLeaseMs: number;
};

export type AcquireReportLeaseSuccess = {
  readonly kind: 'acquired';
  readonly record: MailJobRecord;
};

export type AcquireReportLeaseResult =
  | AcquireReportLeaseSuccess
  | { readonly kind: 'denied'; readonly reason: ReportLeaseDenial };

export type CompleteReportDisposition = 'reported' | 'superseded' | 'orphaned';

export type CompleteReportParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
  readonly disposition: CompleteReportDisposition;
};

export type CompleteReportResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'denied'; readonly reason: ReportCompletionDenial };

export type KeepReportPendingParams = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
};

export type KeepReportPendingResult =
  | { readonly kind: 'applied'; readonly record: MailJobRecord }
  | { readonly kind: 'denied'; readonly reason: ReportCompletionDenial };

export type StaleLeaseSweepItem = Pick<
  MailJobRecord,
  | 'deliveryId'
  | 'messageId'
  | 'dispatchGeneration'
  | 'executionGeneration'
  | 'status'
  | 'leaseExpiresAt'
  | 'leaseOwner'
  | 'attempts'
>;

export type ReportSweepItem = Pick<
  MailJobRecord,
  | 'deliveryId'
  | 'messageId'
  | 'dispatchGeneration'
  | 'status'
  | 'outcomeReportState'
  | 'reportAttempts'
  | 'reportLeaseOwner'
  | 'reportLeaseExpiresAt'
  | 'lastErrorClass'
>;

export type BlockedBacklogSweepItem = Pick<
  MailJobRecord,
  | 'deliveryId'
  | 'messageId'
  | 'dispatchGeneration'
  | 'status'
  | 'blockedAt'
  | 'attempts'
  | 'lastErrorClass'
>;

export type FindStaleLeaseCandidatesParams = {
  readonly nowMs: number;
  readonly limit: number;
};

export type FindReportSweepCandidatesParams = {
  readonly nowMs: number;
  readonly maxReportAttempts: number;
  readonly limit: number;
};

export type FindBlockedBacklogCandidatesParams = {
  readonly cutoffMs: number;
  readonly limit: number;
};

export type UpsertQuarantineRecordParams = {
  readonly quarantineId: string;
  readonly queueMessageId: string;
  readonly reason: QuarantineRecord['reason'];
  readonly fieldName?: string;
  readonly nowMs: number;
};

export type UpsertQuarantineRecordResult =
  | { readonly kind: 'created'; readonly record: QuarantineRecord }
  | { readonly kind: 'updated'; readonly record: QuarantineRecord };

export type GetQuarantineRecordParams = {
  readonly quarantineId: string;
  readonly queueMessageId: string;
};

export interface MailJobRepository {
  loadJobByDeliveryId(deliveryId: string): Promise<MailJobRecord | null>;
  createPendingJob(params: CreatePendingJobParams): Promise<CreatePendingJobResult>;
  claimSameGeneration(params: ClaimSameGenerationParams): Promise<ClaimSameGenerationResult>;
  claimGenerationAdvance(
    params: ClaimGenerationAdvanceParams,
  ): Promise<ClaimGenerationAdvanceResult>;
  markBlockedBudgetExhausted(
    params: MarkBlockedBudgetExhaustedParams,
  ): Promise<MarkBlockedBudgetExhaustedResult>;
  renewExecutionLease(params: RenewExecutionLeaseParams): Promise<RenewExecutionLeaseResult>;
  /**
   * Ghi marker ranh giới gọi provider — statement (e) của migration `0003` — **ngay
   * trước** request provider trong mỗi attempt.
   *
   * First-write-only: chỉ áp khi `provider_call_at IS NULL`. `already-marked` nghĩa là
   * marker đã tồn tại từ một attempt trước của cùng delivery (marker per-delivery, không
   * bị reset kể cả khi `dispatch_generation` tăng) và **không** tự cấp quyền gọi provider:
   * caller bắt buộc đánh giá `isWithinProviderSafeWindow` trên `record.providerCallAt`
   * trước khi quyết định gửi. Guard `lease_owner` + `execution_generation` +
   * `dispatch_generation` giữ caller là execution đang claim.
   *
   * Marker này là biến thời gian của cửa sổ mơ hồ (provider-safety-window): provider
   * CÓ THỂ đã nhận mail từ `provider_call_at`, nên recovery sau crash dùng nó để quyết
   * gọi lại (trong cửa sổ) hay block operator-needed (ngoài cửa sổ).
   */
  markProviderCallBoundary(
    params: MarkProviderCallBoundaryParams,
  ): Promise<MarkProviderCallBoundaryResult>;
  /**
   * Chốt operator-needed cho ambiguity ngoài cửa sổ an toàn — statement (g) (issue #37).
   *
   * Điều kiện chốt: cùng `dispatch_generation`, không execution lease hiệu lực,
   * `status NOT IN ('sent','failed','blocked')`, **`provider_call_at IS NOT NULL`**.
   * Không có điều kiện `attempts`: mơ hồ phải chốt được ở bất kỳ attempt nào — gọi lại
   * provider ngoài cửa sổ không còn chống duplicate. Ghi `last_error_class =
   * 'provider-ambiguous-outcome'`: job `blocked` bền vững, report `pending` để alert
   * sweep block-backlog đón; chỉ redrive có authorize mở khoá. KHÔNG tự gọi lại provider
   * trong worker (ngoài cửa sổ, gọi lại không dedupe được).
   */
  markProviderAmbiguityBlocked(
    params: MarkProviderAmbiguityBlockedParams,
  ): Promise<MarkProviderAmbiguityBlockedResult>;
  persistExecutionResult(
    params: PersistExecutionResultParams,
  ): Promise<PersistExecutionResultResult>;
  releaseExecutionLease(params: ReleaseExecutionLeaseParams): Promise<ReleaseExecutionLeaseResult>;
  /**
   * Ghi `last_error_class` cho một lỗi **trước claim** — đường duy nhất của hàng 19 mà không
   * có lease để guard bằng token. Predicate: `status = 'processing' AND
   * outcome_report_state = 'none' AND dispatch_generation = ?` — không đụng `lease_owner`/
   * `lease_expires_at` (execution đang giữ lease vẫn giữ nguyên lease của nó).
   */
  recordLookupError(params: RecordLookupErrorParams): Promise<RecordLookupErrorResult>;
  acquireReportLease(params: AcquireReportLeaseParams): Promise<AcquireReportLeaseResult>;
  completeReport(params: CompleteReportParams): Promise<CompleteReportResult>;
  keepReportPending(params: KeepReportPendingParams): Promise<KeepReportPendingResult>;
  findStaleLeaseCandidates(
    params: FindStaleLeaseCandidatesParams,
  ): Promise<readonly StaleLeaseSweepItem[]>;
  findReportSweepCandidates(
    params: FindReportSweepCandidatesParams,
  ): Promise<readonly ReportSweepItem[]>;
  findBlockedBacklogCandidates(
    params: FindBlockedBacklogCandidatesParams,
  ): Promise<readonly BlockedBacklogSweepItem[]>;
}

export interface QuarantineRepository {
  upsertQuarantineRecord(
    params: UpsertQuarantineRecordParams,
  ): Promise<UpsertQuarantineRecordResult>;
  getQuarantineRecord(params: GetQuarantineRecordParams): Promise<QuarantineRecord | null>;
}

export type { MailJobRecord, QuarantineRecord };
export type {
  AmbiguityBlockedDenial,
  BudgetExhaustedDenial,
  GenerationAdvanceDenial,
  LeaseOwnershipDenial,
  ProviderCallBoundaryDenial,
  ReportCompletionDenial,
  ReportLeaseDenial,
  SameGenerationClaimDenial,
} from './mail-job-rules';
