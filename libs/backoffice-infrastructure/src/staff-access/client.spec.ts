/**
 * Unit test của `staff-access/client.ts` — kết quả discriminated cho từng
 * nhánh hạ infrastructure, không ném (06 §9: spec colocated không boot
 * Worker thật).
 *
 * ⚠️ Mock dừng ở đúng ranh giới mà module này nhìn thấy: Service Binding
 * (`fetch`) — mọi thứ khác là code thật (`signRequest` canonical thật,
 * validator contract thật). Vì binding là transport, một fake `fetch` là
 * đủ để mô phỏng từng chế độ lỗi mà không cần worker staff-access thật.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  permissionEntry,
  roleListResponse,
  staffListResponse,
} from '@ecoma-io/staff-access-contracts';

import {
  staffAccessClientConfig,
  STAFF_ACCESS_SERVICE_BINDING_NAME,
  STAFF_ACCESS_SECRET_ENV,
  fetchStaffDirectory,
  fetchRoleCatalog,
  fetchPermissionCatalog,
  type StaffServiceBinding,
} from './client';

const SECRET = 'unit-test-internal-secret-0123456789abcdef';

/** Fake binding trả một response sẵn. */
function fakeBinding(response: Response | Error): StaffServiceBinding {
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
function envWith(binding: StaffServiceBinding | null, secret: string | null): unknown {
  return {
    [STAFF_ACCESS_SERVICE_BINDING_NAME]: binding,
    [STAFF_ACCESS_SECRET_ENV]: secret,
  };
}

/**
 * Dựng config đã qua kiểm hình dạng cho test — đi qua `staffAccessClientConfig`
 * thật để secret luôn sống trong closure của `signHeaders`, đúng như production:
 * test không tự tay dựng `{ binding, secret }` vì shape đó không còn tồn tại.
 */
function configWith(
  binding: StaffServiceBinding,
  secret: string,
): NonNullable<ReturnType<typeof staffAccessClientConfig>> {
  const config = staffAccessClientConfig(envWith(binding, secret));
  if (config === null) {
    throw new Error('configWith: envWith produced a null config — test env shape drifted');
  }
  return config;
}

describe('staffAccessClientConfig', () => {
  it('reads the binding from the worker env and keeps the secret out of the config', () => {
    const binding = fakeBinding(new Response('{}'));
    const config = staffAccessClientConfig(envWith(binding, SECRET));
    expect(config).not.toBeNull();
    expect(config?.binding).toBe(binding);
    // Secret không là property của config — chỉ tiếp cận được qua `signHeaders`.
    expect('secret' in (config as object)).toBe(false);
    expect(typeof config?.signHeaders).toBe('function');
  });

  it('signs with the env secret through signHeaders', async () => {
    const binding = fakeBinding(new Response('{}'));
    const config = staffAccessClientConfig(envWith(binding, SECRET));
    const headers = await config?.signHeaders('/staff');
    expect(headers?.['x-ecoma-internal-signature']).toMatch(/^v1=[0-9a-f]+$/u);
    expect(headers?.['x-ecoma-internal-timestamp']).toMatch(/^\d+$/u);
    expect(headers?.['x-ecoma-internal-nonce']).toBeTruthy();
  });

  it.each([
    ['no env object at all', undefined],
    ['binding missing', envWith(null, SECRET)],
    ['secret missing', envWith(fakeBinding(new Response('{}')), null)],
    ['secret empty string', envWith(fakeBinding(new Response('{}')), '')],
    // `staffAccessClientConfig` nhận `unknown` — env sai hình dạng ("binding" không
    // có `fetch`) vẫn phải trả `null`, không ném; cast vì `envWith` định hình
    // đúng cho các nhánh còn lại.
    ['binding without fetch', envWith({ notFetch: 1 } as never, SECRET)],
  ])('returns null when %s', (_label, env) => {
    expect(staffAccessClientConfig(env)).toBeNull();
  });
});

describe('fetchStaffDirectory — ok', () => {
  it('returns validated staff for a well-formed response', async () => {
    const body = staffListResponse(
      [
        {
          id: 's1',
          sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'active',
          display_name: 'Nguyễn Văn A',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      null,
    );
    const binding = fakeBinding(new Response(JSON.stringify(body), { status: 200 }));

    const result = await fetchStaffDirectory(configWith(binding, SECRET));

    expect(result).toEqual({ ok: true, staff: body.staff });
  });

  it('returns empty staff without calling the binding for empty response', async () => {
    const body = staffListResponse([], null);
    const binding = fakeBinding(new Response(JSON.stringify(body), { status: 200 }));

    const result = await fetchStaffDirectory(configWith(binding, SECRET));

    expect(result).toEqual({ ok: true, staff: [] });
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetchRoleCatalog — ok', () => {
  it('returns validated roles for a well-formed response', async () => {
    const body = roleListResponse(
      [
        {
          id: 'operator',
          name: 'Operator',
          kind: 'system',
          permissions: ['staff.read'],
          status: 'active',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      null,
    );
    const binding = fakeBinding(new Response(JSON.stringify(body), { status: 200 }));

    const result = await fetchRoleCatalog(configWith(binding, SECRET));

    expect(result).toEqual({ ok: true, roles: body.roles });
  });
});

describe('fetchPermissionCatalog — ok', () => {
  it('returns validated permissions for a well-formed response', async () => {
    const body = {
      permissions: [permissionEntry('staff', 'read', 'active', '2026-01-01T00:00:00Z')],
      next_cursor: null,
    };
    const binding = fakeBinding(new Response(JSON.stringify(body), { status: 200 }));

    const result = await fetchPermissionCatalog(configWith(binding, SECRET));

    expect(result).toEqual({ ok: true, permissions: body.permissions });
  });
});

describe('staff-access call failures, no throw', () => {
  it.each([
    [
      'staff',
      () => fetchStaffDirectory(configWith(fakeBinding(new Error('network down')), SECRET)),
    ],
    ['roles', () => fetchRoleCatalog(configWith(fakeBinding(new Error('network down')), SECRET))],
    [
      'permissions',
      () => fetchPermissionCatalog(configWith(fakeBinding(new Error('network down')), SECRET)),
    ],
  ])('returns unreachable when %s binding fetch throws', async (_label, call) => {
    await expect(call()).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  it.each([
    [
      'staff',
      () =>
        fetchStaffDirectory(configWith(fakeBinding(new Response('nope', { status: 503 })), SECRET)),
    ],
    [
      'roles',
      () =>
        fetchRoleCatalog(configWith(fakeBinding(new Response('nope', { status: 503 })), SECRET)),
    ],
    [
      'permissions',
      () =>
        fetchPermissionCatalog(
          configWith(fakeBinding(new Response('nope', { status: 503 })), SECRET),
        ),
    ],
  ])('returns http_error on %s non-OK response', async (_label, call) => {
    await expect(call()).resolves.toEqual({ ok: false, reason: 'http_error' });
  });

  it.each([
    [
      'staff',
      () =>
        fetchStaffDirectory(
          configWith(fakeBinding(new Response('not-json', { status: 200 })), SECRET),
        ),
    ],
    [
      'roles',
      () =>
        fetchRoleCatalog(
          configWith(fakeBinding(new Response('not-json', { status: 200 })), SECRET),
        ),
    ],
    [
      'permissions',
      () =>
        fetchPermissionCatalog(
          configWith(fakeBinding(new Response('not-json', { status: 200 })), SECRET),
        ),
    ],
  ])('returns invalid_response for %s non-JSON body', async (_label, call) => {
    await expect(call()).resolves.toEqual({ ok: false, reason: 'invalid_response' });
  });

  it.each([
    [
      'staff',
      () =>
        fetchStaffDirectory(
          configWith(
            fakeBinding(new Response(JSON.stringify({ nope: true }), { status: 200 })),
            SECRET,
          ),
        ),
    ],
    [
      'roles',
      () =>
        fetchRoleCatalog(
          configWith(
            fakeBinding(new Response(JSON.stringify({ nope: true }), { status: 200 })),
            SECRET,
          ),
        ),
    ],
    [
      'permissions',
      () =>
        fetchPermissionCatalog(
          configWith(
            fakeBinding(new Response(JSON.stringify({ nope: true }), { status: 200 })),
            SECRET,
          ),
        ),
    ],
  ])('returns invalid_response for %s body outside contract', async (_label, call) => {
    await expect(call()).resolves.toEqual({ ok: false, reason: 'invalid_response' });
  });

  it('signs the staff request with the canonical envelope headers', async () => {
    const binding = fakeBinding(
      new Response(JSON.stringify(staffListResponse([], null)), { status: 200 }),
    );
    await fetchStaffDirectory(configWith(binding, SECRET));

    const init = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-ecoma-internal-signature']).toMatch(/^v1=[0-9a-f]+$/u);
    expect(headers['x-ecoma-internal-timestamp']).toMatch(/^\d+$/u);
    expect(headers['x-ecoma-internal-nonce']).toBeTruthy();
  });

  it('calls /staff with signed path', async () => {
    const binding = fakeBinding(
      new Response(JSON.stringify(staffListResponse([], null)), { status: 200 }),
    );
    await fetchStaffDirectory(configWith(binding, SECRET));
    const input = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Request;
    expect(input.url).toContain('/staff');
  });

  it('calls /roles with signed path', async () => {
    const binding = fakeBinding(
      new Response(JSON.stringify(roleListResponse([], null)), { status: 200 }),
    );
    await fetchRoleCatalog(configWith(binding, SECRET));
    const input = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Request;
    expect(input.url).toContain('/roles');
  });

  it('calls /permissions with signed path', async () => {
    const binding = fakeBinding(
      new Response(JSON.stringify({ permissions: [], next_cursor: null }), { status: 200 }),
    );
    await fetchPermissionCatalog(configWith(binding, SECRET));
    const input = (binding.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Request;
    expect(input.url).toContain('/permissions');
  });
});
