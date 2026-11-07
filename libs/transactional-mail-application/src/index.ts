/**
 * Barrel exports cho `@ecoma-io/transactional-mail-application`.
 *
 * Contract boundary: chỉ export **public entrypoints** (theo `exports["."]` trong
 * `package.json`). Consumer chỉ phụ thuộc vào package root, không import deep-path.
 *
 * Lib này gồm **hai lớp**: ports (interface + record thuần type — infrastructure cài,
 * application layer chỉ gọi qua chúng) và **use-case orchestration** (thuần thuật toán, mọi
 * I/O đi qua port, mọi ngưỡng vận hành là tham số truyền vào). Không type nào ở đây rò rỉ
 * binding của Cloudflare (`D1Database`, `Env`), type của Hono hay type của driver SQL —
 * đó là ranh giới mà `pnpm dx arch-check` và spec trong lib này cùng giữ.
 *
 * Tài liệu tham chiếu:
 * - `docs/applications/transactional-mail/01-architecture.md` §4, §6, §7.4, §8
 * - `docs/applications/transactional-mail/02-requirements.md` FR-002, FR-004, FR-006, FR-007
 */

export type {
  MailMessageRecord,
  MailOutboxRecord,
  MailOutboxStatus,
  MailRateLimitConsumeResult,
  MailRateLimitScope,
  MailTemplateRecord,
  MailTemplateStatus,
} from './records';

export type { MailTemplateRepository } from './mail-template-repository';

export type {
  ApplyMailDeliveryOutcomeInput,
  ApplyMailDeliveryOutcomeResult,
  CreateMailMessageWithOutboxInput,
  CreateMailMessageWithOutboxResult,
  MailMessageRepository,
} from './mail-message-repository';

export type {
  ClaimMailOutboxInput,
  MarkMailOutboxPublishedInput,
  MarkMailOutboxPublishedResult,
  MailOutboxRepository,
  RecordMailOutboxPublishFailureInput,
  RenewMailOutboxLeaseInput,
} from './mail-outbox-repository';

export type {
  ClaimMailNonceInput,
  DeleteExpiredMailNoncesInput,
  InternalNonceStore,
} from './internal-nonce-store';

export type { MailRateLimitStore, TryConsumeMailRateLimitInput } from './mail-rate-limit-store';

export type {
  ListMailContentRetentionCandidatesInput,
  ListMailStaleNonTerminalMessagesInput,
  MailContentRetentionCandidate,
  MailRetentionQueries,
  MailStaleNonTerminalCandidate,
  RedactMailContentInput,
  RedactMailContentResult,
} from './mail-retention-queries';

// ---------------------------------------------------------------------------
// Use-case orchestration — thuần thuật toán, mọi I/O qua port ở trên.
// ---------------------------------------------------------------------------

/** FR-002 — canonical hoá JSON (RFC 8785) cho request fingerprint. */
export { JcsUnsupportedValueError, jcsCanonicalize } from './jcs';

/** FR-002 — chuẩn hoá recipient/locale + kiểm shape variables. */
export {
  MAIL_DEFAULT_LOCALE,
  MAIL_VARIABLES_MAX_KEYS,
  MAIL_VARIABLES_KEY_PATTERN,
  MAIL_VARIABLES_MAX_STRING_LENGTH,
  type NormalizeLocaleResult,
  type NormalizeRecipientResult,
  type ValidateRequestShapeVariablesResult,
  normalizeLocale,
  normalizeRecipient,
  validateRequestShapeVariables,
} from './normalize-request';

/** FR-002 — request fingerprint có khoá (HMAC-SHA-256, profile `p1`, key tag `k1`). */
export {
  FINGERPRINT_KEY_TAG,
  FINGERPRINT_PROFILE_PREFIX,
  type ComputeRequestFingerprintInput,
  type ComputeRequestFingerprintResult,
  type StoredFingerprintTag,
  canonicalRequestString,
  computeRequestFingerprint,
  fingerprintProfileKeyTag,
  parseStoredFingerprintTag,
  verifyStoredRequestFingerprint,
} from './request-fingerprint';

/** FR-003 — subset JSON schema của template + validation variables + URL allowlist. */
export {
  TEMPLATE_SCHEMA_MAX_KEYS,
  TEMPLATE_SCHEMA_VERSION,
  TEMPLATE_STRING_MAX_LENGTH_LIMIT,
  TEMPLATE_VARIABLE_KEY_PATTERN,
  type ParsedTemplateSchema,
  type ParsedTemplateVariable,
  type ParseTemplateSchemaResult,
  type TemplateVariableFormat,
  type TemplateVariableType,
  type ValidateTemplateUrlResult,
  type ValidateVariablesAgainstSchemaResult,
  parseTemplateSchema,
  validateTemplateUrl,
  validateVariablesAgainstSchema,
} from './mail-template-schema';

/** FR-003 — render `{{ var }}` một lượt với HTML escape. */
export {
  type RenderMailInput,
  type RenderMailResult,
  escapeHtmlAttribute,
  escapeHtmlText,
  renderMail,
} from './mail-render';

/** FR-001 — use case tạo message: normalize → idempotency → rate limit → render → ghi. */
export {
  type CreateMailMessageConfig,
  type CreateMailMessageDeps,
  type CreateMailMessageResult,
  type MailRateLimitPolicy,
  createMailMessage,
} from './create-mail-message';

/** FR-005 — outbox publisher: claim → queue send (ngoài D1) → mark published. */
export {
  type MailOutboxAlert,
  type MailOutboxPublisherDeps,
  type MailSendCommandPayload,
  type PublishOutboxBatchConfig,
  type PublishOutboxBatchResult,
  backoffDelayMs,
  publishOutboxBatch,
  sanitizePublishErrorToken,
} from './outbox-publisher';

/** FR-005 — reconciler: quét dispatch-incomplete và re-dispatch qua callback. */
export {
  type MailOutboxReconcilerDeps,
  type MailReconcilerAlert,
  type RedispatchMailOutboxResult,
  type RunOutboxReconcilerConfig,
  type RunOutboxReconcilerResult,
  runOutboxReconciler,
} from './outbox-reconciler';

/** FR-007 — chu kỳ retention: redact content quá hạn + alert delivery dở. */
export {
  type MailRetentionAlert,
  type MailRetentionDeps,
  type RunRetentionCycleConfig,
  type RunRetentionCycleResult,
  runRetentionCycle,
} from './mail-retention-execution';

/** FR-005 — prune nonce hết hạn theo lô. */
export {
  type MailNoncePruneDeps,
  type RunNoncePruneConfig,
  runNoncePrune,
} from './mail-nonce-prune';

/** SR-001 — authorization theo template: verdict default-deny theo allowlist của principal. */
export { type IsTemplateAuthorizedResult, isTemplateAuthorized } from './is-template-authorized';
