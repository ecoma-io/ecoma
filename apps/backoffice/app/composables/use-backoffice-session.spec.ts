/**
 * Hợp đồng của composable phiên — thứ mà `BackofficeSessionControls` dựa vào.
 *
 * Bốn bất biến được ghim ở đây, theo đúng JSDoc của `use-backoffice-session.ts`:
 *
 * 1. Chỉ một kết quả 200 với body đúng hợp đồng mới đổi `status`; mọi kết cục
 *    khác (mạng lỗi, status lạ, body sai) giữ `unknown`.
 * 2. `logout` là double-submit CSRF: header `x-ecoma-csrf` mang giá trị cookie
 *    `__Host-backoffice-csrf` — thiếu cookie thì đi **không** header (không bịa
 *    token thay server).
 * 3. Logout thành công (204) điều hướng full-page về `/`; kết cục khác hỏi lại
 *    probe thay vì đá người dùng đi đâu.
 * 4. Singleton trên `nuxtApp`: hai call-site nhận cùng một instance — probe một
 *    lần là shell và mọi nơi khác thấy cùng một trạng thái.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setNuxtApp } from '../../tests/nuxt-app-state';
import { useBackofficeSession } from './use-backoffice-session';

const CSRF_COOKIE = '__Host-backoffice-csrf';

/** Fetch giả trả JSON theo kịch bản; mặc định 200 `{ authenticated: false }`. */
function stubFetch(respond: () => { status: number; body?: unknown; networkError?: boolean }) {
  const mock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => {
    const scenario = respond();
    if (scenario.networkError === true) {
      throw new TypeError('Network unavailable');
    }
    return {
      ok: scenario.status >= 200 && scenario.status < 300,
      status: scenario.status,
      json: async () => scenario.body,
    } as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const assign = vi.fn<(url: string) => void>();

beforeEach(() => {
  // `window.location` của jsdom không có assign thật (navigation không được mô
  // phỏng), và phương thức `assign` là own non-configurable — thay cả object
  // `location` (descriptor của nó trên `window` lại configurable).
  assign.mockClear();
  vi.stubGlobal('location', { assign });
  // `__Host-` prefix bắt buộc `Secure` (jsdom cũng thi hành luật này khi ghi
  // document.cookie — giống trình duyệt thật); đọc lại vẫn được qua http trong
  // jsdom, nên không cần mock `document`.
  document.cookie = `${CSRF_COOKIE}=csrf-token-123; path=/; Secure`;
});

afterEach(() => {
  // Xoá đúng cookie test vừa ghi (path + Secure cùng lúc lúc ghi).
  document.cookie = `${CSRF_COOKIE}=; path=/; Secure; max-age=0`;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('use-backoffice-session', () => {
  it('probe with authenticated body → authenticated; composable is a singleton on nuxtApp', async () => {
    setNuxtApp({});
    stubFetch(() => ({ status: 200, body: { authenticated: true } }));

    const session = useBackofficeSession();
    expect(session.status.value).toBe('unknown');

    await session.refresh();

    expect(session.status.value).toBe('authenticated');

    // Cùng slot `nuxtApp` ⇒ call-site thứ hai nhận đúng instance đầu: một probe
    // cho cả app.
    expect(useBackofficeSession()).toBe(session);
  });

  it('probe with unauthenticated body → unauthenticated', async () => {
    setNuxtApp({});
    stubFetch(() => ({ status: 200, body: { authenticated: false } }));

    const session = useBackofficeSession();
    await session.refresh();

    expect(session.status.value).toBe('unauthenticated');
  });

  it('probe with non-200 keeps unknown — a contract breach is not proof of a logged-out user', async () => {
    setNuxtApp({});
    stubFetch(() => ({ status: 500 }));

    const session = useBackofficeSession();
    await session.refresh();

    expect(session.status.value).toBe('unknown');
  });

  it('network failure keeps unknown — no evidence renders nothing, not a guess', async () => {
    setNuxtApp({});
    stubFetch(() => ({ status: 200, networkError: true }));

    const session = useBackofficeSession();
    await session.refresh();

    expect(session.status.value).toBe('unknown');
  });

  it('probe response with a missing authenticated field falls to unauthenticated', async () => {
    setNuxtApp({});
    stubFetch(() => ({ status: 200, body: { nope: 1 } }));

    const session = useBackofficeSession();
    await session.refresh();

    // `authenticated !== true` ⇒ `unauthenticated`. Body sai kiểu là một hợp đồng
    // bị vi phạm — nhưng trường `authenticated` vắng mặt **không** thể phân biệt
    // với `{ authenticated: false }` ở mức runtime, nên hợp đồng runtime của
    // composable là "truthy check trên field". Khẳng định này ghim hành vi thật:
    // field sai tên rơi vào nhánh `unauthenticated`.
    expect(session.status.value).toBe('unauthenticated');
  });

  it('login navigates full-page to the BFF kickoff route', () => {
    setNuxtApp({});
    const session = useBackofficeSession();

    session.login();

    expect(assign).toHaveBeenCalledWith('/api/auth/login');
  });

  it('logout sends the CSRF cookie value in the double-submit header, then navigates home on 204', async () => {
    setNuxtApp({});
    const fetchMock = stubFetch(() => ({ status: 204 }));

    const session = useBackofficeSession();
    session.status.value = 'authenticated';
    await session.logout();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-ecoma-csrf']).toBe('csrf-token-123');

    // 204 là kết cục hợp đồng: full-page về `/` — mọi state in-memory chết cùng phiên.
    expect(assign).toHaveBeenCalledWith('/');
    expect(session.status.value).toBe('unauthenticated');
    expect(session.loggingOut.value).toBe(false);
  });

  it('logout without a CSRF cookie sends no header and lets the server decide', async () => {
    setNuxtApp({});
    document.cookie = `${CSRF_COOKIE}=; path=/; Secure; max-age=0`;
    const fetchMock = stubFetch(() => ({ status: 200, body: { authenticated: true } }));

    const session = useBackofficeSession();
    session.status.value = 'authenticated';
    await session.logout();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual([]);

    // Server từ chối (không 204) ⇒ phiên còn nguyên theo phản hồi: hỏi lại probe,
    // không điều hướng.
    expect(assign).not.toHaveBeenCalled();
    expect(session.status.value).toBe('authenticated');
    expect(session.loggingOut.value).toBe(false);
  });

  it('logout network failure asks the probe again instead of navigating', async () => {
    setNuxtApp({});
    let phase: 'logout' | 'probe' = 'logout';
    stubFetch(() => {
      if (phase === 'logout') {
        phase = 'probe';
        return { status: 204, networkError: true };
      }
      return { status: 200, body: { authenticated: false } };
    });

    const session = useBackofficeSession();
    session.status.value = 'authenticated';
    await session.logout();

    expect(assign).not.toHaveBeenCalled();
    expect(session.status.value).toBe('unauthenticated');
    expect(session.loggingOut.value).toBe(false);
  });

  it('logout while already logging out does not send a second request', async () => {
    setNuxtApp({});
    let release: (() => void) | undefined;
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve({ ok: true, status: 204, json: async () => ({}) } as Response);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const session = useBackofficeSession();
    session.status.value = 'authenticated';
    const first = session.logout();
    const second = session.logout();

    release?.();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});
