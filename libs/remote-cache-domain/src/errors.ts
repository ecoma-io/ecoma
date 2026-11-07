/**
 * Taxonomy loi cua tang domain `remote-cache`.
 *
 * Pattern: `libs/staff-access-domain/src/errors.ts` — mot domain error chi
 * mang `code` on dinh + `message` ngan gon, khong field nao cho
 * identifier/token/secret hay payload tuy y. Mot error object di thang ra log
 * va ra response, nen cho phep mang token hay API key trong message la bien
 * log thanh kenh thu thap secret khong kiem soat.
 *
 * Message la ENGLISH theo language policy cua repo (ruling 2026-10-25 ap dung
 * cho DOMAIN_ERROR_MESSAGES cua moi domain).
 */

/** Ma loi on dinh — contract voi consumer, khong doi nghia theo thoi gian. */
export type RemoteCacheDomainErrorCode =
  | 'invalid_tenant_status'
  | 'tenant_not_found'
  | 'tenant_suspended'
  | 'tenant_deleted'
  | 'tenant_lookup_failed'
  | 'project_not_found'
  | 'project_not_in_tenant'
  | 'invalid_api_key_scope'
  | 'api_key_revoked'
  | 'api_key_not_found'
  | 'invalid_transition'
  | 'quota_exceeded';

/**
 * Message cua tung ma — bang doc nguon duy nhat cua factory. Runtime string
 * phai English (language policy).
 */
export const REMOTE_CACHE_DOMAIN_ERROR_MESSAGES: Record<RemoteCacheDomainErrorCode, string> = {
  invalid_tenant_status: 'Tenant status is not valid.',
  tenant_not_found: 'Tenant not found.',
  tenant_suspended: 'Tenant is suspended.',
  tenant_deleted: 'Tenant is deleted.',
  tenant_lookup_failed: 'Tenant lookup failed.',
  project_not_found: 'Project not found.',
  project_not_in_tenant: 'The project does not belong to the tenant.',
  invalid_api_key_scope: 'API key scope is not valid.',
  api_key_revoked: 'API key has been revoked.',
  api_key_not_found: 'API key not found.',
  invalid_transition: 'The state transition is not valid.',
  quota_exceeded: 'Write would exceed project quota.',
};

/** Error domain: `code` on dinh + `message` ngan gon. */
export interface RemoteCacheDomainError {
  readonly code: RemoteCacheDomainErrorCode;
  readonly message: string;
}

/** Kiem mot error co phai domain error cua context nay khong — type guard. */
export function isRemoteCacheDomainError(value: unknown): value is RemoteCacheDomainError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RemoteCacheDomainError).code === 'string' &&
    (value as RemoteCacheDomainError).code in REMOTE_CACHE_DOMAIN_ERROR_MESSAGES &&
    typeof (value as RemoteCacheDomainError).message === 'string'
  );
}

/** Tao mot domain error tu ma — message lay tu bang doc nguon duy nhat. */
export function remoteCacheDomainError(code: RemoteCacheDomainErrorCode): RemoteCacheDomainError {
  return { code, message: REMOTE_CACHE_DOMAIN_ERROR_MESSAGES[code] };
}
