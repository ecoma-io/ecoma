import { afterEach, describe, expect, it, vi } from 'vitest';

import IndexPage from './index.vue';
import { mountRemoteCacheAppPage } from '../../tests/harness';
import { i18n } from '../../tests/nuxt-globals';

afterEach(() => {
  vi.unstubAllGlobals();
  // `i18n` là singleton cấp module: trả locale về mặc định để test sau không
  // phụ thuộc thứ tự chạy (`tests/setup.ts` cũng làm việc này ở `beforeEach`).
  i18n.global.locale.value = 'en';
});

/**
 * Hợp đồng render của trang Projects — trang gốc của portal (R19).
 *
 * Bốn bất biến:
 *
 * 1. **Đúng một `<h1>`**, và nó là tiêu đề đã dịch. Shell không render heading
 *    nào, nên hai `h1` là một lỗi a11y thật (đường điều hướng bằng phím H bị
 *    phá), không phải chi tiết trình bày.
 * 2. **Trạng thái rỗng theo locale** — kiểm cả `en` và `vi` trên catalog thật;
 *    một bản dịch rơi về tiếng Anh là đỏ ngay.
 * 3. **Không gọi BFF khi tenant vắng** — tenant name lấy từ runtime config;
 *    giá trị vắng là trạng thái unavailable, không phải một lần fetch rỗng.
 * 4. **Bảng project render từ response BFF thật** — stub fetch với body theo
 *    đúng wire contract của list projects (`{projects, next_cursor}`), trang
 *    render từng tên như một link tới trang chi tiết.
 */
describe('projects page', () => {
  it('renders exactly one localized h1', async () => {
    const wrapper = await mountRemoteCacheAppPage(IndexPage, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
    });

    const headings = wrapper.findAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.text()).toBe('Projects');
    wrapper.unmount();
  });

  it('renders the empty state in Vietnamese when the composer is set to vi', async () => {
    i18n.global.locale.value = 'vi';

    const wrapper = await mountRemoteCacheAppPage(IndexPage, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
      fetchEndpoints: [
        {
          path: '/api/portal/tenants/ecoma/projects',
          body: { projects: [], next_cursor: null },
        },
      ],
    });

    expect(wrapper.findAll('h1')[0]?.text()).toBe('Dự án');
    expect(wrapper.text()).toContain('Chưa có dự án nào');
    wrapper.unmount();
  });

  it('does not call the BFF when the tenant name is absent', async () => {
    const fetchSpy = vi.fn<() => Promise<Response>>();
    vi.stubGlobal('fetch', fetchSpy);

    const wrapper = await mountRemoteCacheAppPage(IndexPage, { runtimeConfig: {} });

    expect(fetchSpy).not.toHaveBeenCalled();
    // Fail-closed: trạng thái unavailable, không phải trạng thái rỗng nghiệp vụ.
    expect(wrapper.find('[data-testid="remote-cache-app-unavailable"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('renders project rows from a contract-shaped BFF response', async () => {
    const wrapper = await mountRemoteCacheAppPage(IndexPage, {
      runtimeConfig: { remoteCacheTenantName: 'ecoma' },
      fetchEndpoints: [
        {
          path: '/api/portal/tenants/ecoma/projects',
          body: {
            projects: [
              { id: '11111111-1111-4111-8111-111111111111', name: 'orders-cache', created_at: '2026-11-15T00:00:00Z' },
            ],
            next_cursor: null,
          },
        },
      ],
    });

    const table = wrapper.find('[data-testid="remote-cache-app-projects-table"]');
    expect(table.exists()).toBe(true);
    expect(table.text()).toContain('orders-cache');
    // Link tới trang chi tiết — điều hướng portal là việc của router client.
    expect(table.find('a[href="/projects/orders-cache"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
