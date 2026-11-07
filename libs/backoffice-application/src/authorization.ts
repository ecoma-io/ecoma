/**
 * Lõi enforcement của authorization cho `backoffice` — phần policy-call đã tách
 * khỏi `h3`/Nitro. Chạy thuần theo dữ liệu, không import `h3`, không import
 * infrastructure: audit đi qua {@link AuthorizationAuditPort}.
 *
 * Xem `apps/backoffice/server/authorization.ts` (wrapper mỏng) để ánh xạ kết
 * quả sang HTTP error.
 */

import type {
  CatalogPermission,
  AuthorizationDecision,
  AuthorizationMode,
  AuthorizationRiskClass,
  GrantedAssignment,
} from '@ecoma-io/backoffice-domain';
import { can, isBackofficeAccountId } from '@ecoma-io/backoffice-domain';

import {
  AUTHORIZATION_AUDIT_ID_MAX_LENGTH,
  AUTHORIZATION_FAILURE_INVALID_ACTOR,
  ENFORCEMENT_DENIAL_STALE_WRITE,
  type DecisionAuditInput,
  type AuthorizationFailureAuditInput,
  type EnforcementDenialAuditInput,
  type AuthorizationAuditPort,
} from './authorization-audit-port';

export interface PrincipalAuthorization {
  readonly assignments: readonly GrantedAssignment[];
  readonly actorSub: string;
}

export class AuthorizationDeniedError extends Error {
  readonly code = 'authorization_denied' as const;
  constructor() {
    super('authorization denied');
  }
}

export class AuthorizationUnavailableError extends Error {
  readonly code = 'authorization_unavailable' as const;
  constructor() {
    super('authorization unavailable');
  }
}

/**
 * Checkpoint authorization của một protected request — phần thuần, không HTTP.
 *
 * Thứ tự và ngữ nghĩa xem tài liệu gốc ở `apps/backoffice/server/authorization.ts`.
 * Khác biệt duy nhất: thay vì `throw createError(...)`, hàm ném
 * {@link AuthorizationDeniedError} / {@link AuthorizationUnavailableError};
 * audit lỗi propagate nguyên vẹn (I-08).
 */
export async function evaluatePermission(
  permission: CatalogPermission,
  principal: PrincipalAuthorization,
  auditClient: unknown,
  options: {
    readonly riskClass?: AuthorizationRiskClass;
    readonly requestId?: string;
    readonly correlationId?: string;
    readonly targetSub?: string;
    readonly mode?: AuthorizationMode;
  } = {},
  audit: AuthorizationAuditPort,
): Promise<AuthorizationDecision> {
  const riskClass = options.riskClass ?? 'normal';
  const mode = options.mode ?? 'read';

  if (!isBackofficeAccountId(principal.actorSub)) {
    await audit.recordAuthorizationFailure(auditClient, {
      permission,
      riskClass,
      mode,
      requestId: options.requestId,
      correlationId: options.correlationId,
    });

    throw new AuthorizationUnavailableError();
  }

  const decision = can(permission, principal.assignments, new Date(), riskClass);

  if (decision.allowed) {
    if (mode === 'write' && decision.stale) {
      await audit.recordStaleWriteDenial(auditClient, {
        actorSub: principal.actorSub,
        targetSub: options.targetSub,
        permission,
        riskClass,
        stale: decision.stale,
        mode,
        requestId: options.requestId,
        correlationId: options.correlationId,
      });

      throw new AuthorizationUnavailableError();
    }

    return decision;
  }

  await audit.recordDecision(auditClient, {
    actorSub: principal.actorSub,
    targetSub: options.targetSub,
    permission,
    decision,
    requestId: options.requestId,
    correlationId: options.correlationId,
    mode,
  });

  throw new AuthorizationDeniedError();
}

// Re-export constants for convenience (already in port module).
export {
  AUTHORIZATION_AUDIT_ID_MAX_LENGTH,
  AUTHORIZATION_FAILURE_INVALID_ACTOR,
  ENFORCEMENT_DENIAL_STALE_WRITE,
};
export type { DecisionAuditInput, AuthorizationFailureAuditInput, EnforcementDenialAuditInput };
