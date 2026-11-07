import { describe, expect, it, vi } from 'vitest';

import {
  STAFF_ACCESS_SECRET_ENV,
  STAFF_ACCESS_SERVICE_BINDING_NAME,
} from '@ecoma-io/backoffice-infrastructure';

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin);

const { httpStaffAccessServiceBinding, mountStaffAccessServiceBinding } =
  await import('./staff-access-service-shim');

describe('mountStaffAccessServiceBinding', () => {
  it('creates the Node runtime environment and binding from the configured URL', () => {
    const context: Record<string, unknown> = {};

    mountStaffAccessServiceBinding({
      context,
      origin: 'http://staff-access:8787',
      secret: 'test-secret',
    });

    const env = (context.cloudflare as { env: Record<string, unknown> }).env;
    expect(env[STAFF_ACCESS_SERVICE_BINDING_NAME]).toBeDefined();
    expect(env[STAFF_ACCESS_SECRET_ENV]).toBe('test-secret');
  });

  it('keeps the context unchanged when the URL is missing', () => {
    const context: Record<string, unknown> = {};

    mountStaffAccessServiceBinding({ context, origin: undefined });

    expect(context).toEqual({});
  });

  it('does not replace an existing binding', () => {
    const existing = { fetch: vi.fn<() => void>() };
    const context: Record<string, unknown> = {
      cloudflare: { env: { [STAFF_ACCESS_SERVICE_BINDING_NAME]: existing } },
    };

    mountStaffAccessServiceBinding({
      context,
      origin: 'http://staff-access:8787',
    });

    const env = (context.cloudflare as { env: Record<string, unknown> }).env;
    expect(env[STAFF_ACCESS_SERVICE_BINDING_NAME]).toBe(existing);
  });
});

describe('httpStaffAccessServiceBinding', () => {
  it('rewrites only the origin while preserving the request path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const binding = httpStaffAccessServiceBinding({
      origin: 'http://staff-access:8787/base',
      fetchImpl,
    });

    await binding.fetch(new Request('https://backoffice.example/api/staff?limit=10'));

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://staff-access:8787/api/staff?limit=10',
      }),
      undefined,
    );
  });
});
