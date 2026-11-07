/**
 * `@ecoma-io/account-contracts` — contract mà service `account` **publish** cho
 * consumer của nó (`auth`).
 *
 * ⚠️ **Project này KHÔNG import `@ecoma-io/account-domain`.** Constraint `type:contracts`
 * trong `.oxlintrc.json` cấm phụ thuộc `type:domain` (kể cả transitive), và đó là đúng:
 * contract là thứ provider **publish** để consumer phụ thuộc vào, không phải một tầng để
 * đi theo chiều phụ thuộc. Vì vậy mọi giá trị wire (status, trường bị cấm) được khai
 * báo bằng union `wire` ở đây thay vì import union của tầng domain.
 *
 * Project cũng không chứa domain logic: chỉ shape của message và validator hình thức.
 * Việc tách contract theo provider (issue #324): contract của `account` nằm ở đây,
 * contract của `auth` nằm ở `@ecoma-io/auth-contracts`, còn envelope HMAC
 * `ecoma-internal-v1` dùng chung nằm ở `@ecoma-io/internal-auth-contracts`.
 *
 * ⚠️ **Envelope HMAC `ecoma-internal-v1` không được khai lại ở đây.** Bản cài đặt canonical
 * của giao thức nằm ở `@ecoma-io/internal-auth-contracts` (`scope:platform`) — giao thức
 * không mang khái niệm identity (không principal, không user), nên nơi canonical của nó là
 * tầng platform. File này re-export giao thức để caller lẫn callee của contract
 * `account` (route `/internal/account/status`) ký/kiểm qua **một** nguồn duy nhất; giữ
 * một bản cài đặt thứ hai là tạo lại đúng thứ hai envelope trôi lệch mà lần hợp nhất
 * trước đã dẹp.
 */

export {
  assertKid,
  assertNonceExpirySeconds,
  INTERNAL_BODY_LIMIT_BYTES,
  hashBody,
  canonicalString,
  createNonce,
  DEFAULT_SKEW_SECONDS,
  InvalidCanonicalFieldError,
  InvalidKidError,
  INTERNAL_KID_HEADER,
  isValidNonceExpirySeconds,
  MAX_NONCE_CHARS,
  MAX_NONCE_EXPIRY_EPOCH_SECONDS,
  MAX_SKEW_SECONDS,
  MIN_SKEW_SECONDS,
  NONCE_TTL_BUFFER_SECONDS,
  PROTOCOL_ID,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  isStrongNonce,
  resolveSkewSeconds,
  signRequest,
  timingSafeEqualHex,
  verifyRequest,
  type InternalAuthHeaders,
  type SignRequestInput,
  type VerifyFailureReason,
  type VerifyRequestInput,
  type VerifyResult,
} from '@ecoma-io/internal-auth-contracts';
export {
  ACCOUNT_STATUS_RESPONSE_VALUES,
  accountStatusResponse,
  FORBIDDEN_ACCOUNT_STATUS_FIELDS,
  isAccountStatusResponseValue,
  validateAccountStatusResponse,
  type AccountStatusRejectionReason,
  type AccountStatusResponse,
  type AccountStatusResponseValue,
  type AccountStatusValidation,
} from './account-status-contract';
export {
  ACCOUNT_PROFILES_DISPLAY_NAME_MAX_LENGTH,
  ACCOUNT_PROFILES_MAX_SUBS,
  accountProfilesResponse,
  dedupeProfileSubs,
  FORBIDDEN_ACCOUNT_PROFILE_ENTRY_FIELDS,
  isAccountProfileEntry,
  validateAccountProfilesResponse,
  type AccountProfileEntry,
  type AccountProfilesRejectionReason,
  type AccountProfilesResponse,
  type AccountProfilesValidation,
} from './account-profiles-contract';
