/**
 * `@ecoma-io/pact-broker-api-infrastructure` — PostgreSQL repositories và
 * connection factory của bounded context `pact-broker` cho deploy unit
 * `pact-broker-api` (driver `pg` qua Hyperdrive). Cài các port của
 * `@ecoma-io/pact-broker-api-application` (`TokenRepo`) và trả về record/DTO
 * được route layer của app entry shape hoá thành HAL.
 *
 * Thư viện này **không** import app entry, **không** Hono, và không mở kết
 * nối nào tự động — caller sở hữu lifecycle của Pool.
 */

export { createPool, isConnectionTerminatedError } from './db/client';

export { PgEnvironmentRepo } from './repo/environment-repo';
export type { EnvironmentRecord } from './repo/environment-repo';

export { PgMatrixRepo } from './repo/matrix-repo';
export type { MatrixQueryResult } from './repo/matrix-repo';

export { PgPactRepo } from './repo/pact-repo';
export type {
  PactContent,
  PactRecord,
  PactFull,
  PactForVerificationResult,
  ConsumerVersionSelector,
} from './repo/pact-repo';

export { PactBrokerTenantError, PgTenantRepo } from './repo/tenant-repo';
export type { MachineTokenRecord, TenantRecord } from './repo/tenant-repo';

export { PgEntitlementSyncRepo } from './repo/entitlement-sync-repo';
export type { EntitlementSyncStateRow } from './repo/entitlement-sync-repo';

export { PgAuditRepo } from './repo/audit-repo';

export { PgTokenRepo, insertAuditEvent } from './repo/token-repo';

export { PgVerificationRepo } from './repo/verification-repo';
export type { VerificationRecord } from './repo/verification-repo';

export { PgVersionRepo } from './repo/version-repo';
export type {
  DeploymentRecord,
  PacticipantRecord,
  TagRecord,
  VersionRecord,
} from './repo/version-repo';

export { PgWebhookRepo } from './repo/webhook-repo';
export type { WebhookRecord } from './repo/webhook-repo';
