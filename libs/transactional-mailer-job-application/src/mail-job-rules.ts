/**
 * Pure state-machine rules cho `mail_jobs` — không I/O, không database, không clock.
 *
 * Nguồn canonical: `docs/applications/transactional-mailer-job/01-architecture.md` §9.2.1
 * (sáu statement claim/ghi quyết định, §9.6 cho (e)/(g)), §9.2.2 (ma trận transition),
 * §9.5 (vòng đời báo outcome).
 *
 * ## Vì sao các hàm "phân loại" này tồn tại
 *
 * Các statement claim/ghi canonical đều là **một conditional UPDATE duy nhất**. Khi affected
 * rows = 0, không có cách nào biết guard nào đã chặn chỉ bằng affected rows — nên
 * caller phải đọc lại tối thiểu số trường cần thiết và phân loại. Nếu phân loại đó
 * nằm rải rác ở call site thì hai nơi sẽ phân loại hai kiểu, và một kiểu sai sẽ biến
 * "không lấy được lease" thành "gọi provider đi".
 *
 * Các hàm này nhận row **đã đọc** và criteria **đã validate**, rồi trả về đúng một
 * lý do. Chúng không bao giờ tự đọc database và không bao giờ tự quyết định hành động
 * (ack hay retry) — đó là việc của J2.
 */

import {
  MAIL_JOB_STATUS_VALUES,
  OUTCOME_REPORT_STATE_VALUES,
  type MailJobRecord,
  type MailJobStatus,
  type OutcomeReportState,
  type MailJobPersistableStatus,
  type MailJobReportableState,
} from './mail-job-model';

/** Lý do một claim cùng generation không lấy được quyền. */
export type SameGenerationClaimDenial =
  /** Row chưa tồn tại — caller phải `createPendingJob` rồi claim lại. */
  | 'missing-job'
  /** Row đang ở một `dispatch_generation` khác — không bao giờ reset về generation cũ. */
  | 'generation-mismatch'
  /** Lease còn hiệu lực — duplicate Queue message hoặc execution song song. */
  | 'lease-active'
  /** `attempts >= maxExecutionAttempts` — ngân sách B đã kiệt, đường (c) là đường kế. */
  | 'budget-exhausted'
  /** `sent`/`failed` — terminal per-message, không claim lại. */
  | 'terminal'
  /** `blocked` — non-terminal nhưng chỉ redrive có authorize mới mở khoá (§9.4). */
  | 'blocked'
  /** Row đổi giữa lúc UPDATE và lúc đọc lại — không suy ra gì, thử lại từ đầu. */
  | 'inconsistent';

/** Lý do một generation-advance claim không lấy được quyền. */
export type GenerationAdvanceDenial =
  | 'missing-job'
  /** Authority không lớn hơn row — guard `dispatch_generation < :new_generation` thất bại. */
  | 'generation-not-newer'
  /** Lease cũ còn hiệu lực — delay bounded bởi `leaseMs`, không vô hạn (§9.2.2 hàng 17). */
  | 'lease-active'
  /** `sent`/`failed` — generation mới không áp cho terminal. */
  | 'terminal'
  | 'inconsistent';

/** Lý do một lần chốt `blocked` do ngân sách B kiệt không áp dụng được. */
export type BudgetExhaustedDenial =
  | 'missing-job'
  | 'generation-mismatch'
  /** KHÔNG cắt ngang execution đang sống — đó chính là lý do guard này tồn tại (§9.2.1 (c)). */
  | 'lease-active'
  /** Ngân sách chưa kiệt — đường (c) chỉ dành cho `attempts >= maxExecutionAttempts`. */
  | 'budget-not-exhausted'
  | 'terminal'
  /** Đã `blocked` rồi — idempotent, affected rows = 0 là hành vi đúng. */
  | 'already-blocked'
  | 'inconsistent';

/** Lý do một lần renew lease hoặc persist kết quả không ghi được. */
export type LeaseOwnershipDenial =
  | 'missing-job'
  /** Owner hoặc `execution_generation` không còn khớp — execution này đã mất claim. */
  | 'lease-lost';

/**
 * Lý do statement (e) — ghi marker `provider_call_at` — không áp dụng được.
 *
 * Gồm đầy đủ denial của ownership (cùng guard lease/`execution_generation` với statement
 * persist) cộng thêm `already-marked`: marker là **first-write-only** (`provider_call_at
 * IS NULL` nằm trong WHERE) nên affected rows = 0 có thể nghĩa là một execution trước đó
 * của cùng delivery đã ghi mốc rồi — điều này **không** phải mất claim. Ba nguyên nhân
 * lệch ownership/guard (missing-job, lease-lost, inconsistent) đều **KHÔNG** được suy ra
 * quyền gọi provider; quyền đó của `already-marked` do caller quyết bằng cửa sổ an toàn.
 */
export type ProviderCallBoundaryDenial = LeaseOwnershipDenial | 'already-marked' | 'inconsistent';

/** Lý do acquire report-lease không lấy được quyền. */
export type ReportLeaseDenial =
  | 'missing-job'
  | 'generation-mismatch'
  /** `outcome_report_state` khác `pending` — đã reported/superseded/orphaned/none. */
  | 'not-pending'
  /** Report-lease còn hiệu lực — sweeper khác đang báo. */
  | 'report-lease-active'
  | 'inconsistent';

/** Lý do chốt terminal cho report không ghi được. */
export type ReportCompletionDenial =
  | 'missing-job'
  | 'generation-mismatch'
  /** Không còn ở `pending` — một execution khác đã chốt trước. */
  | 'not-pending'
  /** `report_lease_owner` không còn là owner này. */
  | 'report-lease-lost'
  | 'inconsistent';

/** Kết quả phân loại khi affected rows = 0, cho một statement cụ thể. */
export type ClaimDenial =
  | SameGenerationClaimDenial
  | GenerationAdvanceDenial
  | BudgetExhaustedDenial
  | LeaseOwnershipDenial
  | ReportLeaseDenial
  | ReportCompletionDenial;

/**
 * Bộ điều kiện mà statement (a) — claim cùng generation — dùng để phân loại khi
 * affected rows = 0.
 *
 * Chỉ chứa đúng các field mà việc phân loại **đọc**: generation authority, thời điểm
 * hiện tại và trần ngân sách B. `owner` và thời điểm hết hạn lease không có mặt vì
 * guard tương ứng đã được phản ánh qua `record` (row đọc lại), và thêm chúng vào đây
 * sẽ buộc caller phải tính `nowMs + leaseMs` chỉ để gọi một hàm không dùng giá trị đó.
 */
export type SameGenerationClaimCriteria = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
  readonly maxExecutionAttempts: number;
};

/** Bộ điều kiện của statement (b) — generation-advance claim. */
export type GenerationAdvanceCriteria = {
  readonly deliveryId: string;
  readonly newDispatchGeneration: number;
  readonly nowMs: number;
};

/** Bộ điều kiện của statement (c) — chốt `blocked` khi ngân sách B kiệt. */
export type BudgetExhaustedCriteria = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
  readonly maxExecutionAttempts: number;
};

/** Bộ điều kiện của statement (d) — acquire report-lease. */
export type ReportLeaseCriteria = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly nowMs: number;
};

/** Bộ điều kiện của việc chốt terminal cho report. */
export type ReportCompletionCriteria = {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  readonly owner: string;
  readonly nowMs: number;
};

/**
 * Lease execution còn hiệu lực tại `nowMs`.
 *
 * §9.2.1 định nghĩa lease hiệu lực là `lease_expires_at > now`. `>=` **không** dùng
 * được: guard của statement (a)/(c) là `lease_expires_at <= :now` nghĩa là "hết hiệu
 * lực tại đúng thời điểm đó", nên một lease hết hạn đúng bằng `now` phải được coi là
 * đã hết — nếu rule đọc và rule SQL lệch nhau ở biên, một execution sẽ bị coi là đang
 * giữ lease trong khi statement đã cho execution khác claim.
 */
export function isExecutionLeaseActive(
  record: Pick<MailJobRecord, 'leaseOwner' | 'leaseExpiresAt'>,
  nowMs: number,
): boolean {
  if (record.leaseOwner === null || record.leaseExpiresAt === null) {
    return false;
  }
  return record.leaseExpiresAt > nowMs;
}

/** Report-lease còn hiệu lực tại `nowMs` — cùng biên với statement (d). */
export function isReportLeaseActive(
  record: Pick<MailJobRecord, 'reportLeaseOwner' | 'reportLeaseExpiresAt'>,
  nowMs: number,
): boolean {
  if (record.reportLeaseOwner === null || record.reportLeaseExpiresAt === null) {
    return false;
  }
  return record.reportLeaseExpiresAt > nowMs;
}

/** Trạng thái terminal theo execution: không claim lại, không generation-advance. */
export function isTerminalStatus(status: MailJobStatus): boolean {
  return status === 'sent' || status === 'failed';
}

/**
 * Phân loại lý do statement (a) trả affected rows = 0.
 *
 * Thứ tự kiểm tra ở đây là **thứ tự ưu tiên** (priority order), không phải thứ tự
 * trong WHERE. Ví dụ: nếu lease còn hiệu lực thì lý do là `lease-active` dù ngân
 * sách đã kiệt — vì statement (c) (chốt `blocked`) chỉ được áp dụng khi **không** có
 * execution nào đang sống (§9.2.1 (c)).
 */
export function classifySameGenerationClaimDenial(
  record: MailJobRecord | null,
  criteria: SameGenerationClaimCriteria,
): SameGenerationClaimDenial {
  if (record === null) {
    return 'missing-job';
  }
  if (record.dispatchGeneration !== criteria.dispatchGeneration) {
    return 'generation-mismatch';
  }
  if (isExecutionLeaseActive(record, criteria.nowMs)) {
    return 'lease-active';
  }
  if (record.attempts >= criteria.maxExecutionAttempts) {
    return 'budget-exhausted';
  }
  if (isTerminalStatus(record.status)) {
    return 'terminal';
  }
  if (record.status === 'blocked') {
    return 'blocked';
  }
  // Mọi guard của statement (a) đều thoả mà UPDATE vẫn trả 0: row đổi giữa hai lần
  // đọc. Không được chọn một lý do "trông hợp lý" — đó là lúc phải thử lại từ đầu.
  return 'inconsistent';
}

/**
 * Phân loại lý do statement (b) trả affected rows = 0.
 *
 * Guard của (b) là `dispatch_generation < :new_generation` (strict) + không lease hiệu
 * lực + `status NOT IN ('sent','failed')`. `blocked` **không** nằm trong danh sách loại:
 * chính redrive ra khỏi `blocked` là lý do đường (b) tồn tại (§9.2.1).
 */
export function classifyGenerationAdvanceDenial(
  record: MailJobRecord | null,
  criteria: GenerationAdvanceCriteria,
): GenerationAdvanceDenial {
  if (record === null) {
    return 'missing-job';
  }
  if (record.dispatchGeneration >= criteria.newDispatchGeneration) {
    return 'generation-not-newer';
  }
  if (isExecutionLeaseActive(record, criteria.nowMs)) {
    return 'lease-active';
  }
  if (isTerminalStatus(record.status)) {
    return 'terminal';
  }
  return 'inconsistent';
}

/**
 * Phân loại lý do statement (c) trả affected rows = 0.
 *
 * Guard của (c) có một điểm **quan trọng** phải giữ nguyên thứ tự: `attempts >= :max` **và**
 * không lease hiệu lực. Nếu một execution đang sống vừa tiêu slot B cuối cùng thì
 * (c) phải **không** áp — nếu không, (c) sẽ ghi `blocked` trong khi owner sắp thành
 * công và persist kết quả thật của nó sẽ trả affected rows = 0 (mất kết quả thật).
 */
export function classifyBudgetExhaustedDenial(
  record: MailJobRecord | null,
  criteria: BudgetExhaustedCriteria,
): BudgetExhaustedDenial {
  if (record === null) {
    return 'missing-job';
  }
  if (record.dispatchGeneration !== criteria.dispatchGeneration) {
    return 'generation-mismatch';
  }
  if (isExecutionLeaseActive(record, criteria.nowMs)) {
    return 'lease-active';
  }
  if (record.attempts < criteria.maxExecutionAttempts) {
    return 'budget-not-exhausted';
  }
  if (isTerminalStatus(record.status)) {
    return 'terminal';
  }
  if (record.status === 'blocked') {
    return 'already-blocked';
  }
  return 'inconsistent';
}

/**
 * Phân loại lý do một lần renew lease, persist kết quả, hoặc release lease trả
 * affected rows = 0.
 *
 * Ba operation này dùng **chung một** kết luận vì guard của chúng là cùng một cặp
 * `lease_owner = :owner AND execution_generation = :token` (§9.2.1): affected rows = 0
 * luôn có đúng một ý nghĩa với execution — nó **đã mất claim**. `dispatch_generation`
 * là guard phụ của persist/release, nhưng lệch generation cũng chỉ có nghĩa "claim này
 * không còn áp cho row nữa", nên tách nó thành một lý do riêng sẽ buộc caller xử lý
 * thêm một nhánh không đổi hành vi.
 *
 * Row không còn tồn tại cũng trả `missing-job`: nơi duy nhất job row bị xoá là
 * operator/repair ngoài tầng này, và với execution thì "không có row" và "mất claim"
 * dẫn tới cùng một việc — không ghi, không báo outcome, không gửi lại.
 */
export function classifyLeaseOwnershipDenial(record: MailJobRecord | null): LeaseOwnershipDenial {
  return record === null ? 'missing-job' : 'lease-lost';
}

/**
 * Lý do statement (g) — chốt `blocked` cho ambiguity ngoài cửa sổ an toàn — trả affected
 * rows = 0.
 *
 * Guard của (g) **không** gồm điều kiện ngân sách B: nguyên nhân chốt là tuổi marker
 * (`provider_call_at IS NOT NULL`), không phải attempts — mơ hồ phải chốt được ở bất kỳ
 * attempt nào. Điều kiện còn lại giữ row ở trạng thái kế thừa được: cùng
 * `dispatch_generation`, không lease hiệu lực, chưa terminal/blocked.
 */
export type AmbiguityBlockedDenial =
  | 'missing-job'
  | 'generation-mismatch'
  | 'lease-active'
  | 'terminal'
  | 'already-blocked'
  | 'unmarked'
  | 'inconsistent';

/**
 * Phân loại lý do statement (g) trả affected rows = 0.
 *
 * `unmarked` là denial mang ý nghĩa an toàn riêng của statement này: caller tuyên bố
 * ambiguity ngoài cửa sổ nhưng row chưa từng có marker — statement tự bảo vệ định đề của
 * nó (`provider_call_at IS NOT NULL` ở tầng persistence) thay vì chốt `blocked` với
 * `last_error_class = 'provider-ambiguous-outcome'` cho một job chưa hề chạm ranh giới
 * gọi provider (mislead operator redrive).
 */
export function classifyAmbiguityBlockedDenial(
  record: MailJobRecord | null,
  criteria: { readonly dispatchGeneration: number; readonly nowMs: number },
): AmbiguityBlockedDenial {
  if (record === null) {
    return 'missing-job';
  }
  if (record.dispatchGeneration !== criteria.dispatchGeneration) {
    return 'generation-mismatch';
  }
  if (isExecutionLeaseActive(record, criteria.nowMs)) {
    return 'lease-active';
  }
  if (isTerminalStatus(record.status)) {
    return 'terminal';
  }
  if (record.status === 'blocked') {
    return 'already-blocked';
  }
  if (record.providerCallAt === null) {
    return 'unmarked';
  }
  return 'inconsistent';
}

/**
 * Phân loại lý do statement (e) — ghi marker ranh giới gọi provider — trả affected
 * rows = 0.
 *
 * Thứ tự kiểm tra có chủ đích và **không** được đảo: ownership **trước**, `already-marked`
 * **sau**. Guard của (e) là guard ownership chuẩn cộng `provider_call_at IS NULL`
 * (first-write-only), nên affected rows = 0 có thể do một trong hai — và hai lý do đó có
 * hậu quả ngược nhau: `lease-lost` ⇒ mất claim, KHÔNG được gọi provider; `already-marked`
 * ⇒ marker đã có mặt từ một attempt trước đó của cùng delivery (per-delivery lifetime,
 * không bị reset giữa các attempt hay khi `dispatch_generation` tăng) — caller **vẫn giữ
 * claim** và quyết định gọi provider hay không thuộc về kiểm tra cửa sổ an toàn trên
 * `providerCallAt` của record, không thuộc classifier này. Kiểm `already-marked` trước
 * ownership sẽ biến một execution stale (mất lease, chỉ còn marker cũ của attempt trước)
 * thành "được phép gọi lại" — phá bỏ chính fencing mà marker tồn tại để bảo vệ.
 *
 * Guard trạng thái (status/outcome_report_state) cũng được phân loại tường minh thay vì
 * dựa vào giả định ngầm "owner khớp ⇒ status khớp": hôm nay mọi writer đổi trạng thái
 * đều đồng thời null lease owner, nhưng nếu một writer tương lai đổi trạng thái mà giữ
 * nguyên lease (persist tách release), gán nhầm `already-marked` cho row không còn
 * `processing`/`none` là hướng sai chính xác mà fencing phải chặn — trả `inconsistent`
 * (thử lại từ đầu) là hành vi an toàn.
 */
export function classifyProviderCallBoundaryDenial(
  record: MailJobRecord | null,
  expectation: {
    readonly owner: string;
    readonly executionGeneration: number;
    readonly dispatchGeneration: number;
  },
): ProviderCallBoundaryDenial {
  if (record === null) {
    return 'missing-job';
  }
  const lostLease =
    record.leaseOwner !== expectation.owner ||
    record.executionGeneration !== expectation.executionGeneration ||
    record.dispatchGeneration !== expectation.dispatchGeneration;
  if (lostLease) {
    return 'lease-lost';
  }
  if (record.status !== 'processing' || record.outcomeReportState !== 'none') {
    // Owner/token/generation khớp mà trạng thái đã rời execution đang chạy: không suy ra
    // quyền gọi provider — thử lại từ đầu cho một read-consistent state.
    return 'inconsistent';
  }
  if (record.providerCallAt !== null) {
    return 'already-marked';
  }
  // Owner/token/generation/status khớp hoàn toàn, marker rỗng, mà UPDATE vẫn trả 0:
  // row đổi giữa hai lần đọc (lease vừa hết hạn…). Không suy ra gì — thử lại từ đầu.
  return 'inconsistent';
}

/**
 * Phân loại lý do statement (d) trả affected rows = 0.
 *
 * Guard của (d) là `outcome_report_state = 'pending'` + report-lease hết hiệu lực, cả
 * hai dưới `dispatch_generation = :generation`. Bound `report_attempts < maxReportAttempts`
 * **không** nằm trong (d) — nó là predicate chọn row của sweep (§9.5), nên một row đã
 * chạm bound vẫn acquire được nếu một caller gọi thẳng: điều đó cố ý, vì (d) là
 * statement chung cho cả sweep và redelivery.
 */
export function classifyReportLeaseDenial(
  record: MailJobRecord | null,
  criteria: ReportLeaseCriteria,
): ReportLeaseDenial {
  if (record === null) {
    return 'missing-job';
  }
  if (record.dispatchGeneration !== criteria.dispatchGeneration) {
    return 'generation-mismatch';
  }
  if (record.outcomeReportState !== 'pending') {
    return 'not-pending';
  }
  if (isReportLeaseActive(record, criteria.nowMs)) {
    return 'report-lease-active';
  }
  return 'inconsistent';
}

/**
 * Phân loại lý do việc chốt terminal cho report trả affected rows = 0.
 *
 * Guard là `report_lease_owner = :owner` dưới `outcome_report_state = 'pending'` +
 * `dispatch_generation = :generation`. `report_lease-lost` là trường hợp execution
 * này đã mất quyền báo (report-lease hết hạn và một sweeper khác đã acquire).
 */
export function classifyReportCompletionDenial(
  record: MailJobRecord | null,
  criteria: ReportCompletionCriteria,
): ReportCompletionDenial {
  if (record === null) {
    return 'missing-job';
  }
  if (record.dispatchGeneration !== criteria.dispatchGeneration) {
    return 'generation-mismatch';
  }
  if (record.outcomeReportState !== 'pending') {
    return 'not-pending';
  }
  if (record.reportLeaseOwner !== criteria.owner) {
    return 'report-lease-lost';
  }
  return 'inconsistent';
}

/**
 * Kết quả phân loại một response của control plane cho `POST .../outcome`, ở mức
 * signal — không phải HTTP status.
 *
 * Bảng phân loại canonical: `01-architecture.md` §9.5. **HTTP 200 không phải bằng
 * chứng đã báo xong** — worker phân loại theo body (`applied`/`duplicate`/`stale`).
 * `404`/`400`/`401`/`403` là các signal riêng vì hành vi của chúng khác hẳn nhau:
 * `404` → `orphaned`, `400` và `401/403` giữ `pending` (không phải transient, không
 * phải terminal), `stale` → `superseded`.
 */
export type ControlPlaneOutcomeSignal =
  /** Body `applied` — control plane đã ghi outcome bền vững. */
  | 'applied'
  /** Body `duplicate` — cùng generation + cùng outcome đã ghi; idempotent, không lỗi. */
  | 'duplicate'
  /** Body `stale` — generation cũ hoặc state không còn `accepted`/`queued`. */
  | 'stale'
  /** HTTP `404` — delivery không còn tồn tại ở control plane. */
  | 'not-found'
  /** HTTP `400` — contract violation của chính callback (thiếu field, `error_class` sai). */
  | 'contract-rejected'
  /** HTTP `401`/`403` — authn/authz của **chính worker** (§9.2.2 hàng 19). */
  | 'auth-rejected'
  /** timeout / network / `5xx` / `429` / API unavailable. */
  | 'transient';

/** Hành động persistence tương ứng với một {@link ControlPlaneOutcomeSignal}. */
export type OutcomeReportDisposition =
  /** `outcome_report_state → reported` (terminal cho report). */
  | { readonly kind: 'reported' }
  /** `outcome_report_state → superseded` (terminal; không auto-retry). */
  | { readonly kind: 'superseded' }
  /** `outcome_report_state → orphaned` (terminal; cần operator). */
  | { readonly kind: 'orphaned' }
  /** Giữ `pending`; release report-lease để lần báo sau claim lại được. */
  | { readonly kind: 'keep-pending' };

/**
 * Chốt disposition cho một signal của control plane.
 *
 * Chỉ `applied`/`duplicate` được `reported`. `stale` **không** phải success (§9.5):
 * HTTP 200 với body `stale` vẫn là `superseded`. `stale` và `404` không bao giờ được
 * giữ ở `pending` — đó là điều kiện chặn vòng retry vô hạn.
 */
export function dispositionForControlPlaneOutcome(
  signal: ControlPlaneOutcomeSignal,
): OutcomeReportDisposition {
  switch (signal) {
    case 'applied':
    case 'duplicate':
      return { kind: 'reported' };
    case 'stale':
      return { kind: 'superseded' };
    case 'not-found':
      return { kind: 'orphaned' };
    case 'contract-rejected':
    case 'auth-rejected':
    case 'transient':
      return { kind: 'keep-pending' };
  }
}

/**
 * Một row có đang chờ bị quét cho report sweep không — predicate chọn row của §9.5.
 *
 * Predicate gồm **ba** điều kiện, không phải hai:
 * - `outcome_report_state = 'pending'`
 * - report-lease hết hiệu lực (để hai sweeper không báo trùng)
 * - `report_attempts < maxReportAttempts` — bound dừng auto-retry, **persisted**,
 *   không đo tuổi từ `updated_at` (acquire (d) set `updated_at = :now`).
 */
export function isEligibleForReportSweep(
  record: MailJobRecord,
  criteria: { readonly nowMs: number; readonly maxReportAttempts: number },
): boolean {
  return (
    record.outcomeReportState === 'pending' &&
    !isReportLeaseActive(record, criteria.nowMs) &&
    record.reportAttempts < criteria.maxReportAttempts
  );
}

/**
 * Một row có đang chờ bị quét cho stale-lease sweep (§10 trách nhiệm 1) không.
 *
 * Sweep này **chỉ alert**, không claim và không ghi gì (§10 hàng 1). Nó dùng đúng
 * biên "hết hiệu lực" với statement (a): `lease_expires_at <= now`.
 */
export function isEligibleForStaleLeaseSweep(
  record: MailJobRecord,
  criteria: { readonly nowMs: number },
): boolean {
  return (
    record.status === 'processing' &&
    record.leaseExpiresAt !== null &&
    record.leaseExpiresAt <= criteria.nowMs
  );
}

/**
 * Một row có đang chờ bị quét cho blocked-backlog sweep (§10 trách nhiệm 3) không.
 *
 * Cũng chỉ alert: worker không xoá marker `blocked`, không bump generation, không
 * tự re-enqueue (§9.4).
 */
export function isEligibleForBlockedBacklogSweep(
  record: MailJobRecord,
  criteria: { readonly cutoffMs: number },
): boolean {
  return (
    record.status === 'blocked' &&
    record.blockedAt !== null &&
    record.blockedAt <= criteria.cutoffMs
  );
}

/**
 * Kết quả persist result cho một lần gọi provider — ba trạng thái mà §9.2.2 hàng 1–4
 * cho phép ghi.
 *
 * `MailJobPersistableStatus` được import và tái-export dưới đây chỉ để caller không
 * phải import hai chỗ cho cùng một giá trị; tập giá trị nguồn vẫn là một.
 */
export type { MailJobPersistableStatus, MailJobReportableState };

/**
 * Row có đang chờ persist một execution result không — tức là còn `processing` và giữ
 * lease của execution này.
 *
 * Dùng trước khi gọi provider để re-validate (§9.2.1: "trước khi gọi provider, owner
 * **phải** re-validate lease còn hiệu lực"). Kết quả `false` nghĩa là KHÔNG được gọi
 * provider: lease đã hết hạn, đã bị execution khác chiếm, hoặc row đã sang trạng thái
 * khác.
 */
export function canPersistExecutionResultFor(
  record: MailJobRecord,
  expectation: {
    readonly owner: string;
    readonly executionGeneration: number;
    readonly dispatchGeneration: number;
    readonly nowMs: number;
  },
): boolean {
  return (
    record.status === 'processing' &&
    record.outcomeReportState === 'none' &&
    record.leaseOwner === expectation.owner &&
    record.leaseExpiresAt !== null &&
    record.leaseExpiresAt > expectation.nowMs &&
    record.executionGeneration === expectation.executionGeneration &&
    record.dispatchGeneration === expectation.dispatchGeneration
  );
}

/**
 * `providerCallAt` có còn nằm trong cửa sổ an toàn idempotency (§9.3) không.
 *
 * Cửa sổ = khoảng thời gian mà provider được cho là **còn giữ** kết quả nằm dưới key
 * idempotency `mailjob_${delivery_id}` (Resend documentation nói ~24 giờ; cấu hình worker
 * phải nhỏ hơn hoặc bằng con số có thể xác minh đó — không exactly-once). Trả về:
 * - `true`  → gọi lại với cùng key là an toàn (provider dedupe, hoặc chưa từng thấy request
 *             đầu) ⇒ đường auto-resend.
 * - `false` → ngoài cửa sổ ⇒ KHÔNG tự gọi lại provider; job phải đi vào trạng thái
 *             operator-needed bền vững (`blocked` + `provider-ambiguous-outcome`) và
 *             alertmetric.
 * - `null`  → chưa có marker (`providerCallAt = null`) — không có ambiguity để đánh giá;
 *             caller đang ở đoạn trước marker hoặc đường không marker, không phải quyết
 *             định bằng hàm này.
 *
 * Biên: `now - provider_call_at <= windowMs` (inclusive) — cùng hình dạng "tuổi ≤ bound"
 * với các guard sweep; một boundary test ghim `now - providerCallAt = windowMs` là `true`.
 *
 * ⚠️ Giới hạn đã tuyên bố tường minh: đây KHÔNG phải exactly-once. 24 giờ là con số
 * **tài liệu provider-side** chưa verify được theo contract (docs không xác nhận hành vi
 * dedupe chắc chắn giữa hai lần dùng lại key) — window config chỉ là policy "khi nào tự
 * tin đủ để gọi lại", không phải chứng cứ provider trả kết quả cũ.
 */
/** Ngưỡng "còn trong cửa sổ an toàn" cho một lần gọi lại với cùng idempotency key. */
export function isWithinProviderSafeWindow(
  record: Pick<MailJobRecord, 'providerCallAt'>,
  criteria: { readonly nowMs: number; readonly providerCallSafeWindowMs: number },
): boolean | null {
  if (record.providerCallAt === null) {
    return null;
  }
  return criteria.nowMs - record.providerCallAt <= criteria.providerCallSafeWindowMs;
}

/** Giá trị đóng của `mail_jobs.status` — dùng cho validate khi decode row. */
export function isMailJobStatus(value: unknown): value is MailJobStatus {
  return typeof value === 'string' && (MAIL_JOB_STATUS_VALUES as readonly string[]).includes(value);
}

/** Giá trị đóng của `mail_jobs.outcome_report_state` — dùng cho validate khi decode row. */
export function isOutcomeReportState(value: unknown): value is OutcomeReportState {
  return (
    typeof value === 'string' && (OUTCOME_REPORT_STATE_VALUES as readonly string[]).includes(value)
  );
}
