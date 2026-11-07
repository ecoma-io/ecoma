import { describe, expect, it } from 'vitest';

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
