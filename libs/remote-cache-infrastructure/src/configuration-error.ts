/**
 * Loi cau hinh cua tang infrastructure `remote-cache` — pattern
 * `StaffAccessConfigurationError` (`libs/staff-access-infrastructure`):
 * nem khi thieu/sai cau hinh o luc khoi dong hoac luc dung dependency,
 * message neu TEN bien/binding de nguoi van hanh biet cap gi — nhung
 * KHONG BAO GIO neu gia tri.
 *
 * Day la mot class rieng, khong dung `RemoteCacheDomainError`: domain error
 * la object thuan `{ code, message }` cua taxonomy nghiep vu, con loi cau
 * hinh la Error class cua dependency-wiring.
 */
export class RemoteCacheConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteCacheConfigurationError';
  }
}
