export {
  type MailProviderErrorClass,
  type MailProviderPort,
  type MailProviderSendRequest,
  type MailProviderSendResult,
} from './mail-provider-port';

export {
  MAIL_JOB_STATUS_VALUES,
  OUTCOME_REPORT_STATE_VALUES,
  QUARANTINE_REASON_VALUES,
  MAIL_JOB_PERSISTABLE_STATUS_VALUES,
  MAIL_JOB_REPORTABLE_STATE_VALUES,
  MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS,
  MAIL_JOB_DELIVERY_NOT_FOUND_ERROR_CLASS,
  MAIL_JOB_PROVIDER_AMBIGUOUS_ERROR_CLASS,
  MalformedMailJobStateError,
  MailJobValidationError,
  sanitizeErrorToken,
  QUARANTINE_FIELD_NAME_PATTERN,
  QUARANTINE_FIELD_NAME_MAX_LENGTH,
  sanitizeFieldName,
  assertSafeInteger,
  assertPositiveInteger,
  assertClosedValue,
  assertNonEmptyString,
  assertBoundedString,
  assertBoundedOptionalString,
  MAIL_JOB_IDENTIFIER_MAX_LENGTH,
  assertLeaseOwner,
  type MailJobRecord,
  type MailJobStatus,
  type OutcomeReportState,
  type QuarantineReason,
  type QuarantineRecord,
} from './mail-job-model';

export {
  isExecutionLeaseActive,
  isReportLeaseActive,
  isTerminalStatus,
  isMailJobStatus,
  isOutcomeReportState,
  classifySameGenerationClaimDenial,
  classifyGenerationAdvanceDenial,
  classifyBudgetExhaustedDenial,
  classifyLeaseOwnershipDenial,
  classifyAmbiguityBlockedDenial,
  classifyProviderCallBoundaryDenial,
  classifyReportLeaseDenial,
  classifyReportCompletionDenial,
  dispositionForControlPlaneOutcome,
  isEligibleForReportSweep,
  isEligibleForStaleLeaseSweep,
  isEligibleForBlockedBacklogSweep,
  canPersistExecutionResultFor,
  type BudgetExhaustedDenial,
  type AmbiguityBlockedDenial,
  type GenerationAdvanceDenial,
  type LeaseOwnershipDenial,
  type ReportCompletionDenial,
  type ReportLeaseDenial,
  type SameGenerationClaimDenial,
  type ClaimDenial,
  type ProviderCallBoundaryDenial,
  isWithinProviderSafeWindow,
  type ControlPlaneOutcomeSignal,
  type OutcomeReportDisposition,
  type MailJobPersistableStatus,
  type MailJobReportableState,
} from './mail-job-rules';

export type {
  MailJobRepository,
  QuarantineRepository,
  CreatePendingJobParams,
  CreatePendingJobResult,
  ClaimSameGenerationParams,
  ClaimSameGenerationResult,
  ClaimSameGenerationSuccess,
  ClaimGenerationAdvanceParams,
  ClaimGenerationAdvanceResult,
  ClaimGenerationAdvanceSuccess,
  MarkBlockedBudgetExhaustedParams,
  MarkBlockedBudgetExhaustedResult,
  MarkProviderCallBoundaryParams,
  MarkProviderCallBoundaryResult,
  MarkProviderAmbiguityBlockedParams,
  MarkProviderAmbiguityBlockedResult,
  RenewExecutionLeaseParams,
  RenewExecutionLeaseResult,
  PersistExecutionResultParams,
  PersistExecutionResultResult,
  ExecutionResultOutcome,
  RecordLookupErrorParams,
  RecordLookupErrorResult,
  ReleaseExecutionLeaseParams,
  ReleaseExecutionLeaseResult,
  AcquireReportLeaseParams,
  AcquireReportLeaseResult,
  AcquireReportLeaseSuccess,
  CompleteReportParams,
  CompleteReportResult,
  CompleteReportDisposition,
  KeepReportPendingParams,
  KeepReportPendingResult,
  StaleLeaseSweepItem,
  ReportSweepItem,
  BlockedBacklogSweepItem,
  FindStaleLeaseCandidatesParams,
  FindReportSweepCandidatesParams,
  FindBlockedBacklogCandidatesParams,
  UpsertQuarantineRecordParams,
  UpsertQuarantineRecordResult,
  GetQuarantineRecordParams,
} from './mail-job-repository-port';

// ---------------------------------------------------------------------------
// Use-case orchestration — thuần thuật toán, mọi I/O qua port ở trên.
// ---------------------------------------------------------------------------

/** Gateway port sang private delivery interface của `transactional-mail`. */
export type {
  DeliveryLookupResult,
  DeliveryMaterial,
  MailDeliveryGateway,
  OutcomeReportRequest,
  OutcomeReportResult,
} from './mail-delivery-gateway';

/** §3.1 — HMAC digest của raw Queue body thành `quarantine_id`, không lộ payload. */
export {
  QUARANTINE_ID_PATTERN,
  QUARANTINE_ID_PREFIX,
  QUARANTINE_UNKNOWN_FIELD_NAME,
  computeQuarantineId,
  encodeUtf8,
  optionalSanitizedFieldName,
  quarantineReasonFor,
} from './quarantine-digest';

/** §9.2 — orchestration một Queue command: parse → claim → provider → persist → report. */
export {
  type MailCommandOutcome,
  type ProcessMailCommandConfig,
  type ProcessMailCommandDeps,
  processMailCommand,
  reportOwnerToken,
} from './process-mail-command';

/** §9.5 — ba sweep định kỳ: report pending, lease stale, blocked backlog. */
export {
  REPORT_SWEEP_ALERT_KINDS,
  type AlertSweepSummary,
  type ReportSweepAlert,
  type ReportSweepConfig,
  type ReportSweepDeps,
  type ReportSweepSummary,
  runBlockedBacklogSweep,
  runReportSweep,
  runStaleLeaseSweep,
} from './report-sweeps';

/** §11.3 — lifecycle event trung tính của provider: chuẩn hoá, dedupe, correlate. */
export {
  ingestLifecycleEventMessage,
  MAIL_LIFECYCLE_EVENT_TYPE_VALUES,
  MAIL_LIFECYCLE_REASON_TOKEN_VALUES,
  normalizeLifecycleEventMessage,
  type LifecycleEventIngestDeps,
  type LifecycleEventIngestOutcome,
  type LifecycleEventNormalization,
  type LifecycleEventRejectionReason,
  type MailLifecycleEvent,
  type MailLifecycleEventType,
  type MailLifecycleReasonToken,
} from './lifecycle-events';
