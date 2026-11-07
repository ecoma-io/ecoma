/**
 * `@ecoma-io/account-domain` — value object, invariant vòng đời và policy thuần của
 * bounded context `identity`.
 *
 * Thư viện này **không** import Nx project khác, **không** SQL, **không** Node builtin
 * và **không** I/O. Mọi tham số thời gian và entropy đều do caller truyền vào.
 */

export { createSubject, isSubject, subjectEntropy, type Subject } from './subject';
export {
  ACCOUNT_STATUS,
  ACCOUNT_STATUSES,
  isAccountStatus,
  isTerminalStatus,
  isTombstone,
  type AccountStatus,
} from './account-status';
export { ACR, ACR_VALUES, acrSetFor, acrSatisfies, isAcr, isAcrShape, type Acr } from './acr';
export {
  isExpired,
  isFresh,
  isRevoked,
  requiresReauthentication,
  type ReauthenticationRule,
  type SessionExpiry,
} from './session-policy';
export { base32Decode, base32Encode, Base32DecodeError } from './base32';
export {
  computeTotp,
  decodeTotpSecret,
  DEFAULT_TOTP_ALGORITHM,
  generateTotpSecret,
  MIN_TOTP_SECRET_BYTES,
  otpauthUri,
  TOTP_ALLOWED_DRIFT_STEPS,
  TOTP_DIGITS,
  TOTP_EPOCH_SECONDS,
  TOTP_STEP_SECONDS,
  totpCounterAt,
  type TotpAlgorithm,
  type TotpVerification,
  verifyTotp,
} from './totp';
export {
  createRecoveryCode,
  formatRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_ENTROPY_BYTES,
  RECOVERY_CODE_GROUPS,
  RECOVERY_CODES_PER_SET,
  RECOVERY_HASH_BITS,
  RECOVERY_HASH_ITERATIONS,
  RECOVERY_SALT_BYTES,
  type RecoveryCode,
  verifyRecoveryCode,
} from './recovery-codes';
export {
  DOMAIN_ERROR_MESSAGES,
  domainError,
  isDomainError,
  type DomainError,
  type DomainErrorCode,
} from './errors';
