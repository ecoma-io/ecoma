// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import type { ContentNavigationItem } from '@nuxt/content';
import PublicBreadcrumbs from '~/components/PublicBreadcrumbs.vue';
import PublicNavDisclosure from '~/components/PublicNavDisclosure.vue';
import DocsSidebar from '~/components/docs/DocsSidebar.vue';
import type { DocsBreadcrumb } from '~/utils/docs-breadcrumbs';
import type { LegalBreadcrumb } from '~/domain/legal-navigation';

/**
 * Stub `NuxtLink` giữ đúng shape HTML prerender (`<a href>`): functional
 * component nhận prop `to` + slot default. Đăng ký qua mount option
 * `global.components` — component resolver, không phải biến toàn cục.
 *
 * `PublicBreadcrumbs` render link bằng `NuxtLink`, nên không stub thì
 * `findAll('a')` rỗng và các assertion về `aria-current` sẽ pass một cách
 * vô nghĩa.
 */
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.());
  },
});

/**
 * Options mount chung — NuxtLink resolve ở mọi tầng của cây.
 *
 * Không nhét qua helper với `Record<string, unknown>`: hai component có kiểu
 * props khác nhau nên props phải được kiểm với kiểu thật của từng SFC — đó là
 * điều ta muốn ở đây, vì spec này ghim **contract props** của các shell dùng
 * chung.
 */
const GLOBAL_STUBS = { components: { NuxtLink: NuxtLinkStub } };

/**
 * Render test cho hai shell dùng chung của các bề mặt public có đường dẫn —
 * **trong jsdom**, qua `@vue/test-utils` mount.
 *
 * Vì sao cần spec riêng: hai component này được docs **và** legal dùng chung,
 * nhưng trước đó chỉ được kiểm chứng gián tiếp — qua view của legal
 * (`legal-page.spec.ts`) và qua HTML prerender (`tests/static-output.spec.ts`).
 * Cả hai đều bỏ sót đúng loại hồi quy mà spec này ghim: đổi cấu trúc prop,
 * bỏ `open`, hoặc thêm class phụ thuộc breakpoint mà không ai mount trực tiếp
 * để thấy.
 *
 * Đặc biệt là `PublicNavDisclosure`: nó là nơi duy nhất giữ `<details>` của
 * sidebar mobile **của cả hai bề mặt**, và nó không mang `lg:*` nào — ẩn/hiện
 * theo breakpoint là việc của caller. Đây là hợp đồng cần ghim.
 */

/** Chuỗi breadcrumb mẫu: mắt đầu là link, mắt cuối là trang hiện tại. */
const TWO_CRUMBS = [
  { path: '/en/legal', title: 'Legal Center' },
  { path: '/en/legal/privacy', title: 'Privacy Policy' },
];

describe('PublicBreadcrumbs', () => {
  it('renders nothing when there are no entries', () => {
    // Không có `<nav>` rỗng: một landmark không nhãn nào cũng là landmark thừa.
    const wrapper = mount(PublicBreadcrumbs, {
      props: { entries: [], label: 'Legal' },
      global: GLOBAL_STUBS,
    });
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('marks exactly the last entry as the current page', () => {
    const wrapper = mount(PublicBreadcrumbs, {
      props: { entries: TWO_CRUMBS, label: 'Legal' },
      global: GLOBAL_STUBS,
    });
    const current = wrapper
      .findAll('a')
      .filter((link) => link.attributes('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.attributes('href')).toBe('/en/legal/privacy');
  });

  it('hides the separator from assistive technology', () => {
    const wrapper = mount(PublicBreadcrumbs, {
      props: { entries: TWO_CRUMBS, label: 'Legal' },
      global: GLOBAL_STUBS,
    });
    expect(wrapper.findAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('exposes a distinct accessible name on the nav landmark', () => {
    // Mọi `<nav>` trên trang phải tên khác nhau, nếu không screen reader đọc
    // chúng như cùng một landmark.
    const wrapper = mount(PublicBreadcrumbs, {
      props: { entries: TWO_CRUMBS, label: 'Legal' },
      global: GLOBAL_STUBS,
    });
    expect(wrapper.find('nav').attributes('aria-label')).toBe('Legal');
  });
});

/** Mount disclosure với cây nav mẫu — cây render bởi caller, không phải khung. */
function mountDisclosure() {
  return mount(PublicNavDisclosure, {
    props: { label: 'Legal documents' },
    slots: { default: '<nav aria-label="Legal documents"><a href="/en/legal">Legal</a></nav>' },
  });
}

describe('PublicNavDisclosure', () => {
  it('renders the disclosure open so SSR and hydrate agree', () => {
    // `open` là static attribute: nếu mất, người đọc phải bấm mới thấy cây nav
    // trên mobile, và HTML prerender lệch với client.
    const wrapper = mountDisclosure();
    expect(wrapper.find('details').exists()).toBe(true);
    expect(wrapper.find('details').attributes('open')).toBe('');
  });

  it('carries the label on the summary', () => {
    const wrapper = mountDisclosure();
    expect(wrapper.find('summary').text()).toBe('Legal documents');
  });

  it('renders the caller tree inside the disclosure', () => {
    const wrapper = mountDisclosure();
    expect(wrapper.find('details nav').attributes('aria-label')).toBe('Legal documents');
  });

  it('carries no breakpoint classes of its own', () => {
    // Cả ba call site bọc component này trong `lg:hidden` và render lại cây nav
    // trong `<aside class="hidden lg:block">`, nên `lg:*` ở đây là class chết.
    // Class chết dễ khiến người đọc tin rằng khung tự lo việc ẩn/hiện — và một
    // call site mới bỏ `lg:hidden` ở cha sẽ hỏng sidebar desktop ngay.
    expect(mountDisclosure().html()).not.toMatch(/class="[^"]*\blg:/u);
  });
});

/**
 * Cây docs mẫu — `ContentNavigationItem` có `stem` và `children` như optional
 * nên chỉ cần các trường render thật sự đọc.
 */
const DOCS_ITEMS = [
  { title: 'Getting started', path: '/en/docs/getting-started' },
  {
    title: 'API',
    path: '/en/docs/api',
    children: [{ title: 'Gateway', path: '/en/docs/api/gateway' }],
  },
] as unknown as ContentNavigationItem[];

/**
 * Mount `DocsSidebar` — lớp ráp duy nhất giữ cây nav mobile của docs.
 *
 * Khoảng trống này là thật: `public-shell-parts.spec.ts` mount
 * `PublicNavDisclosure` với slot tĩnh nên không đi qua `DocsSidebar`, còn
 * `static-output.spec.ts` chỉ có assertion sidebar cho **legal**. Nên nếu
 * `DocsSidebar` ngừng forward `currentPath` xuống `DocsNavTree`, toàn bộ sidebar
 * mobile của docs mất highlight mà suite vẫn xanh — và đây là thay đổi duy nhất
 * của PR này chạm render path đó.
 */
function mountDocsSidebar(currentPath: string) {
  return mount(DocsSidebar, {
    props: { items: DOCS_ITEMS, currentPath, label: 'Documentation' },
  });
}

describe('DocsSidebar', () => {
  it('renders the docs tree inside the mobile disclosure', () => {
    const wrapper = mountDocsSidebar('/en/docs/api');
    // `PublicNavDisclosure` không mang `lg:*` nên cây phải nằm trong `<details>`.
    expect(wrapper.find('details nav').exists()).toBe(true);
    expect(wrapper.find('details nav').attributes('aria-label')).toBe('Documentation');
  });

  it('forwards currentPath so exactly one entry is marked as the current page', () => {
    const wrapper = mountDocsSidebar('/en/docs/api');
    const current = wrapper
      .findAll('a')
      .filter((link) => link.attributes('aria-current') === 'page');
    // Đúng một mắt — `currentPath` phải tới được `DocsNavTree`, không phải bị
    // rơi ở wrapper và khiến highlight mất hoàn toàn.
    expect(current).toHaveLength(1);
    expect(current[0]?.attributes('href')).toBe('/en/docs/api');
  });

  it('marks nothing when no entry matches the current path', () => {
    // Cũng là tổng quát của trên: so khớp là pathname đầy đủ, không suy từ tiêu đề.
    const wrapper = mountDocsSidebar('/en/docs/somewhere-else');
    expect(wrapper.findAll('a[aria-current="page"]')).toHaveLength(0);
  });
});

/**
 * Ghim hợp đồng cấu trúc của `PublicBreadcrumbs.entries`.
 *
 * Component dùng chung khai shape `{path, title}` nội tuyến để không phụ thuộc
 * type của từng bề mặt, còn docs và legal mỗi module export type riêng cùng
 * shape. Vì structural typing, thêm/bớt field ở một trong hai type domain **không**
 * làm hỏng typecheck tại prop của component — hợp đồng có thể trôi trong im
 * lặng. Ba `satisfies` dưới đây đỏ ngay ở typecheck khi hai producer lệch shape,
 * trước khi bất kỳ component nào render.
 *
 * `satisfies` chứ không phải `extends`: `extends` chỉ kiểm một chiều (type có
 * thỏa shape không) — đủ ở đây vì component chỉ *đọc*, không ghi thêm field nào
 * ngược lại. Còn `satisfies` kiểm cả chiều ngược, nên nó cũng bắt được trường hợp
 * type domain **thêm** field bắt buộc mà component không đảm bảo.
 */
describe('PublicBreadcrumbs.entries contract', () => {
  it('keeps both domain producers assignable to the shared entry shape', () => {
    const docsEntry = { path: '/en/docs', title: 'Documentation' };
    const legalEntry = { path: '/en/legal', title: 'Legal Center' };
    expect(docsEntry satisfies DocsBreadcrumb).toEqual(docsEntry);
    expect(legalEntry satisfies LegalBreadcrumb).toEqual(legalEntry);
    // Chiều ngược: hai type producer phải gán được vào shape component dùng.
    const asShared: readonly { readonly path: string; readonly title: string }[] = [
      docsEntry satisfies DocsBreadcrumb,
      legalEntry satisfies LegalBreadcrumb,
    ];
    expect(asShared.map((entry) => entry.path)).toEqual(['/en/docs', '/en/legal']);
  });
});
