// @vitest-environment jsdom
import { mount, type DOMWrapper } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { docsUiStrings } from '~/utils/docs-ui-strings';

/**
 * Render test cho hai view của docs — `DocsLandingView`, `DocsPageView`.
 *
 * Khoảng trống này là thật và thuộc phạm vi PR này: PR đổi `DocsBreadcrumbs` →
 * `PublicBreadcrumbs`, nên **giờ** breadcrumb của docs đi qua một component dùng
 * chung với legal. Trước đó không có test nào mount hai view này, nên không ai
 * canh được prop truyền vào; `docs-ui-strings.spec.ts` chỉ kiểm chuỗi trong
 * dictionary mà không kiểm chỗ dùng, và `static-output.spec.ts` chỉ có
 * assertion breadcrumb cho **legal**.
 *
 * Kịch bản hỏng cụ thể mà spec này chặn: `:label="ui.breadcrumbs"` bị đổi thành
 * `ui.documentation` (copy-paste rất dễ vì hai chuỗi cùng nằm trong
 * `docsUiStrings`) → trang docs mang hai landmark `<nav>` trùng accessible name.
 * Đó đúng là lỗi mà JSDoc `docs-ui-strings.ts` cảnh báo.
 *
 * `ContentRenderer` resolve qua alias `#components` trong `vitest.config.mts`
 * (fixture placeholder — xem `shared/test-fixtures/nuxt-components.ts`): AST
 * Markdown của Nuxt Content không dựng được ngoài runtime. Contract của view là
 * truyền value, không biến đổi.
 *
 * Nuxt auto-import cấp `computed`/`NuxtLink` như biến toàn cục; ở đây chỉ có
 * `@vitejs/plugin-vue` nên `computed` phải có trong scope của SFC và `NuxtLink`
 * stub qua mount option `global.components` — cùng pattern `blog-views.spec.ts`.
 */

/** Stub `NuxtLink` giữ shape HTML prerender (`<a href>`) — không có nó thì `findAll('a')` rỗng. */
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.());
  },
});

const GLOBAL_STUBS = { components: { NuxtLink: NuxtLinkStub } };

let DocsLandingView: Component;
let DocsPageView: Component;

beforeAll(async () => {
  DocsLandingView = (
    (await import('~/components/docs/DocsLandingView.vue')) as { default: Component }
  ).default;
  DocsPageView = ((await import('~/components/docs/DocsPageView.vue')) as { default: Component })
    .default;
});

const UI_EN = docsUiStrings('en');
const CRUMBS = [
  { path: '/en/docs', title: 'Documentation' },
  { path: '/en/docs/api', title: 'API' },
];

/**
 * `<nav>` breadcrumb — chỉ nav có `<ol>` là con **trực tiếp**.
 *
 * Không dùng selector `> ol`: jsdom (và `@asamuzakjp/dom-selector` mà vue-test-utils
 * dùng) ném `Invalid selector > ol`, nên `find('> ol')` làm nổi test chứ không
 * kiểm được gì. Duyệt `element.children` trực tiếp.
 */
function breadcrumbNav(wrapper: ReturnType<typeof mount>): DOMWrapper<Element> {
  const nav = wrapper
    .findAll('nav')
    .find((candidate) =>
      Array.from(candidate.element.children).some((child) => child.tagName === 'OL'),
    );
  if (nav === undefined) {
    throw new Error('breadcrumb <nav> was not rendered');
  }
  return nav;
}

/**
 * Nhãn của **cột sidebar** (`DocsNavTree` trong `<aside>`), không phải bản mobile.
 *
 * Cả hai bề mặt đều mang nhãn `documentation` — mobile nằm trong disclosure,
 * desktop trong `<aside class="hidden lg:block">`. Đó là chủ ý: chúng là cùng một
 * cây navigation ở hai breakpoint, và ẩn/hiện bằng CSS chứ không phải render hai
 * nav khác nhau. Vì vậy **không** thể khẳng định "mọi nhãn nav trên trang đều khác
 * nhau" như bản test đầu tiên của spec này đã cố — đó là khẳng định sai theo
 * thiết kế component, và sẽ đỏ ngay với markup hiện tại.
 *
 * Bất biến thật nằm ở chỗ khác: breadcrumb khác sidebar. Nó đã được canh ở mức
 * dictionary cho **mọi** locale (`docs-ui-strings.spec.ts`), nên ở đây chỉ còn
 * việc xác nhận hai view **truyền đúng chuỗi vào đúng chỗ** — kịch bản hỏng mà
 * dictionary test không bắt được, vì nó không mount component nào.
 */
function sidebarLabels(wrapper: ReturnType<typeof mount>): readonly string[] {
  return wrapper
    .findAll('nav')
    .map((nav) => nav.attributes('aria-label') ?? '')
    .filter((label) => label === UI_EN.documentation || label === UI_EN.breadcrumbs);
}

/**
 * Offset `sticky` của các cột dính trong view.
 *
 * Header `PublicHeader` dính ở `h-16` = 4rem = `top-20`. Cột sidebar neo thấp hơn
 * thì mép trên của nó nằm **trong** vùng header — header có nền đục nên che mất,
 * và người đọc mất phần đầu cây nav khi cuộn. Vì vậy giá trị phải bằng đúng chiều
 * cao header, không phải một con số "nhỏ cho vừa".
 *
 * Test này tồn tại vì đổi `top-20` về `top-6` là hồi quy hình ảnh **âm thầm**: không
 * có test nào chạm offset này (`static-output.spec.ts` không nhìn class, còn
 * `legal-page.spec.ts` chỉ đếm số phần tử `.sticky` của legal chứ không đọc giá
 * trị). Đã kiểm chứng: đổi cả ba chỗ về `top-6` thì toàn bộ suite vẫn xanh.
 */
const STICKY_TOP = 'top-20';

describe('DocsLandingView', () => {
  it('anchors the sidebar below the sticky site header', () => {
    const wrapper = mount(DocsLandingView, {
      global: GLOBAL_STUBS,
      props: {
        locale: 'en',
        page: { path: '/en/docs', title: 'Documentation' },
        navigation: [{ title: 'API', path: '/en/docs/api' }],
        currentPath: '/en/docs',
        availableLocales: ['en'],
        breadcrumbs: [{ path: '/en/docs', title: 'Documentation' }],
        sectionDescriptions: {},
      },
    });
    // Chỉ cột desktop (`<aside>`) mới dính; bản mobile nằm trong disclosure nên
    // không có `.sticky` và không được tính vào.
    const sticky = wrapper.find('aside').findAll('.sticky');
    expect(sticky).toHaveLength(1);
    expect(sticky[0]?.classes()).toContain(STICKY_TOP);
  });

  it('names the breadcrumb landmark distinctly from the navigation landmark', () => {
    const wrapper = mount(DocsLandingView, {
      global: GLOBAL_STUBS,
      props: {
        locale: 'en',
        page: { path: '/en/docs', title: 'Documentation' },
        navigation: [{ title: 'API', path: '/en/docs/api' }],
        currentPath: '/en/docs',
        availableLocales: ['en'],
        breadcrumbs: [{ path: '/en/docs', title: 'Documentation' }],
        sectionDescriptions: {},
      },
    });
    // Cả hai landmark phải có mặt **và** phải khác tên — đây là điều `ui` bị truyền
    // nhầm vào sẽ phá, và nó im lặng: không có test nào khác đụng tới. Đếm `documentation`
    // hai lần là **đúng** (mobile + desktop cùng một cây nav), nên bất biến ở đây là
    // `breadcrumbs` không trùng với `documentation`, không phải mọi nhãn đều khác nhau.
    expect(sidebarLabels(wrapper)).toContain(UI_EN.breadcrumbs);
    expect(breadcrumbNav(wrapper).attributes('aria-label')).not.toBe(UI_EN.documentation);
    expect(sidebarLabels(wrapper)).toContain(UI_EN.documentation);
  });
});

describe('DocsPageView', () => {
  it('anchors both the sidebar and the table of contents below the sticky site header', () => {
    const wrapper = mount(DocsPageView, {
      global: GLOBAL_STUBS,
      props: {
        locale: 'en',
        page: { path: '/en/docs/api', title: 'API' },
        navigation: [{ title: 'API', path: '/en/docs/api' }],
        currentPath: '/en/docs/api',
        availableLocales: ['en'],
        breadcrumbs: CRUMBS,
        previous: null,
        next: null,
      },
    });
    // Trang tài liệu có **hai** cột dính: sidebar bên trái và TOC bên phải, mỗi
    // cột một `<aside>` riêng. Cả hai phải tránh header theo cùng một lý do, nên
    // kiểm từng `<aside>` chứ không gộp — gộp sẽ không bắt được khi chỉ một cột
    // bị đổi offset.
    const asides = wrapper.findAll('aside');
    // Cột TOC có `<aside>` **luôn** — chỉ `DocsToc` bên trong mới là `v-if` theo
    // `toc`, nên page không có heading vẫn giữ đúng hai cột. Fixture không truyền
    // body nên `toc` rỗng, và đây vẫn phải là 2: ô trống vẫn phải neo đúng offset.
    expect(asides).toHaveLength(2);
    for (const aside of asides) {
      const sticky = aside.findAll('.sticky');
      expect(sticky).toHaveLength(1);
      expect(sticky[0]?.classes()).toContain(STICKY_TOP);
    }
  });

  it('names the breadcrumb landmark distinctly from the navigation landmark', () => {
    const wrapper = mount(DocsPageView, {
      global: GLOBAL_STUBS,
      props: {
        locale: 'en',
        page: { path: '/en/docs/api', title: 'API' },
        navigation: [{ title: 'API', path: '/en/docs/api' }],
        currentPath: '/en/docs/api',
        availableLocales: ['en'],
        breadcrumbs: CRUMBS,
        previous: null,
        next: null,
      },
    });
    expect(breadcrumbNav(wrapper).attributes('aria-label')).toBe(UI_EN.breadcrumbs);
    expect(sidebarLabels(wrapper)).toContain(UI_EN.documentation);
  });

  it('marks exactly the last crumb as the current page', () => {
    const wrapper = mount(DocsPageView, {
      global: GLOBAL_STUBS,
      props: {
        locale: 'en',
        page: { path: '/en/docs/api', title: 'API' },
        navigation: [{ title: 'API', path: '/en/docs/api' }],
        currentPath: '/en/docs/api',
        availableLocales: ['en'],
        breadcrumbs: CRUMBS,
        previous: null,
        next: null,
      },
    });
    // Neo vào landmark breadcrumb: cây sidebar cũng có link `aria-current` trỏ
    // chính trang đang đọc, đếm toàn trang sẽ ra 3.
    const current = breadcrumbNav(wrapper)
      .findAll('a')
      .filter((link) => link.attributes('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.attributes('href')).toBe('/en/docs/api');
  });
});
