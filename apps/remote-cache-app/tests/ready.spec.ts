import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import healthRoute from '../server/routes/health.get';
import readyRoute from '../server/routes/ready.get';
import { stripComments } from './source-code';

/**
 * Hợp đồng của hai route vận hành của `remote-cache-app` (ADR-0035).
 *
 * Các bất biến được ghim ở đây:
 *
 * 1. **`/health` là liveness** — trả JSON ổn định và không đọc gì từ event.
 * 2. **`/ready` là readiness fail-closed theo cấu hình** — đủ cấu hình OIDC +
 *    control plane ⇒ `200 { status: 'ready' }`; thiếu nhóm nào ⇒ `503` kèm mã
 *    ổn định `*_not_configured`. Route đọc **cấu hình** qua event, không gọi
 *    mạng — readiness không là serving-path dependency của service khác.
 * 3. **Không có lệnh gọi mạng nào trong `ready.get.ts`** — phần **code** (comment
 *    đã bị bóc) không được tham chiếu `fetch(`: kiểm env là đủ, vì middleware
 *    authn và proxy portal fail closed trên đúng các env đó.
 *
 * ⚠️ Cho `/health`, event được thay bằng một `Proxy` **ném khi bị đọc bất kỳ
 * thuộc tính nào**: nếu route lỡ chạm `event.context`, test đỏ ngay tại đó.
 * `/ready` đọc cấu hình từ event (đó là hợp đồng mới của nó), nên phép Proxy
 * chỉ áp cho `/health` và cho phép kiểm source của `/ready`.
 */

/** Event cấm đọc — mọi truy cập thuộc tính đều ném. */
const FORBIDDEN_EVENT = new Proxy(
  {},
  {
    get(_target, property): never {
      throw new Error(`route must not read event.${String(property)}`);
    },
  },
);

const ROUTES_DIR = resolve(import.meta.dirname, '../server/routes');

/**
 * Bỏ comment nhưng **không** đụng vào string literal: `//` trong `'https://…'`
 * không phải comment, và cắt nhầm ở đó sẽ khiến phép quét chạy trên đoạn mã
 * hỏng — đúng loại false-green mà spec này tồn tại để chặn.
 */
const codeOf = stripComments;

describe('/health — liveness', () => {
  it('returns ok and the service name without reading the event', () => {
    const result = healthRoute(FORBIDDEN_EVENT as never);

    expect(result).toEqual({ status: 'ok', service: 'remote-cache-app' });
  });

  it('does not set a response status', () => {
    const source = readFileSync(resolve(ROUTES_DIR, 'health.get.ts'), 'utf8');

    expect(codeOf(source)).not.toMatch(/\bsetResponseStatus\b/u);
  });
});

/**
 * Event giả đủ hình cho `setResponseStatus` của h3 (`event.node.res
 * .statusCode`) và đọc cấu hình qua `context.cloudflare.env`.
 */
function fakeEvent(env: Record<string, string>): { node: { res: { statusCode?: number } } } {
  return { node: { res: {} } as never, context: { cloudflare: { env } } } as never;
}

describe('/ready — fail-closed on BFF configuration', () => {
  it('returns ready with 200 when both config groups are present', () => {
    const event = fakeEvent({
      REMOTE_CACHE_AUTH_ISSUER: 'https://auth.example.com',
      REMOTE_CACHE_AUTH_AUDIENCE: 'ecoma-control-plane',
      REMOTE_CACHE_AUTH_CLIENT_ID: 'ecoma-remote-cache-app',
      REMOTE_CACHE_API_BASE_URL: 'http://ecoma-remote-cache-api:4207',
      INTERNAL_AUTH_SECRET: 'shared-secret',
    });
    const result = readyRoute(event as never);

    expect(result).toEqual({ status: 'ready' });
    expect(event.node.res.statusCode).toBeUndefined();
  });

  it('sets 503 with a stable code when OIDC config is missing', () => {
    const event = fakeEvent({
      REMOTE_CACHE_API_BASE_URL: 'http://ecoma-remote-cache-api:4207',
      INTERNAL_AUTH_SECRET: 'shared-secret',
    });
    const result = readyRoute(event as never);

    expect(result).toEqual({ status: 'not_ready', code: 'oidc_not_configured' });
    expect(event.node.res.statusCode).toBe(503);
  });

  it('sets 503 with a stable code when control-plane config is missing', () => {
    const event = fakeEvent({
      REMOTE_CACHE_AUTH_ISSUER: 'https://auth.example.com',
      REMOTE_CACHE_AUTH_AUDIENCE: 'ecoma-control-plane',
      REMOTE_CACHE_AUTH_CLIENT_ID: 'ecoma-remote-cache-app',
    });
    const result = readyRoute(event as never);

    expect(result).toEqual({ status: 'not_ready', code: 'control_plane_not_configured' });
    expect(event.node.res.statusCode).toBe(503);
  });

  it('fails closed when nothing is configured (empty worker env)', () => {
    const event = fakeEvent({});
    const result = readyRoute(event as never);

    expect(result).toEqual({ status: 'not_ready', code: 'oidc_not_configured' });
    expect(event.node.res.statusCode).toBe(503);
  });

  it('keeps the fail-closed contract documented', () => {
    const source = readFileSync(resolve(ROUTES_DIR, 'ready.get.ts'), 'utf8');

    expect(source).toMatch(/fail.?closed/iu);
    expect(source).toMatch(/503/u);
  });
});

describe('ready route makes no network call of any kind', () => {
  const source = readFileSync(resolve(ROUTES_DIR, 'ready.get.ts'), 'utf8');
  // Bóc comment trước khi kiểm: comment **phải** được phép nói "không gọi mạng" —
  // chính câu đó là tài liệu của bất biến này. Thứ bị cấm là một lệnh gọi mạng
  // trong code chạy được.
  const code = codeOf(source);

  it.each([
    ['fetch(', /\bfetch\s*\(/u],
    ['remote-cache-api host literal', /ecoma-remote-cache-api/u],
  ])('does not reference %s', (_label, pattern) => {
    expect(code).not.toMatch(pattern);
  });
});
