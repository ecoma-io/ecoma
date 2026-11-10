import { describe, it, expect } from 'vitest';
// @vitest-environment jsdom
import type { PublicLocale } from '../../../i18n/index';
import { mount, type DOMWrapper } from '@vue/test-utils';
import { PublicFooter, PublicHeader, PublicShell, parsePublicLayoutPath } from '../../index';

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
      props: { path: '/en' },
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
      props: { path: '/vi' },
      slots: { default: '<div>APP_UNIQUE_MARKER_42</div>' },
    });
    expect(wrapper.find('header').html()).not.toContain('APP_UNIQUE_MARKER_42');
    expect(wrapper.find('footer').html()).not.toContain('APP_UNIQUE_MARKER_42');
    expect(wrapper.find('main').html()).toContain('APP_UNIQUE_MARKER_42');
  });

  it('updates chrome reactively when the path prop changes', async () => {
    // Pin reactivity của props destructure trong computed: đổi path (client-side
    // navigation) thì Header/Footer phải re-render theo, không giữ snapshot.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    expect(wrapper.find('header a[href="/en"]').attributes('href')).toBe('/en');

    await wrapper.setProps({ path: '/vi' });

    expect(wrapper.find('header a[href="/vi"]').attributes('href')).toBe('/vi');
    expect(wrapper.find('header nav[aria-label="Language"] a').attributes('href')).toBe('/en');
    expect(wrapper.find('footer a').attributes('href')).toBe('/vi');
  });

  it('renders without crashing on every path class', () => {
    for (const path of ['/', '/en', '/vi', '/en/unknown', 'garbage']) {
      expect(() => mount(PublicShell, { props: { path }, slots: { default: 'X' } })).not.toThrow();
    }
  });
});

describe('PublicHeader', () => {
  it('renders a skip link to the main landmark as the first focusable element', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const first = wrapper.find('header a');
    expect(first.attributes('href')).toBe('#public-main');
    expect(wrapper.find('main').attributes('id')).toBe('public-main');
  });

  it('links the brand to the locale-root surface', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const brand = wrapper.find('header a[href="/en"]');
    // Brand là artwork logo (`EcomaLogo` render inline `<svg>`), accessible name
    // đến từ `aria-label` — không còn text node hay `alt` để assert; pin role
    // và tên để logo mất nhãn phụ vẫn đỏ test.
    const logo = brand.find('svg');
    expect(logo.attributes('role')).toBe('img');
    expect(logo.attributes('aria-label')).toBe('ecoma.io');
    expect(logo.findAll('path')).toHaveLength(2);
  });

  it('renders brand and language switcher as the only chrome', () => {
    // Sau khi gỡ stack content (issue #72): header chỉ còn brand + locale
    // switcher — không có global nav, không CTA, không mobile toggle. Anchor
    // trong header đúng bộ: skip link, brand, và link sang locale còn lại của
    // switcher (panel đóng vẫn render link — contract crawlable).
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const header = wrapper.find('header');
    const plainAnchors = header.findAll('a');
    expect(plainAnchors.map((anchor) => anchor.attributes('href'))).toEqual([
      '#public-main',
      '/en',
      '/vi',
    ]);
    expect(header.find('nav[aria-label="Global"]').exists()).toBe(false);
    // Duy nhất một button: trigger của menu locale.
    expect(header.findAll('button')).toHaveLength(1);
  });

  it('renders the locale switcher linking to the same resource in the other locale', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.exists()).toBe(true);

    const link = language.find('a');
    expect(link.text()).toBe('Tiếng Việt');
    expect(link.attributes('href')).toBe('/vi');
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
    expect(wrapper.find('header nav[aria-label="Language"]').exists()).toBe(false);
    // Brand trỏ `/` khi chưa có locale; skip link luôn trỏ `#public-main`.
    expect(wrapper.find('header a[href="/"]').exists()).toBe(true);
  });

  it('renders no locale-aware chrome for an invalid path', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en/unknown' } });
    expect(wrapper.find('header nav[aria-label="Language"]').exists()).toBe(false);
    expect(wrapper.find('header a[href="/"]').exists()).toBe(true);
    // Shell vẫn render được khung cho trang lỗi — không throw.
    expect(wrapper.find('main').exists()).toBe(true);
  });

  it('consumes parsed layout state directly without a path prop', () => {
    // Boundary test: Header không tự parse pathname — nó chỉ đọc state mà
    // shell đã parse xong.
    const wrapper = mount(PublicHeader, { props: { layout: parsePublicLayoutPath('/vi') } });
    expect(wrapper.find('a[href="#public-main"]').exists()).toBe(true);
    expect(wrapper.find('nav[aria-label="Language"] a').attributes('href')).toBe('/en');
  });

  it('renders no page-level aria-current on the locale-root surface', () => {
    // Không còn global nav, nên `aria-current="page"` không có chỗ nào đứng:
    // duy nhất span locale hiện tại của switcher dùng `aria-current="true"`
    // (menu state, không phải current page).
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const header = wrapper.find('header');
    for (const el of header.findAll('[aria-current="page"]')) {
      expect(el.exists()).toBe(false);
    }
    expect(header.find('[aria-current="true"]').exists()).toBe(true);
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

describe('PublicHeader locale availability', () => {
  it('renders only the current locale when it is the single available locale', () => {
    const wrapper = mount(PublicShell, {
      props: { path: '/en', availableLocales: ['en'] },
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
      props: { path: '/en', availableLocales: ['en', 'vi'] },
    });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.text()).toContain('English');
    const link = language.find('a');
    expect(link.text()).toBe('Tiếng Việt');
    expect(link.attributes('href')).toBe('/vi');
    expect(link.attributes('hreflang')).toBe('vi-VN');
  });

  it('always renders the current locale even when it is missing from availableLocales', () => {
    // Invariant: current luôn hợp lệ trong context — app không liệt kê 'en'
    // thì 'en' vẫn được render (và 'vi' vẫn link được vì có trong list).
    const wrapper = mount(PublicShell, {
      props: { path: '/en', availableLocales: ['vi'] },
    });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.text()).toContain('English');
    expect(language.find('a').attributes('href')).toBe('/vi');
  });

  it('preserves existing switcher behavior when availableLocales is omitted', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const language = wrapper.find('header nav[aria-label="Language"]');
    expect(language.text()).toContain('English');
    const links = language.findAll('a');
    expect(links.map((link) => link.attributes('href'))).toEqual(['/vi']);
  });

  it('drops values outside the locale registry instead of linking to them', () => {
    // Invalid/unexpected input (JS caller ép kiểu): kế thừa contract
    // `app/i18n` — so khớp exact, giá trị lạ bị loại, không throw.
    const wrapper = mount(PublicShell, {
      props: {
        path: '/en',
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
      props: { path: '/en', availableLocales: ['en'] },
    });
    expect(wrapper.find('header nav[aria-label="Language"]').findAll('a')).toHaveLength(0);

    await wrapper.setProps({ availableLocales: ['en', 'vi'] });

    const link = wrapper.find('header nav[aria-label="Language"] a');
    expect(link.attributes('href')).toBe('/vi');
  });

  it('keeps the brand unaffected by availability', () => {
    // Availability chỉ giới hạn locale switcher — brand giữ nguyên.
    const wrapper = mount(PublicShell, {
      props: { path: '/en', availableLocales: ['en'] },
    });
    expect(wrapper.find('header a[href="/en"]').exists()).toBe(true);
  });
});

/**
 * Menu locale dạng dropdown — dãy pill nằm ngang không co lại được khi số
 * ngôn ngữ tăng, nên header dùng `<button>` trigger + panel ẩn bằng `hidden`.
 */
describe('PublicHeader language dropdown', () => {
  it('renders a button trigger that is not a link and defaults to collapsed', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
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
    // nên crawler vẫn thấy alternate link (canonical + `hreflang` hai chiều).
    // Đây là lý do dùng `hidden` chứ không `v-if`.
    //
    // KHÔNG phải bảo đảm no-JS: link nằm trong subtree `display:none` nên người
    // dùng không có JS không bấm được — đánh đổi đã chọn, xem comment đầu
    // `PublicHeader.vue`.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const link = wrapper.find('header nav[aria-label="Language"] a[href="/vi"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes('hreflang')).toBe('vi-VN');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('toggles the panel on trigger click', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(languagePanel(wrapper).attributes('hidden')).toBeUndefined();

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('closes the language panel on Escape', async () => {
    // Escape là phím dismissal chuẩn của disclosure — người dùng thoát không
    // cần quay lại trigger bấm lần nữa.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    await wrapper.find('header').trigger('keydown', { key: 'Escape' });

    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(languagePanel(wrapper).attributes('hidden')).toBeDefined();
  });

  it('ignores non-Escape keydown', async () => {
    // Chỉ Escape đóng menu — mọi phím khác không được đổi state disclosure.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    await wrapper.find('header').trigger('keydown', { key: 'Tab' });

    expect(trigger.attributes('aria-expanded')).toBe('true');
  });

  it('closes the language panel on a real document click outside the header', async () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    // Click ngoài header (target vẫn connected) phải đóng — listener gắn trên
    // `document` trong `onMounted`, nên target phải là một node thật ngoài
    // `<header>`.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const outsideEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(outsideEvent, 'target', { value: outside, configurable: true });
    document.dispatchEvent(outsideEvent);
    await wrapper.vm.$nextTick();

    expect(trigger.attributes('aria-expanded')).toBe('false');
    outside.remove();
  });

  it('ignores document clicks whose target was detached mid-dispatch', async () => {
    // Regression: click thật chạm icon trong trigger; Vue v-if/v-else swap
    // icon ngay trong handler khiến target bị detach khi event còn đang
    // bubble. Tại document, `contains(detached)` = false và click-outside hiểu
    // nhầm là click ngoài header — menu vừa mở bị đóng tức thì trên trình
    // duyệt thật (jsdom không tái hiện vì mount đồng bộ). Target disconnected
    // phải được bỏ qua, không coi là click ngoài.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    // Mô phỏng event bubble tới document với target đã bị detach (isConnected
    // = false) — không được đóng menu.
    const detached = document.createElement('path');
    const fakeEvent = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(fakeEvent, 'target', { value: detached, configurable: true });
    document.dispatchEvent(fakeEvent);
    await wrapper.vm.$nextTick();

    // Guard có mặt: menu phải vẫn mở. Thiếu guard, click-outside đọc
    // `contains(detached)` = false và đóng menu — assert này đỏ.
    expect(trigger.attributes('aria-expanded')).toBe('true');
  });

  it('lists the current locale as text and other locales as links, in registry order', () => {
    // Locale hiện tại vẫn là `<span aria-current="true">` (không link tự trỏ),
    // các locale khác là link đầy đủ `href`/`hreflang`/`lang`. Thứ tự theo
    // registry nên vị trí mục đứng yên khi người dùng đổi ngôn ngữ.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const items = languagePanel(wrapper).findAll('li');

    expect(items.map((item) => item.text())).toEqual(['English', 'Tiếng Việt']);
    expect(items[0]?.find('span').attributes('aria-current')).toBe('true');
    expect(items[0]?.find('a').exists()).toBe(false);
    expect(items[1]?.find('a').attributes('href')).toBe('/vi');
    expect(items[1]?.find('a').attributes('lang')).toBe('vi');
  });

  it('marks the current locale in Vietnamese pages too', () => {
    const wrapper = mount(PublicShell, { props: { path: '/vi' } });
    const items = languagePanel(wrapper).findAll('li');

    expect(items.map((item) => item.text())).toEqual(['English', 'Tiếng Việt']);
    expect(items[1]?.find('span').attributes('aria-current')).toBe('true');
    expect(items[0]?.find('a').attributes('href')).toBe('/en');
    // Nhãn trợ năng của trigger đổi theo locale của trang.
    expect(languageTrigger(wrapper).text()).toContain('Ngôn ngữ');
  });

  it('omits locales outside the registry rather than listing them', () => {
    // Contract đa ngôn ngữ: menu duyệt `PUBLIC_LOCALES`, nên không bao giờ
    // liệt kê ngôn ngữ mà `app/i18n` không khai báo — kể cả khi app ép truyền
    // một locale lạ qua `availableLocales` (cast kiểu trong test).
    const wrapper = mount(PublicShell, {
      props: {
        path: '/en',
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
      props: { path: '/en', availableLocales: ['en'] },
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
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    expect(languagePanel(wrapper).find('a').attributes('href')).toBe('/vi');

    await wrapper.setProps({ path: '/vi' });

    expect(languagePanel(wrapper).find('a').attributes('href')).toBe('/en');
  });

  it('names the current locale in the trigger accessible name', async () => {
    // Trigger chỉ có icon nên `sr-only` phải mang cả tên locale — nếu chỉ ghi
    // "Language" thì screen reader không biết trang đang ở ngôn ngữ nào khi
    // menu đóng. Accessible name đổi theo locale của trang.
    const wrapper = mount(PublicShell, { props: { path: '/vi' } });
    const name = languageTrigger(wrapper).text();

    expect(name).toContain('Ngôn ngữ');
    expect(name).toContain('Tiếng Việt');

    await wrapper.setProps({ path: '/en' });
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
    const wrapper = mount(PublicShell, { props: { path: '/en' }, attachTo: document.body });
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
    // được đường bàn phím thật — mở menu rồi Tab qua mục cuối sẽ dừng ở phần
    // tử focusable tiếp theo của header (`relatedTarget` khác `null`), menu
    // vẫn mở và nổi đè lên nội dung không còn cách đóng. Sau khi gỡ CTA/nav,
    // phần tử đó là brand link.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');

    const brand = wrapper.find('header a[href="/en"]');
    await wrapper.find('header').trigger('focusout', { relatedTarget: brand.element });

    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('keeps the language menu open while focus moves within it', async () => {
    // Chiều đối xứng: focus đi giữa các mục trong menu thì KHÔNG đóng — chỉ
    // rời khỏi vùng chứa menu mới đóng.
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    const trigger = languageTrigger(wrapper);
    await trigger.trigger('click');

    await wrapper.find('header').trigger('focusout', { relatedTarget: trigger.element });

    expect(trigger.attributes('aria-expanded')).toBe('true');
  });
});

describe('PublicFooter', () => {
  it('renders shared brand, tagline and copyright without application content', () => {
    const wrapper = mount(PublicShell, { props: { path: '/vi' } });
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
    // Tagline theo đúng locale của trang; copyright không năm (deterministic).
    expect(footer.text()).toContain('Bề mặt public của ecoma.io');
    expect(footer.text()).toContain('© ecoma.io');
  });

  it('renders the English tagline on the English page', () => {
    const wrapper = mount(PublicShell, { props: { path: '/en' } });
    expect(wrapper.find('footer').text()).toContain('The public surface of ecoma.io');
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
