/**
 * Unit test của `account/client.ts` — kết quả discriminated cho từng
 * nhánh hạ tầng, không ném (06 §9: spec colocated không boot DB/worker thật).
 *
 * ⚠️ Mock dừng ở đúng ranh giới mà module này nhìn thấy: Service Binding
 * (`fetch`) — mọi thứ khác là code thật (`signRequest` canonical thật, validator
 * contract thật). Vì binding là transport, một fake `fetch` là đủ để mô phỏng
 * từng chế độ lỗi mà không cần worker account thật.
 */

import { describe, expect, it, vi } from 'vitest';

import { ACCOUNT_PROFILES_MAX_SUBS, accountProfilesResponse } from '@ecoma-io/account-contracts';

import {
  accountClientConfig,
  ACCOUNT_SERVICE_BINDING_NAME,
  AUTH_INTERNAL_SECRET_ENV,
  fetchAccountProfiles,
  type AccountServiceBinding,
} from './client';

const SECRET = 'unit-test-internal-secret-0123456789abcdef';

/** `sub_` + 32 ký tự base32 viết thường. */
function makeSub(seed: string): string {
  return `sub_${seed.padEnd(32, 'a').slice(0, 32)}`;
}

/** Fake binding trả một response sẵn. */
function fakeBinding(response: Response | Error): AccountServiceBinding {
  return {
    fetch: vi.fn<(input: Request, init?: RequestInit) => Promise<Response>>(async () => {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }),
  };
}

/** Môi trường `env` Worker với binding + secret — truyền thẳng vào config. */
function envWith(binding: AccountServiceBinding | null, secret: string | null): unknown {
  return {
    [ACCOUNT_SERVICE_BINDING_NAME]: binding,
    [AUTH_INTERNAL_SECRET_ENV]: secret,
  };
}

/**
 * Dựng config đã qua kiểm hình dạng cho test — đi qua `accountClientConfig`
 * thật để secret luôn sống trong closure của `signHeaders`, đúng như production:
 * test không tự tay dựng `{ binding, secret }` vì shape đó không còn tồn tại.
 */
function configWith(
  binding: AccountServiceBinding,
  secret: string,
): NonNullable<ReturnType<typeof accountClientConfig>> {
  const config = accountClientConfig(envWith(binding, secret));
  if (config === null) {
    throw new Error('configWith: envWith produced a null config — test env shape drifted');
  }
  return config;
}

describe('accountClientConfig', () => {
  it('reads the binding from the worker env and keeps the secret out of the config', () => {
    const binding = fakeBinding(new Response('{}'));
    const config = accountClientConfig(envWith(binding, SECRET));
    expect(config).not.toBeNull();
    expect(config?.binding).toBe(binding);
    // Secret không là property của config — chỉ tiếp cận được qua `signHeaders`.
    expect('secret' in (config as object)).toBe(false);
    expect(typeof config?.signHeaders).toBe('function');
  });

  it('signs with the env secret through signHeaders', async () => {
    const binding = fakeBinding(new Response('{}'));
    const config = accountClientConfig(envWith(binding, SECRET));
    const headers = await config?.signHeaders('/internal/account/profiles?subs=sub_x');
    expect(headers?.['x-ecoma-internal-signature']).toMatch(/^v1=[0-9a-f]+$/u);
    expect(headers?.['x-ecoma-internal-timestamp']).toMatch(/^\d+$/u);
    expect(headers?.['x-ecoma-internal-nonce']).toBeTruthy();
  });

  it.each([
    ['no env object at all', undefined],
    ['binding missing', envWith(null, SECRET)],
    ['secret missing', envWith(fakeBinding(new Response('{}')), null)],
    ['secret empty string', envWith(fakeBinding(new Response('{}')), '')],
    // `accountClientConfig` nhận `unknown` — env sai hình dạng ("binding" không
    // có `fetch`) vẫn phải trả `null`, không ném; cast vì `envWith` định hình
    // đúng cho các nhánh còn lại.
    ['binding without fetch', envWith({ notFetch: 1 } as never, SECRET)],
  ])('returns null when %s', (_label, env) => {
    expect(accountClientConfig(env)).toBeNull();
  });
});

describe('fetchAccountProfiles — ok', () => {
  it('returns validated profiles for a well-formed response', async () => {
    const sub = makeSub('01');
    const profiles = accountProfilesResponse([{ sub, displayName: 'Nguyễn Văn A' }]);
    const binding = fakeBinding(new Response(JSON.stringify(profiles), { status: 200 }));

    const result = await fetchAccountProfiles(configWith(binding, SECRET), [sub]);

    expect(result).toEqual({ ok: true, profiles: [{ sub, displayName: 'Nguyễn Văn A' }] });
  });

  it('returns an empty batch without calling the binding for an empty sub list', async () => {
    const binding = fakeBinding(new Response('{}'));
    const result = await fetchAccountProfiles(configWith(binding, SECRET), []);
    expect(result).toEqual({ ok: true, profiles: [] });
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('deduplicates the requested subs before signing', async () => {
    const sub = makeSub('02');
    const binding = fakeBinding(
      new Response(JSON.stringify(accountProfilesResponse([{ sub, displayName: null }])), {
        status: 200,
      }),
    );

    await fetchAccountProfiles(configWith(binding, SECRET), [sub, sub]);

    const request = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Request;
    expect(request.url).toContain(`subs=${sub}`);
    expect(request.url).not.toContain(`${sub},${sub}`);
  });
});

describe('fetchAccountProfiles — infrastructure failures, no throw', () => {
  it('returns unreachable when the binding fetch throws', async () => {
    const binding = fakeBinding(new Error('network down'));
    const result = await fetchAccountProfiles(configWith(binding, SECRET), [makeSub('03')]);
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('returns http_error on a non-OK response', async () => {
    const binding = fakeBinding(new Response('nope', { status: 503 }));
    const result = await fetchAccountProfiles(configWith(binding, SECRET), [makeSub('04')]);
    expect(result).toEqual({ ok: false, reason: 'http_error' });
  });

  it('returns invalid_response for a non-JSON body', async () => {
    const binding = fakeBinding(new Response('not-json', { status: 200 }));
    const result = await fetchAccountProfiles(configWith(binding, SECRET), [makeSub('05')]);
    expect(result).toEqual({ ok: false, reason: 'invalid_response' });
  });

  it.each([
    ['a body outside the contract', { profiles: [{ sub: makeSub('06'), email: 'x@y.z' }] }],
    ['a wrong shape', { nope: true }],
    [
      'an oversized batch',
      {
        profiles: Array.from({ length: ACCOUNT_PROFILES_MAX_SUBS + 1 }, (_, i) => ({
          sub: makeSub(String(i)),
          displayName: null,
        })),
      },
    ],
  ])('returns invalid_response for %s', async (_label, body) => {
    const binding = fakeBinding(new Response(JSON.stringify(body), { status: 200 }));
    const result = await fetchAccountProfiles(configWith(binding, SECRET), [makeSub('07')]);
    expect(result).toEqual({ ok: false, reason: 'invalid_response' });
  });

  it('signs the request with the canonical envelope headers', async () => {
    const binding = fakeBinding(
      new Response(JSON.stringify(accountProfilesResponse([])), { status: 200 }),
    );
    await fetchAccountProfiles(configWith(binding, SECRET), [makeSub('08')]);

    const init = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // Envelope HMAC `ecoma-internal-v1` — header names ghim để một rename ở lib
    // không lặng lẽ làm mọi call fail `bad_signature` mà không gì đỏ ở unit layer.
    // Signature mang prefix version (`v1=<hex>`).
    expect(headers['x-ecoma-internal-signature']).toMatch(/^v1=[0-9a-f]+$/u);
    expect(headers['x-ecoma-internal-timestamp']).toMatch(/^\d+$/u);
    expect(headers['x-ecoma-internal-nonce']).toBeTruthy();
  });
});
