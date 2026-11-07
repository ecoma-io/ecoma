// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { buildLegalSidebar, type LegalSidebarNav } from './legal-navigation';
import {
  groupLegalDocumentsByCategory,
  legalCategoryOrder,
  type LegalDocumentRecord,
} from './legal-collection';

/**
 * Render test cho hai view của Legal Center (`LegalLandingView`,
 * `LegalDocumentView`) — trong jsdom, qua `@vue/test-utils` mount.
 *
 * Phạm vi: view nhận props đã resolve và render đúng — sidebar dùng chung,
 * grouping, badge draft/published, metadata line, breadcrumbs, related links,
 * shell chrome. Route (`pages/[locale]/legal/[[...slug]].vue`) là nơi query;
 * logic query thuộc runtime Nuxt và được phủ ở static-output tests (artifact
 * thật) thay vì stub.
 *
 * `ContentRenderer` được resolve qua alias `#components` trong
 * `vitest.config.mts` (fixture placeholder — xem
 * `shared/test-fixtures/nuxt-components.ts`): body Markdown AST của Nuxt
 * Content không dựng được ngoài runtime; view render nó nguyên vẹn qua props
 * `page` — contract của view là truyền value, không biến đổi.
 */

/**
 * Stub `NuxtLink` giữ đúng shape HTML prerender (`<a href>`): functional
 * component nhận prop `to` + slot default. Đăng ký qua mount option
 * `global.components` — component resolver, không phải biến toàn cục.
 */
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.());
  },
});

/** Options mount chung — NuxtLink resolve ở mọi tầng của cây. */
function mountOptions(options: { props: Record<string, unknown> }) {
  return {
    props: options.props,
    global: { components: { NuxtLink: NuxtLinkStub } },
  };
}

let LegalLandingView: Component;
let LegalDocumentView: Component;
let LegalLayout: Component;

beforeAll(async () => {
  // Dynamic import sau khi stub: import tĩnh bị ESM hoist lên trước `stubGlobal`.
  LegalLandingView = (
    (await import('~/components/legal/LegalLandingView.vue')) as { default: Component }
  ).default;
  LegalDocumentView = (
    (await import('~/components/legal/LegalDocumentView.vue')) as { default: Component }
  ).default;
  LegalLayout = ((await import('~/components/legal/LegalLayout.vue')) as { default: Component })
    .default;
});

const PUBLISHED_SUMMARY = {
  path: '/en/legal/privacy',
  slug: 'privacy',
  title: 'Privacy Policy — ecoma.io',
  description: 'How ecoma.io collects, uses and protects personal data.',
  category: 'policy',
  status: 'published',
  reviewStatus: 'reviewed',
  version: '1.0',
  effectiveDate: '2026-10-10',
  locale: 'en',
} as const;

const TERMS_SUMMARY = {
  path: '/en/legal/terms',
  slug: 'terms',
  title: 'Terms of Service — ecoma.io',
  description: 'The terms that govern use of the ecoma.io platform.',
  category: 'terms',
  status: 'published',
  reviewStatus: 'reviewed',
  version: '1.0',
  effectiveDate: '2026-10-10',
  locale: 'en',
} as const;

const DRAFT_SUMMARY = {
  path: '/en/legal/platform-terms-of-service',
  slug: 'platform-terms-of-service',
  title: 'Platform Terms of Service — ecoma.io',
  description: 'Draft structured outline of the terms governing the ecoma.io platform.',
  category: 'terms',
  status: 'draft',
  reviewStatus: 'unreviewed',
  version: '0.1',
  effectiveDate: null,
  locale: 'en',
} as const;

/** Stub `page` — view chỉ truyền value vào ContentRenderer, không đọc sâu. */
const PAGE_VALUE = { path: '/en/legal/privacy', title: 'Privacy Policy' };

const UI_EN = {
  legal: 'Legal Center',
  policies: 'Policies',
  terms: 'Terms',
  draft: 'Draft',
  published: 'Published',
  unreviewed: 'Not legally reviewed',
  version: 'Version',
  effective: 'Effective',
  related: 'Related documents',
  navigation: 'Legal documents',
  breadcrumbs: 'Legal breadcrumbs',
} as const;

/**
 * Sidebar dựng từ **cùng grouped listing** mà route truyền cho view — ở đây dựng
 * bằng chính `buildLegalSidebar` để test view không phải giả định shape thủ
 * công (thuật toán của domain có spec riêng ở `legal-navigation.spec.ts`).
 *
 * Kiểu tham số là `LegalDocumentRecord` chứ không phải typeof một hằng fixture:
 * các fixture dùng `as const` nên `path` của chúng là literal type, và một
 * fixture khác sẽ không gán được vào tham số đó.
 */
function sidebarFor(input: {
  readonly currentPath: string;
  readonly policy?: readonly LegalDocumentRecord[];
  readonly terms?: readonly LegalDocumentRecord[];
  readonly locale?: 'en' | 'vi';
  /** Ghi đè nhãn nhóm — dùng để dựng fixture có nhãn **khác** `ui`. */
  readonly categoryLabels?: { readonly policy: string; readonly terms: string };
}): LegalSidebarNav {
  const locale = input.locale ?? 'en';
  return buildLegalSidebar({
    legalRootPath: `/${locale}/legal`,
    currentPath: input.currentPath,
    // Nhãn landing lấy theo locale: UI copy của bề mặt là localized, nên fixture
    // VI không được mang nhãn EN (view nhận `ui` từ route, không suy ra từ path).
    legalRootTitle: locale === 'vi' ? 'Trung tâm Pháp lý' : UI_EN.legal,
    categoryOrder: ['policy', 'terms'],
    categoryLabels:
      input.categoryLabels ??
      (locale === 'vi'
        ? { policy: 'Chính sách', terms: 'Điều khoản' }
        : { policy: UI_EN.policies, terms: UI_EN.terms }),
    grouped: {
      policy: input.policy ?? [PUBLISHED_SUMMARY],
      terms: input.terms ?? [TERMS_SUMMARY],
    },
  });
}

/**
 * Link sidebar **desktop** — nằm trong `<aside class="hidden lg:block">`, KHÔNG
 * phải bản disclosure mobile.
 *
 * Neo theo `<aside>` chứ không theo `aria-label`: cả hai bản đều mang **cùng**
 * một `aria-label` (`ui.navigation`) và bản mobile đứng trước `<aside>` trong DOM,
 * nên `find(nav => nav.attributes('aria-label') === …)` trả về bản mobile. Các
 * assertion vẫn xanh vì hai bản render cùng dữ liệu — nhưng xoá `<LegalNav>`
 * trong `<aside>` đi thì suite vẫn pass, tức cột desktop chưa từng được kiểm.
 * `landmarks` vẫn lấy từ **mọi** `<nav>` của trang vì đó là thứ test đang khẳng
 * định (tên landmark phải phân biệt được với nhau).
 *
 * Assertion nằm trong helper phải nằm ngoài `it` (oxlint
 * `vitest/no-conditional-expect`), nên thiếu aside là **throw** chứ không phải
 * `expect` — lỗi mount hiện ra ngay với thông điệp rõ, không phải một
 * assertion rỗng.
 */
function desktopSidebarLinks(wrapper: ReturnType<typeof mount>): {
  hrefs: string[];
  current: string[];
  landmarks: string[];
} {
  const aside = wrapper.find('aside');
  if (aside.exists() === false) {
    throw new Error('desktop sidebar <aside> was not rendered');
  }
  const sidebarNav = aside.find('nav');
  if (sidebarNav.exists() === false) {
    throw new Error(`desktop sidebar <nav> labelled ${UI_EN.navigation} was not rendered`);
  }
  const anchors = sidebarNav.findAll('a');
  return {
    hrefs: anchors.map((anchor) => anchor.attributes('href') ?? ''),
    current: anchors
      .filter((anchor) => anchor.attributes('aria-current') === 'page')
      .map((anchor) => anchor.attributes('href') ?? ''),
    landmarks: wrapper.findAll('nav').map((nav) => nav.attributes('aria-label') ?? ''),
  };
}

/**
 * Nhóm trong cây điều hướng của view — `LegalNav` dùng chung cho cả disclosure
 * mobile lẫn cột sticky desktop, nên đo trên **một** bản render là đủ: hai bản
 * nhận cùng `sidebar`.
 *
 * `documents: null` = nhóm không render `<ul>` nào (nhóm rỗng). Trả về chi tiết
 * này thay vì đếm `<ul>` tổng vì `<ul>` ngoài cùng của cây luôn tồn tại và hai
 * danh sách cùng mang lớp `space-y-1` — đếm theo class là đo nhầm.
 */
function sidebarNavGroups(
  wrapper: ReturnType<typeof mount>,
): readonly { label: string; documents: number | null }[] {
  const nav = wrapper
    .findAll('nav')
    .find((candidate) => candidate.attributes('aria-label') === UI_EN.navigation);
  if (nav === undefined) {
    throw new Error(`sidebar <nav> labelled ${UI_EN.navigation} was not rendered`);
  }
  const groups = nav.findAll('li').filter((li) => li.find('p').exists());
  return groups.map((group) => {
    const label = group.find('p');
    const documents = group.findAll('ul');
    return {
      label: label.text(),
      documents: documents.length === 0 ? null : (documents[0]?.findAll('li').length ?? null),
    };
  });
}

/**
 * Nhóm ở **cột chính** của landing — khác `sidebarNavGroups` ở trên, cái đó đo
 * cây nav.
 *
 * Phải đếm **`<ul>`** chứ không chỉ `<li>`: một `<ul>` rỗng vẫn là `<ul>` trong
 * DOM và có 0 `<li>`, nên chỉ đếm `<li>` thì "không render `<ul>`" và "render
 * `<ul>` rỗng" ra cùng một con số — và guard đúng nhưng test hỏng vẫn xanh.
 */
function landingMainColumnGroups(
  wrapper: ReturnType<typeof mount>,
): readonly { heading: string; lists: number; items: number }[] {
  return wrapper.findAll('section').map((section) => ({
    heading: section.find('h2').text(),
    lists: section.findAll('ul').length,
    items: section.findAll('ul li').length,
  }));
}

/** Sidebar không có mắt `Overview` — anchor landing không resolve được. */
function sidebarWithoutOverview(input: {
  readonly currentPath: string;
  readonly policy?: readonly LegalDocumentRecord[];
  readonly terms?: readonly LegalDocumentRecord[];
}): LegalSidebarNav {
  return buildLegalSidebar({
    // `undefined` là input mà route thật truyền khi không localize được landing —
    // builder bỏ mắt Overview thay vì dựng một URL không tin được.
    legalRootPath: undefined,
    currentPath: input.currentPath,
    legalRootTitle: UI_EN.legal,
    categoryOrder: ['policy', 'terms'],
    categoryLabels: { policy: UI_EN.policies, terms: UI_EN.terms },
    grouped: {
      policy: input.policy ?? [PUBLISHED_SUMMARY],
      terms: input.terms ?? [TERMS_SUMMARY],
    },
  });
}

/**
 * Khung chung của cả hai bề mặt — ghim những class mà chính các vòng review đã
 * buộc phải sửa.
 *
 * Mount trực tiếp `LegalLayout` chứ không chỉ qua view: hai view đều bọc nó, nên
 * một class sai ở đây là hỏng **cả hai** bề mặt cùng lúc, mà các test hiện có
 * không phát hiện được (đã kiểm chứng bằng mutation: bỏ `max-w-3xl` hay bỏ
 * `lg:hidden` đều khiến toàn bộ suite vẫn xanh).
 */
function mountLayout() {
  return mount(
    LegalLayout,
    mountOptions({
      props: {
        path: '/en/legal',
        breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
        sidebar: sidebarFor({ currentPath: '/en/legal' }),
        availableLocales: ['en'],
        ui: UI_EN,
      },
    }),
  );
}

describe('LegalLayout', () => {
  it('keeps the reading column at max-w-3xl for both surfaces', () => {
    // Vòng review 2: landing không có giới hạn này nên ở `ultrawide` nó trải
    // ~1128px còn detail dỗ 768px — hai bề mặt của cùng một Legal Center hiện ra
    // với bề rộng khác nhau. Một lần, đúng một: hai lần nghĩa là cột đọc bị lồng.
    expect(mountLayout().findAll('.max-w-3xl')).toHaveLength(1);
  });

  it('hides the mobile disclosure below lg and shows the desktop column above it', () => {
    const wrapper = mountLayout();
    // Disclosure mobile nằm trong `lg:hidden`; bỏ class này thì sidebar xuất
    // hiện hai lần ở desktop (bản disclosure lẫn bản `<aside>`).
    const disclosure = wrapper.find('details').element.closest('div');
    expect(disclosure?.className.split(' ')).toContain('lg:hidden');
    // Cột desktop là `<aside class="hidden lg:block">` — bỏ `hidden` thì nó
    // xuất hiện ở mobile.
    expect(wrapper.find('aside').classes()).toEqual(expect.arrayContaining(['hidden', 'lg:block']));
    // Đúng một cột sticky, và nó chứa cây nav mang accessible name của sidebar.
    const aside = wrapper.find('aside');
    expect(aside.findAll('.sticky')).toHaveLength(1);
    expect(aside.find('nav').attributes('aria-label')).toBe(UI_EN.navigation);
    // Offset của cột dính cũng phải ghim, không chỉ số lượng. Header
    // `PublicHeader` là `sticky top-0` với thanh trong `h-16` = 4rem, nên cột này
    // phải neo ở `top-20`; neo thấp hơn thì mép trên nằm trong vùng header có
    // nền và bị che, mất `Overview` cùng nhóm đầu tiên khi cuộn. Assertion trên
    // chỉ **đếm** phần tử `.sticky` nên đổi `top-20` về `top-6` vẫn xanh — đã
    // mutation-check, và cùng lý do đó có test tương ứng cho hai view docs trong
    // `docs-views.spec.ts`.
    expect(aside.find('.sticky').classes()).toContain('top-20');
  });

  it('places the content slot inside the width-limited reading column', () => {
    // `max-w-3xl` phải **bọc lấy** slot chứ không phải một `div` rỗng bên cạnh —
    // HTML prerender cho thấy `max-w-3xl` đứng trước `<h1>`. Slot rỗng thì cái
    // duy nhất còn đo được là quan hệ cha–con, nên test này truyền slot thật.
    const wrapper = mount(LegalLayout, {
      ...mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          sidebar: sidebarFor({ currentPath: '/en/legal' }),
          availableLocales: ['en'],
          ui: UI_EN,
        },
      }),
      slots: { default: '<h1>Legal Center</h1>' },
    });
    expect(wrapper.find('.max-w-3xl h1').exists()).toBe(true);
  });
});

describe('LegalLandingView', () => {
  it('renders grouped sections in category order with links to each document', () => {
    const grouped = {
      policy: [PUBLISHED_SUMMARY],
      terms: [DRAFT_SUMMARY],
    };
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped,
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({ currentPath: '/en/legal', terms: [DRAFT_SUMMARY] }),
          ui: UI_EN,
        },
      }),
    );
    const text = wrapper.text();
    expect(text).toContain('Legal Center');
    // Heading nhóm nằm ở cột chính, theo đúng thứ tự category.
    const headings = wrapper.findAll('h2').map((heading) => heading.text());
    expect(headings).toEqual(['Policies', 'Terms']);
    // Mỗi văn bản là một link tới path collection.
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
    expect(hrefs).toContain('/en/legal/privacy');
    expect(hrefs).toContain('/en/legal/platform-terms-of-service');
  });

  it('derives the intro line from the sidebar group names rather than the UI strings', () => {
    // Fixture cố tình mang nhãn nhóm **khác** `ui.policies`/`ui.terms`. Nếu view
    // in dòng này từ `ui` thì kết quả là cặp nhãn UI, còn bản đúng phải là cặp
    // nhãn nhóm — hai chuỗi đó không trùng nhau nên assertion không thể xanh
    // nhầm. Đây là mutant mà finding vòng 9 nêu: revert về `{{ ui.policies }} ·
    // {{ ui.terms }}` khiến toàn bộ suite xanh, vì `static-output.spec.ts` chỉ
    // match `/Policies|Chính sách/` và đó là match nhờ `<h2>` phía dưới.
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped: { policy: [PUBLISHED_SUMMARY], terms: [TERMS_SUMMARY] },
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({
            currentPath: '/en/legal',
            categoryLabels: { policy: 'Group One', terms: 'Group Two' },
          }),
          ui: UI_EN,
        },
      }),
    );
    // Dòng giới thiệu nằm trong `<header>` **chứa `<h1>`**. Không dùng
    // `wrapper.find('header p')`: `PublicShell` và sidebar đều có `<header>` riêng
    // (site header chứa các nhãn nhóm của docs), nên `find` trúng header đầu
    // tiên và trả về "Getting started". Neo theo quan hệ `<h1>` mới đúng bề mặt.
    const landingHeader = wrapper.findAll('header').find((header) => header.find('h1').exists());
    expect(landingHeader).toBeDefined();
    expect(landingHeader?.find('p').text()).toBe('Group One · Group Two');
  });

  it('shows the draft badge and review status for draft documents', () => {
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped: { policy: [], terms: [DRAFT_SUMMARY] },
          availableLocales: ['en'],
          sidebar: sidebarFor({ currentPath: '/en/legal', terms: [DRAFT_SUMMARY] }),
          ui: UI_EN,
        },
      }),
    );
    const text = wrapper.text();
    expect(text).toContain('Draft');
    expect(text).toContain('Not legally reviewed');
  });

  it('renders both locales without leaking the other locale copy', () => {
    const viUi = {
      ...UI_EN,
      legal: 'Trung tâm Pháp lý',
      policies: 'Chính sách',
      terms: 'Điều khoản',
    };
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/vi/legal',
          breadcrumbs: [{ path: '/vi/legal', title: viUi.legal }],
          grouped: { policy: [], terms: [] },
          availableLocales: ['vi'],
          sidebar: sidebarFor({ currentPath: '/vi/legal', policy: [], terms: [], locale: 'vi' }),
          ui: viUi,
        },
      }),
    );
    const text = wrapper.text();
    expect(text).toContain('Trung tâm Pháp lý');
    expect(text).not.toContain('Legal Center');
  });

  it('marks Overview as the current page in the sidebar', () => {
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped: { policy: [PUBLISHED_SUMMARY], terms: [TERMS_SUMMARY] },
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({ currentPath: '/en/legal' }),
          ui: UI_EN,
        },
      }),
    );
    const nav = desktopSidebarLinks(wrapper);
    expect(nav.current).toEqual(['/en/legal']);
    // Overview đứng đầu, rồi tới văn bản theo thứ tự nhóm.
    expect(nav.hrefs).toEqual(['/en/legal', '/en/legal/privacy', '/en/legal/terms']);
  });

  it('groups sidebar entries by category with policies before terms', () => {
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped: { policy: [PUBLISHED_SUMMARY], terms: [TERMS_SUMMARY] },
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({ currentPath: '/en/legal' }),
          ui: UI_EN,
        },
      }),
    );
    // Tên nhóm ở sidebar là nhãn của `<li>`, **không phải heading**: cột chính
    // đã có `<h2>` cho cùng nhóm, thêm heading thứ hai sẽ lặp trong document
    // outline. Neo vào nav của sidebar vì mega panel của header cũng có heading
    // nhóm (Surfaces, Documentation, Platform, Legal) và sẽ lẫn vào kết quả.
    const sidebarNav = wrapper
      .findAll('nav')
      .find((nav) => nav.attributes('aria-label') === UI_EN.navigation);
    if (sidebarNav === undefined) {
      throw new Error(`sidebar <nav> labelled ${UI_EN.navigation} was not rendered`);
    }
    const groupLabels = sidebarNav.findAll('li p').map((label) => label.text());
    expect(groupLabels).toEqual(['Policies', 'Terms']);
    expect(
      sidebarNav.findAll('h1, h2, h3, h4, h5, h6'),
      'sidebar must not contribute headings',
    ).toHaveLength(0);
  });

  it('drops the empty document list of a category with no documents', () => {
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          // Cột chính rỗng ở cả hai category; sidebar thì chỉ `terms` có văn bản.
          grouped: { policy: [], terms: [] },
          availableLocales: ['en'],
          sidebar: sidebarFor({ currentPath: '/en/legal', policy: [], terms: [TERMS_SUMMARY] }),
          ui: UI_EN,
        },
      }),
    );
    // Nhóm `policy` rỗng: giữ nhãn (người đọc biết nhóm tồn tại) nhưng không
    // render `<ul>` rỗng — list không `<li>` chỉ là nhiễu cho screen reader.
    expect(sidebarNavGroups(wrapper)).toEqual([
      { label: 'Policies', documents: null },
      { label: 'Terms', documents: 1 },
    ]);
    // Cùng quy tắc ở **cột chính**, và đây là chỗ `sidebarNavGroups` không đo
    // tới: assertion trên chỉ quét trong `<nav>`. `static-output.spec.ts` không
    // bắt được vì ở production cả hai nhóm đều có văn bản, nên guard này chỉ
    // được ghim ở đây.
    expect(landingMainColumnGroups(wrapper)).toEqual([
      { heading: 'Policies', lists: 0, items: 0 },
      { heading: 'Terms', lists: 0, items: 0 },
    ]);
  });

  it('omits the Overview entry when the landing path does not resolve', () => {
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped: { policy: [PUBLISHED_SUMMARY], terms: [TERMS_SUMMARY] },
          availableLocales: ['en'],
          sidebar: sidebarWithoutOverview({ currentPath: '/en/legal/privacy' }),
          ui: UI_EN,
        },
      }),
    );
    const nav = desktopSidebarLinks(wrapper);
    // Mắt Overview bị bỏ hẳn, không render thành link tới URL rỗng.
    expect(nav.hrefs).toEqual(['/en/legal/privacy', '/en/legal/terms']);
    // `currentPath` trỏ tới văn bản thật trong cây nên vẫn đúng một mắt
    // current — mất Overview không được mất luôn dấu hiệu "đang ở đâu".
    expect(nav.current).toEqual(['/en/legal/privacy']);
    // Cây nhóm vẫn nguyên vẹn — mất Overview không được kéo theo mất điều hướng.
    expect(sidebarNavGroups(wrapper)).toEqual([
      { label: 'Policies', documents: 1 },
      { label: 'Terms', documents: 1 },
    ]);
  });

  /**
   * Ghim coupling mà template đang dựa vào nhưng type **không** bắt được.
   *
   * `sections` của `LegalLandingView` lấy category/thứ tự/nhãn từ
   * `sidebar.groups` nhưng lấy `documents` từ `grouped[group.category]` — hai
   * nguồn khác nhau. `buildLegalSidebar` chỉ bảo đảm phủ hết `categoryOrder`
   * **caller** truyền vào; nó không ràng buộc với khoá của `grouped`, nên một
   * `categoryOrder` lệch (thêm category mà `grouped` chưa có khoá, hoặc
   * `grouped` được lọc khác) sẽ làm nhóm **biến mất khỏi cột chính landing** mà
   * không có typecheck hay test nào đỏ. Ở production điều đó là rò văn bản pháp
   * lý khỏi trang, nên ở đây ghim đúng bằng chứng wiring thật của route:
   * `categoryOrder` lấy từ `legalCategoryOrder()`, `grouped` lấy từ
   * `groupLegalDocumentsByCategory(...)` trên cùng một listing.
   */
  it('keeps the sidebar category order and the landing document keys in step', () => {
    // Dựng **một cách cố ý lệch**: sidebar giữ cả hai nhóm (đúng `categoryOrder`
    // của route) trong khi `grouped` chỉ còn `policy`. Đây là dạng lệch mà
    // `sections` của `LegalLandingView` dễ mắc phải: nó lấy category/thứ tự/nhãn
    // từ `sidebar.groups` nhưng `documents` từ `grouped[group.category]`, mà
    // `buildLegalSidebar` **không** ràng buộc hai nguồn đó với nhau — chỉ bảo đảm
    // phủ hết `categoryOrder` caller truyền vào.
    const grouped = groupLegalDocumentsByCategory([PUBLISHED_SUMMARY]);
    const sidebar = buildLegalSidebar({
      legalRootPath: '/en/legal',
      currentPath: '/en/legal',
      legalRootTitle: UI_EN.legal,
      categoryOrder: legalCategoryOrder(),
      categoryLabels: { policy: UI_EN.policies, terms: UI_EN.terms },
      grouped,
    });

    // Điều kiện landing dựa vào, viết ra thành assertion: mọi category của
    // sidebar phải có khoá trong `grouped`. Ở wiring thật của route hai nguồn
    // cùng xuất phát từ `legalCategoryOrder()` + `groupLegalDocumentsByCategory()`
    // nên điều kiện này đúng; assertion ở đây canh nó để một thay đổi ở
    // `buildLegalSidebar` hoặc ở route không lặp lại kiểu lệch đó trong im lặng.
    expect(sidebar.groups.every((group) => group.category in grouped)).toBe(true);

    // Nhóm `terms` không có văn bản nào ở `grouped` cố ý, nên nếu landing render
    // theo `sidebar.groups` thì cột chính **không được** vỡ — và nếu sau này ai đó
    // đổi `sections` sang duyệt `grouped` thì phải thấy nhóm `terms` biến mất
    // khỏi danh sách, tức điều kiện trên đã hỏng.
    const wrapper = mount(
      LegalLandingView,
      mountOptions({
        props: {
          path: '/en/legal',
          breadcrumbs: [{ path: '/en/legal', title: UI_EN.legal }],
          grouped,
          availableLocales: ['en'],
          sidebar,
          ui: UI_EN,
        },
      }),
    );
    expect(landingMainColumnGroups(wrapper)).toEqual([
      { heading: 'Policies', lists: 1, items: 1 },
      { heading: 'Terms', lists: 0, items: 0 },
    ]);
  });
});

describe('LegalDocumentView', () => {
  it('renders a published document without a draft banner and with its metadata line', () => {
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/en/legal/privacy',
          page: PAGE_VALUE,
          summary: PUBLISHED_SUMMARY,
          related: [],
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({ currentPath: '/en/legal/privacy' }),
          breadcrumbs: [
            { path: '/en/legal', title: 'Legal Center' },
            { path: '/en/legal/privacy', title: 'Privacy Policy — ecoma.io' },
          ],
          ui: UI_EN,
        },
      }),
    );
    const text = wrapper.text();
    // Title không render trong view (Markdown sở hữu `<h1>` qua
    // ContentRenderer, view chỉ render badges + metadata + description).
    expect(wrapper.find('h1').exists()).toBe(false);
    expect(text).toContain('Version 1.0');
    expect(text).toContain('Effective 2026-10-10');
    expect(text).toContain('Published');
    expect(text).not.toContain('Draft');
  });

  it('renders a prominent draft banner for a draft document without an effective date', () => {
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/en/legal/platform-terms-of-service',
          page: { ...PAGE_VALUE, path: DRAFT_SUMMARY.path },
          summary: DRAFT_SUMMARY,
          related: [],
          availableLocales: ['en'],
          sidebar: sidebarFor({ currentPath: '/en/legal/platform-terms-of-service' }),
          breadcrumbs: [
            { path: '/en/legal', title: 'Legal Center' },
            { path: DRAFT_SUMMARY.path, title: DRAFT_SUMMARY.title },
          ],
          ui: UI_EN,
        },
      }),
    );
    const text = wrapper.text();
    expect(text).toContain('Draft');
    expect(text).toContain('Not legally reviewed');
    // Draft chưa chốt hiệu lực: không được render đoạn "Effective undefined".
    expect(text).not.toContain('Effective null');
    expect(text).not.toContain('Effective undefined');
  });

  it('renders related documents as links in declaration order', () => {
    const refundSummary = {
      ...PUBLISHED_SUMMARY,
      path: '/en/legal/refund',
      slug: 'refund',
      title: 'Refund Policy — ecoma.io',
    };
    const paymentSummary = {
      ...PUBLISHED_SUMMARY,
      path: '/en/legal/payment',
      slug: 'payment',
      title: 'Payment Policy — ecoma.io',
    };
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/en/legal/privacy',
          page: PAGE_VALUE,
          summary: PUBLISHED_SUMMARY,
          related: [refundSummary, paymentSummary],
          availableLocales: ['en'],
          sidebar: sidebarFor({ currentPath: '/en/legal/privacy' }),
          breadcrumbs: [
            { path: '/en/legal', title: 'Legal Center' },
            { path: '/en/legal/privacy', title: 'Privacy Policy — ecoma.io' },
          ],
          ui: UI_EN,
        },
      }),
    );
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
    // Related list nằm trong `<ul>` riêng; phải neo vào đó chứ không vào toàn
    // DOM — mega panel của header cũng chứa các URL policy (nay thêm cả
    // landing, sidebar và breadcrumb), nên `indexOf` trên `hrefs` gộp sẽ đo
    // nhầm thứ tự.
    const relatedHrefs = wrapper.findAll('section ul li a').map((a) => a.attributes('href'));
    // Thứ tự khai báo được giữ.
    expect(relatedHrefs).toEqual(['/en/legal/refund', '/en/legal/payment']);
    // Link về Legal Center landing cũng có mặt.
    expect(hrefs).toContain('/en/legal');
  });

  it('marks the open document, not Overview, as the current sidebar entry', () => {
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/en/legal/privacy',
          page: PAGE_VALUE,
          summary: PUBLISHED_SUMMARY,
          related: [],
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({ currentPath: '/en/legal/privacy' }),
          breadcrumbs: [
            { path: '/en/legal', title: 'Legal Center' },
            { path: '/en/legal/privacy', title: 'Privacy Policy — ecoma.io' },
          ],
          ui: UI_EN,
        },
      }),
    );
    const nav = desktopSidebarLinks(wrapper);
    // Đúng một mắt mang `aria-current="page"` và nó là văn bản đang đọc.
    expect(nav.current).toEqual(['/en/legal/privacy']);
    // Overview vẫn là link hợp lệ tới landing (không phải link chết, không mất
    // khỏi sidebar khi ở detail).
    expect(nav.hrefs).toContain('/en/legal');
  });

  it('omits the footer link back to the overview when the anchor is unresolvable', () => {
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/en/legal/privacy',
          page: PAGE_VALUE,
          summary: PUBLISHED_SUMMARY,
          related: [],
          availableLocales: ['en'],
          sidebar: sidebarWithoutOverview({ currentPath: '/en/legal/privacy' }),
          breadcrumbs: [{ path: '/en/legal/privacy', title: 'Privacy Policy' }],
          ui: UI_EN,
        },
      }),
    );
    // `sidebar.overview` là `null`, nên `v-if` phải bỏ hẳn link cuối trang thay vì
    // dereference `null` lúc render. Không có case nào mount detail view với
    // `overview: null` thì bỏ `v-if` đi suite vẫn xanh (đã kiểm chứng bằng mutation).
    expect(wrapper.text()).not.toContain(`← ${UI_EN.legal}`);
  });

  it('renders breadcrumbs ending at the current document', () => {
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/vi/legal/privacy',
          page: PAGE_VALUE,
          summary: { ...PUBLISHED_SUMMARY, path: '/vi/legal/privacy' },
          related: [],
          availableLocales: ['vi'],
          sidebar: sidebarFor({ currentPath: '/vi/legal/privacy', locale: 'vi' }),
          breadcrumbs: [
            { path: '/vi/legal', title: 'Trung tâm Pháp lý' },
            { path: '/vi/legal/privacy', title: 'Chính sách bảo mật — ecoma.io' },
          ],
          ui: { ...UI_EN, legal: 'Trung tâm Pháp lý' },
        },
      }),
    );
    const crumbs = wrapper.findAll('nav[aria-label="Legal breadcrumbs"] ol li a');
    expect(crumbs.map((a) => a.attributes('href'))).toEqual(['/vi/legal', '/vi/legal/privacy']);
    // Mắt cuối là page hiện tại; mắt đầu là link về landing.
    expect(crumbs.map((a) => a.attributes('aria-current'))).toEqual([undefined, 'page']);
  });

  it('gives the sidebar and the breadcrumb distinct accessible names', () => {
    const wrapper = mount(
      LegalDocumentView,
      mountOptions({
        props: {
          path: '/en/legal/privacy',
          page: PAGE_VALUE,
          summary: PUBLISHED_SUMMARY,
          related: [],
          availableLocales: ['en', 'vi'],
          sidebar: sidebarFor({ currentPath: '/en/legal/privacy' }),
          breadcrumbs: [
            { path: '/en/legal', title: 'Legal Center' },
            { path: '/en/legal/privacy', title: 'Privacy Policy — ecoma.io' },
          ],
          ui: UI_EN,
        },
      }),
    );
    const landmarks = desktopSidebarLinks(wrapper).landmarks;
    expect(landmarks).toContain(UI_EN.navigation);
    expect(landmarks).toContain(UI_EN.breadcrumbs);
    // Cả hai nhãn phải **xuất hiện** trên trang. Phần "hai landmark phải khác
    // tên" không kiểm ở đây: `UI_EN` là fixture định nghĩa trong chính file này
    // nên so hai thuộc tính của nó luôn cho kết quả đúng, kể cả khi chuỗi thật
    // trong `legal-ui-strings.ts` đã trùng nhau. Bất biến đó canh ở
    // `legal-ui-strings.spec.ts`, đọc dictionary thật.
  });
});
