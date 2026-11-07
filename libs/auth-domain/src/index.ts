export { AuthConfigurationError, OAuthProtocolError, type OAuthErrorCode } from './errors';

export {
  HANDLE_DOMAINS,
  MIN_TRANSACTION_ID_LENGTH,
  assertHandleBelongsToTransaction,
  base64UrlToBytes,
  bytesToBase64Url,
  deriveHandle,
  hashHandle,
  lengthPrefixed,
  timingSafeEqual,
  type HandleDomain,
} from './handle';

export {
  MAX_CODE_VERIFIER_LENGTH,
  MIN_CODE_VERIFIER_LENGTH,
  SUPPORTED_CODE_CHALLENGE_METHOD,
  assertValidCodeVerifier,
  computeS256Challenge,
  parseCodeChallenge,
  verifyCodeChallenge,
  type ParsedCodeChallenge,
} from './pkce';

export {
  LOOPBACK_HOSTS,
  assertWellFormedRedirectUri,
  redirectUriMatches,
  type RedirectUriPolicy,
} from './redirect-uri';

export {
  COMPLETABLE_STATES,
  assertBrowserConfirmed,
  assertTransition,
  canTransition,
  isTerminal,
  type AuthorizationTransactionState,
} from './transaction';

export {
  MAX_NONCE_LENGTH_BYTES,
  MAX_STATE_LENGTH_BYTES,
  SUPPORTED_GRANT_TYPES,
  SUPPORTED_RESPONSE_TYPE,
  assertRegisteredRedirectUri,
  filterAllowedScopes,
  parseAuthorizationRequest,
  type AuthorizationRequest,
  type SupportedGrantType,
} from './authorize-request';

export {
  assertGrantCoversScope,
  assertUsableClient,
  assessRiskLevel,
  isActiveClient,
  needsConsent,
  type ClientType,
  type RiskLevel,
} from './grant';

export {
  FAIL_CLOSED_ONLY_AT_ISSUANCE,
  assertRevocationCacheTtl,
  isIssuable,
  type RevocationCheckResult,
  type RevocationScope,
} from './revocation';

export { allowsIssuance } from './issuance-policy';

export {
  SIGNING_ALGORITHM,
  SIGNING_CURVE,
  SIGNING_KEY_TYPE,
  type PublicJwk,
  type SigningKeyMetadata,
  type SigningKeyProvider,
} from './signing-key';
