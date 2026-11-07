// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Component } from 'vue';

/**
 * Render test cho chính page Home (`app/pages/[locale]/index.vue`) — **trong
 * jsdom**, qua `@vue/test-utils` mount. Phạm vi: cây component và việc ghép ba
 * mảnh đã test riêng (`parseHomeLocaleRoot`, `buildHomeSeo`, `HOME_CONTENT`)
 * với `PublicShell` — nếu chỉ test các mảnh rời thì một lỗi ghép (render nhầm
 * locale, quên truyền `path`) vẫn lọt.
 *
 * Đây **không** phải SSR test: jsdom có DOM và không đi qua đường render của
 * server. SSR thật nằm ở `home-ssr.spec.ts` (môi trường node,
 * `vue/server-renderer`), còn `<head>` thật trong response nằm ở runtime smoke
 * trên output đã build.
 *
 * Nuxt auto-import cung cấp `definePageMeta`/`useRoute`/`useHead`/`createError`
 * như biến toàn cục, còn ở đây chỉ có `@vitejs/plugin-vue`, nên các macro và
 * composable được stub bằng `vi.stubGlobal` trước khi mount. `definePageMeta`
 * là stub rỗng: nó chỉ chạy lúc **router** resolve route, không phải lúc
 * render — luật validate đã được phủ trực tiếp ở `home-locale.spec.ts`.
 */

vi.stubGlobal('definePageMeta', (): void => undefined);
vi.stubGlobal('useHead', (): void => undefined);
vi.stubGlobal('createError', (options: { statusCode: number; statusMessage: string }): Error =>
  Object.assign(new Error(options.statusMessage), options),
);

/** Path mà `useRoute()` trả về — đổi trước mỗi lần mount. */
let currentPath = '/en';
vi.stubGlobal('useRoute', () => ({ path: currentPath }));

let HomePage: Component;

beforeAll(async () => {
  // Dynamic import sau khi stub: import tĩnh bị ESM hoist lên trước `stubGlobal`.
  HomePage = ((await import('~/pages/[locale]/index.vue')) as { default: Component }).default;
});

function render(path: string) {
  currentPath = path;
  return mount(HomePage);
}

describe('app/pages/[locale]/index.vue', () => {
  it('renders English content and passes the current pathname down to the shell', () => {
    const wrapper = render('/en');
    const text = wrapper.text();

    expect(text).toContain('Every page is served under a locale prefix');
    expect(text).toContain('Public pages are served from the edge and rendered on the server.');
    // Shell nhận `route.path` nên brand dựng theo chính locale của trang.
    // Anchor đầu header là skip link (`#public-main`) — chọn anchor theo href.
    expect(wrapper.find('header a[href="/en"]').exists()).toBe(true);
    expect(wrapper.find('main').exists()).toBe(true);
    expect(wrapper.find('footer').exists()).toBe(true);
  });

  it('renders Vietnamese content when pathname is /vi', () => {
    const wrapper = render('/vi');
    const text = wrapper.text();

    expect(text).toContain('Mọi trang đều được phục vụ dưới một locale prefix');
    expect(text).toContain('Các trang public được phục vụ từ edge và render ở server.');
    expect(wrapper.find('header a[href="/vi"]').exists()).toBe(true);
  });

  it('each locale renders its own content — no leakage of the other locale', () => {
    const enText = render('/en').text();
    const viText = render('/vi').text();
    expect(enText).not.toContain('Mọi trang đều được phục vụ');
    expect(viText).not.toContain('Every page is served');
  });

  it('does not pass availableLocales — Home exists at every registry locale', () => {
    // Mặc định của shell là toàn bộ registry: locale hiện tại hiển thị dạng
    // `span[aria-current]`, locale còn lại là link có `hreflang`. Nếu Home
    // giới hạn locale thì switcher sẽ chỉ có đúng một mục và mất link switch.
    const header = render('/en').find('header');
    expect(header.html()).toContain('aria-current="true"');
    expect(header.html()).toContain('hreflang="vi-VN"');
    expect(header.find('a[href="/vi"]').exists()).toBe(true);
    expect(header.findAll('nav[aria-label="Language"] li')).toHaveLength(2);
  });

  it('static markup after mount: h1, brand, and content list', () => {
    // Test này **không** phải SSR test — nó mount trong jsdom. Kiểm chứng đường
    // server-render thật (môi trường node, `renderToString`, không DOM) nằm ở
    // `home-ssr.spec.ts`; `<head>` thật trong response nằm ở runtime smoke.
    // Brand giờ là artwork logo (inline `<svg>` với `role="img"` + `aria-label`)
    // trong cả header lẫn footer — pin theo ARIA thay vì `alt` của `<img>`.
    const wrapper = render('/en');
    expect(wrapper.html()).toContain('<h1');
    const brand = wrapper.find('svg[role="img"][aria-label="ecoma.io"]');
    expect(brand.exists()).toBe(true);
    // Mark + wordmark, mỗi phần tô theo token của nó.
    expect(brand.find('path.fill-brand').exists()).toBe(true);
    expect(brand.find('path.fill-foam').exists()).toBe(true);
    expect(wrapper.html()).toContain('Public web, built right');
    expect(wrapper.html()).toContain('<ul');
  });
});
