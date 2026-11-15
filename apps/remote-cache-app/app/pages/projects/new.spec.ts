import { afterEach, describe, expect, it, vi } from 'vitest';

import NewPage from './new.vue';
import { mountRemoteCacheAppPage, flush } from '../../../tests/harness';
import { i18n } from '../../../tests/nuxt-globals';

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.global.locale.value = 'en';
});

/**
 * Hợp đồng render của trang create project (R19):
 *
 * 1. Submit với tên hợp lệ gọi đúng BFF route và body `{name}`.
 * 2. 201 → token từ response đi vào hộp thoại show-once, KHÔNG render vào trang.
 * 3. Đóng hộp thoại thả token — SR show-once ở tầng UI.
 * 4. Tên không hợp lệ (viết hoa) tắt nút submit — mirror contract control plane.
 */
describe('create project page', () => {
  it('submits the project name and opens the show-once dialog with the returned token', async () => {
    const fetchCalls: { url: string; method: string; body: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const body = typeof init?.body === 'string' ? init.body : null;
          if (init?.method === 'POST') {
            fetchCalls.push({ url, method: init.method, body });
          }
          return new Response(
            JSON.stringify({
              project: {
                id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                name: 'orders-cache',
                created_at: '2026-11-15T00:00:00Z',
              },
              api_key: {
                id: '2f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0c',
                scopes: ['read'],
                credential_class: 'developer',
                token: 'rc_once_abc123',
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
      ) as unknown as typeof fetch,
    );

    const wrapper = await mountRemoteCacheAppPage(NewPage, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
    });

    await wrapper
      .find('[data-testid="remote-cache-app-create-project-name"]')
      .setValue('orders-cache');
    wrapper.find('[data-testid="remote-cache-app-create-project-form"]').trigger('submit');
    await flush();

    expect(fetchCalls).toEqual([
      {
        url: '/api/portal/tenants/ecoma/projects',
        method: 'POST',
        body: JSON.stringify({ name: 'orders-cache' }),
      },
    ]);

    // Hộp thoại show-once render qua Teleport tới `body`.
    const token = document.body.querySelector('[data-testid="remote-cache-app-show-once-token"]');
    expect(token?.textContent).toContain('rc_once_abc123');
    wrapper.unmount();
  });

  it('drops the token when the show-once dialog is confirmed', async () => {
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<(_input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'POST') postCount += 1;
          return new Response(
            JSON.stringify({
              project: {
                id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                name: 'orders-cache',
                created_at: '2026-11-15T00:00:00Z',
              },
              api_key: {
                id: '2f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0c',
                scopes: ['read'],
                credential_class: 'developer',
                token: 'rc_once_abc123',
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
      ) as unknown as typeof fetch,
    );

    const wrapper = await mountRemoteCacheAppPage(NewPage, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
    });

    await wrapper
      .find('[data-testid="remote-cache-app-create-project-name"]')
      .setValue('orders-cache');
    wrapper.find('[data-testid="remote-cache-app-create-project-form"]').trigger('submit');
    await flush();

    expect(
      document.body.querySelector('[data-testid="remote-cache-app-show-once"]'),
    ).not.toBeNull();

    document.body
      .querySelector('[data-testid="remote-cache-app-show-once-confirm"]')
      ?.dispatchEvent(new Event('click'));
    await flush();

    // SR show-once: dialog đóng và component (cùng token) biến mất.
    expect(document.body.querySelector('[data-testid="remote-cache-app-show-once"]')).toBeNull();
    // Không submit lần hai: token chỉ có một lượt.
    expect(postCount).toBe(1);
    wrapper.unmount();
  });

  it('disables submit for a name outside the project name contract', async () => {
    const wrapper = await mountRemoteCacheAppPage(NewPage, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
    });

    await wrapper.find('[data-testid="remote-cache-app-create-project-name"]').setValue('Orders');
    const submit = wrapper.find('[data-testid="remote-cache-app-create-project-submit"]');
    expect((submit.element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });
});
