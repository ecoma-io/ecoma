export {
  DB_BACKOFFICE_BINDING,
  attachPoolErrorHandler,
  backofficeHyperdrive,
  backofficeNodeDatabaseUrl,
  buildPoolOptions,
  createNodePool,
  createPool,
  withBackofficePool,
} from './hyperdrive-pool';
export type { HyperdriveBinding } from './hyperdrive-pool';

export {
  AUTHORIZATION_AUDIT_ID_MAX_LENGTH,
  AUTHORIZATION_FAILURE_INVALID_ACTOR,
  ENFORCEMENT_DENIAL_STALE_WRITE,
} from '@ecoma-io/backoffice-application';
export type {
  AuthorizationAuditContext,
  AuthorizationFailureAuditInput,
  DecisionAuditInput,
  EnforcementDenialAuditInput,
} from '@ecoma-io/backoffice-application';

export {
  recordAuthorizationFailure,
  recordDecision,
  recordPrivilegedSuccess,
  recordStaleWriteDenial,
  listAuthorizationAudit,
} from './authorization-audit';
export type {
  PrivilegedOperationAuditInput,
  LocalAuthorizationAuditEntry,
} from './authorization-audit';

export {
  listPermissions,
  listRoles,
  listStaff,
  loadPrincipalAuthorization,
  loadPrincipalAuthorizationProjection,
  AUTHZ_PROJECTION_CUTOVER_ENV,
} from './queries';
export type {
  PrincipalAuthorizationData,
  RoleRow,
  StaffRow,
  AuthorizationProjection,
} from './queries';

export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_ID_BYTES,
  SESSION_IDLE_SECONDS,
  createCsrfToken,
  createSessionIdentifier,
  csrfCookie,
  csrfMatches,
  clearCsrfCookie,
  clearSessionCookie,
  hashSessionIdentifier,
  insertSession,
  isSessionLive,
  loadSessionByHash,
  replaceAccessToken,
  revokeSessionByHash,
  sessionCookie,
  sessionDeadlines,
  touchSession,
} from './auth/session-store';
export type { BackofficeSessionRow } from './auth/session-store';

export { JWKS_CACHE_TTL_SECONDS, jwksResolver, resetJwksCacheForTests } from './auth/jwks';

export { verifyAccessToken } from './auth/verify';
export type {
  BackofficeAuthConfig,
  InvalidTokenResult,
  TokenVerifyResult,
  UnavailableTokenResult,
  VerifiedAccessToken,
} from './auth/verify';

export {
  ACCOUNT_INTERNAL_SECRET_ENV,
  ACCOUNT_SERVICE_BINDING_NAME,
  AUTH_INTERNAL_SECRET_ENV,
  accountClientConfig,
  fetchAccountProfiles,
} from './account/client';
export type { AccountServiceBinding } from './account/client';

export {
  STAFF_ACCESS_SERVICE_BINDING_NAME,
  STAFF_ACCESS_SECRET_ENV,
  staffAccessClientConfig,
  fetchStaffDirectory,
  fetchRoleCatalog,
  fetchPermissionCatalog,
  fetchStaffEntitlements,
  fetchStaffAssignments,
  fetchAuditEntries,
} from './staff-access/client';
export type { StaffServiceBinding } from './staff-access/client';
export type {
  StaffDirectoryCallResult,
  RoleCatalogCallResult,
  PermissionCatalogCallResult,
  StaffEntitlementsCallResult,
  StaffAssignmentsCallResult,
  AuditListCallResult,
  StaffAccessCallFailureReason,
} from './staff-access/client';
