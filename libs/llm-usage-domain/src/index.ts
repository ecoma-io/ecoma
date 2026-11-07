/**
 * `@ecoma-io/llm-usage-domain` — tầng domain thuần của bounded context `llm-usage`
 * (usage measurement, normalization, token accounting, correction, reconciliation).
 *
 * Target architecture: `docs/domains/llm-usage/domain-model.md`.
 *
 * Thuần khiết:
 * - **Không** import Nx project khác.
 * - **Không** SQL, **Không** Node builtin, **Không** I/O.
 * - Mọi tham số thời gian do caller truyền vào; domain không đọc đồng hồ.
 * - Không provider SDK, không HTTP client, không DB driver, không ORM.
 * - Không import implementation bounded context khác.
 * - Không persistence, durable idempotency, alerting, event dispatch.
 * - Không sở hữu quota / reservation / settlement / credit / balance / ledger.
 *
 * ## Ràng buộc chưa chốt — không âm thầm chốt trong lib này
 *
 * Thiết kế của `llm-usage` để mở các quyết định tại `docs/domains/llm-usage/domain-model.md`
 * §13 (Quyết định còn OPEN).
 *
 * - **U-1**: Nhiều attempt completed — tổng hợp `sum` hay `last-wins`? `aggregateAttemptUsage`
 *   hiện tại dùng `sum` (hành vị interim), chưa được business xác nhận.
 * - **U-2**: Thứ tự correction, replacement vs merge, conflict trùng khóa. `isCorrectionValid`
 *   chỉ kiểm validity cơ bản, không implement ordering hay replacement.
 * - **U-3**: Mối quan hệ correction request-level vs attempt-level. `correctionIdempotencyKey`
 *   hỗ trợ cả hai scope độc lập, không suy luận mối quan hệ.
 * - **U-4**: Ngưỡng so sánh reconciliation (tolerance). `reconcile` so sánh exact, không sai số.
 */

export {
  type NormalizedUsage,
  type TokenCount,
  type UsageStatus,
  type Provenance,
  type ParsedProviderUsage,
  type AttemptUsage,
  type RequestUsage,
  type Correction,
  type ReconciliationResult,
  type DomainError,
  type DomainErrorCode,
  USAGE_STATUS,
} from './types';
export {
  LLM_USAGE_DOMAIN_ERROR_MESSAGES,
  type LLMUsageDomainError,
  llmUsageDomainError,
  isLLMUsageDomainError,
  domainErrorKeys,
} from './errors';
export {
  isValidTokenCount,
  createNormalizedUsage,
  computeTotalTokens,
  validateUsageInvariants,
  isNormalizedUsage,
} from './normalized-usage';
export { createProvenance, isProvenance } from './provenance';
export { normalizeUsage } from './normalize';
export { classifyUsage } from './classify';
export { aggregateAttemptUsage } from './aggregate';
export { isCorrection, isCorrectionValid, correctionIdempotencyKey } from './correction';
export { reconcile } from './reconcile';
