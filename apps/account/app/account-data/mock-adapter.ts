/*
 * ⚠️ `no-invalid-void-type` tắt cho file này: `Result<void>` là **hợp đồng**, không
 * phải lựa chọn kiểu. Nhánh `ok` của một thao tác không trả dữ liệu vẫn phải mang
 * một `value`, và `void` là kiểu nói đúng điều đó. Thay bằng `undefined` sẽ tạo
 * `Result<undefined> | Result<AccountProfile>` — rồi mọi call-site phải thu hẹp lại,
 * và `AccountAdapter` (`types.ts`) cũng dùng `Result<void>`, nên mock lệch với
 * interface nó đang hiện thực hoá. Rule cấm `void` ở vị trí khác vẫn bật.
 */
/* oxlint-disable typescript/no-invalid-void-type -- xem giải thích ngay trên */
import type {
  AccountAdapter,
  AccountEmail,
  AccountPreferences,
  AccountProfile,
  AccountSession,
  ConnectedApplication,
  ConsentContext,
  LoginChallenge,
  NotificationPreferences,
  Passkey,
  PrivacyRequest,
  PrivacyRequestKind,
  RecoveryCodesState,
  Result,
  TotpState,
} from './types';

/**
 * Adapter mock — dữ liệu **cục bộ, tất định** để dựng và kiểm UI trước khi hợp
 * đồng BFF thật có mặt.
 *
 * Ba tính chất phải giữ, và chúng là lý do file này tồn tại:
 *
 * 1. **Không giả vờ là server.** Mọi thao tác ghi chỉ đổi state trong bộ nhớ.
 *    `isPreview = true` và banner của shell nói rõ điều đó ở mọi trang — một
 *    người xem preview không thể nhầm dữ liệu này là tài khoản thật đã lưu.
 * 2. **Tất định.** Mọi mốc thời gian là hằng số ISO viết cứng, không `Date.now()`.
 *    UI format bằng `Intl` theo locale + timezone tường minh, nên SSR và client
 *    cho cùng chuỗi. Dùng `new Date()` ở đây sẽ tạo hydration mismatch chỉ vào
 *    những ngày khác nhau — loại lỗi tệ nhất vì nó xuất hiện ở CI muộn.
 * 3. **Thay thế được bằng một dòng.** Factory dưới đây là điểm duy nhất chọn
 *    implementation; đổi sang adapter thật chỉ đổi chỗ này.
 *
 * ⚠️ Không có `fetch`, không có `useFetch`, không có truy cập storage trong file
 * này. Mock cố ý không chạm mạng và không chạm cookie: một mock gọi endpoint
 * thật sẽ biến preview thành một đường ghi dữ liệu ngoài ý muốn.
 */

/** Mốc thời gian cố định cho toàn bộ dữ liệu mock. */
const CLOCK = {
  now: '2026-10-13T09:00:00.000Z',
  sessionSignedIn: '2026-10-12T21:14:00.000Z',
  sessionLastSeen: '2026-10-13T08:52:00.000Z',
  sessionExpires: '2026-11-11T21:14:00.000Z',
  otherSessionSignedIn: '2026-10-08T06:30:00.000Z',
  otherSessionLastSeen: '2026-10-10T17:03:00.000Z',
  otherSessionExpires: '2026-11-07T06:30:00.000Z',
  applicationGranted: '2026-09-02T11:20:00.000Z',
  passkeyCreated: '2026-08-19T07:45:00.000Z',
  privacySubmitted: '2026-10-06T13:05:00.000Z',
} as const;

/**
 * Handle consent hợp lệ của bản mock.
 *
 * Cố ý là một chuỗi **cố định** để preview dùng được, và cố ý **không** giống
 * handle thật: hình dạng opaque của handle thật do `auth` quyết định, và mock
 * không được định hình kiểu dữ liệu mà nó không sở hữu.
 */
export const MOCK_CONSENT_HANDLE = 'mock-consent-handle';

const INITIAL_PROFILE: AccountProfile = {
  displayName: 'Nguyen Van A',
  avatarUrl: undefined,
};

const INITIAL_EMAILS: readonly AccountEmail[] = [
  // Địa chỉ đăng nhập: `isSignInAddress` để UI chặn xoá khi không có thay thế.
  { id: 'email-1', address: 'nguyen.van.a@example.com', status: 'verified', isSignInAddress: true },
  { id: 'email-2', address: 'a.nguyen@example.org', status: 'pending', isSignInAddress: false },
];

const INITIAL_PASSKEYS: readonly Passkey[] = [
  { id: 'passkey-1', name: 'MacBook Pro', createdAt: CLOCK.passkeyCreated },
];

const INITIAL_SESSIONS: readonly AccountSession[] = [
  {
    id: 'session-1',
    device: 'Firefox on macOS',
    location: 'Ho Chi Minh City, VN',
    lastSeenAt: CLOCK.sessionLastSeen,
    signedInAt: CLOCK.sessionSignedIn,
    expiresAt: CLOCK.sessionExpires,
    isCurrent: true,
  },
  {
    id: 'session-2',
    device: 'Safari on iPhone',
    location: 'Ho Chi Minh City, VN',
    lastSeenAt: CLOCK.otherSessionLastSeen,
    signedInAt: CLOCK.otherSessionSignedIn,
    expiresAt: CLOCK.otherSessionExpires,
    isCurrent: false,
  },
];

const INITIAL_APPLICATIONS: readonly ConnectedApplication[] = [
  {
    id: 'app-1',
    clientName: 'Ecoma Docs',
    grantedAt: CLOCK.applicationGranted,
    scopes: ['profile:read', 'email:read'],
    highRisk: false,
  },
  {
    id: 'app-2',
    clientName: 'Third-party analytics',
    grantedAt: CLOCK.applicationGranted,
    scopes: ['profile:read', 'email:read', 'activity:read'],
    // Bề mặt rủi ro **giả định của mock**, không phải ui tự phán. Adapter thật
    // lấy cờ này từ contract.
    highRisk: true,
  },
];

const INITIAL_PRIVACY_REQUESTS: readonly PrivacyRequest[] = [
  {
    id: 'privacy-1',
    kind: 'export',
    submittedAt: CLOCK.privacySubmitted,
    dueAt: '2026-11-05T13:05:00.000Z',
    status: 'in-progress',
  },
];

const INITIAL_PREFERENCES: AccountPreferences = {
  // `undefined` = tài khoản **chưa** lưu locale — đúng trạng thái của một tài khoản
  // mới. Giữ `'en'` ở đây thì sau khi shell nạp (`useAccountShellPreferences`)
  // `stored` luôn có giá trị và luôn thắng cookie: lựa chọn cục bộ của người
  // chưa đăng nhập bị bỏ qua hoàn toàn, và trang `/preferences` không phân biệt
  // được "chưa chọn" với "đã chọn tiếng Anh".
  locale: undefined,
  invalidLocale: undefined,
  timezone: 'Asia/Ho_Chi_Minh',
  colorMode: 'system',
};

const INITIAL_NOTIFICATIONS: NotificationPreferences = {
  serviceEmail: true,
  productUpdates: false,
  marketing: false,
};

/**
 * Context consent của bản mock.
 *
 * `permissions` là nhãn **đã mô tả sẵn** đúng như BFF sẽ cấp — UI không map mã
 * scope sang câu tiếng người, vì việc diễn giải một scope là quyết định của bên
 * sở hữu nó.
 */
const MOCK_CONSENT: ConsentContext = {
  clientName: 'Ecoma Docs',
  permissions: [
    { label: 'Read your profile', description: 'Display name and avatar.' },
    { label: 'Read your email addresses', description: 'Including verification state.' },
    { label: 'Read your activity', description: 'Recent documents you have opened.' },
  ],
  highRisk: true,
};

/** Sinh id tuần tự, tất định — không dùng `crypto.randomUUID()`. */
function makeCounter(prefix: string): () => string {
  let next = 0;
  return (): string => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/**
 * Chế độ challenge của mock.
 *
 * Mặc định `email-link` **không** phải vì tài liệu đã chốt email link, mà vì đó
 * là chế độ không cần thêm bước nhập mã. Test sẽ chạy cả hai nhánh để chứng minh
 * bước nhập code chỉ xuất hiện khi adapter nói `'code'`.
 */
export type MockAdapterOptions = {
  readonly challengeMode?: LoginChallenge['mode'];
  /** Ép một lần đọc preference trả locale lạ, để test đường xử lý lỗi contract. */
  readonly invalidStoredLocale?: string;
  /** Danh sách thao tác ghi luôn thất bại, để test nhánh lỗi và trạng thái không-lưu-được. */
  readonly failWrites?: readonly string[];
};

export function createMockAccountAdapter(options: MockAdapterOptions = {}): AccountAdapter {
  const challengeMode = options.challengeMode ?? 'email-link';
  const failWrites = new Set(options.failWrites ?? []);

  let profile: AccountProfile = INITIAL_PROFILE;
  let emails: AccountEmail[] = [...INITIAL_EMAILS];
  let passkeys: Passkey[] = [...INITIAL_PASSKEYS];
  let sessions: AccountSession[] = [...INITIAL_SESSIONS];
  let applications: ConnectedApplication[] = [...INITIAL_APPLICATIONS];
  let privacyRequests: PrivacyRequest[] = [...INITIAL_PRIVACY_REQUESTS];
  let preferences: AccountPreferences = {
    ...INITIAL_PREFERENCES,
    locale: options.invalidStoredLocale === undefined ? INITIAL_PREFERENCES.locale : undefined,
    invalidLocale: options.invalidStoredLocale,
  };
  let notifications: NotificationPreferences = { ...INITIAL_NOTIFICATIONS };
  const totp: TotpState = { enabled: false, confirmedAt: undefined };
  const recoveryCodes: RecoveryCodesState = { remaining: undefined };

  const nextEmailId = makeCounter('email-mock');
  const nextPrivacyId = makeCounter('privacy-mock');

  /** Nhánh hỏng dùng chung: trả `Result` lỗi thay vì ném. */
  function refuse<T>(operation: string): Result<T> | undefined {
    if (failWrites.has(operation)) {
      return { ok: false, reason: `mock adapter refused "${operation}"` };
    }
    return undefined;
  }

  return {
    isPreview: true,

    getProfile: async (): Promise<AccountProfile> => profile,

    updateProfile: async (input): Promise<Result<AccountProfile>> => {
      const refused = refuse<AccountProfile>('updateProfile');
      if (refused) {
        return refused;
      }
      profile = { displayName: input.displayName, avatarUrl: input.avatarUrl };
      return { ok: true, value: profile };
    },

    listEmails: async (): Promise<readonly AccountEmail[]> => emails,

    addEmail: async (address): Promise<Result<AccountEmail>> => {
      const refused = refuse<AccountEmail>('addEmail');
      if (refused) {
        return refused;
      }
      // Địa chỉ mới luôn `pending`: chưa xác minh thì chưa đăng nhập được (FR-002).
      const created: AccountEmail = {
        id: nextEmailId(),
        address,
        status: 'pending',
        isSignInAddress: false,
      };
      emails = [...emails, created];
      return { ok: true, value: created };
    },

    resendVerification: async (id): Promise<Result<void>> => {
      const refused = refuse<void>('resendVerification');
      if (refused) {
        return refused;
      }
      return emails.some((email) => email.id === id)
        ? { ok: true, value: undefined }
        : { ok: false, reason: 'unknown email' };
    },

    removeEmail: async (id): Promise<Result<void>> => {
      const refused = refuse<void>('removeEmail');
      if (refused) {
        return refused;
      }
      const target = emails.find((email) => email.id === id);
      if (!target) {
        return { ok: false, reason: 'unknown email' };
      }
      // Ràng buộc hiển thị: địa chỉ đăng nhập không xoá được khi chưa có thay
      // thế. Server là nơi enforce thật; mock giữ cùng luật để UI không đi qua
      // một đường mà production sẽ từ chối.
      if (target.isSignInAddress) {
        return { ok: false, reason: 'last sign-in address' };
      }
      emails = emails.filter((email) => email.id !== id);
      return { ok: true, value: undefined };
    },

    listPasskeys: async (): Promise<readonly Passkey[]> => passkeys,

    removePasskey: async (id): Promise<Result<void>> => {
      const refused = refuse<void>('removePasskey');
      if (refused) {
        return refused;
      }
      passkeys = passkeys.filter((passkey) => passkey.id !== id);
      return { ok: true, value: undefined };
    },

    getTotpState: async (): Promise<TotpState> => totp,

    getRecoveryCodesState: async (): Promise<RecoveryCodesState> => recoveryCodes,

    listSessions: async (): Promise<readonly AccountSession[]> => sessions,

    revokeSession: async (id): Promise<Result<void>> => {
      const refused = refuse<void>('revokeSession');
      if (refused) {
        return refused;
      }
      const target = sessions.find((session) => session.id === id);
      if (!target) {
        return { ok: false, reason: 'unknown session' };
      }
      // Session hiện tại không tự thu hồi được: thu hồi nó là đăng xuất, một
      // hành động khác hẳn về hệ quả. UI đưa ra control riêng cho việc đó khi
      // adapter thật có nó; ở đây từ chối thay vì làm nửa vời.
      if (target.isCurrent) {
        return { ok: false, reason: 'current session' };
      }
      sessions = sessions.filter((session) => session.id !== id);
      return { ok: true, value: undefined };
    },

    listApplications: async (): Promise<readonly ConnectedApplication[]> => applications,

    revokeApplication: async (id): Promise<Result<void>> => {
      const refused = refuse<void>('revokeApplication');
      if (refused) {
        return refused;
      }
      applications = applications.filter((application) => application.id !== id);
      return { ok: true, value: undefined };
    },

    getPreferences: async (): Promise<AccountPreferences> => preferences,

    updatePreferences: async (patch): Promise<Result<AccountPreferences>> => {
      const refused = refuse<AccountPreferences>('updatePreferences');
      if (refused) {
        return refused;
      }
      // Trường không gửi giữ nguyên, không reset về default (FR-008e).
      preferences = {
        ...preferences,
        ...patch,
        // `invalidLocale` chỉ mô tả dữ liệu server trả hỏng; một lần ghi hợp lệ
        // làm nó hết hiệu lực.
        invalidLocale: patch.locale === undefined ? preferences.invalidLocale : undefined,
      };
      return { ok: true, value: preferences };
    },

    getNotificationPreferences: async (): Promise<NotificationPreferences> => notifications,

    updateNotificationPreferences: async (patch): Promise<Result<NotificationPreferences>> => {
      const refused = refuse<NotificationPreferences>('updateNotificationPreferences');
      if (refused) {
        return refused;
      }
      notifications = { ...notifications, ...patch };
      return { ok: true, value: notifications };
    },

    listPrivacyRequests: async (): Promise<readonly PrivacyRequest[]> => privacyRequests,

    submitPrivacyRequest: async (kind: PrivacyRequestKind): Promise<Result<PrivacyRequest>> => {
      const refused = refuse<PrivacyRequest>('submitPrivacyRequest');
      if (refused) {
        return refused;
      }
      // Request mới vào trạng thái `pending` — **chưa** hoàn thành. UI hiển thị
      // đúng như vậy; nộp đơn không phải là đã xử lý xong.
      const created: PrivacyRequest = {
        id: nextPrivacyId(),
        kind,
        submittedAt: CLOCK.now,
        dueAt: '2026-11-10T09:00:00.000Z',
        status: 'pending',
      };
      privacyRequests = [...privacyRequests, created];
      return { ok: true, value: created };
    },

    /**
     * ⚠️ `continuationHandle` được nhận và **bỏ qua có chủ đích**. Không lưu vào
     * biến module, không đưa vào message trả về, không `console.log`: một handle
     * nằm lại trong adapter sau khi request kết thúc chính là handle có thể bị lộ
     * qua một log hay một error message về sau. Adapter thật sẽ chuyển nó cho
     * BFF; bản mock không có BFF nên không có chỗ nào đặt nó.
     *
     * Tham số `_continuationHandle` có tiền tố `_` để lint bắt được việc dùng nó
     * nếu ai đó sau này viết thêm mã vào đây mà quên luật này.
     */
    requestLoginChallenge: async (email, _continuationHandle): Promise<Result<LoginChallenge>> => {
      const refused = refuse<LoginChallenge>('requestLoginChallenge');
      if (refused) {
        return refused;
      }
      return {
        ok: true,
        value: { email, mode: challengeMode, expiresAt: '2026-10-13T09:15:00.000Z' },
      };
    },
    verifyLoginCode: async (code): Promise<Result<{ readonly confirmUrl?: string }>> => {
      const refused = refuse<{ readonly confirmUrl?: string }>('verifyLoginCode');
      if (refused) {
        return refused;
      }
      // Mock chấp nhận đúng một mã, và từ chối mọi mã khác — kể cả mã đúng khi
      // chế độ là `email-link`: bước này không tồn tại ở chế độ đó.
      //
      // ⚠️ `confirmUrl` là **object có trường undefined**, không phải `undefined`:
      // hợp đồng nói "mock không có BFF ⇒ không có continuation cấp được" — value
      // vẫn phải có hình dạng đầy đủ của nó để caller đọc `.confirmUrl` an toàn.
      return challengeMode === 'code' && code === '123456'
        ? { ok: true, value: { confirmUrl: undefined } }
        : { ok: false, reason: 'invalid code' };
    },

    /**
     * ⚠️ Mock **không có BFF** — hoàn tất bàn giao không tồn tại ở preview.
     * Trả `{ ok: false }` thay vì tự dựng một `continueUrl` giả: báo trước
     * sẽ chặn đúng đường "coi như đã bàn giao" mà luồng thật phải đi qua auth.
     */
    completeHandoff: async (_handle): Promise<Result<{ continueUrl: string | undefined }>> => ({
      ok: false,
      reason: 'mock adapter: no server handoff in preview',
    }),

    getConsentContext: async (handle): Promise<ConsentContext | undefined> =>
      handle === MOCK_CONSENT_HANDLE ? MOCK_CONSENT : undefined,

    /**
     * ⚠️ `decision` không được đọc: bản mock không có grant nào để cấp hay thu
     * hồi, nên nó chỉ trả về kết quả của việc *ghi nhận* quyết định. Tiền tố `_`
     * là quy ước của repo cho tham số bắt buộc phải có trong chữ ký (interface định
     * nghĩa nó) nhưng implementation này chưa dùng.
     */
    decideConsent: async (
      handle,
      _decision,
    ): Promise<Result<{ continueUrl: string | undefined }>> => {
      const refused = refuse<{ continueUrl: string | undefined }>('decideConsent');
      if (refused) {
        return refused;
      }
      if (handle !== MOCK_CONSENT_HANDLE) {
        return { ok: false, reason: 'unknown consent request' };
      }
      // Mock ghi lại quyết định **chỉ trong bộ nhớ**: không có grant nào được
      // cấp, không có redirect nào được dựng. `continueUrl: undefined` cũng có
      // chủ đích: một mock dựng URL là mock tự chọn đích — điều chỉ `auth`
      // được làm ở luồng thật. UI hiển thị kết quả thành công, không điều hướng.
      return { ok: true, value: { continueUrl: undefined } };
    },
  };
}
