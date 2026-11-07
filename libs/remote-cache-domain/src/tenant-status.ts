/**
 * Lifecycle state cua tenant (va cung hinh voi project) trong bounded context
 * `remote-cache`.
 *
 * Nguon rang buoc: `docs/domains/remote-cache/domain-model.md` SS2.1 — moi
 * tenant co lifecycle state rieng voi semantics tuong minh; enforcement
 * **fail-closed**: credential cua tenant khong o trang thai `active` MUST bi
 * tu choi, ke ca khi cached configuration chua phan anh trang thai moi
 * (stale cache khong duoc bien suspend/delete thanh allow).
 *
 * Cach dung: module nay chi dinh nghia hinh dang va tap nhan — duong enforce
 * (authn + lifecycle check) thuoc tang serving, khong nam o domain lib.
 */

/** Cac gia tri lifecycle state hop le cua tenant — de xuat theo spec SS2.1. */
export const REMOTE_CACHE_TENANT_STATUSES = ['active', 'suspended', 'deleted'] as const;

/** Union type cua lifecycle state — dung cho contract va schema CHECK. */
export type RemoteCacheTenantStatus = (typeof REMOTE_CACHE_TENANT_STATUSES)[number];

/** Hang so tap nhan — dung lam nguon duy nhat cho validator va migration. */
export const REMOTE_CACHE_TENANT_STATUS: Record<RemoteCacheTenantStatus, RemoteCacheTenantStatus> =
  {
    active: 'active',
    suspended: 'suspended',
    deleted: 'deleted',
  };

/** Kiem mot gia tri chuoi co phai lifecycle state hop le khong — type guard. */
export function isRemoteCacheTenantStatus(value: unknown): value is RemoteCacheTenantStatus {
  return (
    typeof value === 'string' && (REMOTE_CACHE_TENANT_STATUSES as readonly string[]).includes(value)
  );
}

/** Kiem mot trang thai lifecycle co phai `active` khong — duong enforce
 * fail-closed o tang serving: chi `active` moi duoc phep doc/ghi cache. */
export function isRemoteCacheTenantStatusActive(status: RemoteCacheTenantStatus): boolean {
  return status === REMOTE_CACHE_TENANT_STATUS.active;
}

/** Tap nhan trang thai bi tu choi (khong `active`) — dung cho fail-closed. */
export const REMOTE_CACHE_TENANT_STATUS_REJECTED = [
  REMOTE_CACHE_TENANT_STATUS.suspended,
  REMOTE_CACHE_TENANT_STATUS.deleted,
] as const;
