/*
 * ⚠️ `no-invalid-void-type` tắt cho file này: `Result<void>` là **hợp đồng**,
 * không phải lựa chọn kiểu (cùng lý do với `mock-adapter.ts`).
 */

/**
 * Adapter thật — UI nói chuyện với **server API của chính app account**.
 *
 * ## Ranh giới
 *
 * Đây KHÔNG phải là adapter gọi trực tiếp `auth` hay transactional-mail: mọi
 * request đi tới các route BFF của app (`/api/auth/*`, `/api/consent/*`) trên
 * cùng origin. Envelope HMAC, Service Binding và secret sống ở **server**;
 * browser chỉ có session cookie + CSRF token. UI không bao giờ là security
 * boundary.
 *
 * ## Luồng đã nối
 *
 * - `/login` challenge → `POST /api/auth/challenge` (204 anti-enumeration —
 *   UI không phân biệt hết hạn/lỗi/địa chỉ lạ, mọi nhánh là "đã gửi").
 * - `/login` verify → `POST /api/auth/verify` (session + CSRF cookie).
 * - `/login/continue` handoff → `POST /api/auth/handoff` (push
 *   `/internal/session/verified` về auth; `continueUrl` do auth cấp được relay).
 * - `/consent` context → `POST /api/consent/context`.
 * - `/consent` decide → `POST /api/consent/decide`.
 *
 * ## Security — chưa có đường backend, từ chối tường minh
 *
 * Passkey, TOTP và mã khôi phục **chưa có route BFF**: `securityCapabilities`
 * trả `false` cho cả ba, và bốn phương thức của `AccountSecurityPort` từ chối
 * tường minh (đọc ném lỗi có message ổn định, ghi trả `Result` lỗi) thay vì
 * trả dữ liệu minh hoạ. UI đọc capabilities trước để render trạng thái "chưa
 * khả dụng" — không có hành động nào chỉ thành công được qua dữ liệu giả.
 *
 * ⚠️ Adapter này **không import `mock-adapter.ts`**: ở mode preview (`nuxt dev`)
 * dữ liệu mock được ghép lên adapter thật ở `preview-adapter.ts`, nên artifact
 * production không chứa đường mock nào cho data domain của account.
 *
 * ⚠️ **Không giữ dữ liệu nhạy cảm qua trang**: giá trị cookie đọc b indirectly
 * qua `$fetch` với `credentials: 'include'` (browser tự gắn) và CSRF token
 *(document.cookie). Adapter KHÔNG viết cookies, KHÔNG viết storage.
 */

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
  SecurityCapabilities,
  TotpState,
} from './types';
import { isAccountLocale } from '../i18n/locale-registry';

/**
 * Nhãn hiển thị cho phiên khi server không có dữ liệu client (v1 của
 * `account_sessions` không lưu user-agent/device — xem PR body). Chuỗi trung
 * tính, không bịa dữ liệu: UI vẫn render được hàng mà không nói dối về thiết bị.
 */
const SESSION_DEVICE_PLACEHOLDER = 'Unknown device';

/** Cookie CSRF do verify cấp; browser JS đọc được (không HttpOnly). */
const CSRF_COOKIE_NAME = '__Host-account-csrf';
/** Header double-submit tương ứng. */
const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/** Đọc cookie bằng trình duyệt đúng semantics của document.cookie. */
function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

/** POST JSON với CSRF double-submit nếu có token. */
async function postJson(path: string, body: unknown): Promise<Response> {
  return sendJson('POST', path, body);
}

/** PATCH JSON với cùng double-submit. */
async function patchJson(path: string, body: unknown): Promise<Response> {
  return sendJson('PATCH', path, body);
}

/** DELETE (body rỗng) với cùng double-submit. */
async function deleteJson(path: string): Promise<Response> {
  return sendJson('DELETE', path, undefined);
}

/**
 * Gửi JSON với CSRF double-submit nếu có token.
 *
 * ⚠️ GET KHÔNG đi qua đây: route đọc không nhận CSRF check ở server (double-
 * submit chỉ là защиты mutation), và fetch GET mặc định đủ.
 */
async function sendJson(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
): Promise<Response> {
  const csrf = readCsrfToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrf !== undefined) {
    headers[CSRF_HEADER_NAME] = csrf;
  }
  return fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
}

/** GET JSON — mọi route đọc của BFF trả JSON hoặc ném 401/5xx. */
async function getJson(path: string): Promise<Response> {
  return fetch(path, { credentials: 'same-origin' });
}

/**
 * Lỗi transport chung của mọi phương thức dữ liệu — message nói đúng mức
 * contract của adapter: method + đường + status. Không nêu detail nào của body
 * lỗi (route lỗi của BFF là một dòng chung chung; adapter không diễn giải thêm).
 */
function requestFailed(operation: string, status: number): string {
  return `${operation} failed with ${status}`;
}

/**
 * Lỗi transport của thao tác **ghi** khi fetch bị từ chối (mạng đứt, BFF chết).
 * Ghi trả `Result` — hợp đồng port nói `Result` là kênh thất bại duy nhất của
 * ghi (mục đích của chính `Result`: "nhánh hỏng không bị bỏ qua") — nên một
 * rejection không được phép thoát ra ngoài handler của trang: handler ghi chỉ
 * bắt `Result`, một throw lọt qua là unhandled rejection không trạng thái nào.
 * Message giữ đúng hình dạng `requestFailed`.
 */
function writeTransportFailed(operation: string): string {
  return `${operation} failed with network error`;
}

/** Đọc JSON body của một response, `undefined` khi body không phải JSON. */
async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

/** TTL của OTP đo từ phía server (OTP_TTL_SECONDS = 600); UI chỉ hiển thị. */
const OTP_TTL_UI_SECONDS = 600;

/**
 * Adapter thật — mọi phương thức của cả ba port đều nối BFF thật hoặc từ chối
 * tường minh, không mượn gì từ mock.
 *
 * Dữ liệu tài khoản và auth đi qua các route BFF đã liệt kê ở đầu file; security
 * chưa có route nên từ chối rõ ràng (xem phần "Security"). Không có tham số
 * tuỳ chỉnh: một adapter thật không có "chế độ mock bên trong" — dữ liệu preview
 * được ghép ở {@link createPreviewAccountAdapter}, không ở đây.
 */
export function createServerAccountAdapter(): AccountAdapter {
  /**
   * Email đang chờ verify của phiên — holder nội bộ, không storage. Khai báo
   * trong closure của factory (không module-level): trên SSR factory chạy
   * **mỗi request một lần**, trên client mỗi tab một instance — phạm vi của
   * biến đúng bằng phạm vi sống của một "phiên adapter". Ở module-level, hai
   * request SSR đồng thời sẽ dùng chung biến — rò email/handle giữa hai
   * người dùng, đúng thứ invariant 12 cấm.
   *
   * Không `useState`, không `localStorage` — chạm storage là đường "lưu thông
   * tin xác thực" mà `01-architecture.md` §4 của app account không cho (chỉ
   * lưu hash session ở server).
   */
  let pendingLoginEmail: string | undefined;

  /**
   * Continuation handle đang chờ verify của phiên — cùng lớp giữ với
   * `pendingLoginEmail` (closure, không storage): `challenge` nhớ nó khi UI
   * gửi vào, `verify` forward cho BFF để server so binding và dựng
   * `confirmUrl`. Không giữ ở đây thì BFF không bao giờ thấy handle ⇒ verify
   * luôn rơi nhánh `no_continuation` dù issuer đã cấu hình đúng.
   */
  let pendingContinuationHandle: string | undefined;

  return {
    /**
     * `false` literal — mọi thứ adapter này trả về đến từ BFF thật hoặc là một
     * refusal tường minh. Banner "preview data" chỉ dành cho dữ liệu mock của
     * `preview-adapter.ts`, vốn ghép fixtures lên adapter này dưới `nuxt dev`.
     */
    isPreview: false,

    /**
     * Luồng challenge làm một request thật; response luôn `204` bất kể kết quả
     * gửi mail. Adapter dựng `LoginChallenge` **từ TTL hợp đồng** — đây là dữ
     * liệu hiển thị duy nhất cho phản hồi 204 và không phải là kết quả mock:
     * mode `'code'` là mode của luồng thật (email-link chưa nối ở server).
     *
     * ⚠️ Không có cách nào cho UI phân biệt "địa chỉ không tồn tại" ra khỏi
     * "đã gửi" — route là anti-enumeration, và UI,vì thế,từ chối đường nào đó vì nó: mọi
     * request thành công đều được hiện như một challenge đã gửi.
     *
     * Handle continuation đi **vào body** của request (FR-006c: binding được
     * ghi tại bước challenge): server cần nó để ghi `login_handoffs` cho
     * session trình X. Nó KHÔNG đi vào URL — trên URL thì handle lọt vào
     * access log, `Referer` và lịch sử proxy.
     */
    requestLoginChallenge: async (
      email: string,
      continuationHandle?: string,
    ): Promise<Result<LoginChallenge>> => {
      // Handle opaque, hình dạng tối thiểu ở server — adapter chỉ forward.
      const response = await postJson('/api/auth/challenge', {
        email,
        ...(continuationHandle === undefined ? {} : { handle: continuationHandle }),
      });
      if (!response.ok) {
        // 400 (body sai hình dạng) hoặc 503 (config/DB chết) — hiển thị lỗi
        // chung; không phân biệt detail ra UI.
        return { ok: false, reason: `challenge request failed with ${response.status}` };
      }
      // Nhớ email cho bước verify trong cùng phiên — xem `pendingLoginEmail`.
      pendingLoginEmail = email;
      // Handle đi cùng challenge (opaque) — verify kế forward cho BFF.
      pendingContinuationHandle = continuationHandle;
      const expiresAt = new Date(Date.now() + OTP_TTL_UI_SECONDS * 1000).toISOString();
      return { ok: true, value: { email, mode: 'code', expiresAt } };
    },

    /**
     * Verify với một mã từ UI. Email được nhớ từ lần challenge gần nhất trong
     * phiên của adapter (module-local của nuxtApp, không storage) — cùng lớp
     * giữ với email UI state.
     *
     * ⚠️ Verify yêu cầu email từ UI mock hiện tại; điều đó nghĩa là một trang
     * đã reload giữa chừng (adapter mất email đang chờ) là một phiên lỗi, UI
     * bắt người dùng phải yêu cầu challenge mới. Đây là một tình huống thật
     * (tải lại trang) mà chi phí sửa là thay đổi hợp đồng bên server-side —
     * out of scope cho PR này (tài liệu hóa trong PR handoff).
     */
    verifyLoginCode: async (code: string): Promise<Result<{ readonly confirmUrl?: string }>> => {
      const email = pendingLoginEmail;
      if (email === undefined) {
        // Không có challenge nào được yêu cầu từ phiên này (ví dụ vừa reload
        // trang) — UI phải yêu cầu challenge mới; không có đường nào verify
        // mà không có email.
        return { ok: false, reason: 'no challenge requested' };
      }
      const response = await postJson('/api/auth/verify', {
        email,
        code,
        // Handle của flow continuation — thiếu nó là BFF không so được binding
        // và không cấp `confirmUrl` (§5.1.2 hàng 7); đăng nhập thuần không gửi.
        ...(pendingContinuationHandle === undefined ? {} : { handle: pendingContinuationHandle }),
      });
      if (!response.ok) {
        return { ok: false, reason: `verify request failed with ${response.status}` };
      }
      // Mã đã dùng — xỉa email pending cho lần verify kế (rotation là luồng
      // bình thường, một verify mới bắt đầu từ một challenge mới).
      pendingLoginEmail = undefined;
      pendingContinuationHandle = undefined;
      // `confirmUrl` do server dựng (`/authorize/confirm` của auth) — adapter
      // chỉ relay giá trị có hình dạng chuỗi, mọi thứ khác là "không có".
      const body: unknown = await response.json().catch(() => undefined);
      const confirmUrl =
        typeof (body as { confirmUrl?: unknown } | null)?.confirmUrl === 'string'
          ? ((body as { confirmUrl: string }).confirmUrl as string)
          : undefined;
      return { ok: true, value: { confirmUrl } };
    },

    /**
     * Push `/internal/session/verified` qua BFF để hoàn tất continuation.
     */
    completeHandoff: async (
      handle: string,
    ): Promise<Result<{ continueUrl: string | undefined }>> => {
      const response = await postJson('/api/auth/handoff', { handle });
      if (response.status === 401) {
        // Session chấm dứt giữa chừng — UI đưa về luồng login từ đầu.
        return { ok: false, reason: 'session not active' };
      }
      if (!response.ok) {
        return { ok: false, reason: `handoff request failed with ${response.status}` };
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (typeof body !== 'object' || body === null || !(body as { ok?: unknown }).ok) {
        return { ok: false, reason: 'handoff response unreadable' };
      }
      const candidate = body as {
        ok?: boolean;
        reason?: string;
        continueUrl?: string;
      };
      if (!candidate.ok) {
        return { ok: false, reason: candidate.reason ?? 'handoff rejected' };
      }
      return { ok: true, value: { continueUrl: candidate.continueUrl } };
    },

    /**
     * Consent context qua BFF. Trả `undefined` cho mọi lỗi — nhánh `empty`
     * của `/consent` không phân biệt lý do, giống như luồng thật không phân
     * biệt "handle lạ" với "handle hết hạn" (không oracle thêm).
     */
    getConsentContext: async (handle: string): Promise<ConsentContext | undefined> => {
      const response = await postJson('/api/consent/context', { handle });
      if (!response.ok) {
        return undefined;
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (typeof body !== 'object' || body === null) {
        return undefined;
      }
      const candidate = body as {
        ok?: unknown;
        clientName?: unknown;
        permissions?: unknown;
        highRisk?: unknown;
      };
      if (
        candidate.ok !== true ||
        typeof candidate.clientName !== 'string' ||
        candidate.clientName === '' ||
        !Array.isArray(candidate.permissions)
      ) {
        return undefined;
      }
      // Shape từng permission do server dựng — chỉ relay.
      const permissions = candidate.permissions
        .filter(
          (entry): entry is { label: string; description: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { label?: unknown }).label === 'string' &&
            typeof (entry as { description?: unknown }).description === 'string',
        )
        .map((entry) => ({ label: entry.label, description: entry.description }));
      if (permissions.length === 0) {
        return undefined;
      }
      return {
        clientName: candidate.clientName,
        permissions,
        highRisk: candidate.highRisk === true,
      };
    },

    /**
     * Consent decide qua BFF; `continueUrl` được relay (UI điều hướng browser)
     * khi có.
     */
    decideConsent: async (
      handle: string,
      decision: 'approve' | 'deny',
    ): Promise<Result<{ continueUrl: string | undefined }>> => {
      const response = await postJson('/api/consent/decide', { handle, decision });
      if (response.status === 401) {
        return { ok: false, reason: 'session not active' };
      }
      if (!response.ok) {
        return { ok: false, reason: `decide request failed with ${response.status}` };
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (typeof body !== 'object' || body === null) {
        return { ok: false, reason: 'decide response unreadable' };
      }
      const candidate = body as {
        ok?: unknown;
        reason?: unknown;
        continueUrl?: unknown;
      };
      if (candidate.ok !== true) {
        return {
          ok: false,
          reason:
            typeof candidate.reason === 'string' && candidate.reason !== ''
              ? candidate.reason
              : 'decide rejected',
        };
      }
      return {
        ok: true,
        value: {
          continueUrl:
            typeof candidate.continueUrl === 'string' ? candidate.continueUrl : undefined,
        },
      };
    },

    /**
     * Security port — chưa có route BFF cho passkey/TOTP/mã khôi phục, nên cả
     * ba năng lực là `false` và bốn phương thức **từ chối tường minh**:
     *
     * - Đọc (`listPasskeys`, `getTotpState`, `getRecoveryCodesState`) ném lỗi
     *   có message ổn định — UI bắt nó và hiển thị trạng thái unavailable;
     *   message là chữ ký contract, không đổi tuỳ ý.
     * - Ghi (`removePasskey`) trả `Result` lỗi — không bao giờ `ok: true` mà
     *   không có một thao tác backend thật đứng sau (no fake success,
     *   `05-code-architecture.md` §5).
     *
     * Khi BFF có route cho một năng lực, bật nó nghĩa là đổi capability thành
     * `true` **và** hiện thực method bằng đường thật — một trong hai đổi một
     * mình là regression (bảng điều khiển bật hành động không có backend, hoặc
     * capability nói dối về năng lực).
     */
    securityCapabilities: {
      passkeys: false,
      totp: false,
      'recovery-codes': false,
    } satisfies SecurityCapabilities,

    listPasskeys: async (): Promise<readonly Passkey[]> => {
      throw new Error('passkeys unavailable: no backend capability');
    },

    removePasskey: async (): Promise<Result<void>> => ({
      ok: false,
      reason: 'passkeys unavailable: no backend capability',
    }),

    getTotpState: async (): Promise<TotpState> => {
      throw new Error('totp unavailable: no backend capability');
    },

    getRecoveryCodesState: async (): Promise<RecoveryCodesState> => {
      throw new Error('recovery codes unavailable: no backend capability');
    },

    /**
     * Đọc profile thật (`GET /api/profile`). `profile: null` → profile rỗng
     * ("chưa nhập lần nào" là trạng thái hợp lệ, không phải lỗi); 401 → ném
     * (UI phải đưa về luồng login; cùng hợp đồng với mọi method đọc).
     */
    getProfile: async (): Promise<AccountProfile> => {
      const response = await getJson('/api/profile');
      if (!response.ok) {
        throw new Error(requestFailed('profile read', response.status));
      }
      const body = (await readJsonBody(response)) as
        | { profile?: { displayName?: unknown; avatarUrl?: unknown } | null }
        | undefined;
      if (body === undefined) {
        // 200 không đọc được body là lỗi đọc, không phải profile rỗng.
        throw new Error(requestFailed('profile read', response.status));
      }
      const profile = body.profile;
      // `avatarUrl: null` của server ↔ `undefined` của hợp đồng UI ("không có").
      return {
        displayName: typeof profile?.displayName === 'string' ? profile.displayName : '',
        avatarUrl: typeof profile?.avatarUrl === 'string' ? profile.avatarUrl : undefined,
      };
    },

    /**
     * Ghi profile thật (`PATCH /api/profile`, partial). Trả `Result` — 400 sai
     * hình dạng là lỗi nghiệp vụ caller tự sửa được, không phải exception.
     */
    updateProfile: async (input): Promise<Result<AccountProfile>> => {
      let response: Response;
      try {
        response = await patchJson('/api/profile', {
          displayName: input.displayName,
          ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
        });
      } catch {
        return { ok: false, reason: writeTransportFailed('profile update') };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('profile update', response.status) };
      }
      const body = (await readJsonBody(response)) as
        | { profile?: { displayName?: unknown; avatarUrl?: unknown } | null }
        | undefined;
      if (body === undefined) {
        // 200 với body không đọc được là lỗi, không phải "profile rỗng" — chỉ
        // `profile: null` của JSON hợp lệ mới là trạng thái chưa-có-dữ-liệu.
        return { ok: false, reason: requestFailed('profile update', response.status) };
      }
      return {
        ok: true,
        value: {
          displayName:
            typeof body.profile?.displayName === 'string' ? body.profile.displayName : '',
          avatarUrl:
            typeof body.profile?.avatarUrl === 'string' ? body.profile.avatarUrl : undefined,
        },
      };
    },

    /** Danh sách email thật (`GET /api/emails`) — địa chỉ đã mask ở server. */
    listEmails: async (): Promise<readonly AccountEmail[]> => {
      const response = await getJson('/api/emails');
      if (!response.ok) {
        throw new Error(requestFailed('email list', response.status));
      }
      const body = (await readJsonBody(response)) as { emails?: unknown } | undefined;
      if (body === undefined || !Array.isArray(body.emails)) {
        throw new Error(requestFailed('email list', response.status));
      }
      // `AccountEmailView` của server có `isSignIn` (không phải
      // `isSignInAddress`) và một trạng thái `revoked` mà hợp đồng UI không có
      // — map tường minh ở đây; hàng `revoked` bị lọc khỏi hiển thị (trạng
      // thái đó không có nghĩa hiển thị trong hợp đồng UI hiện tại).
      const mapped: AccountEmail[] = [];
      for (const entry of body.emails) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }
        const row = entry as {
          id?: unknown;
          address?: unknown;
          status?: unknown;
          isSignIn?: unknown;
        };
        if (
          typeof row.id !== 'string' ||
          typeof row.address !== 'string' ||
          (row.status !== 'pending' && row.status !== 'verified')
        ) {
          continue;
        }
        mapped.push({
          id: row.id,
          address: row.address,
          status: row.status,
          isSignInAddress: row.isSignIn === true,
        });
      }
      return mapped;
    },

    /** Thêm email (`POST /api/emails`) — anti-enumeration: mọi nhánh là 200. */
    addEmail: async (address): Promise<Result<AccountEmail>> => {
      let response: Response;
      try {
        response = await postJson('/api/emails', { email: address });
      } catch {
        return { ok: false, reason: writeTransportFailed('email add') };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('email add', response.status) };
      }
      const body = (await readJsonBody(response)) as { email?: unknown } | undefined;
      if (body === undefined) {
        // 200 không đọc được body **khác** với nhánh im lặng `email: null` của
        // route (anti-enumeration — đã tồn tại/suppressed): JSON rỗng/không đọc
        // được thì không có gì để dựng placeholder, trả lỗi thay vì bịa hàng.
        return { ok: false, reason: requestFailed('email add', response.status) };
      }
      const row =
        typeof body.email === 'object' && body.email !== null
          ? (body.email as {
              id?: unknown;
              address?: unknown;
              status?: unknown;
              isSignIn?: unknown;
            })
          : undefined;
      if (
        row === undefined ||
        typeof row.id !== 'string' ||
        typeof row.address !== 'string' ||
        (row.status !== 'pending' && row.status !== 'verified')
      ) {
        // Nhánh im lặng của route (`email: null`) — suppressed/đã tồn tại/đã
        // owned. UI hiện "đã thêm, chờ verify" như mọi nhánh khác: không có
        // hàng thật để render, dựng hàng placeholder pending.
        return {
          ok: true,
          value: { id: '', address, status: 'pending', isSignInAddress: false },
        };
      }
      return {
        ok: true,
        value: {
          id: row.id,
          address: row.address,
          status: row.status,
          isSignInAddress: row.isSignIn === true,
        },
      };
    },

    /** Cấp lại mã verify (`POST /api/emails/:id/resend`) — im lặng 200 mọi nhánh. */
    resendVerification: async (id): Promise<Result<void>> => {
      let response: Response;
      try {
        response = await postJson(`/api/emails/${encodeURIComponent(id)}/resend`, {});
      } catch {
        return { ok: false, reason: writeTransportFailed('email resend') };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('email resend', response.status) };
      }
      return { ok: true, value: undefined };
    },

    /**
     * Gỡ email (`DELETE /api/emails/:id`). 400 `last_verified_email` là lỗi
     * nghiệp vụ UI cần hiện đúng lý do (không cho gỡ địa chỉ đăng nhập cuối);
     * mọi 400 khác là sai hình dạng id — không xảy ra với id lấy từ list.
     */
    removeEmail: async (id): Promise<Result<void>> => {
      let response: Response;
      try {
        response = await deleteJson(`/api/emails/${encodeURIComponent(id)}`);
      } catch {
        return { ok: false, reason: writeTransportFailed('email remove') };
      }
      if (response.status === 400) {
        const detail = (await readJsonBody(response)) as { statusMessage?: unknown } | undefined;
        if (detail?.statusMessage === 'last_verified_email') {
          return { ok: false, reason: 'last sign-in address' };
        }
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('email remove', response.status) };
      }
      return { ok: true, value: undefined };
    },

    /**
     * Danh sách phiên thật (`GET /api/sessions`) — `id` là digest công khai.
     *
     * ⚠️ **v1 placeholder (quyết định ghi trong PR body)**: hợp đồng UI yêu cầu
     * `device`/`signedInAt`, nhưng schema `account_sessions` của BFF không lưu
     * user-agent hay thời điểm đăng nhập — các giá trị đó không tồn tại ở
     * server. Adapter điền nhãn trung tính và suy `signedInAt` từ `createdAt`
     * (thời điểm gần đúng nhất DB biết), không bịa dữ liệu ngoài phản hồi.
     */
    listSessions: async (): Promise<readonly AccountSession[]> => {
      const response = await getJson('/api/sessions');
      if (!response.ok) {
        throw new Error(requestFailed('session list', response.status));
      }
      const body = (await readJsonBody(response)) as { sessions?: unknown } | undefined;
      if (body === undefined || !Array.isArray(body.sessions)) {
        throw new Error(requestFailed('session list', response.status));
      }
      const mapped: AccountSession[] = [];
      for (const entry of body.sessions) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }
        const row = entry as {
          id?: unknown;
          createdAt?: unknown;
          lastSeenAt?: unknown;
          expiresAt?: unknown;
          isCurrent?: unknown;
        };
        if (
          typeof row.id !== 'string' ||
          typeof row.createdAt !== 'string' ||
          typeof row.lastSeenAt !== 'string' ||
          typeof row.expiresAt !== 'string'
        ) {
          continue;
        }
        mapped.push({
          id: row.id,
          device: SESSION_DEVICE_PLACEHOLDER,
          location: undefined,
          lastSeenAt: row.lastSeenAt,
          signedInAt: row.createdAt,
          expiresAt: row.expiresAt,
          isCurrent: row.isCurrent === true,
        });
      }
      return mapped;
    },

    /**
     * Thu hồi phiên (`DELETE /api/sessions/:id`). 404 — phiên không còn sống
     * (đã revoked/hết hạn) — là idempotent success: trạng thái cuối client
     * muốn đã đạt, cùng tinh thần với revokeApplication.
     */
    revokeSession: async (id): Promise<Result<void>> => {
      let response: Response;
      try {
        response = await deleteJson(`/api/sessions/${encodeURIComponent(id)}`);
      } catch {
        return { ok: false, reason: writeTransportFailed('session revoke') };
      }
      if (response.status === 404) {
        return { ok: true, value: undefined };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('session revoke', response.status) };
      }
      return { ok: true, value: undefined };
    },

    /**
     * Ứng dụng đã kết nối (`GET /api/applications`) — qua contract với auth.
     * `highRisk` không có trong contract v1 của danh sách grant (rủi ro là
     * bề mặt của CONSENT, không phải của grant đã cấp) — luôn `false`, UI chỉ
     * render khi cờ nói vậy. `grantedAt` ISO từ epoch ms của contract.
     */
    listApplications: async (): Promise<readonly ConnectedApplication[]> => {
      const response = await getJson('/api/applications');
      if (!response.ok) {
        throw new Error(requestFailed('application list', response.status));
      }
      const body = (await readJsonBody(response)) as { applications?: unknown } | undefined;
      if (body === undefined || !Array.isArray(body.applications)) {
        throw new Error(requestFailed('application list', response.status));
      }
      const mapped: ConnectedApplication[] = [];
      for (const entry of body.applications) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }
        const row = entry as {
          id?: unknown;
          clientName?: unknown;
          grantedAt?: unknown;
          scopes?: unknown;
        };
        if (
          typeof row.id !== 'string' ||
          typeof row.clientName !== 'string' ||
          typeof row.grantedAt !== 'string' ||
          !Array.isArray(row.scopes) ||
          !row.scopes.every((scope) => typeof scope === 'string')
        ) {
          continue;
        }
        mapped.push({
          id: row.id,
          clientName: row.clientName,
          grantedAt: row.grantedAt,
          scopes: row.scopes,
          highRisk: false,
        });
      }
      return mapped;
    },

    /** Thu hồi ứng dụng (`DELETE /api/applications/:id`) — proxy qua auth. */
    revokeApplication: async (id): Promise<Result<void>> => {
      let response: Response;
      try {
        response = await deleteJson(`/api/applications/${encodeURIComponent(id)}`);
      } catch {
        return { ok: false, reason: writeTransportFailed('application revoke') };
      }
      if (response.status === 404) {
        // Đã revoked hoặc không còn — trạng thái cuối client muốn đã đạt.
        return { ok: true, value: undefined };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('application revoke', response.status) };
      }
      return { ok: true, value: undefined };
    },

    /**
     * Preference thật (`GET /api/preferences`). `preferences: null` → trạng
     * thái "chưa cấu hình": hợp đồng UI (`locale: undefined`,
     * `invalidLocale: undefined`) là đúng — UI hiện form chọn locale. Server
     * chỉ trả locale trong allowlist (PATCH chặn trước), nhưng GUI vẫn kiểm qua
     * `isAccountLocale`: một giá trị lạ đọc ra là contract error phải nhìn thấy
     * được qua `invalidLocale` (FR-008a), không phải fallback im lặng.
     */
    getPreferences: async (): Promise<AccountPreferences> => {
      const response = await getJson('/api/preferences');
      if (!response.ok) {
        throw new Error(requestFailed('preferences read', response.status));
      }
      const body = (await readJsonBody(response)) as { preferences?: unknown } | undefined;
      if (body === undefined) {
        throw new Error(requestFailed('preferences read', response.status));
      }
      const row =
        typeof body.preferences === 'object' && body.preferences !== null
          ? (body.preferences as { locale?: unknown; timezone?: unknown; colorMode?: unknown })
          : undefined;
      if (row === undefined) {
        return {
          locale: undefined,
          invalidLocale: undefined,
          timezone: 'Asia/Ho_Chi_Minh',
          colorMode: 'system',
        };
      }
      const locale = typeof row.locale === 'string' ? row.locale : undefined;
      const timezone = typeof row.timezone === 'string' ? row.timezone : 'Asia/Ho_Chi_Minh';
      const colorMode =
        row.colorMode === 'light' || row.colorMode === 'dark' ? row.colorMode : 'system';
      if (locale === undefined || !isAccountLocale(locale)) {
        return { locale: undefined, invalidLocale: locale, timezone, colorMode };
      }
      return { locale, invalidLocale: undefined, timezone, colorMode };
    },

    /** Partial update preference (`PATCH /api/preferences`). */
    updatePreferences: async (patch): Promise<Result<AccountPreferences>> => {
      let response: Response;
      try {
        response = await patchJson('/api/preferences', patch);
      } catch {
        return { ok: false, reason: writeTransportFailed('preferences update') };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('preferences update', response.status) };
      }
      // Route trả hàng sau ghi — parse bằng cùng luật đọc ở trên.
      const body = (await readJsonBody(response)) as { preferences?: unknown } | undefined;
      if (body === undefined) {
        return { ok: false, reason: requestFailed('preferences update', response.status) };
      }
      const row =
        typeof body.preferences === 'object' && body.preferences !== null
          ? (body.preferences as { locale?: unknown; timezone?: unknown; colorMode?: unknown })
          : undefined;
      const locale = typeof row?.locale === 'string' ? row.locale : undefined;
      const timezone = typeof row?.timezone === 'string' ? row.timezone : 'Asia/Ho_Chi_Minh';
      const colorMode =
        row?.colorMode === 'light' || row?.colorMode === 'dark' ? row.colorMode : 'system';
      return {
        ok: true,
        value:
          locale === undefined || !isAccountLocale(locale)
            ? { locale: undefined, invalidLocale: locale, timezone, colorMode }
            : { locale, invalidLocale: undefined, timezone, colorMode },
      };
    },

    /** Ý định nhận thông báo (`GET /api/notifications`). */
    getNotificationPreferences: async (): Promise<NotificationPreferences> => {
      const response = await getJson('/api/notifications');
      if (!response.ok) {
        throw new Error(requestFailed('notification preferences read', response.status));
      }
      const body = (await readJsonBody(response)) as { notifications?: unknown } | undefined;
      if (body === undefined) {
        throw new Error(requestFailed('notification preferences read', response.status));
      }
      const row = body.notifications as
        | {
            serviceEmail?: unknown;
            productUpdates?: unknown;
            marketing?: unknown;
          }
        | undefined;
      return {
        serviceEmail: row?.serviceEmail === true,
        productUpdates: row?.productUpdates === true,
        marketing: row?.marketing === true,
      };
    },

    /** Ghi ý định nhận thông báo (`PATCH /api/notifications`, partial). */
    updateNotificationPreferences: async (patch): Promise<Result<NotificationPreferences>> => {
      // Chỉ bọc lệnh PATCH: nếu PATCH thành công mà reload GET sau đó hỏng,
      // ghi đã xảy ra — ok:false sẽ nói dối về thao tác, throw (mà trang bắt)
      // là trung thực hơn: UI hiện lỗi rồi reload thấy state đã lưu.
      let response: Response;
      try {
        response = await patchJson('/api/notifications', patch);
      } catch {
        return { ok: false, reason: writeTransportFailed('notification preferences update') };
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: requestFailed('notification preferences update', response.status),
        };
      }
      // Route trả `{ ok: true }` — state sau ghi là hợp nhất patch lên giá trị
      // đã biết gần nhất; UI reload từ GET ngay sau đó (trang hiện tại làm vậy).
      const response2 = await getJson('/api/notifications');
      if (!response2.ok) {
        throw new Error(requestFailed('notification preferences read', response2.status));
      }
      const body = (await readJsonBody(response2)) as { notifications?: unknown } | undefined;
      if (body === undefined) {
        throw new Error(requestFailed('notification preferences read', response2.status));
      }
      const row = body.notifications as
        | { serviceEmail?: unknown; productUpdates?: unknown; marketing?: unknown }
        | undefined;
      return {
        ok: true,
        value: {
          serviceEmail: row?.serviceEmail === true,
          productUpdates: row?.productUpdates === true,
          marketing: row?.marketing === true,
        },
      };
    },

    /**
     * Danh sách privacy request (`GET /api/privacy-requests`). `id` không có
     * trong response v1 (PK là cặp subject+kind, route không cấp id) — UI
     * không dùng id của privacy request vào operation nào; `id: ''` giữ đúng
     * shape của hợp đồng UI.
     */
    listPrivacyRequests: async (): Promise<readonly PrivacyRequest[]> => {
      const response = await getJson('/api/privacy-requests');
      if (!response.ok) {
        throw new Error(requestFailed('privacy request list', response.status));
      }
      const body = (await readJsonBody(response)) as { requests?: unknown } | undefined;
      if (body === undefined || !Array.isArray(body.requests)) {
        throw new Error(requestFailed('privacy request list', response.status));
      }
      const mapped: PrivacyRequest[] = [];
      for (const entry of body.requests) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }
        const row = entry as {
          kind?: unknown;
          status?: unknown;
          submittedAt?: unknown;
          dueAt?: unknown;
        };
        if (
          typeof row.kind !== 'string' ||
          typeof row.status !== 'string' ||
          typeof row.submittedAt !== 'string' ||
          typeof row.dueAt !== 'string'
        ) {
          continue;
        }
        mapped.push({
          id: '',
          kind: row.kind as PrivacyRequestKind,
          submittedAt: row.submittedAt,
          dueAt: row.dueAt,
          status: row.status as PrivacyRequest['status'],
        });
      }
      return mapped;
    },

    /** Nộp privacy request (`POST /api/privacy-requests`). */
    submitPrivacyRequest: async (kind): Promise<Result<PrivacyRequest>> => {
      let response: Response;
      try {
        response = await postJson('/api/privacy-requests', { kind });
      } catch {
        return { ok: false, reason: writeTransportFailed('privacy request submit') };
      }
      if (response.status === 429) {
        return { ok: false, reason: 'too many requests' };
      }
      if (!response.ok) {
        return { ok: false, reason: requestFailed('privacy request submit', response.status) };
      }
      const body = (await readJsonBody(response)) as { request?: unknown };
      const row = body.request as
        | { kind?: unknown; status?: unknown; submittedAt?: unknown; dueAt?: unknown }
        | undefined;
      if (
        row === undefined ||
        typeof row.kind !== 'string' ||
        typeof row.status !== 'string' ||
        typeof row.submittedAt !== 'string' ||
        typeof row.dueAt !== 'string'
      ) {
        return { ok: false, reason: requestFailed('privacy request submit', response.status) };
      }
      return {
        ok: true,
        value: {
          id: '',
          kind: row.kind as PrivacyRequestKind,
          submittedAt: row.submittedAt,
          dueAt: row.dueAt,
          status: row.status as PrivacyRequest['status'],
        },
      };
    },
  };
}
