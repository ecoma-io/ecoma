/**
 * `@ecoma-io/llm-consumer-routing-domain` — domain library thuân cho bounded
 * context `llm-consumer-routing`: model alias, routing policy, candidate selection, fallback
 * hai cap, config version/snapshot. Pure TypeScript, khong I/O, khong database,
 * khong HTTP, khong Node builtin, khong global mutable state.
 *
 * Thoi gian, cursor, randomness duoc caller truyen vao; domain khong doc dong
 * ho va khong sinh so ngau nhien.
 *
 * ## Ranh voi cac bounded context khac
 *
 * - Pricing calculation/catalog → `llm-seller-pricing` (domain khong tinh gia).
 * - Reserve/settle quota → `llm-api` (A7) — domain khong reserve/settle.
 * - Dispatch/provider execution → `llm-inference` — domain khong dispatch.
 * - Tenant/membership/workspace → `llm-consumer-tenant` — domain nhan facts lam input.
 * - Seller offer/model catalog/upstream endpoint → `llm-marketplace`.
 *
 * Domain khong import Nx project nao khac (type:domain).
 *
 * Public surface duoc giu co chung toi; tat ca module khac la internal.
 */

export type { DomainOk, DomainRejection } from './shared';
export {
  isNonEmptyString,
  isEpochMillis,
  isFiniteNumber,
  isNonNegativeInteger,
  isPositiveInteger,
} from './shared';

export type { RoutingDomainErrorCode, RoutingDomainError } from './errors';
export { ROUTING_DOMAIN_ERROR_MESSAGES, isRoutingDomainError, routingDomainError } from './errors';

export type {
  ModelAlias,
  AliasStatus,
  AliasRecord,
  ResolveAliasResult,
  RetireAliasResult,
} from './alias';
export {
  ALIAS_STATUS,
  isModelAlias,
  isAliasStatus,
  isAliasRecord,
  resolveAlias,
  retireAlias,
} from './alias';

export type { RoutingPolicy, CreatePolicyResult } from './policy';
export { isRoutingPolicy, createPolicy } from './policy';

export type { CandidateId, CandidateStatus, CandidateCapability, Candidate } from './candidate';
export {
  CANDIDATE_STATUS,
  isCandidateId,
  isCandidateStatus,
  isCandidateCapability,
  isCandidate,
} from './candidate';

export type {
  EligibilityDenialReason,
  EligibilityFacts,
  CandidateEligibility,
} from './eligibility';
export { evaluateEligibility, filterEligible } from './eligibility';

export type {
  RoutingStrategy,
  RoundRobinCursor,
  PriceFact,
  RoundRobinResult,
  RoutingStrategyResult,
} from './strategy';
export {
  ROUTING_STRATEGY,
  isRoutingStrategy,
  isRoundRobinCursor,
  isPriceFact,
  selectByPriority,
  selectRoundRobin,
  selectLowestPrice,
  selectCandidate,
} from './strategy';

export type { ExecutionEvidence, FallbackDecision, FallbackInputs } from './fallback';
export {
  EXECUTION_EVIDENCE,
  isExecutionEvidence,
  decideFallback,
  isFallbackAllowedEvidence,
} from './fallback';

export type { RoutingPolicyVersion, FallbackConfig, RoutingSnapshot } from './snapshot';
export {
  isRoutingPolicyVersion,
  isRoutingSnapshot,
  buildSnapshot,
  freezeSnapshot,
} from './snapshot';
