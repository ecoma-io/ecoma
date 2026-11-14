import { afterEach, describe, expect, it } from 'vitest';

import OnboardingPage from './onboarding.vue';
import { mountRemoteCacheAppPage } from '../../tests/harness';
import { i18n } from '../../tests/nuxt-globals';

afterEach(() => {
  i18n.global.locale.value = 'en';
});

/**
 * Hợp đồng render của trang Nx onboarding (R21/A33):
 *
 * 1. Endpoint render từ runtime config — giá trị deploy layer ghim, trang
 *    không đoán.
 * 2. Cấu hình Nx hiển thị theo đúng hai biến bắt buộc mà
 *    `docs/applications/remote-cache/03-operations.md` §4 ghim.
 * 3. Trang không hiển thị token nào — credential chỉ được nói tới dạng hướng
 *    dẫn (show-once ở lúc tạo).
 * 4. First-use workflow hiện rõ.
 */
describe('onboarding page', () => {
  it('renders the endpoint from runtime config and both required Nx variables', async () => {
    const wrapper = await mountRemoteCacheAppPage(OnboardingPage, {
      runtimeConfig: { remoteCacheCacheEndpoint: 'https://cache.example.test' },
    });

    const endpoint = wrapper.find('[data-testid="remote-cache-app-onboarding-endpoint"]');
    expect((endpoint.element as HTMLInputElement).value).toBe('https://cache.example.test');
    expect(wrapper.text()).toContain('NX_SELF_HOSTED_REMOTE_CACHE_SERVER');
    expect(wrapper.text()).toContain('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN');
    expect(wrapper.text()).toContain('@ecoma-io/nx-remote-cache');
    wrapper.unmount();
  });

  it('never renders an actual token value', async () => {
    const wrapper = await mountRemoteCacheAppPage(OnboardingPage, {
      runtimeConfig: { remoteCacheCacheEndpoint: 'https://cache.example.test' },
    });

    // Phần tử token của hộp thoại show-once không tồn tại trên trang này.
    expect(wrapper.find('[data-testid="remote-cache-app-show-once"]').exists()).toBe(false);
    // Giá trị access token là placeholder, không phải credential.
    expect(wrapper.text()).toContain('<project-scoped-key>');
    wrapper.unmount();
  });

  it('shows the first-use workflow', async () => {
    const wrapper = await mountRemoteCacheAppPage(OnboardingPage, {
      runtimeConfig: { remoteCacheCacheEndpoint: 'https://cache.example.test' },
    });

    expect(wrapper.find('[data-testid="remote-cache-app-onboarding-first-use"]').exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain('Remote Cache Hit');
    wrapper.unmount();
  });
});
