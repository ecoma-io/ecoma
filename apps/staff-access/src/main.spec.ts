import { describe, expect, it, vi } from 'vitest';

import { buildApp, resetCachedConfig } from './main';
import { StaffAccessAppConfigurationError, loadStaffAccessConfig } from './config';
describe('staff-access worker skeleton', () => {
  it('serves /health without credentials and without touching the binding', async () => {
    const app = buildApp();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('staff-access');
  });

  it('returns 503 fail-closed on configured routes when the Hyperdrive binding is missing', async () => {
    resetCachedConfig();
    const app = buildApp();
    // /health nam truoc middleware config, nen dung mot request bat ky vao
    // phan config-required — o skeleton nay moi path khac /health deu doi
    // config va phai tra 503 thay vi leak loi binding cho caller.
    const response = await app.request('/anything', { method: 'GET' });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Service Unavailable');
  });

  it('rejects management requests without an internal envelope', async () => {
    resetCachedConfig();
    const app = buildApp();
    const response = await app.request(
      '/staff',
      {
        headers: {
          'content-type': 'application/json',
        },
        ...({
          // The binding is only used after authentication; this request must fail first.
        } as object),
      },
      {
        DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
        AUTH_INTERNAL_SECRET: 'internal-secret-test',
      },
    );
    expect(response.status).toBe(401);
  });

  it('adds security headers to every response', async () => {
    const app = buildApp();
    const response = await app.request('/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('echoes a request id, generating one when the caller omits the header', async () => {
    const app = buildApp();
    const echoed = await app.request('/health', { headers: { 'x-request-id': 'req-1' } });
    expect(echoed.headers.get('x-request-id')).toBe('req-1');

    const generated = await app.request('/health');
    expect(generated.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('/ready — readiness with a real dependency probe', () => {
  it('returns 503 config_invalid when the Hyperdrive binding is missing', async () => {
    // `/ready` KHONG duoc tra 200 khi cau hinh khong nap duoc: mot backend
    // thieu binding se 503 moi route `/api/**`, nen readiness 200 se la loi noi
    // doi. Response khong duoc neu ten binding (thong tin cau hinh).
    //
    // Response cua hai nhanh loi CO CHU DICH giong het nhau, nen assertion
    // theo status/body khong phan biet duoc nguyen nhan — log `reason` moi la
    // tin hieu phan biet, va do la thu duy nhat test nay ghim.
    resetCachedConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = buildApp();
      const response = await app.request('/ready');
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('service_unavailable');
      expect(JSON.stringify(body)).not.toContain('DB_STAFF_ACCESS');
      expect(JSON.stringify(body)).not.toContain('AUTH_INTERNAL_SECRET');
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: 'ready.failed', status: 503, reason: 'config_invalid' }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('returns 503 db_unreachable when the configured database does not answer', async () => {
    // Binding + secret day du nhung origin khong ton tai: probe phai that bai
    // (fail-closed) thay vi 200, va cau hinh khong duoc lot vao response.
    //
    // `reason: db_unreachable` (khong phai `config_invalid`) la bang chung
    // probe DA CHAM DB va that bai o do — neu khong ghim, mot config hong
    // cung tao ra dung response 503 nay va test se xanh vi ly do sai.
    resetCachedConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = buildApp();
      const response = await app.request(
        '/ready',
        {},
        {
          DB_STAFF_ACCESS: { connectionString: 'postgresql://nobody@127.0.0.1:1/db-staff-access' },
          AUTH_INTERNAL_SECRET: 'internal-secret-test',
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      const body = await response.text();
      expect(body).not.toContain('127.0.0.1');
      expect(body).not.toContain('db-staff-access');
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: 'ready.failed', status: 503, reason: 'db_unreachable' }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('serves /ready without an internal envelope (probe path is credential-free)', async () => {
    // Khong co header envelope van phai toi duoc readiness — neu khong thi
    // healthcheck Docker luon 401 va container mai mai `unhealthy`.
    //
    // Assertion phai chung minh request da DI QUA lop xac thuc: env day du
    // (config nap duoc) + khong envelope van ra `db_unreachable`, khong phai
    // 401. Chi assert `!== 401` thi mot config hong cung lam test xanh ma
    // khong noi gi ve viec bypass xac thuc.
    resetCachedConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = buildApp();
      const response = await app.request(
        '/ready',
        {},
        {
          DB_STAFF_ACCESS: { connectionString: 'postgresql://nobody@127.0.0.1:1/db-staff-access' },
          AUTH_INTERNAL_SECRET: 'internal-secret-test',
        },
      );
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(503);
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ event: 'ready.failed', status: 503, reason: 'db_unreachable' }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('bypasses authentication for exactly /health and /ready, and no other path', async () => {
    // Tap bypass la mot `Set` so khop TUYET DOI. Mot ban sua doi sang
    // `startsWith` hay regex se mo rong bypass sang `/ready/anything` —
    // test nay ghim ranh gioi do, va ghim rang cac path con lai van 401
    // (khong phai 503 tu config, vi env du de config nap duoc).
    resetCachedConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = buildApp();
      const env = {
        DB_STAFF_ACCESS: { connectionString: 'postgresql://nobody@127.0.0.1:1/db-staff-access' },
        AUTH_INTERNAL_SECRET: 'internal-secret-test',
      };
      expect((await app.request('/health', {}, env)).status).toBe(200);
      expect((await app.request('/ready', {}, env)).status).not.toBe(401);
      for (const path of ['/health/', '/ready/extra', '/staff', '/roles', '/']) {
        expect((await app.request(path, {}, env)).status, `${path} must require an envelope`).toBe(
          401,
        );
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe('loadStaffAccessConfig', () => {
  it('accepts a bound Hyperdrive object and exposes its connection string', () => {
    const config = loadStaffAccessConfig({
      DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
      AUTH_INTERNAL_SECRET: 'internal-secret-test',
    });
    expect(config.hyperdrive.connectionString).toBe('postgres://x');
  });

  it('rejects a missing binding with the configuration error naming the variable', () => {
    expect(() => loadStaffAccessConfig(undefined)).toThrow(StaffAccessAppConfigurationError);
    expect(() => loadStaffAccessConfig({})).toThrow(/DB_STAFF_ACCESS/u);
    expect(() => loadStaffAccessConfig({ DB_STAFF_ACCESS: { connectionString: '' } })).toThrow(
      /DB_STAFF_ACCESS/u,
    );
  });
});
