/**
 * Kiểu dữ liệu của lớp UI account.
 *
 * Đây là **hợp đồng giữa UI và adapter**, không phải hợp đồng giữa `account` và
 * `auth`. Mọi trường ở đây hoặc (a) đã có trong tài liệu thiết kế, hoặc (b) là
 * dữ liệu hiển thị thuần tuý lấy từ response của BFF. Không có trường nào được
 * thêm vào chỉ để lấp chỗ trống trên layout — UI không tự đặt ra lĩnh vực hồ sơ
 * mà tài liệu chưa định nghĩa.
 *
 * ⚠️ **Không có kiểu nào cho password.** Ecoma là passwordless; sự vắng mặt của
 * kiểu `PasswordCredential` ở đây là cố ý và là một phần của bất biến sản phẩm.
 */

import type { AccountLocale } from '../i18n/locale-registry';

/** Locale + các trường hiển thị khác của `user_preferences` (`01-architecture.md` §3.3). */
export type ColorMode = 'system' | 'light' | 'dark';

export type AccountPreferences = {
  /**
   * `undefined` khi server trả một giá trị **không** nằm trong allowlist.
   *
   * Không gộp trường hợp này vào `DEFAULT_ACCOUNT_LOCALE`: một giá trị lạ đến từ
   * server là lỗi contract phải nhìn thấy được (FR-008a cấm server fallback im
   * lặng, và UI cũng không được làm điều tương đương ở phía nó). Trường
   * `invalidLocale` mang giá trị thô để thông báo lỗi nói được cái gì sai.
   */
  readonly locale: AccountLocale | undefined;
  /** Giá trị thô server trả về khi `locale` không hợp lệ; `undefined` khi hợp lệ. */
  readonly invalidLocale: string | undefined;
  readonly timezone: string;
  readonly colorMode: ColorMode;
};

/** Hồ sơ — `user_profiles` (`01-architecture.md` §3.2). Chỉ trường đã được tài liệu hoá. */
export type AccountProfile = {
  readonly displayName: string;
  readonly avatarUrl: string | undefined;
};

export type EmailStatus = 'pending' | 'verified';

export type AccountEmail = {
  readonly id: string;
  readonly address: string;
  readonly status: EmailStatus;
  /**
   * Địa chỉ dùng để đăng nhập được — tổng hợp từ `verified`. UI dùng cờ này để
   * **không cho** xoá địa chỉ đã xác minh cuối cùng mà không có thay thế
   * (một địa chỉ `verified` là điều kiện đăng nhập, FR-002). Đây là ràng buộc
   * hiển thị; server vẫn là nơi enforce.
   */
  readonly isSignInAddress: boolean;
};

/** `authenticators` — passkey | TOTP, một bảng với discriminator (§3.2). */
export type Passkey = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
};

export type TotpState = {
  readonly enabled: boolean;
  readonly confirmedAt: string | undefined;
};

export type RecoveryCodesState = {
  /** `undefined` khi chưa sinh mã lần nào. */
  readonly remaining: number | undefined;
};

/** `account_sessions` (`01-architecture.md` §3.2, §4). */
export type AccountSession = {
  readonly id: string;
  readonly device: string;
  readonly location: string | undefined;
  readonly lastSeenAt: string;
  readonly signedInAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
};

/** Grant đã cấp — dữ liệu của `auth`, đọc qua contract, không đọc `db-auth`. */
export type ConnectedApplication = {
  readonly id: string;
  readonly clientName: string;
  readonly grantedAt: string;
  readonly scopes: readonly string[];
  /**
   * Bề mặt rủi ro do contract cung cấp, không do UI suy diễn. UI chỉ render khi
   * contract nói `true`; nó không tự phán một scope là "nguy hiểm".
   */
  readonly highRisk: boolean;
};

export type PrivacyRequestKind = 'export' | 'correct' | 'delete' | 'restrict' | 'object';

export type PrivacyRequestStatus = 'pending' | 'in-progress' | 'completed' | 'rejected';

/** `privacy_requests` (§3.2). */
export type PrivacyRequest = {
  readonly id: string;
  readonly kind: PrivacyRequestKind;
  readonly submittedAt: string;
  readonly dueAt: string;
  readonly status: PrivacyRequestStatus;
};

/** `notification_preferences` — chỉ **ý định**, không phải thiết bị/subscription (§3.4). */
export type NotificationPreferences = {
  readonly serviceEmail: boolean;
  readonly productUpdates: boolean;
  readonly marketing: boolean;
};

/**
 * Chế độ challenge mà `/login` được phép render.
 *
 * ⚠️ Tài liệu **chưa chốt** cơ chế email challenge (email link hay one-time
 * code) — xem `docs/applications/account/01-architecture.md` §12. Vì vậy kiểu này
 * chỉ **mô tả** chế độ mà implementation thật trả về; UI không giả định. Bước
 * nhập code chỉ render khi adapter nói `'code'`.
 */
export type LoginChallengeMode = 'email-link' | 'code';

export type LoginChallenge = {
  readonly email: string;
  readonly mode: LoginChallengeMode;
  readonly expiresAt: string;
};

/**
 * Context hiển thị trên `/consent`.
 *
 * ⚠️ **Mọi trường đều do BFF cấp** qua contract với `auth`
 * (`POST /internal/consent/context`). UI **không** nhận `client_id`,
 * `redirect_uri`, scope, state hay `nonce` từ browser, và **không** dựng URL
 * redirect — `auth` sở hữu authorization transaction và là bên duy nhất tạo
 * redirect cuối (`01-architecture.md` §5, `02-requirements.md` FR-006k,
 * FR-006o). Vì vậy kiểu này cố ý **không có** trường `redirectUri`.
 */
export type ConsentContext = {
  readonly clientName: string;
  /**
   * Scope dạng **đã mô tả để hiển thị** (nhãn + mô tả), không phải mã scope thô:
   * BFF/`auth` là bên quyết định cách diễn giải một scope, UI không tự map mã
   * scope sang câu tiếng người.
   */
  readonly permissions: readonly { readonly label: string; readonly description: string }[];
  readonly highRisk: boolean;
};

/**
 * Kết quả một thao tác ghi.
 *
 * Không dùng `Promise<void>` + throw vì UI cần một đường **thất bại có kiểu**:
 * yêu cầu "không hiện trạng thái thành công bền vững nếu lưu hỏng" chỉ kiểm
 * được nếu adapter buộc call-site xử lý nhánh hỏng.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Adapter dữ liệu account — ranh giới duy nhất giữa UI và dữ liệu, ghép từ
 * **ba trách nhiệm** (`AccountDataPort` + `AuthenticationPort` +
 * `AccountSecurityPort`).
 *
 * ⚠️ Việc tách ba port không phải trang trí kiểu: đó là điều kiện để luật
 * "mock chỉ nằm trên dữ liệu" trở thành **bất biến compile-time**. Adapter mock
 * chỉ hiện thực `PreviewAccountAdapter` (dữ liệu + `isPreview: true`), nên một
 * lệnh spread từ mock vào adapter thật không thể cung cấp phương thức auth hay
 * security — đúng lỗ hổng mà `...mock` cũ tạo ra (bốn phương thức credential
 * chạy bản in-memory ở mode real).
 *
 * Mọi phương thức đọc có thể ném lỗi (UI hiển thị error state); mọi phương thức
 * ghi trả `Result` để nhánh hỏng không bị bỏ qua.
 *
 * ⚠️ **Thao tác ghi của adapter này KHÔNG phải là bằng chứng server đã đổi
 * trạng thái.** Implementation thật gọi BFF với CSRF token; bản preview chỉ đổi
 * state trong bộ nhớ và UI đánh dấu rõ điều đó qua `isPreview`. UI không bao giờ
 * là security boundary: mọi quyết định xác thực/uỷ quyền/session cuối cùng do
 * server enforce.
 */
export type AccountAdapter = AccountDataPort &
  AuthenticationPort &
  AccountSecurityPort & {
    /** `true` khi dữ liệu đến từ mock, để UI hiển thị banner "preview data". */
    readonly isPreview: boolean;
  };

/**
 * Bề mặt adapter preview — thứ duy nhất adapter mock được phép hiện thực.
 *
 * `isPreview: true` là **literal**, không phải `boolean`: hệ thống kiểu tự nói
 * rằng mọi adapter hiện thực kiểu này là adapter dữ liệu giả, và banner preview
 * không thể quên bật.
 */
export type PreviewAccountAdapter = AccountDataPort & {
  readonly isPreview: true;
};

/**
 * Port dữ liệu tài khoản — hồ sơ, email, phiên, ứng dụng đã kết nối,
 * preference, thông báo, privacy request.
 *
 * Đây là **port duy nhất** mock được thay thế: dữ liệu preview là fixture cục
 * bộ, tất định, ephemeral (`docs/architecture/05-code-architecture.md` §5).
 */
export type AccountDataPort = {
  getProfile(): Promise<AccountProfile>;
  updateProfile(input: {
    displayName: string;
    avatarUrl?: string;
  }): Promise<Result<AccountProfile>>;

  listEmails(): Promise<readonly AccountEmail[]>;
  addEmail(address: string): Promise<Result<AccountEmail>>;
  resendVerification(id: string): Promise<Result<void>>;
  removeEmail(id: string): Promise<Result<void>>;

  listSessions(): Promise<readonly AccountSession[]>;
  revokeSession(id: string): Promise<Result<void>>;

  listApplications(): Promise<readonly ConnectedApplication[]>;
  revokeApplication(id: string): Promise<Result<void>>;

  getPreferences(): Promise<AccountPreferences>;
  updatePreferences(patch: Partial<AccountPreferences>): Promise<Result<AccountPreferences>>;

  getNotificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreferences(
    patch: Partial<NotificationPreferences>,
  ): Promise<Result<NotificationPreferences>>;

  listPrivacyRequests(): Promise<readonly PrivacyRequest[]>;
  submitPrivacyRequest(kind: PrivacyRequestKind): Promise<Result<PrivacyRequest>>;
};

/**
 * Port xác thực — challenge, verify OTP, bàn giao session, consent.
 *
 * ⚠️ **Không có implementation mock nào của port này, ở mọi mode** — kể cả
 * preview dưới `nuxt dev` (`docs/architecture/05-code-architecture.md` §5:
 * "auth flows luôn thật"; skill `frontend-data-mocking` §G: auth giữ đường BFF
 * thật ở mọi mode). Hệ quả trải nghiệm: dưới dev preview, `/login` và
 * `/consent` gọi BFF thật và cần auth backend chạy cục bộ; không có backend thì
 * luồng **thất bại trung thực** thay vì diễn một luồng đăng nhập giả.
 */
export type AuthenticationPort = {
  /**
   * Bắt đầu đăng nhập passwordless. Trả **chế độ** challenge để UI quyết định có
   * render bước nhập code hay không — không phải UI tự đoán.
   *
   * `continuationHandle` là opaque handle do `auth` cấp trong `continue_url` và
   * được UI **chuyển tiếp nguyên vẹn**. Đây là call-site **duy nhất** nhận nó:
   * không có tham số nào khác trong ranh giới này mang handle tới nơi khác, nên
   * không có đường nào để nó đi lạch. UI không đọc, không parse, không kiểm tra
   * định dạng, và không dựng URL nào từ nó.
   */
  requestLoginChallenge(
    email: string,
    continuationHandle?: string,
  ): Promise<Result<LoginChallenge>>;
  /**
   * Xác minh mã OTP và nhận URL bước kế tiếp của luồng continuation.
   *
   * `confirmUrl` (khi có) là URL `/authorize/confirm` **do server dựng** tuyệt
   * đối từ cấu hình issuer (ADR-0012: UI không tự ghép chuỗi từ dữ liệu browser
   * hay cấu hình client-side). Vắng mặt nghĩa là không có continuation cấp được:
   * handle không khớp session, chưa cấu hình issuer hay DB không đọc được — UI
   * hiện trạng thái kết thúc thay vì điều hướng. ⚠️ Không log giá trị này.
   */
  verifyLoginCode(code: string): Promise<Result<{ readonly confirmUrl?: string }>>;

  /**
   * Hoàn tất bàn giao về `auth` sau khi mã được chấp nhận (handle `X` từ
   * `?handle=` của `/login`).
   *
   * Trả `continueUrl` khi `auth` quyết định outcome ngay trong response
   * (`granted` ⇒ URL cuối của RP; `consent_required` ⇒ `/consent?handle=Y` của
   * `account`); `already_processed` ⇒ `undefined` (không continuation — phần
   * hợp đồng này được `auth` kiểm theo protocol, UI tôn trọng). Fail (auth
   * chết, result `rejected`…) ⇒ `ok: false` — người dùng retry được, và KHÔNG
   * có đường nào coi "push xong" là "hoàn tất bàn giao" khi chưa có URL.
   *
   * ⚠️ UI relay `continueUrl` bằng cách điều hướng browser; nó không tự ghép
   * chuỗi, không thêm tham số. Handle đi qua đây và KHÔNG được log hay dán vào
   * kiểu dữ liệu nào khác.
   */
  completeHandoff(handle: string): Promise<Result<{ readonly continueUrl: string | undefined }>>;

  /**
   * Đọc consent context cho một authorization request.
   *
   * Nhận opaque handle do BFF cấp; UI **chỉ chuyển tiếp** nó, không diễn giải,
   * không log, không lưu vào storage, không nhét vào link khác. Trả `undefined`
   * khi handle không hợp lệ/hết hạn.
   */
  getConsentContext(handle: string): Promise<ConsentContext | undefined>;

  /**
   * Ghi nhận quyết định consent và nhận URL tiếp theo khi `auth` cấp.
   *
   * `continueUrl` là URL do `auth` dựng; UI relay URL bằng điều hướng browser;
   * nó không tự dựng redirect và không thêm tham số nào. Handle đã bị tiêu thụ
   * sau khi thành công, nên UI không gửi lại nó: thành công của method này là
   * trạng thái chết (terminal), khác với các thao tác ghi retry-able khác.
   */
  decideConsent(
    handle: string,
    decision: 'approve' | 'deny',
  ): Promise<Result<{ readonly continueUrl: string | undefined }>>;
};

/**
 * Năng lực security mà backend thực sự cung cấp — passkey, TOTP, mã khôi phục.
 *
 * Đây là bản đồ **năng lực thật**, không phải cờ UI: `false` nghĩa là BFF chưa
 * có route cho năng lực đó, và UI phải render trạng thái "chưa khả dụng" thay
 * vì bày một hành động chỉ thành công được qua dữ liệu giả.
 */
export type SecurityCapability = 'passkeys' | 'totp' | 'recovery-codes';

export type SecurityCapabilities = Readonly<Record<SecurityCapability, boolean>>;

/**
 * Port security — passkey, TOTP, mã khôi phục MFA.
 *
 * ⚠️ **Không giả thành công.** Khi `securityCapabilities` nói một năng lực chưa
 * có đường backend, phương thức tương ứng **từ chối tường minh**: đọc ném lỗi có
 * chữ ký ổn định, ghi trả `Result` lỗi. Không bao giờ có trạng thái thành công
 * sinh ra mà không có một thao tác backend thật đứng sau (`05-code-architecture.md`
 * §5: no fake success). UI đọc `securityCapabilities` trước để render đúng
 * trạng thái unavailable thay vì bày control chỉ thành công được qua mock.
 */
export type AccountSecurityPort = {
  /** Năng lực thật của backend hôm nay — UI dùng nó để bật/tắt hành động. */
  readonly securityCapabilities: SecurityCapabilities;

  /**
   * Danh sách passkey đã đăng ký. Ném lỗi tường minh khi năng lực chưa có
   * đường backend — không bao giờ trả một danh sách minh hoạ.
   */
  listPasskeys(): Promise<readonly Passkey[]>;
  /** Gỡ một passkey. `ok: false` khi năng lực chưa có đường backend. */
  removePasskey(id: string): Promise<Result<void>>;
  /** Trạng thái TOTP. Ném lỗi tường minh khi năng lực chưa có đường backend. */
  getTotpState(): Promise<TotpState>;
  /** Trạng thái mã khôi phục MFA. Ném lỗi tường minh khi năng lực chưa có đường backend. */
  getRecoveryCodesState(): Promise<RecoveryCodesState>;
};
