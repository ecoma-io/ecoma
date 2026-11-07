/**
 * `@ecoma-io/remote-cache-infrastructure` — PostgreSQL adapter của bounded
 * context `remote-cache` qua Hyperdrive binding `DB_REMOTE_CACHE` (ADR-0015).
 *
 * Mỗi module là một adapter của schema trong
 * `apps/remote-cache/db/migrations/` — SQL là bản chép của schema, không có
 * hằng "tự chế" nào. Không có I/O nào ngoài postgres.js client; không có
 * logic authorization nào ở đây (schema enforceCHECK, app enforce policy —
 * skeleton P4.1 chỉ mở đường read/insert tối thiểu).
 */

export { RemoteCacheConfigurationError } from './configuration-error';
export {
  createRemoteCachePostgresClient,
  withRemoteCacheClient,
  type RemoteCacheClient,
  type RemoteCacheClientConfig,
  type RemoteCacheHyperdriveBinding,
  type RemoteCacheQueryable,
} from './postgres';
export { getTenantById, type TenantRow } from './tenant-repository';
export {
  getProjectById,
  getProjectByTenantAndName,
  insertProject,
  listProjectsByTenant,
  type ProjectRow,
} from './project-repository';
export {
  apiKeyHasWriteScope,
  getApiKeyById,
  getApiKeyByTokenHash,
  insertApiKey,
  parseApiKeyScopes,
  revokeApiKey,
  type ApiKeyRow,
} from './api-key-repository';
export {
  getCacheEntryByProjectAndHash,
  insertCacheEntry,
  listCacheEntriesByProject,
  type CacheEntryRow,
} from './cache-entry-repository';
export {
  getQuotaLimitByProject,
  upsertQuotaLimit,
  type QuotaLimitRow,
} from './quota-limit-repository';
export {
  getUsageCounterByProject,
  upsertUsageCounter,
  rebuildUsageCounter,
  type UsageCounterRow,
} from './usage-counter-repository';
export { insertAuditLog, type AuditLogRow } from './audit-log-repository';
