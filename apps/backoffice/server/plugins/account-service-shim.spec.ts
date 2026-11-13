import { describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_INTERNAL_SECRET_ENV,
  ACCOUNT_SERVICE_BINDING_NAME,
  AUTH_INTERNAL_SECRET_ENV,
  accountClientConfig,
} from '@ecoma-io/backoffice-infrastructure';

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin);

const { httpAccountServiceBinding, mountAccountServiceBinding } =
  await import('./account-service-shim');

describe('mountAccountServiceBinding', () => {
  it('creates the Node runtime environment and binding from the configured URL', () => {
    const context: Record<string, unknown> = {};

    mountAccountServiceBinding({
      context,
      origin: 'http://account:4202',
      secret: 'test-secret',
    });

    const env = (context.cloudflare as { env: Record<string, unknown> }).env;
    expect(env[ACCOUNT_SERVICE_BINDING_NAME]).toBeDefined();
    expect(env[ACCOUNT_INTERNAL_SECRET_ENV]).toBe('test-secret');
  });

  it('injects the pair secret without touching the generic internal secret', () => {
    // Container local giữ secret cặp staff-access trong `AUTH_INTERNAL_SECRET`
    // — shim của account phải để nguyên giá trị đó và chỉ nạp secret của mình
    // vào tên riêng, nếu không mọi gọi staff-access ký sai khoá.
    const context: Record<string, unknown> = {
      cloudflare: { env: { [AUTH_INTERNAL_SECRET_ENV]: 'staff-access-pair-secret' } },
    };

    mountAccountServiceBinding({
      context,
      origin: 'http://account:4202',
      secret: 'account-pair-secret',
    });

    const env = (context.cloudflare as { env: Record<string, unknown> }).env;
    expect(env[AUTH_INTERNAL_SECRET_ENV]).toBe('staff-access-pair-secret');
    expect(env[ACCOUNT_INTERNAL_SECRET_ENV]).toBe('account-pair-secret');
  });

  it('keeps the context unchanged when the URL is missing', () => {
    const context: Record<string, unknown> = {};

    mountAccountServiceBinding({ context, origin: undefined });

    expect(context).toEqual({});
  });

  it('does not replace an existing binding', () => {
    const existing = { fetch: vi.fn<() => void>() };
    const context: Record<string, unknown> = {
      cloudflare: { env: { [ACCOUNT_SERVICE_BINDING_NAME]: existing } },
    };

    mountAccountServiceBinding({
      context,
      origin: 'http://account:4202',
    });

    const env = (context.cloudflare as { env: Record<string, unknown> }).env;
    expect(env[ACCOUNT_SERVICE_BINDING_NAME]).toBe(existing);
  });

  it('yields a config the account client accepts for signing', async () => {
    const context: Record<string, unknown> = {};
    mountAccountServiceBinding({
      context,
      origin: 'http://account:4202',
      secret: 'account-pair-secret',
    });
    const env = (context.cloudflare as { env: Record<string, unknown> }).env;

    const config = accountClientConfig(env);
    expect(config).not.toBeNull();
    const headers = await config?.signHeaders('/internal/account/profiles?subs=sub_x');
    expect(headers?.['x-ecoma-internal-signature']).toMatch(/^v1=[0-9a-f]+$/u);
  });
});

describe('httpAccountServiceBinding', () => {
  it('rewrites only the origin while preserving the request path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const binding = httpAccountServiceBinding({
      origin: 'http://account:4202/base',
      fetchImpl,
    });

    await binding.fetch(
      new Request('https://account.internal/internal/account/profiles?subs=sub_x'),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://account:4202/internal/account/profiles?subs=sub_x',
      }),
      undefined,
    );
  });

  it('propagates the init signal of the caller', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const binding = httpAccountServiceBinding({ origin: 'http://account:4202', fetchImpl });

    const signal = AbortSignal.timeout(1_000);
    await binding.fetch(new Request('https://account.internal/x'), { signal });

    expect(fetchImpl).toHaveBeenCalledWith(expect.anything(), { signal });
  });
});
