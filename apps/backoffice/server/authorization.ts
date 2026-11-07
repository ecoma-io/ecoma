/**
 * Wrapper mỏng của `requirePermission` cho `apps/backoffice` — giữ nguyên tên
 * export (`requirePermission`, `PrincipalAuthorization`) để route files và
 * `read-route.ts` không đổi. Ánh xạ kết quả thuần của
 * `@ecoma-io/backoffice-application` sang lỗi `h3`.
 *
 * Audit đi qua port được cắm bằng các hàm của
 * `@ecoma-io/backoffice-infrastructure` (runtime role).
 */

import { createError } from 'h3';
import type { Client } from 'pg';

import type { AuthorizationDecision } from '@ecoma-io/backoffice-domain';
import {
  evaluatePermission,
  AuthorizationDeniedError,
  AuthorizationUnavailableError,
  type PrincipalAuthorization as ApplicationPrincipalAuthorization,
} from '@ecoma-io/backoffice-application';
import {
  recordAuthorizationFailure,
  recordDecision,
  recordStaleWriteDenial,
} from '@ecoma-io/backoffice-infrastructure';

export type PrincipalAuthorization = ApplicationPrincipalAuthorization;

const auditPort = {
  recordDecision,
  recordStaleWriteDenial,
  recordAuthorizationFailure,
};

export async function requirePermission(
  permission: Parameters<typeof evaluatePermission>[0],
  principal: PrincipalAuthorization,
  auditClient: Client,
  options: Parameters<typeof evaluatePermission>[3] = {},
): Promise<AuthorizationDecision> {
  try {
    return await evaluatePermission(permission, principal, auditClient, options, auditPort);
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) {
      throw createError({ statusCode: 403, statusMessage: 'forbidden' });
    }
    if (error instanceof AuthorizationUnavailableError) {
      throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
    }
    throw error;
  }
}
