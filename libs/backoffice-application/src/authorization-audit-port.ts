/**
 * Port của `@ecoma-io/backoffice-application` — **mọi** dependency mà use case
 * `requirePermission` cần ở tầng enforcement, khai báo dưới dạng interface.
 *
 * Lib này **không** import `@ecoma-io/backoffice-infrastructure` (`type:application`
 * bị cấm phụ thuộc `type:infrastructure` — xem `.oxlintrc.json`) và không có
 * implementation nào. Implementation thật nằm ở
 * `@ecoma-io/backoffice-infrastructure` (recordDecision, recordStaleWriteDenial,
 * recordAuthorizationFailure) và chỉ được biết qua interface ở đây.
 *
 * Audit types (`DecisionAuditInput`, `AuthorizationAuditContext`, ...) và các
 * hằng (`AUTHORIZATION_AUDIT_ID_MAX_LENGTH`, ...) **sống ở đây** vì tầng
 * enforcement (application) là chủ sở hữu của hợp đồng audit; infrastructure
 * chỉ cung cấp đường ghi và import/re-export các type này để giữ tương thích
 * với call-site cũ (`@ecoma-io/backoffice-infrastructure`).
 */

import type {
  AuthorizationDecision,
  AuthorizationMode,
  AuthorizationRiskClass,
  CatalogPermission,
} from '@ecoma-io/backoffice-domain';

/** Độ dài tối đa của `request_id` / `correlation_id` ghi vào audit (SR-013). */
export const AUTHORIZATION_AUDIT_ID_MAX_LENGTH = 128;

/** Reason code của denial phát sinh ở tầng enforcement (write path quá TTL). */
export const ENFORCEMENT_DENIAL_STALE_WRITE = 'stale_write_blocked';

/** Reason code của một lần kiểm tra authorization không xác định được actor. */
export const AUTHORIZATION_FAILURE_INVALID_ACTOR = 'invalid_actor';

export interface DecisionAuditInput {
  readonly actorSub: string;
  readonly targetSub?: string;
  readonly permission: CatalogPermission;
  readonly decision: AuthorizationDecision;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly mode?: AuthorizationMode;
}

export interface AuthorizationAuditContext {
  readonly riskClass: AuthorizationRiskClass;
  readonly stale: boolean;
  readonly mode: AuthorizationMode;
}

export interface AuthorizationFailureAuditInput {
  readonly permission: CatalogPermission;
  readonly riskClass: AuthorizationRiskClass;
  readonly mode: AuthorizationMode;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface EnforcementDenialAuditInput {
  readonly actorSub: string;
  readonly targetSub?: string;
  readonly permission: CatalogPermission;
  readonly riskClass: AuthorizationRiskClass;
  readonly stale: boolean;
  readonly mode: AuthorizationMode;
  readonly requestId?: string;
  readonly correlationId?: string;
}

/**
 * Port ghi audit của authorization — implementation thật nằm ở infrastructure.
 * Application chỉ gọi qua interface này; mọi lỗi propagate nguyên vẹn (I-08).
 */
export interface AuthorizationAuditPort {
  recordDecision(client: unknown, input: DecisionAuditInput): Promise<void>;
  recordStaleWriteDenial(client: unknown, input: EnforcementDenialAuditInput): Promise<void>;
  recordAuthorizationFailure(client: unknown, input: AuthorizationFailureAuditInput): Promise<void>;
}
