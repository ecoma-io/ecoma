/**
 * Unit test của `GET /api/auth/session` (#182) — route probe trạng thái phiên
 * **chỉ để hiển thị** của shell.
 *
 * Hợp đồng bị ghim ở đây, đúng JSDoc của route:
 *
 * 1. **Luôn 200** — không nhánh nào ném; kể cả nhánh không kết luận được.
 * 2. **Cookie vắng ⇒ kết luận sớm** — không chạm cấu hình/DB/JWKS (đây là nhánh
 *    giữ console browser sạch trên mọi trang chưa đăng nhập).
 * 3. **Degraded ⇒ `false` + đúng một dòng log** `session_probe.degraded` mang
 *    reason ổn định, **không** chứa giá trị cookie/token (SR-14).
 * 4. **Chỉ đọc** — không có `touchSession` trong đường đi; không gắn principal.
 * 5. `Cache-Control: no-store` — response gắn với phiên, không được cache.
 *
 * Phép đo trên phiên (mocker của `loadSessionByHash`/`verifyAccessToken`) chỉ
 * tái tạo trình tự middleware; **trình tự thật** với PostgreSQL + JWKS thật nằm
 * ở `tests/integrations/authn-middleware.spec.ts` — hai tầng test, mỗi tầng ghim
 * đúng thứ mình đo được.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler, type H3Event } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Các hàm infra được import tĩnh: `vi.mock` ở dưới thay thế module này, nên mọi
// tên ở đây nhận đúng mock của factory. Không dùng `await import` động — một
// import động biến thư viện thành "lazy-loaded" và `@nx/enforce-module-boundaries`
// cấm mọi import tĩnh của nó trong toàn app (29 lỗi ở các file khác).
import {
  loadSessionByHash,
  SESSION_COOKIE_NAME,
  touchSession,
  verifyAccessToken,
} from '@ecoma-io/backoffice-infrastructure';

import sessionRoute from './session.get';

const writeLog = vi.fn<(entry: Record<string, unknown>) => void>();
vi.mock('../../log', () => ({ writeLog: (...args: unknown[]) => writeLog(...args) }));

const backofficeAuthConfig = vi.fn<(event: H3Event) => unknown>(() => ({
  issuer: 'https://auth.test',
}));
vi.mock('../../auth/config', () => ({
  backofficeAuthConfig: (event: H3Event) => backofficeAuthConfig(event),
}));

const poolBinding = vi.fn<(event: H3Event) => unknown>(() => ({ fake: 'binding' }));
vi.mock('../../db', () => ({ poolBinding: (event: H3Event) => poolBinding(event) }));

vi.mock('@ecoma-io/backoffice-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/backoffice-infrastructure')>();
  return {
    ...actual,
    hashSessionIdentifier: vi.fn<(value: string) => Promise<string>>(
      async (value) => `hash(${value})`,
    ),
    loadSessionByHash: vi.fn<(pool: unknown, idHash: string) => Promise<unknown>>(async () => null),
    verifyAccessToken: vi.fn<
      (token: string, config: unknown) => Promise<{ outcome: string; sub?: string; exp?: number }>
    >(async () => ({ outcome: 'invalid' })),
    // ⚠️ Không phải `...actual.touchSession`: spy **tường minh** — assertion
    // "probe không đụng phiên" phải quan sát được, một hàm thật thì không.
    touchSession: vi.fn<(pool: unknown, idHash: string, nextMs: number) => Promise<void>>(
      async () => undefined,
    ),
    withBackofficePool: async <T>(_binding: unknown, callback: (pool: unknown) => Promise<T>) =>
      callback({ fake: 'pool' }),
  };
});

/** Hàng phiên sống — `isSessionLive` thật chạy trên nó (không mock). */
const LIVE_ROW = {
  account_sub: 'sub_' + 'a'.repeat(32),
  access_token: 'fake-token',
  created_at: new Date(Date.now() - 60_000),
  expires_at: new Date(Date.now() + 600_000),
  revoked_at: null,
};

/** Gửi GET tới route thật với cookie tuỳ chọn, trả status + body + headers. */
async function get(cookie?: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  const app = createApp();
  app.use(
    defineEventHandler((event) => {
      event.context.cloudflare = { env: {} };
    }),
  );
  const router = createRouter();
  router.get('/api/auth/session', sessionRoute);
  app.use(router.handler);

  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  const response = await toWebHandler(app)(
    new Request('https://backoffice.test/api/auth/session', { headers }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}

function cookieHeader(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}`;
}

describe('GET /api/auth/session — display-only session probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ⚠️ `clearAllMocks` **không** gỡ `mockReturnValue` của test trước (nó chỉ
    // xoá calls) — mặc định phải gán lại tường minh ở đây, nếu không test đổi
    // cấu hình/binding sẽ rò sang test kế tiếp theo thứ tự chạy.
    backofficeAuthConfig.mockReturnValue({ issuer: 'https://auth.test' });
    poolBinding.mockReturnValue({ fake: 'binding' });
    vi.mocked(loadSessionByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue({ outcome: 'invalid' });
  });

  it('answers 200 unauthenticated for a cookieless request without touching config or DB', async () => {
    const { status, body, headers } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    expect(headers.get('cache-control')).toBe('no-store');

    // Kết luận sớm: nhánh này là thứ giữ console browser sạch — không có gì để
    // lỗi, nên không có cấu hình hay DB nào bị hỏi.
    expect(backofficeAuthConfig).not.toHaveBeenCalled();
    expect(poolBinding).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('answers false with a degraded log when OIDC config is missing', async () => {
    backofficeAuthConfig.mockReturnValue(null);

    const { status, body } = await get(cookieHeader('some-session-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    expect(writeLog).toHaveBeenCalledTimes(1);
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session_probe.degraded', reason: 'auth_config_missing' }),
    );
  });

  it('answers false with a degraded log when the DB binding is missing', async () => {
    poolBinding.mockReturnValue(null);

    const { status, body } = await get(cookieHeader('some-session-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session_probe.degraded', reason: 'db_binding_missing' }),
    );
  });

  it('answers false without a log for an unknown session value', async () => {
    const { status, body } = await get(cookieHeader('unknown-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    // Phiên vắng là một **kết luận** (chưa có phiên dùng được), không phải trạng
    // thái không kết luận được — im lặng, không log degraded.
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('answers true for a live session whose token verifies', async () => {
    vi.mocked(loadSessionByHash).mockResolvedValue(LIVE_ROW);
    vi.mocked(verifyAccessToken).mockResolvedValue({
      outcome: 'verified',
      sub: LIVE_ROW.account_sub,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    const { status, body } = await get(cookieHeader('live-session-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: true });
    expect(writeLog).not.toHaveBeenCalled();
    // Route không đọc-ghi: không có touch — phép đo không kéo dài phiên.
    expect(touchSession).not.toHaveBeenCalled();
  });

  it('answers false with a degraded log when JWKS is unavailable', async () => {
    vi.mocked(loadSessionByHash).mockResolvedValue(LIVE_ROW);
    vi.mocked(verifyAccessToken).mockResolvedValue({ outcome: 'unavailable' });

    const { status, body } = await get(cookieHeader('live-session-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session_probe.degraded', reason: 'jwks_unavailable' }),
    );
  });

  it('answers false without a log when the stored token no longer verifies', async () => {
    vi.mocked(loadSessionByHash).mockResolvedValue(LIVE_ROW);
    vi.mocked(verifyAccessToken).mockResolvedValue({ outcome: 'invalid' });

    const { status, body } = await get(cookieHeader('live-session-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    // Token chết là kết luận về phiên đó — không phải trạng thái hạ tầng.
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('answers false with a degraded log when the database is unreachable, without leaking driver errors', async () => {
    vi.mocked(loadSessionByHash).mockRejectedValue(
      new Error(
        'password authentication failed for user ecoma_backoffice_runtime postgres://secret-host',
      ),
    );

    const { status, body } = await get(cookieHeader('live-session-id'));

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    // Log chỉ mang reason ổn định — không nối message driver (connection string
    // có thể nằm trong đó), cùng luật với middleware authn (SR-14).
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session_probe.degraded', reason: 'db_unreachable' }),
    );
    const logged = JSON.stringify(writeLog.mock.calls[0]?.[0]);
    expect(logged).not.toContain('postgres://');
    expect(logged).not.toContain('some-session-id');
  });

  it('never logs the session cookie or token values on any path (SR-14)', async () => {
    vi.mocked(loadSessionByHash).mockResolvedValue(LIVE_ROW);
    vi.mocked(verifyAccessToken).mockResolvedValue({ outcome: 'unavailable' });

    await get(cookieHeader('live-session-id'));

    const logged = writeLog.mock.calls.map((call) => JSON.stringify(call[0])).join('\n');
    expect(logged).not.toContain('live-session-id');
    expect(logged).not.toContain('fake-token');
  });
});
