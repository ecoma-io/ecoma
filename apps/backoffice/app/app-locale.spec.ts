/**
 * Đổi ngôn ngữ ở runtime — những điều mà `shell-integration.spec.ts` (regex trên
 * source) và `catalogs.spec.ts` (đối chiếu ba catalog) **không** bắt được.
 *
 * Test này mount `app.vue` thật, trên **catalog thật**, rồi đổi ngôn ngữ qua chính
 * `<select>` mà người dùng dùng. Nó trả lời câu hỏi: "bấm chọn ngôn ngữ thì giao
 * diện có thật sự đổi không?", chứ không phải "source có nhắc tới `lang` không?".
 *
 * Năm luật sản phẩm được ghim ở đây:
 *
 * 1. Lựa chọn locale chảy tới `vue-i18n` — văn bản đổi, không chỉ `<html lang>`.
 * 2. `<html lang>` là **BCP-47**, không phải `code`: `zh-CN` phải cho `zh-Hans`.
 * 3. Đổi ngôn ngữ **không** điều hướng: route và query giữ nguyên.
 * 4. Thứ tự ưu tiên: lựa chọn trong phiên → cookie hợp lệ → mặc định `en`; cookie
 *    không hợp lệ rơi về mặc định, không im lặng thành một locale khác.
 * 5. SSR khởi tạo từ cookie đã localized ngay trong HTML đầu tiên — không dựa vào
 *    client sửa DOM sau hydrate.
 */
import { describe, expect, it } from 'vitest';

import en from './i18n/locales/en';
import vi from './i18n/locales/vi';
import zhCN from './i18n/locales/zh-CN';
import type { BackofficeLocale } from './i18n/locale-registry';
import StaffPage from './pages/staff.vue';
import { backofficeStores, headHtmlAttrs, i18n, useCookie } from '../tests/nuxt-globals';
import { flushPromises, mountBackofficeApp, renderBackofficeAppToHtml } from '../tests/harness';

/**
 * Tên cookie locale — viết lại ở đây thay vì import hằng (nó không được export).
 *
 * ⚠️ Cố ý: nếu tên cookie đổi mà test không theo, test sẽ **vẫn xanh** — nó đặt
 * một cookie không ai đọc rồi khẳng định app rơi về tiếng Anh. Nhưng khẳng định
 * "cookie hợp lệ được đọc" bên dưới sẽ đỏ, vì `preferred` khi đó không theo cookie.
 * Nghĩa là tên lệch làm test đỏ ở đúng chỗ, không im lặng pass.
 */
const LOCALE_COOKIE = 'backoffice-locale';

/**
 * Composer mà app ghi locale vào — **cùng object** với `i18n.global`.
 *
 * `app.vue` → `useBackofficeI18n()` → `useI18n().locale.value = preferred`; ở mode
 * `legacy: false` và không có scope cục bộ, `useI18n()` trả chính composer toàn cục
 * mà `createI18n()` tạo ra, tức object này. Đọc ở đây là để phân biệt "app thật sự
 * đổi locale của `vue-i18n`" với "app chỉ đổi `<html lang>`/giá trị trong `<select>`".
 */
const composer = i18n.global;

/**
 * Đặt cookie locale như nó đến **từ bên ngoài** phiên đang chạy: tab khác, hoặc
 * header của request.
 *
 * ⚠️ Ghi qua đúng `useCookie()` mà `use-backoffice-locale.ts` đọc — cùng key thì
 * cùng `Ref` (hợp đồng của stub, xem `tests/nuxt-globals.ts`), nên đây không phải
 * một kênh ghi thứ hai mà test tự phát minh ra. Cố ý **không** đụng tầng
 * `useState` (`explicit`): nhánh đang kiểm là "chưa có lựa chọn trong phiên".
 */
function storeLocaleCookie(value: string): void {
  useCookie<string | undefined>(LOCALE_COOKIE).value = value;
}

/** Giá trị cookie locale hiện tại, đọc qua cùng `Ref` đó. */
function readLocaleCookie(): string | undefined {
  return useCookie<string | undefined>(LOCALE_COOKIE).value;
}

/** Câu chữ mong đợi cho một key, lấy từ **catalog thật**. */
const EXPECTED = {
  navStaff: { en: en.nav.staff, vi: vi.nav.staff, 'zh-CN': zhCN.nav.staff },
  navOverview: { en: en.nav.overview, vi: vi.nav.overview, 'zh-CN': zhCN.nav.overview },
  navHeading: { en: en.nav.platform, vi: vi.nav.platform, 'zh-CN': zhCN.nav.platform },
  pageOverviewTitle: {
    en: en.pages.overview.title,
    vi: vi.pages.overview.title,
    'zh-CN': zhCN.pages.overview.title,
  },
  pageOverviewDescription: {
    en: en.pages.overview.description,
    vi: vi.pages.overview.description,
    'zh-CN': zhCN.pages.overview.description,
  },
  pageStaffTitle: {
    en: en.pages.staff.title,
    vi: vi.pages.staff.title,
    'zh-CN': zhCN.pages.staff.title,
  },
} as const;

const LOCALES: readonly BackofficeLocale[] = ['en', 'vi', 'zh-CN'];

/** Chọn một locale qua chính `<select>` mà người dùng bấm. */
async function selectLanguage(
  wrapper: Awaited<ReturnType<typeof mountBackofficeApp>>['wrapper'],
  locale: BackofficeLocale,
): Promise<void> {
  const select = wrapper.find('[data-testid="backoffice-language-select"]');
  expect(select.exists()).toBe(true);
  await select.setValue(locale);
  await flushPromises(wrapper);
}

/** Nội dung trang Overview hiện tại. */
function pageTitle(wrapper: Awaited<ReturnType<typeof mountBackofficeApp>>['wrapper']): string {
  const title = wrapper.find('[data-testid="backoffice-page-title"]');
  expect(title.exists()).toBe(true);
  return title.text();
}

/**
 * Nhãn của một mục nav trong sidebar — phần **shell** của giao diện.
 *
 * ⚠️ Selector phải khoanh đúng vùng sidebar. `a[href="/staff"]` trần sẽ khớp
 * **hai** thứ: mục nav trong sidebar, và card khu vực ở trang Overview trỏ tới
 * cùng route đó. `find` lấy phần tử đầu tiên theo thứ tự DOM — ở lần chạy đầu
 * nó trúng mục nav, nên một test viết `a[href="/staff"]` có thể xanh **nhờ nhầm
 * sang nội dung trang**, tức là đúng cái loại bằng chứng rỗng mà nhiệm vụ này
 * cấm. `a[href="/"]` còn tệ hơn: khớp luôn brand link chứa logo, không có text.
 *
 * `[data-slot="sidebar-menu-button"]` là attribute của chính primitive sidebar, đặt
 * lên **mọi** mục nav và không nằm trên phần tử nào khác — nên nó khoanh đúng
 * vùng shell. Số phần tử được kiểm đúng 1: nếu một thay đổi làm selector khớp
 * nhiều hoặc không khớp gì, test đỏ ngay thay vì đọc nhầm phần tử.
 */
function navLabel(
  wrapper: Awaited<ReturnType<typeof mountBackofficeApp>>['wrapper'],
  href: string,
): string {
  const links = wrapper.findAll(`a[href="${href}"]`);
  const inSidebar = links.filter((l) => l.element.closest('[data-slot="sidebar"]') !== null);
  // Brand link trong header trỏ tới '/' nhưng nằm trong <slot name="brand"> — không phải mục nav.
  // Mục nav 'Overview' là mục duy nhất trong sidebar trỏ tới '/'.
  const navOnly = inSidebar.filter(
    (l) => l.element.closest('[data-slot="sidebar-group"]') !== null,
  );
  expect(navOnly, `số mục nav trong sidebar khớp href="${href}"`).toHaveLength(1);
  return navOnly[0]?.text() ?? '';
}

/**
 * Tiêu đề nhóm nav trong sidebar (`nav.platform`) — nhãn **shell** thứ hai, độc
 * lập với nhãn của từng mục.
 *
 * ⚠️ `[data-slot="sidebar-group-label"]` là attribute của chính
 * `SidebarGroupLabel`, không phải một class trang trí — đổi style không làm nó
 * mất, còn `SidebarGroupLabel` bị bỏ thì test đỏ ngay. Kiểm đúng 1 phần tử để
 * một thay đổi cấu trúc không âm thầm biến phép đọc thành "phần tử đầu tiên".
 */
function navHeading(wrapper: Awaited<ReturnType<typeof mountBackofficeApp>>['wrapper']): string {
  const headings = wrapper.findAll('[data-slot="sidebar-group-label"]');
  expect(headings, 'số tiêu đề nhóm nav trong sidebar').toHaveLength(1);
  return headings[0]?.text() ?? '';
}

describe('switches locale at runtime', () => {
  /**
   * Chốt chặn chống test rỗng: nếu ba catalog trùng nhau ở các key dùng để khẳng
   * định, mọi phép so dưới đây vẫn xanh dù app không hề dịch gì. Ba giá trị phải
   * **khác nhau từng đôi một**.
   */
  it('catalogs used in assertions really differ across the three locales', () => {
    for (const [key, values] of Object.entries(EXPECTED)) {
      expect(new Set([values.en, values.vi, values['zh-CN']]).size, `key: ${key}`).toBe(3);
    }
  });

  it('switching locale updates the page title to match the catalog', async () => {
    const { wrapper } = await mountBackofficeApp();
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.en);

    for (const locale of LOCALES) {
      await selectLanguage(wrapper, locale);
      expect(pageTitle(wrapper), `locale: ${locale}`).toBe(EXPECTED.pageOverviewTitle[locale]);
    }
  });

  it('switching locale updates the shell navigation labels too', async () => {
    const { wrapper } = await mountBackofficeApp();
    expect(navLabel(wrapper, '/staff')).toBe(EXPECTED.navStaff.en);

    for (const locale of LOCALES) {
      await selectLanguage(wrapper, locale);
      expect(navLabel(wrapper, '/staff'), `locale: ${locale}`).toBe(EXPECTED.navStaff[locale]);
      // 'Overview' là nhãn của mục nav, không phải brand link; brand link cũng trỏ tới '/'
      expect(navLabel(wrapper, '/'), `locale: ${locale}`).toBe(EXPECTED.navOverview[locale]);
      // Tiêu đề nhóm nav là nhãn shell thứ hai, độc lập với nhãn từng mục.
      expect(navHeading(wrapper), `locale: ${locale}`).toBe(EXPECTED.navHeading[locale]);
    }
  });

  it('switching locale updates the body copy, not only the title', async () => {
    const { wrapper } = await mountBackofficeApp();
    expect(wrapper.text()).toContain(EXPECTED.pageOverviewDescription.en);

    await selectLanguage(wrapper, 'vi');
    expect(wrapper.text()).toContain(EXPECTED.pageOverviewDescription.vi);
    // Văn bản tiếng Anh đã biết phải biến mất — một khẳng định chỉ bắt được thứ nó
    // đã nghĩ tới, nên kiểm cả hai chiều.
    expect(wrapper.text()).not.toContain(EXPECTED.pageOverviewDescription.en);
  });

  it('a cookie changed between sessions is followed, not only at initialization', async () => {
    // ⚠️ Test này ghim tính **reactive** của `useCookie` của harness — cùng hợp đồng
    // mà Nuxt thật có (`useCookie` trả `CookieRef`).
    //
    // `use-backoffice-locale.ts` đọc `preferred = computed(() => explicit.value ??
    // parse(cookie.value) ?? default)`. Ở đây chưa có lựa chọn trong phiên nên
    // `explicit` vẫn `undefined`: cookie là nguồn duy nhất. Nếu jar của stub không
    // reactive (Map trần), `computed` cache vĩnh viễn và ghi cookie giữa phiên sẽ
    // không đổi một chữ nào trên UI — đúng false-green mà `app.vue` đang dễ mắc
    // với `preferences` của shell.
    const { wrapper } = await mountBackofficeApp();
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.en);

    // Cookie tới từ bên ngoài (tab khác, response của server), không qua `chooseLocale`
    // nên không đụng tầng `explicit`.
    storeLocaleCookie('vi');
    await flushPromises(wrapper);

    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.vi);
    expect(composer.locale.value).toBe('vi');
    expect(headHtmlAttrs()['lang']).toBe('vi');
  });

  it('writes the locale into vue-i18n, not only the value in <select>', async () => {
    // ⚠️ Assertion composer là tối quan trọng: `BackofficeLanguageSelect` luôn hiện
    // đúng lựa chọn của nó (nó bind `:value="preferred"`), nên một app chỉ đổi
    // `preferred` mà không nối vào `vue-i18n` vẫn cho `<select>` đúng trong khi văn
    // bản đứng yên. Test này ghim đúng dây nối đó.
    const { wrapper } = await mountBackofficeApp();
    expect(composer.locale.value).toBe('en');

    await selectLanguage(wrapper, 'vi');
    expect(composer.locale.value).toBe('vi');

    await selectLanguage(wrapper, 'zh-CN');
    expect(composer.locale.value).toBe('zh-CN');
  });

  it('keeps route and query unchanged when switching language', async () => {
    const { wrapper } = await mountBackofficeApp({
      page: StaffPage,
      route: { path: '/staff', query: { status: 'active', page: '2' } },
    });

    const before = {
      path: backofficeStores.route.path,
      query: { ...backofficeStores.route.query },
    };
    expect(before.path).toBe('/staff');
    expect(before.query).toEqual({ status: 'active', page: '2' });
    await selectLanguage(wrapper, 'vi');
    // Sau lần đổi sang zh-CN, trang vẫn phải ở Staff và tên trang phải là
    // bản dịch của locale hiện tại.
    await selectLanguage(wrapper, 'zh-CN');

    expect(backofficeStores.route.path).toBe(before.path);
    expect({ ...backofficeStores.route.query }).toEqual(before.query);
    // ⚠️ Và không có lệnh điều hướng nào được phát ra. Chỉ so route là chưa đủ: một
    // app gọi `navigateTo`/`router.push` sẽ đổi URL trên Nuxt thật, còn route của
    // stub thì đứng yên — nên phải đo chính lệnh điều hướng.
    expect(backofficeStores.navigations).toEqual([]);
    // Trang vẫn là trang cũ, chỉ khác ngôn ngữ.
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageStaffTitle['zh-CN']);
  });
});

describe('<html lang> follows BCP-47', () => {
  it('en → en, vi → vi, zh-CN → zh-Hans', async () => {
    const { wrapper } = await mountBackofficeApp();
    expect(headHtmlAttrs()['lang']).toBe('en');

    await selectLanguage(wrapper, 'vi');
    expect(headHtmlAttrs()['lang']).toBe('vi');

    await selectLanguage(wrapper, 'zh-CN');
    // ⚠️ `zh-Hans`, không phải `zh-CN`. Catalog này viết bằng Hán tự giản thể, và
    // screen reader / công cụ dịch cần biến thể chữ đúng. `zh-CN` vẫn hợp lệ về cú
    // pháp nên không có dấu hiệu nào khác báo lỗi — chỉ assertion này bắt được.
    expect(headHtmlAttrs()['lang']).toBe('zh-Hans');
    expect(headHtmlAttrs()['lang']).not.toBe('zh-CN');
  });

  it("does not drop the shell's other <html>/<body> attributes", async () => {
    const { wrapper } = await mountBackofficeApp();
    await selectLanguage(wrapper, 'vi');

    // `app.vue` gộp `lang` với `htmlAttrs` của shell trong **một** `useHead`; nếu ai
    // đó tách `lang` ra một `useHead` thứ hai, phần shell có thể rơi mất.
    expect(headHtmlAttrs()).toMatchObject({ class: 'dark', dir: 'ltr' });
  });
});

describe('priority order of the locale selection', () => {
  it('a new session reads a valid cookie from the very first render', async () => {
    storeLocaleCookie('vi');
    const { wrapper } = await mountBackofficeApp();

    // Không có thao tác nào của người dùng ở đây — đây là nhánh "khởi tạo từ cookie".
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.vi);
    expect(composer.locale.value).toBe('vi');
    expect(headHtmlAttrs()['lang']).toBe('vi');
  });

  it('an invalid cookie falls back to the default, not to another locale', async () => {
    storeLocaleCookie('klingon');
    const { wrapper } = await mountBackofficeApp();

    // ⚠️ Assertion trên `composer.locale.value` là assertion **duy nhất** phân biệt
    // được hai hành vi ở đây, và nó bắt buộc phải có: `fallbackLocale` là `en`, nên
    // một app nhận cookie rác làm locale vẫn render ra **đúng** câu tiếng Anh và vẫn
    // cho `lang="en"` (`getBackofficeLocaleDefinition('klingon')` là `undefined`, và
    // `language` rơi về `'en'`). Đo được: nếu `parseBackofficeLocale` chấp nhận mọi
    // chuỗi thì hai khẳng định văn bản/`lang` phía dưới **vẫn xanh** — chỉ locale của
    // composer cho thấy sự thật (`'klingon'`).
    expect(composer.locale.value).toBe('en');
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.en);
    expect(headHtmlAttrs()['lang']).toBe('en');
    // Và selector không được hiển thị một lựa chọn không có trong registry.
    const select = wrapper.find('[data-testid="backoffice-language-select"]');
    expect((select.element as HTMLSelectElement).value).toBe('en');
  });

  it('the in-session choice beats an older stored cookie', async () => {
    // Cookie đã lưu là `vi`; người dùng vừa chọn `en`. UI phải đổi **ngay**.
    storeLocaleCookie('vi');
    const { wrapper } = await mountBackofficeApp();
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.vi);

    await selectLanguage(wrapper, 'en');
    expect(pageTitle(wrapper)).toBe(EXPECTED.pageOverviewTitle.en);
    expect(composer.locale.value).toBe('en');
    expect(headHtmlAttrs()['lang']).toBe('en');
  });

  it('writes the new choice to the cookie so the next session remembers', async () => {
    const { wrapper } = await mountBackofficeApp();
    await selectLanguage(wrapper, 'zh-CN');

    expect(readLocaleCookie()).toBe('zh-CN');
  });

  it('the in-session choice does not change when remounting within the same session', async () => {
    storeLocaleCookie('en');
    const { wrapper, remount } = await mountBackofficeApp();
    await selectLanguage(wrapper, 'vi');

    const again = await remount();
    expect(pageTitle(again)).toBe(EXPECTED.pageOverviewTitle.vi);
  });
});

describe('SSR initializes from the cookie', () => {
  it('server HTML is already localized, not waiting for the client to patch the DOM', async () => {
    // ⚠️ Đây là phép đo **không có client**: `renderToString` chỉ chạy setup + render
    // một lần trên server, nên văn bản tìm thấy trong chuỗi HTML chỉ có thể đến từ
    // server. Không có nhánh nào để "client sửa sau hydrate" làm test xanh nhầm.
    //
    // ⚠️ Vì sao không khẳng định `<html lang="...">` trên chuỗi HTML: `renderToString`
    // chỉ render **fragment của app** — đầu ra bắt đầu bằng `<!--[--><div vaul-drawer-wrapper`,
    // không có `<!DOCTYPE html>` và không có thẻ `<html>` nào (đã đo: `html.includes('<html')`
    // là `false`; ba lần `lang=` trong chuỗi đều là `<option lang="...">` của chính
    // `BackofficeLanguageSelect`). Thẻ `<html>` do document template của Nuxt dựng, nằm
    // ngoài phạm vi một unit test không chạy Nuxt. Nên `htmlAttrs` được khẳng định ở
    // **đúng tầng `app.vue` kiểm soát** — object nó truyền cho `useHead`, đúng thứ
    // Nuxt đọc để ghi ra thẻ `<html>` thật.
    storeLocaleCookie('vi');
    // Trước khi render chưa có gì: khẳng định dưới đây vì thế chắc chắn đo giá trị
    // **do lần render này sinh ra**, không phải state còn sót của test trước.
    expect(headHtmlAttrs()).toEqual({});
    const html = await renderBackofficeAppToHtml();

    expect(html).toContain(EXPECTED.pageOverviewTitle.vi);
    expect(html).toContain(EXPECTED.navStaff.vi);
    expect(html).toContain(EXPECTED.pageOverviewDescription.vi);
    // Nội dung tiếng Anh không được lọt vào HTML của một phiên tiếng Việt.
    expect(html).not.toContain(EXPECTED.pageOverviewDescription.en);
    // `<html lang>` được quyết định trong cùng lần render đó.
    expect(headHtmlAttrs()['lang']).toBe('vi');
  });

  it('without a cookie the server renders English with lang="en"', async () => {
    const html = await renderBackofficeAppToHtml();

    expect(html).toContain(EXPECTED.pageOverviewTitle.en);
    expect(headHtmlAttrs()['lang']).toBe('en');
  });
});
