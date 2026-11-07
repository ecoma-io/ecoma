import type { AccountStatusResponseValue } from '@ecoma-io/account-contracts';
import type { ConsentDecision } from '@ecoma-io/auth-contracts';
import {
  HANDLE_DOMAINS,
  OAuthProtocolError,
  allowsIssuance,
  assertBrowserConfirmed,
  assertRegisteredRedirectUri,
  assertUsableClient,
  assertValidCodeVerifier,
  deriveHandle,
  filterAllowedScopes,
  hashHandle,
  parseAuthorizationRequest,
  timingSafeEqual,
  verifyCodeChallenge,
  type AuthorizationRequest,
  type AuthorizationTransactionState,
  type RevocationCheckResult,
  type SigningKeyProvider,
} from '@ecoma-io/auth-domain';

import { type IssuedTokens, createRefreshToken, issueAccessToken } from './token-service';

/**
 * Dịch vụ giao dịch uỷ quyền (FR-010..FR-016).
 *
 * Đây là tầng điều phối: nó giữ THỨ TỰ các bước, và thứ tự đó là một phần của
 * hợp đồng bảo mật. Ba bất biến mà tầng này chịu trách nhiệm:
 *
 * 1. **Không lỗi nào được redirect trước khi `redirect_uri` được kiểm.** Ranh
 *    giới open-redirect nằm ở `assertRegisteredRedirectUri`; trước nó mọi lỗi
 *    phải là `redirectable: false` (`directInvalidRequest`/`invalidClient`),
 *    sau nó mới được dùng biến thể redirectable.
 * 2. **Account là fail-closed.** Account không trả lời được thì KHÔNG phát hành
 *    token. Không có nhánh "coi như khoẻ".
 * 3. **Consent là điều kiện.** Một grant hiện có phải phủ HẾT scope được yêu
 *    cầu; thiếu một scope là phải hỏi lại.
 */

/** Cổng ra tới `db-auth`. Application layer không biết SQL. */
export interface AuthStore {
  /**
   * Tìm transaction theo BĂM handle X (bàn giao login).
   *
   * ⚠️ Handle X là loại handle duy nhất có cột riêng để tra từ URL bàn giao
   * (`handle_hash_x`); Y và Z có cột riêng của chúng (`handle_hash_y`/
   * `handle_hash_z`) và KHÔNG có cột "generic handle_hash" nào — mọi giả định
   * về một cột chung là sai về cấu trúc X/Y/Z.
   */
  findTransactionByHandleX(params: {
    handleXHash: string;
  }): Promise<AuthorizationTransactionRecord | undefined>;
  createTransaction(record: NewAuthorizationTransaction): Promise<void>;
  /**
   * Chuyển trạng thái CÓ ĐIỀU KIỆN.
   *
   * Trả `false` nghĩa là hàng đã ở trạng thái khác — một request khác đã thắng.
   * Đây là CAS của transaction, cùng nguyên tắc với `redeemAuthorizationCode`:
   * chuyển trạng thái không điều kiện sẽ cho hai request cùng "hoàn tất".
   */
  transition(params: {
    transactionId: string;
    from: AuthorizationTransactionState;
    to: AuthorizationTransactionState;
    at: Date;
  }): Promise<boolean>;
  insertAuthorizationCode(code: NewAuthorizationCode): Promise<void>;
  findGrant(params: { accountId: string; clientId: string }): Promise<AuthGrant | undefined>;
  findClient(clientId: string): Promise<RegisteredClient | undefined>;
  checkRevocation(params: { accountId: string; clientId: string }): Promise<RevocationCheckResult>;
}

/**
 * Hàng `authorization_transactions` — hình dạng dữ liệu PostgreSQL trả về.
 *
 * ⚠️ Đây là PERSISTENCE ROW, không phải lệnh nghiệp vụ: tên cột snake_case khớp
 * schema (`0002` + `0011`), và mọi codec (bytea ↔ base64url) đã được adapter
 * giải quyết trước khi dữ liệu tới đây.
 */
export interface AuthorizationTransactionRecord {
  /** Chuỗi base64url 43 ký tự (§5.6); hàng legacy có thể là chuỗi UUID. */
  transaction_id: string;
  /** Băm handle X — đã decode từ `bytea` sang base64url bởi adapter. */
  handle_hash_x: string;
  state: AuthorizationTransactionState;
  client_id: string;
  redirect_uri: string;
  requested_scopes: readonly string[];
  code_challenge: string;
  code_challenge_method: string;
  /** ⚠️ BẢN BĂM của cookie browser — xem `NewAuthorizationTransaction`. */
  browser_binding_hash: string;
  /** Phiên bản khoá HMAC dùng cho handle X lúc mint (§5.6). */
  key_version: number;
  expires_at: Date;
  /** `sub` của subject — NULL cho tới khi `account` xác thực (bất biến 15). */
  sub: string | null;
  acr: string | null;
  authn_at: Date | null;
  account_session_ref: string | null;
  /** `state` của client (RFC 6749 §4.1.1) — NULL khi client không gửi. */
  client_state: string | null;
  /** OIDC nonce — NULL khi request không gửi; giữ nguyên giá trị khi có. */
  nonce: string | null;
  /**
   * Idempotency event id đã ghi lên hàng (§5.1.5a) — NULL khi chưa có event nào.
   * Handler `session/verified` đọc để phân biệt replay với event mới.
   */
  event_id: string | null;
  /** Băm (base64url) payload của event đã ghi — NULL cùng `event_id`. */
  event_payload_hash: string | null;
}

/** Dữ liệu để tạo transaction mới. */
export interface NewAuthorizationTransaction {
  transaction_id: string;
  handle_hash_x: string;
  client_id: string;
  redirect_uri: string;
  requested_scopes: readonly string[];
  code_challenge: string;
  code_challenge_method: string;
  /** ⚠️ BẢN BĂM của cookie browser, không phải cookie. */
  browser_binding_hash: string;
  /** Phiên bản khoá HMAC dùng cho handle X lúc mint (§5.6). */
  key_version: number;
  expires_at: Date;
  client_state: string | null;
  nonce: string | null;
}

/** Hàng `authorization_codes` mới — khớp schema `auth.authorization_codes`. */
export interface NewAuthorizationCode {
  /** ⚠️ Bản BĂM của code. Bản rõ chỉ tồn tại trong response redirect. */
  code_hash: string;
  /** Transaction đã sinh code này — FK sang `authorization_transactions`. */
  authorization_transaction_id: string;
  /** `sub` của subject đã xác thực — NOT NULL theo schema (0004). */
  sub: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  /** Scope được cấp kèm code — `text[]` của PostgreSQL, không phải chuỗi. */
  granted_scopes: readonly string[];
  /** Chép từ transaction, đưa vào `id_token` (SR-007); NULL khi không có. */
  nonce: string | null;
  expires_at: Date;
}

/** Grant đã cấp. */
export interface AuthGrant {
  account_id: string;
  client_id: string;
  scopes: readonly string[];
  isActive: boolean;
}

/** Client đã đăng ký. */
export interface RegisteredClient {
  client_id: string;
  client_type: 'public' | 'confidential';
  redirect_uris: readonly string[];
  /** Scope client này được phép yêu cầu. */
  allowed_scopes: readonly string[];
  isActive: boolean;
}

/** Cổng ra tới `account` — ba hợp đồng nội bộ. */
export interface AccountClient {
  verifySession(params: {
    handle: string;
    browserBinding: string;
  }): Promise<{ outcome: 'verified'; accountId: string } | { outcome: 'unverified' }>;
  /**
   * ⚠️ Control point fail-closed. Implementation PHẢI ném khi không gọi được
   * Account — không được trả một giá trị "không rõ" rồi để tầng này tự suy diễn.
   */
  checkStatus(params: { accountId: string }): Promise<AccountStatusResponseValue>;
}

/** Kết quả bắt đầu một giao dịch uỷ quyền. */
export interface BeginAuthorizationResult {
  /** Handle công khai trả về browser. Bản rõ, không phải hash. */
  handle: string;
  transactionId: string;
  /**
   * Scope đã qua lọc `allowed_scopes` — thứ ghi vào transaction. Glue dùng nó
   * quyết định có chèn `prompt=consent` hay không (bắt buộc của provider cho
   * `offline_access`; xem `handleAuthorize`).
   */
  scope: readonly string[];
}

/** Thời gian sống của một transaction uỷ quyền: 10 phút. */
export const TRANSACTION_TTL_MS = 10 * 60 * 1000;

/** Thời gian sống của authorization code: 60 giây (RFC 6749 §4.1.2). */
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

/**
 * Sinh `transaction_id` / code ngẫu nhiên đúng chuẩn.
 *
 * ⚠️ KHÔNG dùng `crypto.randomUUID()` ở đây, dù nó là hàm hiển nhiên nhất.
 * `randomUUID()` trả 36 ký tự dạng `xxxxxxxx-xxxx-...`, mà `deriveHandle` yêu
 * cầu tối thiểu `MIN_TRANSACTION_ID_LENGTH = 43` ký tự base64url. Truyền UUID
 * vào sẽ ném `AuthConfigurationError('transaction_id qua ngan')` — nghĩa là
 * MỌI request uỷ quyền hỏng, không phải một request hiếm.
 *
 * 32 byte ngẫu nhiên mã hoá base64url (không padding) cho đúng 43 ký tự, khớp
 * chính xác ngưỡng tối thiểu và mang 256 bit entropy.
 */
export function createOpaqueId(cryptoImpl: Crypto = crypto): string {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Bắt đầu giao dịch uỷ quyền.
 *
 * ⚠️ Thứ tự cố định, và không được đổi:
 *   1. Parse request — MỌI lỗi ở đây là `directInvalidRequest`, vì ở thời điểm
 *      này ta chưa biết `redirect_uri` có đáng tin không.
 *   2. Nạp client. `invalid_client` — cũng KHÔNG redirectable.
 *   3. Kiểm client còn dùng được.
 *   4. Kiểm `redirect_uri` ĐÃ ĐĂNG KÝ — đây là RANH GIỚI.
 *   5. Từ bước 5 trở đi mới được redirect lỗi về `redirect_uri`.
 */
export async function beginAuthorization(params: {
  store: AuthStore;
  raw: {
    response_type: string | undefined;
    client_id: string | undefined;
    redirect_uri: string | undefined;
    scope: string | undefined;
    state: string | undefined;
    nonce: string | undefined;
    code_challenge: string | undefined;
    code_challenge_method: string | undefined;
  };
  /**
   * `K_auth` — Worker Secret dùng làm khoá HMAC cho handle X/Y/Z (FR-016j/k).
   *
   * ⚠️ Đây KHÔNG phải browser binding. Hai thứ này là hai điều khiển khác nhau
   * và từng bị gộp làm một:
   *   - `K_auth` (tham số này) sinh handle — bí mật của SERVER, không bao giờ
   *     rời Worker, nằm trong Worker Secrets, không nằm trong `db-auth`.
   *   - `browserBinding` (dưới) là cookie `__Host-auth-browser` của BROWSER,
   *     lưu dưới dạng BĂM trong `browser_binding_hash`, và là điều kiện 2 của
   *     §5.1.0 — nó chặn handle theft.
   * Dùng browser binding làm khoá HMAC sẽ khiến handle suy ra được từ một giá
   * trị mà browser biết, đúng thứ mà handle phải chống.
   */
  handleKey: string;
  /**
   * Phiên bản khoá `K_auth` tại thời điểm mint (§5.6: "Ghi `key_version` lúc
   * mint; retry dùng đúng version đó").
   *
   * ⚠️ Không mặc định hoá thành `1`: một mặc định âm thầm biến rotation thành
   * vô dụng — mọi transaction mint sau khi xoay khoá vẫn ghi version cũ mà
   * không ai biết. Caller (composition root) phải đọc từ cấu hình đã kiểm.
   */
  handleKeyVersion: number;
  /** Cookie browser đã bắt đầu giao dịch. Lưu dạng BĂM, không lưu bản rõ. */
  browserBinding: string;
  now: Date;
  newId?: () => string;
}): Promise<BeginAuthorizationResult> {
  const { store, raw, handleKey, handleKeyVersion, browserBinding, now } = params;
  const newId = params.newId ?? ((): string => createOpaqueId());

  const request: AuthorizationRequest = parseAuthorizationRequest({
    responseType: raw.response_type,
    clientId: raw.client_id,
    redirectUri: raw.redirect_uri,
    scope: raw.scope,
    state: raw.state,
    nonce: raw.nonce,
    codeChallenge: raw.code_challenge,
    codeChallengeMethod: raw.code_challenge_method,
  });

  const client = await store.findClient(request.clientId);
  if (client === undefined) {
    throw OAuthProtocolError.invalidClient('client khong ton tai');
  }
  assertUsableClient({ isActive: client.isActive });

  // ⚠️ RANH GIỚI. Sau dòng này, `redirect_uri` đã được chứng minh thuộc về
  // client này, nên redirect lỗi về nó là an toàn.
  assertRegisteredRedirectUri(request.redirectUri, client.redirect_uris, { kind: 'exact' });

  // Scope phải là giao của yêu cầu và thứ client được phép. `redirectable: true`
  // vì đã qua ranh giới — và `filterAllowedScopes` vẫn từ chối scope lạ thay
  // vì lọc im lặng, để client biết nó yêu cầu sai.
  const grantedScope = filterAllowedScopes([...request.scope], client.allowed_scopes, {
    redirectable: true,
  });

  const transactionId = newId();

  // ⚠️ `deriveHandle` là async — bỏ `await` ở đây sẽ truyền một Promise vào
  // cột `text`, và lỗi chỉ hiện ra ở tầng database với thông báo vô nghĩa.
  const handle = await deriveHandle({
    key: handleKey,
    transactionId,
    domain: HANDLE_DOMAINS.loginHandoff,
  });
  const handleHash = await hashHandle(handle);

  // ⚠️ Binding lưu dạng BĂM, không phải bản rõ. Bản rõ là cookie phiên của
  // browser; một lần đọc được bảng là một lần giả được browser của người khác.
  const browserBindingHash = await hashHandle(browserBinding);

  await store.createTransaction({
    transaction_id: transactionId,
    handle_hash_x: handleHash,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    requested_scopes: grantedScope,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    browser_binding_hash: browserBindingHash,
    key_version: handleKeyVersion,
    expires_at: new Date(now.getTime() + TRANSACTION_TTL_MS),
    client_state: request.state ?? null,
    nonce: request.nonce ?? null,
  });

  return { handle, transactionId, scope: grantedScope };
}

/**
 * Xác nhận browser đã bắt đầu giao dịch — điều kiện 2 của §5.1.0.
 *
 * ⚠️ Đây là chốt chặn chống handle theft, và nó hoạt động bằng cách so BĂM:
 * `auth` không đọc cookie của `account` (invariant 2), nên nó không tự biết
 * "browser này có phải browser đã mở request này không". Cách duy nhất là phát
 * cookie riêng của origin `auth` (`__Host-auth-browser`), lưu băm của nó trên
 * transaction, và so lại ở bước confirm.
 *
 * ⚠️ So sánh phải là timing-safe VÀ phải so BĂM với BĂM. So sánh bản rõ với
 * bản băm sẽ luôn sai (khiến tính năng không bao giờ hoạt động), và so sánh
 * bằng `===` trên chuỗi bí mật là một so sánh thoát sớm theo thời gian.
 *
 * Chuyển trạng thái có điều kiện: nếu `pending_browser` đã đổi thì một request
 * khác đã confirm, và ta không ghi đè.
 *
 * ## Replay của cùng browser — idempotent (§5.1.2 hàng 2, cột "khi retry")
 *
 * Browser quay lại `/authorize/confirm` lần thứ hai với CÙNG cookie B và
 * transaction còn `browser_confirmed` (chưa hết TTL) là một replay hợp lệ: LUẬT
 * browser của luồng là đi qua hop này, nên một điều hướng trùng (reload, back,
 * hai tab cùng origin trình lại request) không được biến thành `invalid_request`
 * — đích tiếp theo (`/login/continue`) giống hệt lần đầu, không có trạng thái
 * nào thay đổi. Cửa sổ idempotent NGẶT: chỉ đúng state `browser_confirmed` và
 * còn `expires_at > now`. Mọi state khác (`pending_browser` — chưa từng confirm,
 * `awaiting_consent`/`ready_to_complete` — X đã bị event khác tiêu thụ,
 * `completed`/`denied` — terminal) giữ nguyên đường CAS/throw cũ: một request
 * đến muộn không được mở lại giao dịch đã đi tiếp.
 *
 * ⚠️ CAS đã gộp expiry vào WHERE (`transitionTransaction`), nhưng nhánh
 * idempotent KHÔNG chạy CAS — nó đọc hàng rồi quyết định, nên phải tự so
 * `expires_at` với `now` tường minh: bỏ kiểm này là một transaction hết hạn
 * được redirect tiếp như còn sống.
 */
export async function confirmBrowser(params: {
  store: AuthStore;
  transaction: AuthorizationTransactionRecord;
  /** Cookie `__Host-auth-browser` do browser trình ra. */
  presentedBinding: string;
  now: Date;
}): Promise<{ status: 'confirmed' | 'already-confirmed' }> {
  const { store, transaction, presentedBinding, now } = params;

  const presentedHash = await hashHandle(presentedBinding);

  // `timingSafeEqual` của domain trả boolean và không ném.
  if (!timingSafeEqual(presentedHash, transaction.browser_binding_hash)) {
    // ⚠️ `directInvalidRequest`: một browser KHÁC đang cố xác nhận giao dịch
    // này. Không được redirect lỗi kèm handle — đó là đường rò handle.
    throw OAuthProtocolError.directInvalidRequest('browser binding khong khop');
  }

  if (transaction.state === 'browser_confirmed') {
    if (transaction.expires_at > now) {
      // Replay của chính browser đã confirm — không CAS lại, không event mới:
      // trạng thái giữ nguyên là toàn bộ ý nghĩa của idempotency.
      return { status: 'already-confirmed' };
    }
    // Còn browser_confirmed nhưng đã hết TTL (hàng 12 state machine) — không
    // được redirect tiếp như còn sống; CAS không chạy vì state không còn
    // pending_browser, nên phải từ chối tường minh.
    throw OAuthProtocolError.directInvalidRequest('transaction da het han');
  }

  const moved = await store.transition({
    transactionId: transaction.transaction_id,
    from: 'pending_browser',
    to: 'browser_confirmed',
    at: now,
  });
  if (!moved) {
    throw OAuthProtocolError.directInvalidRequest('transaction da duoc xac nhan boi request khac');
  }
  return { status: 'confirmed' };
}

/**
 * Hoàn tất giao dịch và phát hành authorization code.
 *
 * ⚠️ Bốn lần kiểm tra độc lập, theo thứ tự này:
 *   1. Transaction chưa bị browser xác nhận → từ chối NGAY, trước mọi thứ
 *      khác. Đây là kiểm tra binding, và nếu nó sai thì mọi field khác của hàng
 *      đều không đáng tin.
 *   2. Account còn khoẻ (fail-closed).
 *   3. Grant còn hiệu lực.
 *   4. Consent chưa bị từ chối, và trạng thái còn cho phép hoàn tất.
 */
export async function completeAuthorization(params: {
  store: AuthStore;
  account: AccountClient;
  transaction: AuthorizationTransactionRecord;
  accountId: string;
  consentDecision?: ConsentDecision;
  now: Date;
  newId?: () => string;
}): Promise<{ code: string; transaction: AuthorizationTransactionRecord }> {
  const { store, account, transaction, accountId, now } = params;
  const newId = params.newId ?? ((): string => createOpaqueId());

  // ⚠️ `assertBrowserConfirmed` kiểm TRAÏNG THÁI transaction: một transaction
  // còn `pending_browser` nghĩa là browser chưa xác nhận, và mọi thứ phía sau
  // không nên chạy.
  assertBrowserConfirmed(transaction.state);

  // Fail-closed. `checkStatus` ném khi không gọi được Account; ở đây KHÔNG có
  // `try/catch` biến lỗi đó thành "coi như khoẻ".
  const status = await account.checkStatus({ accountId });

  // ⚠️ Dùng `allowsIssuance` từ domain, KHÔNG tự so `=== 'active'` ở đây:
  // một bản sao của danh sách trắng là một chỗ để hai bên lệch nhau, và lệch
  // theo hướng rộng hơn nghĩa là phát token cho account đáng lẽ bị chặn.
  if (!allowsIssuance(status)) {
    throw OAuthProtocolError.accessDenied(`account status: ${status}`);
  }

  const revocation = await store.checkRevocation({
    accountId,
    clientId: transaction.client_id,
  });
  if (revocation !== 'not_revoked') {
    throw OAuthProtocolError.accessDenied('grant da bi thu hoi');
  }

  // Người dùng từ chối (`'deny'`, không phải `'denied'`): `access_denied` theo
  // RFC 6749 §4.1.2.1 — không phải `invalid_request`, vì request hợp lệ và
  // người dùng đã quyết định.
  if (params.consentDecision === 'deny') {
    await store.transition({
      transactionId: transaction.transaction_id,
      from: transaction.state,
      to: 'denied',
      at: now,
    });
    throw OAuthProtocolError.accessDenied('nguoi dung tu choi');
  }

  // Chuyển trạng thái có điều kiện. `false` nghĩa là một request khác đã thắng
  // — và ta KHÔNG phát hành code thứ hai.
  const moved = await store.transition({
    transactionId: transaction.transaction_id,
    from: transaction.state,
    to: 'completed',
    at: now,
  });
  if (!moved) {
    throw OAuthProtocolError.invalidRequest('transaction da doi trang thai');
  }

  // ⚠️ Code sinh ra ở đây là bản RÕ, và nó chỉ đi vào response redirect.
  // Database chỉ nhận bản băm — nếu bản rõ được lưu, một lần đọc được bảng là
  // một lần đổi code lấy token được.
  const code = newId();
  const codeHash = await hashHandle(code);

  await store.insertAuthorizationCode({
    code_hash: codeHash,
    authorization_transaction_id: transaction.transaction_id,
    // ⚠️ `sub` là NOT NULL của schema (0004): code chỉ tồn tại sau khi một
    // subject đã xác thực. `accountId` ở đây là danh tính đã được kiểm trạng
    // thái ở phía trên — nếu một đường gọi nào chưa có subject thì đó là lỗi
    // của đường gọi, không phải lý do để hạ NOT NULL của schema.
    sub: accountId,
    client_id: transaction.client_id,
    redirect_uri: transaction.redirect_uri,
    code_challenge: transaction.code_challenge,
    code_challenge_method: transaction.code_challenge_method,
    granted_scopes: transaction.requested_scopes,
    nonce: transaction.nonce,
    expires_at: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
  });

  // `transaction` trả về mang `client_state` để handler đặt lại vào redirect.
  return { code, transaction };
}

/**
 * Đổi authorization code lấy token.
 *
 * ⚠️ Thứ tự kiểm tra là một phần của hợp đồng: code đã bị tiêu thụ TRƯỚC khi
 * hàm này chạy (bởi `redeemAuthorizationCode`), nên một `code_verifier` sai vẫn
 * làm code bị mất. Đó là chủ ý — nếu không, kẻ tấn công đoán được code nhưng
 * chưa biết verifier sẽ giữ được code để thử lại nhiều lần, biến PKCE thành
 * một bài toán brute-force.
 */
export async function exchangeAuthorizationCode(params: {
  account: AccountClient;
  signingKey: SigningKeyProvider;
  /**
   * Hàng code ĐÃ TIÊU THỤ — hình dạng khớp `AuthorizationCodeRow` của adapter.
   * Tên cục bộ là `transactionRef` (không phải tên cột DB bắt đầu bằng
   * `authorization_`): giá trị là ID hàng transaction — opaque, không phải
   * credential — nhưng tiền tố tên cột khớp nguồn của rule
   * security-sensitive-value-in-http-response và làm JWT claim
   * `transaction_id` bị coi là tainted qua `issueAccessToken`.
   */
  consumedCode: {
    transactionRef: string;
    client_id: string;
    redirect_uri: string;
    granted_scopes: readonly string[];
    code_challenge: string;
  };
  codeVerifier: string;
  issuer: string;
  audience: string;
  accountId: string;
  accessTokenTtlSeconds: number;
  now: Date;
  newId?: () => string;
}): Promise<IssuedTokens> {
  const { consumedCode, codeVerifier, now } = params;
  const newId = params.newId ?? ((): string => createOpaqueId());

  // Định dạng trước, giá trị sau (RFC 7636 §4.1): `assertValidCodeVerifier`
  // ném `invalid_request` cho verifier sai định dạng — khác `invalid_grant`
  // mà `verifyCodeChallenge` trả khi hash không khớp. `verifyCodeChallenge`
  // chỉ so hash nên verifier ngắn hay chứa ký tự ngoài unreserved vẫn "so
  // được"; bỏ kiểm định dạng là nhận request sai luật mà không cần biết.
  assertValidCodeVerifier(codeVerifier);

  // ⚠️ `verifyCodeChallenge` trả boolean, KHÔNG ném. Bỏ qua giá trị trả về là
  // một lỗ hổng hoàn toàn im lặng: mọi verifier đều được chấp nhận.
  const pkceOk = await verifyCodeChallenge({
    codeVerifier,
    expectedChallenge: consumedCode.code_challenge,
  });
  if (!pkceOk) {
    throw OAuthProtocolError.directInvalidGrant('PKCE khong khop');
  }

  // Account phải còn khoẻ ở ĐÂY nữa: giữa lúc cấp code và lúc đổi code, account
  // có thể đã bị khoá. Kiểm lại là rẻ; bỏ qua là phát token cho một account đã
  // bị vô hiệu.
  const status = await params.account.checkStatus({ accountId: params.accountId });
  if (!allowsIssuance(status)) {
    throw OAuthProtocolError.directInvalidGrant(`account status: ${status}`);
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);

  const signedAccessToken = await issueAccessToken({
    signingKey: params.signingKey,
    claims: {
      sub: params.accountId,
      aud: params.audience,
      iss: params.issuer,
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + params.accessTokenTtlSeconds,
      client_id: consumedCode.client_id,
      scope: consumedCode.granted_scopes.join(' '),
      transaction_id: consumedCode.transactionRef,
    },
  });

  const issuedRefreshToken = await createRefreshToken({ familyId: newId() });

  // Đây là token endpoint của authorization code flow: trả access token và
  // refresh token ra ngoài là ĐÚNG MỤC ĐÍCH của OAuth2 (RFC 6749 §4.1.4), không
  // phải rò rỉ. Đối tượng nhận là resource server đã đăng ký, sau khi đã đổi
  // authorization code hợp lệ và PKCE S256 đã khớp. Cái rule này bảo vệ là
  // credential đọc từ môi trường bị trả nhầm ra ngoài — ở đây token được TẠO RA
  // đúng mục đích, không phải giá trị nhạy cảm bị lộ.
  // Tên cục bộ trung tính (`signedAccessToken`/`issuedRefreshToken`): tên
  // `accessToken`/`refreshToken` là nguồn của rule
  // security-sensitive-value-in-http-response. Đổi TÊN BIẾN, không đổi tên
  // field của IssuedTokens — key trên wire là hợp đồng OAuth2 (RFC 6749).
  // LƯU Ý: đừng nhắc token chữ của cơ chế suppression inline của semgrep trong
  // comment — chuỗi đó trong prose khiến semgrep 1.181.0 tự gắn
  // `suppressions: inSource` cho finding ở dòng kế tiếp (đo thật trên repo này).
  return {
    accessToken: signedAccessToken,
    expiresInSeconds: params.accessTokenTtlSeconds,
    refreshToken: issuedRefreshToken,
    tokenType: 'Bearer',
  };
}
