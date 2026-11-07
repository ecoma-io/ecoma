/**
 * `@ecoma-io/remote-cache-contracts` — wire contract của **control plane**
 * bounded context `remote-cache` (P4.1 skeleton; issue #442, ADR-0015).
 *
 * ⚠️ **Project này KHÔNG import implementation nào** — đúng ràng buộc
 * `type:contracts` của `.oxlintrc.json` (cấm `type:domain`/`type:application`/
 * `type:infrastructure` kể cả transitive). Vocabulary scope/status được khai
 * lại ở mức hình thức wire; test so le giữa hai tập là chốt chặn drift với
 * domain lib.
 *
 * ⚠️ **Phạm vi P4.1:** chỉ contract create/list project trong tenant của key.
 * KHÔNG có data plane, KHÔNG có quota, KHÔNG có hardening (P4.2/P4.3/P4.4).
 */

export {
  FORBIDDEN_PROJECT_CREDENTIAL_FIELDS,
  isRemoteCacheApiKeyScope,
  isRemoteCacheProjectName,
  isRemoteCacheTenantStatus,
  PROJECT_LIST_DEFAULT_LIMIT,
  PROJECT_LIST_MAX_LIMIT,
  REMOTE_CACHE_API_KEY_SCOPES,
  REMOTE_CACHE_PROJECT_NAME_PATTERN,
  REMOTE_CACHE_TENANT_STATUSES,
  validateCreateRemoteCacheProjectRequest,
  validateRemoteCacheProject,
  validateRemoteCacheProjectListRequest,
  validateRemoteCacheProjectListResponse,
  type CreateRemoteCacheProjectRequest,
  type RemoteCacheApiKeyScope,
  type RemoteCacheControlPlaneRejectionReason,
  type RemoteCacheControlPlaneValidation,
  type RemoteCacheProject,
  type RemoteCacheProjectListResponse,
  type RemoteCacheTenantStatus,
} from './project-control-plane-contract';
