/**
 * `@ecoma-io/remote-cache-domain` — value object, invariant vong doi va
 * constraint thuan cua bounded context `remote-cache` (tenant, project,
 * membership, API key machine credential; quota/retention/usage/audit thuoc
 * P4.3) — phan trach nhiem da duoc xac lap boi ADR-0015
 * (`docs/domains/remote-cache/adr/0015-remote-cache-bounded-context.md`).
 *
 * Thu vien nay **khong** import Nx project khac, **khong** SQL, **khong**
 * Node builtin va **khong** I/O. Moi tham so thoi gian do caller truyen vao;
 * domain khong doc dong ho.
 *
 * ## Rang buoc nguon — khong am tham chot trong lib nay
 *
 * - **Lifecycle state tenant/project** (`docs/domains/remote-cache/
 *   domain-model.md` SS2.1): active/suspended/deleted voi enforcement
 *   fail-closed — credential cua tenant/project khong o trang thai `active`
 *   phai bi tu choi. Tap nhan la de xuat cua spec; thu tu chuyen trang thai
 *   chi tiet (deleted terminal?) thuoc P4.4.
 * - **API key** la machine credential cua chinh context nay (ADR-0015),
 *   doc lap voi membership: hash-only, show-once, revoke = set `revoked_at`,
 *   khong `last_used_at`. Scope chi read/write per project — khong permission
 *   nao cua staff-access catalog.
 * - **Khong co quota/usage/audit logic nao o day**: P4.3 pin semantics
 *   (attribution, double-count) truoc khi implement.
 */

export {
  REMOTE_CACHE_TENANT_STATUS,
  REMOTE_CACHE_TENANT_STATUSES,
  REMOTE_CACHE_TENANT_STATUS_REJECTED,
  isRemoteCacheTenantStatus,
  isRemoteCacheTenantStatusActive,
  type RemoteCacheTenantStatus,
} from './tenant-status';
export {
  REMOTE_CACHE_API_KEY_SCOPES,
  REMOTE_CACHE_API_KEY_SCOPE_PATTERN,
  hasRemoteCacheWriteScope,
  isRemoteCacheApiKeyScopeList,
  type RemoteCacheApiKeyScope,
} from './api-key-scope';
export {
  REMOTE_CACHE_DOMAIN_ERROR_MESSAGES,
  isRemoteCacheDomainError,
  remoteCacheDomainError,
  type RemoteCacheDomainError,
  type RemoteCacheDomainErrorCode,
} from './errors';
