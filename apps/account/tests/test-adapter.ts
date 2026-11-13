/*
 * ⚠️ `no-invalid-void-type` tắt cho file này: `Result<void>` là **hợp đồng**, không
 * phải lựa chọn kiểu — cùng lý do với `mock-adapter.ts`. Nhánh `ok` của một thao
 * tác không trả dữ liệu vẫn phải mang một `value`, và port định nghĩa `Result<void>`;
 * thay bằng `undefined` sẽ lệch hợp đồng mà UI đã xử lý. Rule cấm `void` ở vị trí
 * khác vẫn bật.
 */
/* oxlint-disable typescript/no-invalid-void-type -- xem giải thích ngay trên */
import type {
  AccountAdapter,
  ConsentContext,
  LoginChallenge,
  Passkey,
  RecoveryCodesState,
  Result,
  SecurityCapabilities,
  TotpState,
} from '../app/account-data/types';
import {
  createMockAccountAdapter,
  type MockAdapterOptions,
} from '../app/account-data/mock-adapter';

/**
 * Adapter **dành cho test** — nền dữ liệu là adapter mock của app (fixtures tất
 * định), phủ thêm scripted auth và security để kiểm hành vi UI quanh các port
 * đó. File nằm trong `tests/`, không trong `app/`: nó không bao giờ vào module
 * graph của app, và đúng vì vậy nó được phép "giả" — nhưng chỉ trong phạm vi
 * test, không phải một đường chạy được của production.
 *
 * Phân biệt với adapter preview (`app/account-data/preview-adapter.ts`): adapter
 * preview phục vụ `nuxt dev` với auth **thật**; adapter test phục vụ vitest với
 * auth **scripted** — UI cần một kịch bản ổn định (`'123456'`, handle cố định)
 * để khẳng định chính xác nhánh render nào được đi qua.
 */

/**
 * Handle consent hợp lệ của adapter test.
 *
 * Cố ý cố định để test dùng được, và cố ý **không** giống handle thật: hình dạng
 * opaque của handle thật do `auth` quyết định, test không được định hình kiểu dữ
 * liệu mà nó không sở hữu.
 */
export const TEST_CONSENT_HANDLE = 'test-consent-handle';

/** Context consent do test cung cấp — nhãn đã mô tả sẵn, UI không map mã scope. */
const TEST_CONSENT: ConsentContext = {
  clientName: 'Ecoma Docs',
  permissions: [
    { label: 'Read your profile', description: 'Display name and avatar.' },
    { label: 'Read your email addresses', description: 'Including verification state.' },
    { label: 'Read your activity', description: 'Recent documents you have opened.' },
  ],
  highRisk: true,
};

export type TestAdapterOptions = {
  /**
   * Chế độ challenge mà `requestLoginChallenge` báo cho UI — UI chỉ render bước
   * nhập mã khi adapter nói `'code'`. Mặc định `'email-link'`, chế độ không cần
   * bước nhập mã; test chạy cả hai nhánh để chứng minh UI không tự đoán.
   */
  readonly challengeMode?: LoginChallenge['mode'];
  /** Ép một lần đọc preference trả locale lạ, để test đường xử lý lỗi contract. */
  readonly invalidStoredLocale?: string;
  /** Danh sách thao tác ghi luôn thất bại, để test nhánh lỗi và trạng thái không-lưu-được. */
  readonly failWrites?: readonly string[];
  /**
   * Năng lực security mà adapter test báo — mặc định **đầy đủ** để test tương
   * tác được passkey/TOTP/mã khôi phục; đặt `false` để kiểm trạng thái
   * unavailable của UI (`/security` phải render "chưa khả dụng" thay vì bày
   * control). Chỉ key được nêu mới đổi; phần còn lại giữ `true`.
   */
  readonly securityCapabilities?: Partial<SecurityCapabilities>;
};

/** Fixtures security tất định — nền cho các test tương tác của `/security`. */
const TEST_PASSKEYS: readonly Passkey[] = [
  { id: 'passkey-1', name: 'MacBook Pro', createdAt: '2026-08-19T07:45:00.000Z' },
];

const TEST_TOTP: TotpState = { enabled: false, confirmedAt: undefined };
const TEST_RECOVERY_CODES: RecoveryCodesState = { remaining: undefined };

export function createTestAccountAdapter(options: TestAdapterOptions = {}): AccountAdapter {
  const challengeMode = options.challengeMode ?? 'email-link';
  const failWrites = new Set(options.failWrites ?? []);
  const capabilities: SecurityCapabilities = {
    passkeys: options.securityCapabilities?.passkeys ?? true,
    totp: options.securityCapabilities?.totp ?? true,
    'recovery-codes': options.securityCapabilities?.['recovery-codes'] ?? true,
  };
  let passkeys: readonly Passkey[] = TEST_PASSKEYS;

  /** Nhánh hỏng dùng chung: trả `Result` lỗi thay vì ném. */
  function refuse<T>(operation: string): Result<T> | undefined {
    if (failWrites.has(operation)) {
      return { ok: false, reason: `test adapter refused "${operation}"` };
    }
    return undefined;
  }

  return {
    // Nền dữ liệu là mock của app: 16 phương thức `AccountDataPort`, fixtures
    // tất định, `failWrites` và `invalidStoredLocale` forwarding nguyên vẹn —
    // cùng hành vi mà adapter preview cấp dưới `nuxt dev`.
    ...createMockAccountAdapter({
      invalidStoredLocale: options.invalidStoredLocale,
      failWrites: options.failWrites,
    } satisfies MockAdapterOptions),

    isPreview: true,

    // ── AuthenticationPort (scripted — không bao giờ là đường production) ──

    requestLoginChallenge: async (
      email: string,
      _continuationHandle?: string,
    ): Promise<Result<LoginChallenge>> => {
      const refused = refuse<LoginChallenge>('requestLoginChallenge');
      if (refused) {
        return refused;
      }
      return {
        ok: true,
        value: { email, mode: challengeMode, expiresAt: '2026-10-13T09:15:00.000Z' },
      };
    },

    verifyLoginCode: async (code: string): Promise<Result<{ readonly confirmUrl?: string }>> => {
      const refused = refuse<{ readonly confirmUrl?: string }>('verifyLoginCode');
      if (refused) {
        return refused;
      }
      // Chấp nhận đúng một mã khi mode là `'code'`, và từ chối mọi mã khác — kể
      // cả mã đúng khi mode là `'email-link'`: bước đó không tồn tại ở mode đó.
      //
      // ⚠️ `confirmUrl` là **object có trường undefined**, không phải `undefined`:
      // hợp đồng nói value vẫn phải có hình dạng đầy đủ để caller đọc
      // `.confirmUrl` an toàn.
      return challengeMode === 'code' && code === '123456'
        ? { ok: true, value: { confirmUrl: undefined } }
        : { ok: false, reason: 'invalid code' };
    },

    completeHandoff: async (
      _handle: string,
    ): Promise<Result<{ continueUrl: string | undefined }>> => ({
      ok: false,
      reason: 'test adapter: no server handoff in test harness',
    }),

    getConsentContext: async (handle: string): Promise<ConsentContext | undefined> =>
      handle === TEST_CONSENT_HANDLE ? TEST_CONSENT : undefined,

    decideConsent: async (
      handle: string,
      _decision: 'approve' | 'deny',
    ): Promise<Result<{ continueUrl: string | undefined }>> => {
      const refused = refuse<{ continueUrl: string | undefined }>('decideConsent');
      if (refused) {
        return refused;
      }
      if (handle !== TEST_CONSENT_HANDLE) {
        return { ok: false, reason: 'unknown consent request' };
      }
      // Quyết định được ghi nhận **chỉ trong bộ nhớ test**: không có grant nào
      // được cấp, không có redirect nào được dựng — `continueUrl: undefined` vì
      // URL đích là việc của `auth` ở luồng thật.
      return { ok: true, value: { continueUrl: undefined } };
    },

    // ── AccountSecurityPort (fixtured, có capability gate) ──

    securityCapabilities: capabilities,

    listPasskeys: async (): Promise<readonly Passkey[]> => {
      if (!capabilities.passkeys) {
        throw new Error('passkeys unavailable: no backend capability');
      }
      return passkeys;
    },

    removePasskey: async (id: string): Promise<Result<void>> => {
      if (!capabilities.passkeys) {
        return { ok: false, reason: 'passkeys unavailable: no backend capability' };
      }
      const refused = refuse<void>('removePasskey');
      if (refused) {
        return refused;
      }
      passkeys = passkeys.filter((passkey) => passkey.id !== id);
      return { ok: true, value: undefined };
    },

    getTotpState: async (): Promise<TotpState> => {
      if (!capabilities.totp) {
        throw new Error('totp unavailable: no backend capability');
      }
      return TEST_TOTP;
    },

    getRecoveryCodesState: async (): Promise<RecoveryCodesState> => {
      if (!capabilities['recovery-codes']) {
        throw new Error('recovery codes unavailable: no backend capability');
      }
      return TEST_RECOVERY_CODES;
    },
  };
}
