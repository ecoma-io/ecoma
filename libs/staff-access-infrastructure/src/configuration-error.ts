/**
 * Loi cau hinh cua tang infrastructure `staff-access` — pattern
 * `PactBrokerConfigurationError` (`apps/pact-broker-api/src/config.ts`) va
 * `AuthConfigurationError` (`libs/auth-domain`): nem khi thieu/sai cau hinh
 * o luc khoi dong hoac luc dung dependency, message neu TEN bien/binding de
 * nguoi van hanh biet cap gi — nhung KHONG BAO GIO neu gia tri.
 *
 * Day la mot class rieng, khong dung `StaffAccessDomainError`: domain error
 * la object thuan `{ code, message }` cua taxonomy nghiep vu, con loi cau hinh
 * la Error class cua dependency-wiring. Tron hai lo la mot loi tich hop trong
 * nhu mot loi nghiep vu neu co cho phan nhanh theo class.
 */
export class StaffAccessConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffAccessConfigurationError';
  }
}
