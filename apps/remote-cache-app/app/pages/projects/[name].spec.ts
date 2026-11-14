import { afterEach, describe, expect, it, vi } from 'vitest';

import DetailPage from './[name].vue';
import { mountRemoteCacheAppPage, flush } from '../../../tests/harness';
import { i18n, remoteCacheAppStores } from '../../../tests/nuxt-globals';

/** Metadata key hợp lệ theo wire contract — dùng lại cho mọi test case. */
const KEY_DEVELOPER = {
  id: '0f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0a',
  project_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  scopes: ['read'],
  credential_class: 'developer',
  revoked_at: null,
  created_at: '2026-11-15T00:00:00Z',
};

const KEY_TRUSTED_CI = {
  ...KEY_DEVELOPER,
  id: '1f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0b',
  scopes: ['read', 'write'],
  credential_class: 'trusted_ci',
};

function keysEndpoint(): { path: string; body: unknown } {
  return {
    path: '/api/portal/tenants/ecoma/projects/orders-cache/api-keys',
    body: {
      project: {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        name: 'orders-cache',
        created_at: '2026-11-15T00:00:00Z',
      },
      api_keys: [KEY_DEVELOPER, KEY_TRUSTED_CI],
    },
  };
}

function mountDetail(): ReturnType<typeof Object> {
  remoteCacheAppStores.route.params = { name: 'orders-cache' };
  return DetailPage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.global.locale.value = 'en';
  remoteCacheAppStores.route.params = {};
});

/**
 * Hợp đồng render của trang chi tiết project (R19/R20):
 *
 * 1. Metadata key render từ response BFF — KHÔNG BAO GIỜ có token trên trang
 *    (chốt chặn SR "metadata không secret" ở tầng UI).
 * 2. Phân biệt developer vs trusted CI là trực quan (badge với testid riêng).
 * 3. Revoke qua dialog xác nhận; submit gọi đúng route revoke.
 * 4. Tạo key thành công mở hộp thoại show-once với token.
 */
describe('project detail page', () => {
  it('renders key metadata rows and never a token', async () => {
    const Page = mountDetail();
    const wrapper = await mountRemoteCacheAppPage(Page, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
      fetchEndpoints: [keysEndpoint()],
    });

    expect(wrapper.find('[data-testid="remote-cache-app-keys-table"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('read');
    // SR "metadata không secret": phần tử token của hộp thoại show-once KHÔNG
    // bao giờ render ở trang danh sách — chuỗi 'token' trong description là
    // hợp lệ (nó là copy hướng dẫn), giá trị token thì không có nguồn nào.
    expect(wrapper.find('[data-testid="remote-cache-app-show-once"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('visually distinguishes developer from trusted CI keys', async () => {
    const Page = mountDetail();
    const wrapper = await mountRemoteCacheAppPage(Page, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
      fetchEndpoints: [keysEndpoint()],
    });

    expect(wrapper.find('[data-testid="remote-cache-app-key-class-developer"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="remote-cache-app-key-class-trusted-ci"]').exists()).toBe(
      true,
    );
    wrapper.unmount();
  });

  it('revokes an active key through the confirm dialog', async () => {
    const Page = mountDetail();
    const fetchCalls: { url: string; method: string }[] = [];
    const endpoint = keysEndpoint();
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          fetchCalls.push({ url, method: init?.method ?? 'GET' });
          if (init?.method === 'POST' && url.endsWith('/revoke')) {
            return new Response(
              JSON.stringify({
                api_key: { id: KEY_DEVELOPER.id, revoked_at: '2026-11-15T10:00:00Z' },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify(endpoint.body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      ) as unknown as typeof fetch,
    );

    const wrapper = await mountRemoteCacheAppPage(Page, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
    });

    // Bấm revoke của key developer — dialog mở ra. Dialog render qua Teleport
    // tới `body` nên phải tra DOM toàn cục, không phải wrapper.
    wrapper.find(`[data-testid="remote-cache-app-revoke-${KEY_DEVELOPER.id}"]`).trigger('click');
    await flush();

    const confirm = document.body.querySelector('[data-testid="remote-cache-app-revoke-confirm"]');
    expect(confirm).not.toBeNull();
    document.body
      .querySelector('[data-testid="remote-cache-app-revoke-confirm-submit"]')
      ?.dispatchEvent(new Event('click'));
    await flush();

    const revokeCall = fetchCalls.find((call) => call.url.endsWith('/revoke'));
    expect(revokeCall).toEqual({
      url: `/api/portal/tenants/ecoma/projects/orders-cache/api-keys/${KEY_DEVELOPER.id}/revoke`,
      method: 'POST',
    });
    // Sau revoke, dialog đóng.
    expect(
      document.body.querySelector('[data-testid="remote-cache-app-revoke-confirm"]'),
    ).toBeNull();
    wrapper.unmount();
  });

  it('opens the show-once dialog with the token after creating a key', async () => {
    const Page = mountDetail();
    const endpoint = keysEndpoint();
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'POST') {
            return new Response(
              JSON.stringify({
                api_key: {
                  id: '2f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0c',
                  scopes: ['read'],
                  credential_class: 'developer',
                  token: 'rc_once_abc123',
                },
              }),
              { status: 201, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify(endpoint.body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      ) as unknown as typeof fetch,
    );

    const wrapper = await mountRemoteCacheAppPage(Page, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
    });

    wrapper.find('[data-testid="remote-cache-app-create-key"]').trigger('click');
    await flush();

    // Dialog show-once cũng render qua Teleport tới `body`.
    const dialog = document.body.querySelector('[data-testid="remote-cache-app-show-once"]');
    expect(dialog).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="remote-cache-app-show-once-token"]')?.textContent,
    ).toContain('rc_once_abc123');
    wrapper.unmount();
  });
});
