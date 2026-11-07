/**
 * `@ecoma-io/auth-contracts` — contract mà service `auth` **publish** cho
 * consumer của nó (`account`).
 *
 * ⚠️ **Project này KHÔNG import tầng domain.** Constraint `type:contracts`
 * trong `.oxlintrc.json` cấm phụ thuộc `type:domain` (kể cả transitive), và đó là đúng:
 * contract là thứ provider **publish** để consumer phụ thuộc vào, không phải một tầng để
 * đi theo chiều phụ thuộc. Vì vậy `authn_level` (ACR URN) được khai báo lại bằng union
 * `wire` ở đây thay vì import union của tầng domain, và được canh bởi parity test với
 * bản mirror của domain.
 *
 * Project cũng không chứa domain logic: chỉ shape của message, validator hình thức và
 * re-export của envelope HMAC dùng chung cho cả caller lẫn callee.
 *
 * ⚠️ **Hướng của `/internal/consent/*` và `/internal/connected-applications*` là
 * `account → auth`, không phải ngược lại.** `auth` là **provider** (route nằm trên
 * không gian tên của provider), `account` là **consumer**. Đọc sai hướng dẫn tới việc
 * dựng một route `/internal/consent/*` trong `account` — tức hai bản cài đặt cho một
 * contract. `getConsentContext`/`submitConsent` là **lời gọi do `account` phát ra**,
 * không phải hàm `auth` gọi vào `account`. Xem bảng hướng trong
 * `docs/applications/auth/01-architecture.md` §5.1.7 — cột "Hướng" đọc là
 * `consumer → provider`, và tên endpoint nằm trên không gian tên của provider.
 * `/internal/account/status` có TIỀN TỐ `account` nhưng thuộc về `account`
 * (contract của nó nằm ở `@ecoma-io/account-contracts`).
 *
 * ⚠️ **Envelope HMAC `ecoma-internal-v1` không được khai lại ở đây.** Bản cài đặt canonical
 * của giao thức nằm ở `@ecoma-io/internal-auth-contracts` (`scope:platform`) — giao thức
 * không mang khái niệm identity (không principal, không user), nên nơi canonical của nó là
 * tầng platform. File này re-export giao thức để caller lẫn callee của các contract
 * `auth` (`/internal/session/verified`, `/internal/consent/*`,
 * `/internal/connected-applications*`) ký/kiểm qua **một** nguồn duy nhất; giữ một bản
 * cài đặt thứ hai là tạo lại đúng thứ hai envelope trôi lệch mà lần hợp nhất trước đã dẹp.
 *
 * Việc tách contract theo provider (issue #324): contract của `account` nằm ở
 * `@ecoma-io/account-contracts`, còn bề mặt internal-HMAC dùng chung nằm ở
 * `@ecoma-io/internal-auth-contracts`.
 *
 * ⚠️ **`allowsIssuance` KHÔNG thuộc contract.** Hàm đó là policy cấp phát credential
 * (mọi trạng thái ngoài `active` đều chặn issuance) — nó sống ở tầng domain
 * (`@ecoma-io/auth-domain`), không phải ở wire contract.
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
  ACR_URN_VALUES,
  FORBIDDEN_SESSION_VERIFIED_FIELDS,
  REQUIRED_SESSION_VERIFIED_FIELDS,
  validateSessionVerifiedRequest,
  type AcrUrn,
  type SessionVerifiedOutcome,
  type SessionVerifiedRejectionReason,
  type SessionVerifiedRequest,
  type SessionVerifiedResponse,
  type SessionVerifiedValidation,
} from './session-verified';
export type {
  ConnectedApplicationGrant,
  ConnectedApplicationRevokeRequest,
  ConnectedApplicationRevokeResponse,
  ConnectedApplicationsRequest,
  ConnectedApplicationsResponse,
  ConsentContextRequest,
  ConsentContextResponse,
  ConsentDecision,
  ConsentDecideRequest,
  ConsentDecideResponse,
} from './consent';
