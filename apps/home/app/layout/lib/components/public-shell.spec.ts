import { describe, it, expect } from 'vitest';
// @vitest-environment jsdom
import type { PublicLocale } from '../../../i18n/index';
import { mount, type DOMWrapper } from '@vue/test-utils';
import { PublicFooter, PublicHeader, PublicShell, parsePublicLayoutPath } from '../../index';

/**
 * Lib tsconfig không có DOM lib — MouseEvent chỉ tồn tại runtime (jsdom).
 * Helper này expose đúng phần test cần: tạo event và đọc `defaultPrevented`.
 */
function domClick(init: { ctrlKey?: boolean }): { defaultPrevented: boolean } {
  const env = globalThis as unknown as {
    MouseEvent: new (t: string, i: object) => { defaultPrevented: boolean };
  };
  return new env.MouseEvent('click', { cancelable: true, ...init });
}

/**
 * Trigger của menu locale — `<button>`, không phải link: nó chỉ điều khiển
 * disclosure nên không có destination.
 */
function languageTrigger(wrapper: ReturnType<typeof mount>): DOMWrapper<Element> {
  return wrapper.find('header nav[aria-label="Language"] button');
}

/**
 * Panel của menu locale — luôn trong DOM, đóng bằng `hidden` (link phải còn
 * cho crawler trong HTML tĩnh).
 */
function languagePanel(wrapper: ReturnType<typeof mount>): DOMWrapper<Element> {
  return wrapper.find('#public-header-language-panel');
}

describe('PublicShell composition', () => {
  it('renders header, main and footer landmarks around slot content', () => {
    const wrapper = mount(PublicShell, {
      props: { path: '/en/blog' },
      slots: { default: '<div class="app-page">APP_CONTENT</div>' },
    });

    const html = wrapper.html();
    expect(wrapper.find('header').exists()).toBe(true);
    expect(wrapper.find('main').exists()).toBe(true);
    expect(wrapper.find('footer').exists()).toBe(true);
    expect(wrapper.find('main').text()).toBe('APP_CONTENT');

    // Thứ tự: header (mở) → main → footer; `<main id=` khớp landmark chính,
    // không trúng `public-main` xuất hiện trước trong skip link của header.
    expect(html.indexOf('<header')).toBeLessThan(html.indexOf('<main id='));
    expect(html.indexOf('<main id=')).toBeLessThan(html.indexOf('<footer'));
  });

  it('keeps application content out of header and footer', () => {
    const wrapper = mount(PublicShell, {
      props: { path: '/vi/docs' },
      slots: { default: '<div>APP_UNIQUE_MARKER_42</div>' },
    });
    expect(wrapper.find('header').html()).not.toContain('APP_UNIQUE_MARKER_42');
    expect(wrapper.find('footer').html()).not.toContain('APP_UNIQUE_MARKER_42');
    expect(wrapper.find('main').html()).toContain('APP_UNIQUE_MARKER_42');
  });

  it('updates chrome reactively when the path prop changes', async () => {
    // Pin reactivity của props destructure trong computed: đổi path (client-side
    // navigation) thì Header/Footer phải re-render theo, không giữ snapshot.
    const wrapper = mount(PublicShell, { props: { path: '/en/blog' } });
    expect(wrapper.find('header a[href="/en"]').attributes('href')).toBe('/en');

    await wrapper.setProps({ path: '/vi/docs' });

    expect(wrapper.find('header a[href="/vi"]').attributes('href')).toBe('/vi');
    // Trigger Docs là disclosure link (`a[href="/vi/docs"]` + aria-expanded);
    // panel đóng vẫn nằm trong DOM (chỉ `hidden`), nên đếm anchor **cấp
    // top-level** của nav (`nav > ul > li > a`) sẽ thấy cả trigger lẫn Blog —
    // lấy link khác trigger để xác nhận chỉ Blog là link thường.
    const links = wrapper.findAll('header nav[aria-label="Global"] > ul > li > a');
    expect(links.map((link) => link.attributes('href'))).toEqual([
      '/vi/docs',
      '/vi/blog',
      '/vi/legal',
    ]);
    expect(links[0]?.text()).toContain('Docs');
    expect(wrapper.find('footer a').attributes('href')).toBe('/vi');
  });

  it('renders without crashing on every path class', () => {
    for (const path of ['/', '/en', '/vi/docs/api', '/en/unknown', 'garbage']) {
      expect(() => mount(PublicShell, { props: { path }, slots: { default: 'X' } })).not.toThrow();
    }
  });
});

describe('PublicHeader', () => {
  it('renders a skip link to the main landmark as the first focusable element', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const first = wrapper.find('header a');
    expect(first.attributes('href')).toBe('#public-main');
    expect(wrapper.find('main').attributes('id')).toBe('public-main');
  });

  it('links the brand to the locale-root surface', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const brand = wrapper.find('header a[href="/en"]');
    // Brand là artwork logo (`EcomaLogo` render inline `<svg>`), accessible name
    // đến từ `aria-label` — không còn text node hay `alt` để assert; pin role
    // và tên để logo mất nhãn phụ vẫn đỏ test.
    const logo = brand.find('svg');
    expect(logo.attributes('role')).toBe('img');
    expect(logo.attributes('aria-label')).toBe('ecoma.io');
    expect(logo.findAll('path')).toHaveLength(2);
  });

  it('renders global navigation with locale-aware hrefs', () => {
    const wrapper = mount(PublicShell, { props: { path: '/vi/blog' } });
    const nav = wrapper.find('header nav[aria-label="Global"]');
    expect(nav.exists()).toBe(true);
    // Mọi mục nav cấp cao nhất đều là `<a href>` thật — kể cả trigger mega
    // panel (no-JS và crawler vẫn có link thật). Combinator trực tiếp `>` để
    // không trúng link trong panel.
    const topLinks = nav.findAll(':scope > ul > li > a');
    expect(topLinks.map((link) => link.attributes('href'))).toEqual([
      '/vi/docs',
      '/vi/blog',
      '/vi/legal',
    ]);
    expect(topLinks[0]?.text()).toContain('Docs');
    const trigger = topLinks[0];
    expect(trigger?.attributes('aria-expanded')).toBe('false');
    expect(trigger?.attributes('aria-controls')).toBe('public-header-panel-docs');
    // Blog là link thường — không có aria-expanded.
    expect(topLinks[1]?.attributes('aria-expanded')).toBeUndefined();
  });

  it('opens the docs disclosure to reveal mount root and group links', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    // Panel luôn trong DOM, đóng bằng `hidden` — không nằm trong accessibility
    // tree khi đóng.
    const panel = wrapper.find('#public-header-panel-docs');
    expect(panel.attributes('hidden')).toBeDefined();

    await trigger.trigger('click');

    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(panel.attributes('hidden')).toBeUndefined();
    const links = panel.findAll('a');
    const hrefs = links.map((link) => link.attributes('href'));
    expect(hrefs).toEqual([
      '/en/docs',
      '/en/docs/getting-started',
      '/en/docs/getting-started/installation',
      '/en/docs/getting-started/first-steps',
      '/en/docs/concepts',
      '/en/docs/concepts/public-web',
      '/en/docs/concepts/content-and-locales',
      '/en/docs/guides',
      '/en/docs/guides/building-a-public-page',
      '/en/docs/guides/local-development',
    ]);
  });

  it('keeps mega panels independent: opening legal does not close docs', async () => {
    // Data v2: mỗi nav item có state disclosure riêng theo id — mở panel thứ
    // hai không tự đóng panel thứ nhất (đóng hàng loạt chỉ qua Escape /
    // focus-out / click-outside).
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const docsTrigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');
    const legalTrigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/legal"]');

    await docsTrigger.trigger('click');
    await legalTrigger.trigger('click');

    expect(docsTrigger.attributes('aria-expanded')).toBe('true');
    expect(legalTrigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('#public-header-panel-docs').attributes('hidden')).toBeUndefined();
    expect(wrapper.find('#public-header-panel-legal').attributes('hidden')).toBeUndefined();

    // Toggle lại docs — legal vẫn mở.
    await docsTrigger.trigger('click');
    expect(docsTrigger.attributes('aria-expanded')).toBe('false');
    expect(legalTrigger.attributes('aria-expanded')).toBe('true');
  });

  it('opens the legal panel revealing the landing and the five policy links', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    // Trigger legal là link thật tới landing `/en/legal` (#116); panel mở
    // đầu bằng chính link landing đó nên no-JS/crawler vẫn vào được Center.
    const trigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/legal"]');
    expect(trigger.attributes('aria-expanded')).toBe('false');

    await trigger.trigger('click');

    const links = wrapper
      .find('#public-header-panel-legal')
      .findAll('a')
      .map((link) => link.attributes('href'));
    expect(links).toEqual([
      '/en/legal',
      '/en/legal',
      '/en/legal/privacy',
      '/en/legal/terms',
      '/en/legal/service-delivery',
      '/en/legal/payment',
      '/en/legal/refund',
    ]);
  });

  it('lets modifier-click through so new-tab navigation reaches the mount root', async () => {
    // `@click.exact.prevent`: guard `exact` chạy trước `prevent` trong
    // withModifiers — modifier-click KHÔNG bị preventDefault (đi native mở
    // tab mới) và panel không toggle. Assert cả defaultPrevented: thứ tự
    // đảo (`prevent.exact`) sẽ prevent rồi mới return — click chết, và test
    // chỉ assert aria-expanded sẽ không bắt được.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');

    const event = domClick({ ctrlKey: true });
    (trigger.element as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('#public-header-panel-docs').attributes('hidden')).toBeDefined();
  });

  it('prevents plain clicks so the panel toggles instead of navigating', async () => {
    // Chiều đối xứng: click thuần bị preventDefault (không điều hướng) và
    // toggle panel.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');

    const event = domClick({});
    (trigger.element as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('#public-header-panel-docs').attributes('hidden')).toBeUndefined();
  });

  it('closes every panel on Escape', async () => {
    // Escape đóng hàng loạt: người dùng thoát điều hướng bằng một phím, không
    // phải đóng từng panel.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const docsTrigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');
    const legalTrigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/legal"]');

    await docsTrigger.trigger('click');
    await legalTrigger.trigger('click');
    expect(docsTrigger.attributes('aria-expanded')).toBe('true');
    expect(legalTrigger.attributes('aria-expanded')).toBe('true');

    await wrapper.find('header').trigger('keydown', { key: 'Escape' });

    expect(wrapper.find('#public-header-panel-docs').attributes('hidden')).toBeDefined();
    expect(wrapper.find('#public-header-panel-legal').attributes('hidden')).toBeDefined();
  });

  it('ignores document clicks whose target was detached mid-dispatch', async () => {
    // Regression: click thật chạm `<path>` của icon hamburger; Vue v-if/v-else
    // swap icon ngay trong handler khiến target bị detach khi event còn đang
    // bubble. Tại document, `contains(detached)` = false và click-outside hiểu
    // nhầm là click ngoài header — menu vừa mở bị đóng tức thì trên trình
    // duyệt thật (jsdom không tái hiện vì mount đồng bộ). Target disconnected
    // phải được bỏ qua, không coi là click ngoài.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const toggle = wrapper.find('button[aria-controls="public-header-mobile-panel"]');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');

    // Mô phỏng event bubble tới document với target đã bị detach (isConnected
    // = false) — không được đóng menu. Target được override bằng
    // `Object.defineProperty` vì jsdom không cho truyền `target` qua init;
    // event đi qua `document` (không qua header) để đường bubble đúng như
    // listener trên document nhìn thấy.
    const detached = document.createElement('path');
    const fakeEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(fakeEvent, 'target', { value: detached, configurable: true });
    document.dispatchEvent(fakeEvent);
    await wrapper.vm.$nextTick();

    // Guard có mặt: menu phải vẫn mở. Thiếu guard, click-outside đọc
    // `contains(detached)` = false và đóng menu — assert này đỏ.
    expect(toggle.attributes('aria-expanded')).toBe('true');
  });

  it('closes disclosures on a real document click outside the header', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const toggle = wrapper.find('button[aria-controls="public-header-mobile-panel"]');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');

    // Click ngoài header (target vẫn connected) phải đóng.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const outsideEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(outsideEvent, 'target', { value: outside, configurable: true });
    document.dispatchEvent(outsideEvent);
    await wrapper.vm.$nextTick();

    expect(toggle.attributes('aria-expanded')).toBe('false');
    outside.remove();
  });

  it('marks the exact current mount with aria-current=page', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/blog' } });
    const nav = wrapper.find('header nav[aria-label="Global"]');
    // Blog (link thường) là trang hiện tại.
    expect(nav.find('a[href="/en/blog"]').attributes('aria-current')).toBe('page');
    // Trigger Docs (disclosure link) mang section sense — ở đây không active.
    expect(nav.find('a[href="/en/docs"]').attributes('aria-current')).toBeUndefined();
  });

  it('marks a nested mount with aria-current=true on the parent trigger', () => {
    // docs/api không có mục riêng trong global nav — pathname dưới mount lồng
    // nhau vẫn hiện thị section cha là đang active, trên chính trigger.
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api/guide' } });
    const nav = wrapper.find('header nav[aria-label="Global"]');
    expect(nav.find('a[href="/en/docs"]').attributes('aria-current')).toBe('true');
    expect(nav.find('a[href="/en/blog"]').attributes('aria-current')).toBeUndefined();
  });

  it('marks a child resource of the current mount with aria-current=true, not page', () => {
    // Trigger Docs trỏ mount root; pathname /en/docs/hello-world là trang con
    // của mount docs — 'page' sẽ sai semantics ARIA, section sense là 'true'.
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/hello-world' } });
    const nav = wrapper.find('header nav[aria-label="Global"]');
    expect(nav.find('a[href="/en/docs"]').attributes('aria-current')).toBe('true');
    expect(nav.find('a[href="/en/blog"]').attributes('aria-current')).toBeUndefined();
  });

  it('marks the exact legal trigger target with aria-current=page', () => {
    // Trigger legal trỏ landing `/legal`; pathname dừng đúng tại đó → 'page',
    // còn một policy khác của cùng mount → 'true' (section sense).
    const atLanding = mount(PublicShell, { props: { path: '/en/legal' } });
    const atTerms = mount(PublicShell, { props: { path: '/en/legal/terms' } });
    expect(
      atLanding
        .find('header nav[aria-label="Global"] a[href="/en/legal"]')
        .attributes('aria-current'),
    ).toBe('page');
    expect(
      atTerms
        .find('header nav[aria-label="Global"] a[href="/en/legal"]')
        .attributes('aria-current'),
    ).toBe('true');
  });

  it('renders no aria-current on the locale-root surface', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const nav = wrapper.find('header nav[aria-label="Global"]');
    for (const el of nav.findAll('a')) {
      expect(el.attributes('aria-current')).toBeUndefined();
    }
  });

  it('renders the locale switcher linking to the same resource in the other locale', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.exists()).toBe(true);

    const link = language.find('a');
    expect(link.text()).toBe('Tiếng Việt');
    expect(link.attributes('href')).toBe('/vi/docs/api');
    expect(link.attributes('hreflang')).toBe('vi-VN');
    expect(link.attributes('lang')).toBe('vi');

    // Locale hiện tại hiển thị dạng text, không phải link tự trỏ.
    expect(language.text()).toContain('English');
    expect(language.findAll('a')).toHaveLength(1);
  });

  it('switches locale on the locale-root surface too', () => {
    const wrapper = mount(PublicShell, { props: { path: '/vi' } });
    const link = wrapper.find('header nav[aria-label="Language"] a');
    expect(link.attributes('href')).toBe('/en');
    expect(link.attributes('hreflang')).toBe('en');
  });

  it('renders no locale-aware chrome for the bare root path', () => {
    const wrapper = mount(PublicShell, { props: { path: '/' } });
    expect(wrapper.find('header nav[aria-label="Global"]').exists()).toBe(false);
    expect(wrapper.find('header nav[aria-label="Language"]').exists()).toBe(false);
    // Brand trỏ `/` khi chưa có locale; skip link luôn trỏ `#public-main`.
    expect(wrapper.find('header a[href="/"]').exists()).toBe(true);
  });

  it('renders no locale-aware chrome for an invalid path', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/unknown' } });
    expect(wrapper.find('header nav[aria-label="Global"]').exists()).toBe(false);
    expect(wrapper.find('header nav[aria-label="Language"]').exists()).toBe(false);
    expect(wrapper.find('header a[href="/"]').exists()).toBe(true);
    // Shell vẫn render được khung cho trang lỗi — không throw.
    expect(wrapper.find('main').exists()).toBe(true);
  });

  it('consumes parsed layout state directly without a path prop', () => {
    // Boundary test: Header không tự parse pathname — nó chỉ đọc state mà
    // shell đã parse xong.
    const wrapper = mount(PublicHeader, {
      props: { layout: parsePublicLayoutPath('/vi/docs') },
    });
    const nav = wrapper.find('nav[aria-label="Global"]');
    expect(nav.find('a[href="/vi/blog"]').attributes('href')).toBe('/vi/blog');
    // /vi/docs dừng đúng mount root → trigger Docs (disclosure link) mang
    // section sense 'page' (như link thường).
    expect(nav.find('a[href="/vi/docs"]').attributes('aria-current')).toBe('page');
    expect(wrapper.find('nav[aria-label="Language"] a').attributes('href')).toBe('/en/docs');
  });

  it('renders every nav group inside the mobile panel too', async () => {
    // Mobile panel: cùng dữ liệu nav, một bề mặt md:hidden — mọi link của
    // mega panel phải xuất hiện (mobile không có hover, panel không toggle
    // được nên link luôn trong cây).
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    wrapper.find('#public-header-mobile-panel').attributes('hidden');
    const mobile = wrapper.find('#public-header-mobile-panel');
    const hrefs = mobile.findAll('a').map((link) => link.attributes('href'));
    expect(hrefs).toContain('/en/docs');
    expect(hrefs).toContain('/en/docs/getting-started/installation');
    expect(hrefs).toContain('/en/blog');
    expect(hrefs).toContain('/en/legal/refund');
    // CTA nằm trong mobile panel — destination thật của docs getting-started.
    expect(hrefs).toContain('/en/docs/getting-started');
  });
});

describe('PublicHeader locale availability', () => {
  it('renders only the current locale when it is the single available locale', () => {
    const wrapper = mount(PublicShell, {
      props: { path: '/en/docs/api', availableLocales: ['en'] },
    });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.exists()).toBe(true);
    // Chỉ en: current hiển thị dạng text, không có link sang locale nào.
    expect(language.findAll('a')).toHaveLength(0);
    expect(language.text()).toContain('English');
    expect(language.text()).not.toContain('Tiếng Việt');
    // Không sinh link tới locale ngoài context ở bất kỳ đâu trong header.
    expect(wrapper.find('header').html()).not.toContain('/vi');
  });

  it('renders both locales when both are available', () => {
    const wrapper = mount(PublicShell, {
      props: { path: '/en/docs/api', availableLocales: ['en', 'vi'] },
    });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.text()).toContain('English');
    const link = language.find('a');
    expect(link.text()).toBe('Tiếng Việt');
    expect(link.attributes('href')).toBe('/vi/docs/api');
    expect(link.attributes('hreflang')).toBe('vi-VN');
  });

  it('always renders the current locale even when it is missing from availableLocales', () => {
    // Invariant: current luôn hợp lệ trong context — app không liệt kê 'en'
    // thì 'en' vẫn được render (và 'vi' vẫn link được vì có trong list).
    const wrapper = mount(PublicShell, {
      props: { path: '/en/blog', availableLocales: ['vi'] },
    });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.text()).toContain('English');
    expect(language.find('a').attributes('href')).toBe('/vi/blog');
  });

  it('preserves existing switcher behavior when availableLocales is omitted', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/docs' } });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.text()).toContain('English');
    const links = language.findAll('a');
    expect(links.map((link) => link.attributes('href'))).toEqual(['/vi/docs']);
  });

  it('drops values outside the locale registry instead of linking to them', () => {
    // Invalid/unexpected input (JS caller ép kiểu): kế thừa contract
    // `app/i18n` — so khớp exact, giá trị lạ bị loại, không throw.
    const wrapper = mount(PublicShell, {
      props: {
        path: '/en/blog',
        availableLocales: ['en', 'de'] as unknown as readonly PublicLocale[],
      },
    });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.exists()).toBe(true);
    expect(language.text()).toContain('English');
    expect(language.findAll('a')).toHaveLength(0);
    expect(wrapper.find('header').html()).not.toContain('/de');
    expect(wrapper.find('header').html()).not.toContain('/vi');
  });

  it('updates the switcher reactively when availableLocales changes', async () => {
    const wrapper = mount(PublicShell, {
      props: { path: '/en/blog', availableLocales: ['en'] },
    });
    expect(wrapper.find('header nav[aria-label="Language"]').findAll('a')).toHaveLength(0);

    await wrapper.setProps({ availableLocales: ['en', 'vi'] });

    const link = wrapper.find('header nav[aria-label="Language"] a');
    expect(link.attributes('href')).toBe('/vi/blog');
  });

  it('keeps global navigation and brand unaffected by availability', () => {
    // Availability chỉ giới hạn locale switcher — nav mount và brand giữ nguyên.
    const wrapper = mount(PublicShell, {
      props: { path: '/en/blog', availableLocales: ['en'] },
    });
    expect(wrapper.find('header a[href="/en"]').exists()).toBe(true);
    const nav = wrapper.find('header nav[aria-label="Global"]');
    expect(nav.find('a[href="/en/blog"]').exists()).toBe(true);
    expect(nav.find('a[href="/en/docs"]').text()).toContain('Docs');
  });

  it('renders the brand logo with fallback size classes and viewBox ratio intact', () => {
    // Sizing contract: header đặt `block h-6 w-auto` qua class fallthrough của
    // EcomaLogo (CSS-only — logo là inline `<svg>` có `viewBox` nên tỉ lệ
    // artwork do viewBox giữ, không có cặp attribute HTML nào để khớp;
    // `block` bỏ descender gap của inline element). Pin lại để không ai xoá
    // `w-auto` — một mình `h-6` bóp méo artwork — hay thêm width/height attrs.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const brandLogo = wrapper.find('header a[href="/en"] svg');
    expect(brandLogo.classes()).toEqual(expect.arrayContaining(['block', 'h-6', 'w-auto']));
    expect(brandLogo.attributes('viewBox')).toBeTruthy();
    expect(brandLogo.attributes('width')).toBeUndefined();
    expect(brandLogo.attributes('height')).toBeUndefined();
    expect(brandLogo.attributes('aria-label')).toBe('ecoma.io');
  });
});

/**
 * Menu locale dạng dropdown — dãy pill nằm ngang không co lại được khi số
 * ngôn ngữ tăng, nên header dùng `<button>` trigger + panel ẩn bằng `hidden`.
 */
describe('PublicHeader language dropdown', () => {
  it('renders a button trigger that is not a link and defaults to collapsed', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const trigger = languageTrigger(wrapper);

    expect(trigger.exists()).toBe(true);
    // Trigger chỉ điều khiển disclosure — không có href, và `type="button"` để
    // không kích hoạt submit nếu bị bọc trong form.
    expect(trigger.element.tagName).toBe('BUTTON');
    expect(trigger.attributes('type')).toBe('button');
    expect(trigger.attributes('href')).toBeUndefined();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.attributes('aria-controls')).toBe('public-header-language-panel');
    // Panel đóng mặc định nhưng vẫn nằm trong DOM (link phải còn cho crawler).
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('keeps every locale href in the static DOM while the panel is closed', () => {
    // Hợp đồng quan trọng nhất của dropdown: đóng menu KHÔNG được mất link.
    // `hidden` chỉ ẩn bề mặt — `href`/`hreflang` vẫn nằm trong HTML prerender,
    // nên crawler vẫn thấy alternate link (invariant 21: canonical + `hreflang`
    // hai chiều). Đây là lý do dùng `hidden` chứ không `v-if`.
    //
    // KHÔNG phải bảo đảm no-JS: link nằm trong subtree `display:none` nên người
    // dùng không có JS không bấm được — đánh đổi đã chọn, xem comment đầu
    // `PublicHeader.vue`.
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const link = wrapper.find('header nav[aria-label="Language"] a[href="/vi/docs/api"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes('hreflang')).toBe('vi-VN');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('toggles the panel on trigger click', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const trigger = languageTrigger(wrapper);

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(languagePanel(wrapper).attributes('hidden')).toBeUndefined();

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('closes the language panel on Escape together with every other panel', async () => {
    // Đóng hàng loạt dùng chung `closeDisclosures()`: Escape đóng menu locale
    // và mega panel cùng lúc, không phải điều khiển riêng từng cái.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    const docsTrigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');

    await trigger.trigger('click');
    await docsTrigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(docsTrigger.attributes('aria-expanded')).toBe('true');

    await wrapper.find('header').trigger('keydown', { key: 'Escape' });

    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
    expect(wrapper.find('#public-header-panel-docs').attributes('hidden')).toBeDefined();
  });

  it('closes the language panel on a real document click outside the header', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    // Click ngoài header (target vẫn connected) phải đóng — cùng cách dispatch
    // mà case mobile-menu dùng: listener gắn trên `document` trong `onMounted`,
    // nên target phải là một node thật ngoài `<header>`.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const outsideEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(outsideEvent, 'target', { value: outside, configurable: true });
    document.dispatchEvent(outsideEvent);
    await wrapper.vm.$nextTick();

    expect(trigger.attributes('aria-expanded')).toBe('false');
    outside.remove();
  });

  it('keeps mega panels independent from the language panel', async () => {
    // Mở menu locale không đóng mega panel và ngược lại: chúng là các
    // disclosure độc lập, chỉ đóng hàng loạt qua Escape/click-outside.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    const docsTrigger = wrapper.find('header nav[aria-label="Global"] a[href="/en/docs"]');

    await trigger.trigger('click');
    expect(docsTrigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('#public-header-panel-docs').attributes('hidden')).toBeDefined();

    await docsTrigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(docsTrigger.attributes('aria-expanded')).toBe('true');
  });

  it('lists the current locale as text and other locales as links, in registry order', () => {
    // Locale hiện tại vẫn là `<span aria-current="true">` (không link tự trỏ),
    // các locale khác là link đầy đủ `href`/`hreflang`/`lang`. Thứ tự theo
    // registry nên vị trí mục đứng yên khi người dùng đổi ngôn ngữ.
    const wrapper = mount(PublicShell, { props: { path: '/en/docs/api' } });
    const items = languagePanel(wrapper).findAll('li');

    expect(items.map((item) => item.text())).toEqual(['English', 'Tiếng Việt']);
    expect(items[0]?.find('span').attributes('aria-current')).toBe('true');
    expect(items[0]?.find('a').exists()).toBe(false);
    expect(items[1]?.find('a').attributes('href')).toBe('/vi/docs/api');
    expect(items[1]?.find('a').attributes('lang')).toBe('vi');
  });

  it('marks the current locale in Vietnamese pages too', () => {
    const wrapper = mount(PublicShell, { props: { path: '/vi/blog' } });
    const items = languagePanel(wrapper).findAll('li');

    expect(items.map((item) => item.text())).toEqual(['English', 'Tiếng Việt']);
    expect(items[1]?.find('span').attributes('aria-current')).toBe('true');
    expect(items[0]?.find('a').attributes('href')).toBe('/en/blog');
    // Nhãn trợ năng của trigger đổi theo locale của trang.
    expect(languageTrigger(wrapper).text()).toContain('Ngôn ngữ');
  });

  it('omits locales outside the registry rather than listing them', () => {
    // Contract đa ngôn ngữ: menu duyệt `PUBLIC_LOCALES`, nên không bao giờ
    // liệt kê ngôn ngữ mà `app/i18n` không khai báo — kể cả khi app ép truyền
    // một locale lạ qua `availableLocales` (cast kiểu trong test).
    const wrapper = mount(PublicShell, {
      props: {
        path: '/en/blog',
        availableLocales: ['en', 'de', 'fr'] as unknown as readonly PublicLocale[],
      },
    });

    expect(languagePanel(wrapper).findAll('li')).toHaveLength(1);
    expect(languagePanel(wrapper).text()).toContain('English');
    expect(wrapper.find('header').html()).not.toContain('/de');
    expect(wrapper.find('header').html()).not.toContain('/fr');
  });

  it('keeps the menu rendered with a single available locale', () => {
    // Context chỉ có `en`: menu vẫn hiện (locale hiện tại luôn hợp lệ trong
    // context) nhưng không có link chuyển ngôn ngữ nào.
    const wrapper = mount(PublicShell, {
      props: { path: '/en/docs/api', availableLocales: ['en'] },
    });

    expect(languageTrigger(wrapper).exists()).toBe(true);
    const items = languagePanel(wrapper).findAll('li');
    expect(items).toHaveLength(1);
    expect(items[0]?.text()).toBe('English');
    expect(languagePanel(wrapper).find('a').exists()).toBe(false);
  });

  it('updates the menu reactively when the path prop changes', async () => {
    // Đổi pathname (client-side navigation) thì menu phải dựng lại href theo
    // resource mới, không giữ snapshot của resource cũ.
    const wrapper = mount(PublicShell, { props: { path: '/en/blog' } });
    expect(languagePanel(wrapper).find('a').attributes('href')).toBe('/vi/blog');

    await wrapper.setProps({ path: '/en/docs/concepts/content-and-locales' });

    expect(languagePanel(wrapper).find('a').attributes('href')).toBe(
      '/vi/docs/concepts/content-and-locales',
    );
  });

  it('closes the mobile panel when the language menu opens', async () => {
    // Menu locale hiện ở mọi breakpoint còn mobile panel là `md:hidden`, nên ở
    // mobile hai panel sẽ chồng lên nhau (menu `absolute top-full z-50` phủ lên
    // các dòng nav đầu của mobile panel) nếu không đóng chéo.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const mobileToggle = wrapper.find('button[aria-controls="public-header-mobile-panel"]');
    const trigger = languageTrigger(wrapper);

    await mobileToggle.trigger('click');
    expect(mobileToggle.attributes('aria-expanded')).toBe('true');

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(mobileToggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('#public-header-mobile-panel').attributes('hidden')).toBeDefined();
  });

  it('closes the language menu when the mobile panel opens', async () => {
    // Chiều đối xứng của case trên — cùng một lý do chồng panel.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const mobileToggle = wrapper.find('button[aria-controls="public-header-mobile-panel"]');
    const trigger = languageTrigger(wrapper);

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    await mobileToggle.trigger('click');
    expect(mobileToggle.attributes('aria-expanded')).toBe('true');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('names the current locale in the trigger accessible name', async () => {
    // Trigger chỉ có icon nên `sr-only` phải mang cả tên locale — nếu chỉ ghi
    // "Language" thì screen reader không biết trang đang ở ngôn ngữ nào khi
    // menu đóng (hồi quy so với dãy pill cũ hiện tên ngôn ngữ ngay trên
    // header). Accessible name đổi theo locale của trang.
    const wrapper = mount(PublicShell, { props: { path: '/vi/blog' } });
    const name = languageTrigger(wrapper).text();

    expect(name).toContain('Ngôn ngữ');
    expect(name).toContain('Tiếng Việt');

    await wrapper.setProps({ path: '/en/blog' });
    const englishName = languageTrigger(wrapper).text();
    expect(englishName).toContain('Language');
    expect(englishName).toContain('English');
  });

  it('returns focus to the trigger when Escape closes the language menu', async () => {
    // Đóng bằng `hidden` khiến `display:none`, nên focus đang ở một mục trong
    // menu rơi về `<body>` — mất vị trí và phải Tab lại từ đầu. Escape phải
    // trả focus về trigger (WAI-ARIA disclosure navigation).
    //
    // `attachTo` bắt buộc: focus chỉ có tác dụng trên cây DOM đang gắn vào
    // document — mount detached thì `.focus()` là no-op trong jsdom.
    const wrapper = mount(PublicShell, {
      props: { path: '/en/docs' },
      attachTo: document.body,
    });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');

    const menuLink = languagePanel(wrapper).find('a');
    (menuLink.element as HTMLElement).focus();
    expect(document.activeElement).toBe(menuLink.element);

    await wrapper.find('header').trigger('keydown', { key: 'Escape' });

    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('closes the language menu when focus moves elsewhere inside the header', async () => {
    // Regression: `focusout` chỉ bắt `relatedTarget === null` nên không bắt
    // được đường bàn phím thật — mở menu rồi Tab qua mục cuối sẽ dừng ở CTA
    // (`relatedTarget` khác `null`), menu vẫn mở và nổi đè lên nội dung
    // không còn cách đóng.
    const wrapper = mount(PublicShell, { props: { path: '/en/docs' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    const cta = wrapper.find('header a[href="/en/docs/getting-started"]');
    await wrapper.find('header').trigger('focusout', { relatedTarget: cta.element });

    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('keeps the language menu open while focus moves within it', async () => {
    // Chiều đối xứng: focus đi giữa các mục trong menu thì KHÔNG đóng — chỉ
    // rời khỏi vùng chứa menu mới đóng.
    const wrapper = mount(PublicShell, { props: { path: '/en/docs' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');

    await wrapper.find('header').trigger('focusout', { relatedTarget: trigger.element });

    expect(trigger.attributes('aria-expanded')).toBe('true');
  });
});

describe('PublicFooter', () => {
  it('renders shared brand and copyright without application content', () => {
    const wrapper = mount(PublicShell, { props: { path: '/vi/blog' } });
    const footer = wrapper.find('footer');
    // Brand footer là artwork logo (inline `<svg>` với aria-label) — anchor
    // brand giữ toàn bộ contract thị giác: KHÔNG có plate nền, vì mark tô theo
    // `fill-brand` và wordmark theo `fill-foam` nên đọc được thẳng trên nền
    // footer tối; `h-6 w-auto` là sizing CSS-only, `block` bỏ descender gap.
    // Pin cả bộ để xoá nhầm một class, hay bọc lại plate trắng cũ, vẫn đỏ test.
    const brand = footer.find('a[href="/vi"]');
    expect(brand.classes()).not.toContain('bg-white');
    expect(brand.text()).toBe('');
    const brandLogo = brand.find('svg');
    expect(brandLogo.classes()).toEqual(expect.arrayContaining(['block', 'h-6', 'w-auto']));
    expect(brandLogo.attributes('aria-label')).toBe('ecoma.io');
    expect(brandLogo.findAll('path')).toHaveLength(2);
    expect(footer.text()).toContain('© ecoma.io');
  });

  it('falls back to / for the brand on root and invalid paths', () => {
    for (const path of ['/', '/en/unknown']) {
      const wrapper = mount(PublicFooter, { props: { layout: parsePublicLayoutPath(path) } });
      expect(wrapper.find('a').attributes('href')).toBe('/');
    }
  });

  it('contains no navigation and no runtime state', () => {
    const wrapper = mount(PublicFooter, {
      props: { layout: parsePublicLayoutPath('/en') },
    });
    expect(wrapper.find('nav').exists()).toBe(false);
    expect(wrapper.html()).not.toContain('undefined');
  });
});
