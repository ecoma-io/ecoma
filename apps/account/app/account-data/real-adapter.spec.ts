/**
 * Hợp đồng của adapter thật — thứ mà **mọi mode** (kể cả dev preview cho auth)
 * đi qua.
 *
 * ⚠️ Hai điều test này giữ:
 *
 * 1. **Hiện thực tường minh mọi phương thức của cả ba port.** Từ Issue #123,
 *    adapter thật không được mượn một phương thức nào từ mock — mỗi method hoặc
 *    là đường BFF thật (stub fetch ở đây), hoặc là refusal tường minh. Nhờ object
 *    đủ key, một spread từ mock không còn chỗ để lọt: test dưới đây là bằng chứng
 *    runtime của điều mà kiểu trả về của factory đã ép ở compile-time.
 * 2. **Security chưa có backend thì từ chối, không giả thành công.**
 *    `securityCapabilities` toàn `false`; đọc ném lỗi có message ổn định (chữ ký
 *    contract mà UI bắt để render unavailable), ghi trả `Result` lỗi — không bao
 *    giờ có một `ok: true` không đứng sau thao tác backend thật.
 *
 * Mọi response ở đây đều hình dung **BFF thật của app** (`/api/*` trên cùng
 * origin) — adapter không bao giờ gọi thẳng `auth` hay transactional-mail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerAccountAdapter } from './real-adapter';

/** Response JSON một dòng — hình dạng tối thiểu mà mọi route BFF trả. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('real adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('implements every method of the adapter contract explicitly', () => {
    const adapter = createServerAccountAdapter();

    // Mỗi key phải là một hàm tự có — không có phương thức nào "kế thừa" từ
    // lớp khác. `securityCapabilities` là duy nhất không phải hàm (bản đồ năng lực).
    const methods = [
      // AccountDataPort
      'getProfile',
      'updateProfile',
      'listEmails',
      'addEmail',
      'resendVerification',
      'removeEmail',
      'listSessions',
      'revokeSession',
      'listApplications',
      'revokeApplication',
      'getPreferences',
      'updatePreferences',
      'getNotificationPreferences',
      'updateNotificationPreferences',
      'listPrivacyRequests',
      'submitPrivacyRequest',
      // AuthenticationPort
      'requestLoginChallenge',
      'verifyLoginCode',
      'completeHandoff',
      'getConsentContext',
      'decideConsent',
      // AccountSecurityPort
      'listPasskeys',
      'removePasskey',
      'getTotpState',
      'getRecoveryCodesState',
    ] as const;
    for (const method of methods) {
      // Nhãn nằm trong giá trị khẳng định (`valid-expect` chỉ nhận một argument):
      // khi một key thiếu, failure tự nói tên method chứ không chỉ "undefined".
      expect(`${method}: ${typeof adapter[method]}`).toBe(`${method}: function`);
    }
    expect(adapter.securityCapabilities).toEqual({
      passkeys: false,
      totp: false,
      'recovery-codes': false,
    });
  });

  it('is not preview data', () => {
    expect(createServerAccountAdapter().isPreview).toBe(false);
  });

  it('reports security capabilities as unavailable and refuses the reads explicitly', async () => {
    const adapter = createServerAccountAdapter();

    // Message ném ra là **chữ ký ổn định** — UI (và test của UI) bắt nó để render
    // trạng thái unavailable; đổi chữ là đổi contract.
    await expect(adapter.listPasskeys()).rejects.toThrow('passkeys unavailable');
    await expect(adapter.getTotpState()).rejects.toThrow('totp unavailable');
    await expect(adapter.getRecoveryCodesState()).rejects.toThrow('recovery codes unavailable');
  });

  it('refuses the security write without reporting success', async () => {
    const adapter = createServerAccountAdapter();
    await expect(adapter.removePasskey('passkey-1')).resolves.toEqual({
      ok: false,
      reason: 'passkeys unavailable: no backend capability',
    });
  });

  it('sends the login challenge to the account BFF, not to any mock path', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createServerAccountAdapter();

    const result = await adapter.requestLoginChallenge('user@example.com', 'opaque-handle');

    expect(result.ok).toBe(true);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [path, init] = firstCall as [RequestInfo | URL, RequestInit | undefined];
    expect(String(path)).toBe('/api/auth/challenge');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'user@example.com',
      handle: 'opaque-handle',
    });
  });

  it('refuses to verify before a challenge was requested in this session', async () => {
    // `pendingLoginEmail` là state trong closure của factory (một "phiên
    // adapter"), nên một instance **mới** đảm bảo trạng thái đầu không phụ thuộc
    // thứ tự test — một test trước đó trên instance riêng của nó không thể
    // nhiễm sang instance này.
    const adapter = createServerAccountAdapter();

    await expect(adapter.verifyLoginCode('123456')).resolves.toEqual({
      ok: false,
      reason: 'no challenge requested',
    });
  });

  it('relays the server-issued confirmUrl verbatim after a successful verify', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/auth/challenge') {
          return new Response(null, { status: 204 });
        }
        if (path === '/api/auth/verify') {
          return jsonResponse({
            ok: true,
            confirmUrl: 'https://auth.example.com/authorize/confirm?handle=x',
          });
        }
        throw new Error(`unexpected fetch: ${path}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createServerAccountAdapter();

    await adapter.requestLoginChallenge('user@example.com');
    const result = await adapter.verifyLoginCode('123456');

    expect(result).toEqual({
      ok: true,
      value: { confirmUrl: 'https://auth.example.com/authorize/confirm?handle=x' },
    });
  });

  it('reads the profile from the account BFF', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ profile: { displayName: 'Real Name', avatarUrl: null } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createServerAccountAdapter();

    const profile = await adapter.getProfile();

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall?.[0])).toBe('/api/profile');
    expect(profile).toEqual({ displayName: 'Real Name', avatarUrl: undefined });
  });

  it('turns a transport error into a typed failure for writes, never a success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<Response>>(async () => jsonResponse({ error: 'down' }, 503)),
    );
    const adapter = createServerAccountAdapter();

    const result = await adapter.updateProfile({ displayName: 'X' });

    // Một BFF chết không được biến thành "đã lưu" — đây là đường mà bản cũ đi
    // qua mock mỗi khi `real` chưa nối (Issue #123).
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('503');
  });

  it('resolves a rejected fetch to a failed Result for writes instead of throwing', async () => {
    // Mạng đứt/BFF chết làm `fetch` **ném** — hợp đồng ghi nói `Result` là kênh
    // thất bại duy nhất: một rejection lọt qua handler của trang (chỉ bắt
    // `Result`) là unhandled rejection không trạng thái nào.
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<Response>>(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const adapter = createServerAccountAdapter();

    const profile = await adapter.updateProfile({ displayName: 'X' });
    const email = await adapter.addEmail('new@example.com');
    const preferences = await adapter.updatePreferences({ locale: 'vi' });

    expect(profile.ok ? '' : profile.reason).toBe('profile update failed with network error');
    expect(email.ok ? '' : email.reason).toBe('email add failed with network error');
    expect(preferences.ok ? '' : preferences.reason).toBe(
      'preferences update failed with network error',
    );
  });

  it('treats a 200 with an unreadable body as a failure, not an empty success', async () => {
    // Body không phải JSON (proxy cắt ngang, route hỏng) — khác với JSON hợp lệ
    // thiếu trường: bịa "đã lưu" từ body rác là biến lỗi backend thành thành
    // công. Ghi → `ok:false`; đọc → ném cùng message với lỗi status.
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
        return new Response('not json at all', { status: 200 });
      }),
    );
    const adapter = createServerAccountAdapter();

    const written = await adapter.updateProfile({ displayName: 'X' });
    expect(written.ok).toBe(false);
    expect(written.ok ? '' : written.reason).toBe('profile update failed with 200');

    await expect(adapter.getProfile()).rejects.toThrow('profile read failed with 200');
  });
});
