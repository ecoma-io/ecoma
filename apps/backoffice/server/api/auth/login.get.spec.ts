/**
 * Unit test của `GET /api/auth/login` — đường vào của luồng đăng nhập
 * (ADR-0012 §1.1–1.2). Suite integration không phủ route này (nó nằm ngoài
 * ranh giới middleware authn và cần `auth` thật), nên hợp đồng của nó được ghim
 * ở đây trên **h3 app thật** với một ranh giới mock duy nhất: pool `pg`.
 *
 * Mock dừng đúng ở pool (06 §9: spec colocated không boot database thật) — mọi
 * thứ sau đó là code thật: sinh flow value, hash SHA-256, PKCE S256, dựng
 * authorize URL, cookie. `pool.query` ghi lại INSERT để test đối chiếu **ba
 * chân** của chống-replay mà callback sẽ kiểm:
 *
 * 1. Cookie phát cho browser map đúng **hash** của hàng đã INSERT;
 * 2. `state` trên URL là đúng `state` đã lưu cùng hàng;
 * 3. `code_challenge` là S256 của đúng `code_verifier` đã lưu.
 *
 * Fail-closed: thiếu cấu hình ⇒ `503` trước mọi thứ; thiếu nguồn DB ⇒ `503`
 * **trước khi** phát cookie — một luồng login hỏng nửa chừng không được để lại
 * cookie mồ côi trên browser.
 */

import { createHash } from 'node:crypto';
import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import loginHandler from './login.get';

// ⚠️ Mock ở ranh giới DB duy nhất của route: pool giả whose `query` ghi lại
// mọi câu lệnh để test đối chiếu với response. `withBackofficePool` thật sẽ
// mở connection tới connection string giả — điều mà spec colocated cấm.
const db = vi.hoisted(() => ({
  nodeUrl: null as string | null,
  inserts: [] as { text: string; values: readonly unknown[] }[],
}));

// ⚠️ KHÔNG mock `../../db`: `poolBinding` dùng chung giữ bản thật — nhánh
// Hyperdrive trả `null` qua barrel mock ở dưới, nhánh Node đọc
// `useRuntimeConfig` (test stub global) ⇒ `db.nodeUrl` vẫn là đường điều khiển.

vi.mock('@ecoma-io/backoffice-infrastructure', () => ({
  backofficeHyperdrive: () => null,
  backofficeNodeDatabaseUrl: () => db.nodeUrl,
  withBackofficePool: async <T>(
    _binding: unknown,
    callback: (pool: unknown) => Promise<T>,
  ): Promise<T> =>
    callback({
      query: async (text: string, values?: readonly unknown[]) => {
        db.inserts.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 1 };
      },
    }),
}));

const ISSUER = 'https://auth.test.ecoma.io';
const CONFIG = {
  backofficeAuthIssuer: ISSUER,
  backofficeAuthAudience: 'https://api.test.ecoma.io/backoffice',
  backofficeAuthClientId: 'backoffice-test',
};

function handler(): WebHandler {
  const app = createApp();
  const router = createRouter();
  router.get('/api/auth/login', loginHandler);
  app.use(router.handler);
  return toWebHandler(app);
}

describe('GET /api/auth/login — fail-closed', () => {
  it('returns 503 and issues no cookie when the OIDC configuration is missing', async () => {
    db.nodeUrl = 'postgres://runtime@origin/db-backoffice';
    vi.stubGlobal('useRuntimeConfig', () => ({}));

    const response = await handler()(new Request('https://backoffice.test/api/auth/login'));

    expect(response.status).toBe(503);
    // Không cấu hình là không mở luồng: không cookie flow, không redirect.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
  });

  it('returns 503 when the configuration exists but no database source does', async () => {
    db.nodeUrl = null;
    vi.stubGlobal('useRuntimeConfig', () => CONFIG);

    const response = await handler()(new Request('https://backoffice.test/api/auth/login'));

    // Không lưu được flow thì callback không verify được cookie/state ⇒ không
    // mở luồng cho qua; và cookie không được phát trước khi hàng đã chốt.
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /api/auth/login — authorize URL and flow row contract', () => {
  beforeEach(() => {
    db.nodeUrl = 'postgres://runtime@origin/db-backoffice';
    db.inserts.length = 0;
    vi.stubGlobal('useRuntimeConfig', () => CONFIG);
  });

  it('redirects to {issuer}/authorize with the full S256 PKCE parameter set', async () => {
    const response = await handler()(
      // ⚠️ Header `host` phải đặt tường minh: `callbackRedirectUri` dựng
      // `redirect_uri` từ header này, và mặc định của nó khi thiếu là
      // `localhost` — URL assertion dưới đây sai vì lý do sai nếu thiếu header.
      new Request('https://backoffice.test/api/auth/login', {
        headers: { host: 'backoffice.test' },
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin).toBe(ISSUER);
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('backoffice-test');
    // Scope ghim ADR-0012 §6 — không nhận từ query của request.
    expect(location.searchParams.get('scope')).toBe('openid offline_access');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    // Redirect URI là path cố định của chính app, ghép với origin request.
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://backoffice.test/api/auth/callback',
    );
  });

  it('marks the response no-store and issues a single-use __Host- flow cookie', async () => {
    const response = await handler()(new Request('https://backoffice.test/api/auth/login'));

    expect(response.headers.get('cache-control')).toBe('no-store');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Host-backoffice-login=[A-Za-z0-9_-]{43}/u);
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });

  it('stores a row whose hash, state and PKCE challenge match what the browser received', async () => {
    const response = await handler()(
      new Request('https://backoffice.test/api/auth/login', {
        headers: { host: 'backoffice.test' },
      }),
    );

    expect(db.inserts).toHaveLength(1);
    const { text, values } = db.inserts[0];
    expect(text).toContain('INSERT INTO backoffice.bff_login_flows');

    const cookieValue = (response.headers.get('set-cookie') ?? '')
      .split(';')[0]
      ?.split('=')
      .slice(1)
      .join('=');
    expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    // Cookie chỉ mang định danh hàng — DB thấy đúng SHA-256 hex của giá trị đó.
    expect(values[0]).toBe(createHash('sha256').update(cookieValue).digest('hex'));

    // `state` trên URL là đúng `state` đã lưu cùng hàng.
    const location = new URL(response.headers.get('location') as string);
    expect(location.searchParams.get('state')).toBe(values[1]);

    // `code_challenge` = S256 của đúng `code_verifier` đã lưu (RFC 7636 §4.2).
    const verifier = values[2] as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(location.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier, 'utf8').digest('base64url'),
    );

    // TTL của hàng khớp TTL của cookie (10 phút) trong một cửa sổ dung sai.
    const expiresAt = values[3] as Date;
    const ageSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(ageSeconds).toBeGreaterThan(590);
    expect(ageSeconds).toBeLessThanOrEqual(600);
  });
});
