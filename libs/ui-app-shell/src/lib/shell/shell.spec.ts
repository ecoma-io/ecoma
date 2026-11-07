import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { useDirection } from 'reka-ui';
import type { VNode } from 'vue';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppShellPreferences } from '../preferences';
import { NuxtLinkStub, resetMediaQueryMatches, setMediaQueryMatches } from '../testing/nuxt-env';
import AppShell from './AppShell.vue';
import { DEFAULT_APP_SHELL_LABELS } from './labels';
import { isAppShellNavGroup } from './types';
import type { AppShellCommandGroup, AppShellLabels, AppShellNavSection } from './types';

/**
 * Test của shell trên DOM thật, không phải trên ảnh chụp component. Ba nhóm bất
 * biến được kiểm ở đây là thứ dễ vỡ im lặng nhất khi port:
 *
 * - chiều văn bản phải đi tới **cả** hai nơi: reka (menu, sheet, tooltip) và vị
 *   trí sidebar. Chỉ đổi được một trong hai là đúng cái lỗi "RTL chỉ đổi phía
 *   sidebar" mà yêu cầu cấm;
 * - bảng tuỳ chỉnh chỉ được có hai nhóm điều khiển, và `update:preferences` chỉ
 *   mang hai trường;
 * - nhánh mobile/desktop phải theo viewport, cả cho sidebar lẫn bảng tuỳ chỉnh.
 */

const DESKTOP_QUERY = '(min-width: 768px)';
const MOBILE_QUERY = '(max-width: 768px)';

/**
 * Hai query trên bù nhau ở hai phía của 768px, nhưng thư viện stub mặc định mọi
 * query chưa khai là `false`, nên phải khai cả hai — nếu không, "desktop" vẫn ra
 * đúng sidebar desktop mà bảng tuỳ chỉnh lại chọn nhánh Drawer.
 */
function setViewport(mobile: boolean): void {
  setMediaQueryMatches(MOBILE_QUERY, mobile);
  setMediaQueryMatches(DESKTOP_QUERY, !mobile);
}

const NAV: readonly AppShellNavSection[] = [
  {
    heading: 'Platform',
    items: [
      { title: 'Dashboard', href: '/dashboard' },
      { title: 'Settings', href: '/settings' },
      {
        title: 'Billing',
        href: '/billing',
        children: [
          { title: 'Invoices', href: '/billing/invoices' },
          { title: 'Plans', href: '/billing/plans' },
        ],
      },
    ],
  },
  {
    heading: 'Team',
    items: [{ title: 'Members', href: '/team/members', badge: 'New' }],
  },
];

/**
 * Đích của lệnh cố tình khác đích của mục nav (`/palette/reports` chứ không
 * `/settings`): palette teleport vào `document.body`, cùng chỗ với sidebar, nên
 * một selector theo `href` sẽ không phân biệt được hai nguồn.
 */
const COMMANDS: readonly AppShellCommandGroup[] = [
  {
    heading: 'Pages',
    items: [
      { title: 'Reports', href: '/palette/reports', keys: ['G', 'R'] },
      { title: 'Settings', href: '/palette/settings' },
    ],
  },
];

/**
 * Đọc `dir` từ chính ngữ cảnh của reka. Đây là phép đo duy nhất chứng minh
 * `ConfigProvider :dir` có tác dụng: thuộc tính `dir` trên `<html>` do app đặt
 * (không phải shell) và reka **không** đọc nó, nên nếu chỉ khẳng định
 * `document.documentElement.dir` thì test vẫn xanh kể cả khi bỏ `ConfigProvider`.
 */
const DirectionProbe = defineComponent({
  name: 'DirectionProbe',
  setup() {
    const direction = useDirection();

    return (): VNode => h('span', { 'data-probe-direction': direction.value });
  },
});

/**
 * Nav thay thế cho `NAV`, giữ nguyên **hình dạng** để phép so vnode của Vue tái
 * sử dụng đúng component nhóm: section `Platform` vẫn có ba entry, và entry thứ
 * ba (index 2) vẫn là một nhóm — chỉ khác danh tính object. Đó là điều kiện để
 * `AppShellSidebarNavGroup` được reuse thay vì mount lại, tức là điều kiện để
 * chính state `open` cục bộ trở thành vấn đề.
 *
 * Nhóm mới là `Reports` với mục con `/reports/weekly`; chính `currentPath` của
 * từng test quyết định nhóm mới có mục active hay không, nên không cần tham số.
 */
function swappedNav(): readonly AppShellNavSection[] {
  return [
    {
      heading: 'Platform',
      items: [
        { title: 'Dashboard', href: '/dashboard' },
        { title: 'Settings', href: '/settings' },
        {
          title: 'Reports',
          href: '/reports',
          children: [{ title: 'Weekly', href: '/reports/weekly' }],
        },
      ],
    },
    {
      heading: 'Team',
      items: [{ title: 'Members', href: '/team/members', badge: 'New' }],
    },
  ];
}

interface MountShellOptions {
  readonly preferences: AppShellPreferences;
  readonly currentPath?: string;
  readonly nav?: readonly AppShellNavSection[];
  readonly labels?: AppShellLabels;
}

const mountedWrappers: VueWrapper[] = [];

function mountShell({
  preferences,
  currentPath = '/dashboard',
  nav = NAV,
  labels = undefined,
}: MountShellOptions) {
  const wrapper = mount(AppShell, {
    attachTo: document.body,
    props: {
      preferences,
      nav,
      commands: COMMANDS,
      currentPath,
      links: [{ title: 'Dashboard', href: '/dashboard' }],
      labels,
    },
    slots: {
      default: () => h(DirectionProbe),
      brand: () => 'Ecoma',
      footer: () => 'Account',
      actions: () => 'Actions',
    },
    global: { components: { NuxtLink: NuxtLinkStub } },
  });

  mountedWrappers.push(wrapper as VueWrapper);

  return wrapper as VueWrapper;
}

function findByText(selector: string, text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    (element.textContent ?? '').includes(text),
  );
}

/**
 * Nút mở/đóng của một nhóm nav.
 *
 * Không dùng `data-slot`: `SidebarMenuButton` có tooltip nên đi qua
 * `TooltipTrigger as-child`, và trigger đó ghi đè `data-slot` thành
 * `tooltip-trigger`. `data-sidebar="menu-button"` là thứ còn lại trên chính thẻ
 * `<button>` của nhóm.
 */
function groupTrigger(text: string): HTMLButtonElement | undefined {
  return findByText('button[data-sidebar="menu-button"]', text) as HTMLButtonElement | undefined;
}

/** Mở/đóng một nhóm nav bằng chính nút của nó, như người dùng làm. */
async function clickGroupTrigger(text: string): Promise<void> {
  const trigger = groupTrigger(text);

  expect(trigger).toBeDefined();
  trigger?.click();
  await flushPromises();
  await nextTick();
}

/** Nhóm nav có đang mở hay không, đọc từ DOM chứ không từ state nội bộ. */
function groupIsOpen(wrapper: VueWrapper, childHref: string): boolean {
  return wrapper.find(`a[href="${childHref}"]`).exists();
}

/**
 * Mở bảng tuỳ chỉnh bằng nút nổi rồi trả về **phần nội dung đã mở**, không trả
 * về cả `document.body`: các khẳng định phủ định dưới đây phải nói về bảng tuỳ
 * chỉnh, không phải về mọi thứ khác đang có trên trang.
 */
async function openSettingsPanel(): Promise<HTMLElement> {
  const trigger = document.body.querySelector<HTMLElement>('button.fixed');

  expect(trigger).not.toBeNull();
  trigger?.click();
  await flushPromises();
  await nextTick();

  const panel =
    document.body.querySelector<HTMLElement>('[data-slot="sheet-content"]') ??
    document.body.querySelector<HTMLElement>('[data-slot="drawer-content"]');

  expect(panel).not.toBeNull();

  return panel as HTMLElement;
}

beforeEach(() => {
  setViewport(false);
});

afterEach(() => {
  // `wrapper.unmount()` TRƯỚC khi xoá `body`, và theo thứ tự ngược: các
  // component reka (teleport của dialog/sheet, popper, scroll-lock của drawer)
  // giữ tham chiếu tới node đã mount. Xoá `body` trước khi unmount làm chúng
  // patch vào node đã mất và ném "Cannot read properties of null
  // (reading 'insertBefore')" — lỗi không thuộc test nào, nhưng lại rơi vào lúc
  // một test khác đang chạy và làm nó đỏ oan.
  for (const wrapper of mountedWrappers.toReversed()) {
    wrapper.unmount();
  }
  mountedWrappers.length = 0;

  document.body.innerHTML = '';
  resetMediaQueryMatches();
});

describe('AppShell nav', () => {
  it('renders every section heading and plain item', () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(wrapper.text()).toContain('Platform');
    expect(wrapper.text()).toContain('Team');
    expect(wrapper.find('a[href="/dashboard"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/team/members"]').text()).toContain('New');
  });

  it('renders a group as a trigger, with children only once it is open', () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(wrapper.find('a[href="/billing/invoices"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Billing');
  });

  it('opens the group that contains the current path, so the active item is visible', () => {
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/billing/invoices',
    });

    const invoices = wrapper.find('a[href="/billing/invoices"]');

    expect(invoices.exists()).toBe(true);
    expect(invoices.attributes('data-active')).toBe('true');
  });

  it('opens the group when navigation moves into it after mount, not only on first render', async () => {
    // `AppShell` sống trong `app.vue` suốt vòng đời app và nhóm key theo `index`,
    // nên component nhóm **không** remount khi điều hướng: chỉ `currentPath` đổi.
    // Khởi tạo trạng thái mở một lần lúc setup (thay vì `watch`) để lại nhóm đóng
    // sau khi đi từ `/dashboard` sang `/billing/invoices`, và mục đang xem biến
    // mất khỏi nav — không lỗi nào được ném ra.
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(wrapper.find('a[href="/billing/invoices"]').exists()).toBe(false);

    await wrapper.setProps({ currentPath: '/billing/invoices' });
    await flushPromises();

    expect(wrapper.find('a[href="/billing/invoices"]').exists()).toBe(true);
  });

  it('never closes a group by itself when navigation leaves it', async () => {
    // Chỉ được **mở** theo route, không bao giờ tự đóng: người dùng mở tay một
    // nhóm rồi điều hướng sang chỗ khác thì trạng thái của họ phải giữ nguyên.
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/billing/invoices',
    });

    expect(wrapper.find('a[href="/billing/invoices"]').exists()).toBe(true);

    await wrapper.setProps({ currentPath: '/dashboard' });
    await flushPromises();

    expect(wrapper.find('a[href="/billing/invoices"]').exists()).toBe(true);
  });

  it('reopens a group the user closed, when the next route still belongs to it', async () => {
    // Đi trong nội bộ nhóm không đổi `hasActiveChild` (`true` trước và sau), nên
    // watcher theo đúng computed đó không chạy: người dùng đóng tay nhóm Billing
    // rồi đi sang `/billing/plans` sẽ thấy mục đang xem vẫn nằm trong nhóm đóng.
    // Vì vậy watcher phải theo `currentPath`, và đây là ca duy nhất phân biệt được
    // hai cách viết.
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/billing/invoices',
    });

    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);

    await clickGroupTrigger('Billing');

    // Đóng tay: mục con biến khỏi nav, nhưng route vẫn đang nằm trong nhóm.
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(false);

    await wrapper.setProps({ currentPath: '/billing/plans' });
    await flushPromises();

    // Nhóm phải mở lại, và mục đang xem mới phải được đánh dấu active.
    const plans = wrapper.find('a[href="/billing/plans"]');

    expect(plans.exists()).toBe(true);
    expect(plans.attributes('data-active')).toBe('true');
  });

  it('does not close a group the user opened by hand when the route leaves it', async () => {
    // Khác ca trên: nhóm này do người dùng mở tay, không phải do route, nên khi
    // điều hướng ra ngoài nó phải giữ nguyên trạng thái mở. Một watcher gán
    // `open = hasActiveChild` mỗi lần điều hướng sẽ đóng nó lại — đúng thứ hợp
    // đồng cấm.
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    // `/dashboard` không nằm trong nhóm Billing nên nhóm đóng sẵn.
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(false);

    await clickGroupTrigger('Billing');
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);

    await wrapper.setProps({ currentPath: '/team/members' });
    await flushPromises();

    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);
  });

  it('resets a reused group to closed when the app swaps in a group with no active child', async () => {
    // `AppShellNav` key theo `index`, nên khi app thay nhóm ở đúng vị trí đó thì
    // Vue **tái sử dụng** component: không có `onMounted` nào chạy lại, và
    // `open` cục bộ ở lại. Nhóm mới không được thừa hưởng trạng thái mở của nhóm
    // cũ — nếu không, một nhóm chưa từng được mở sẽ hiện sẵn các mục con.
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/billing/invoices',
    });

    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);

    await wrapper.setProps({ nav: swappedNav() });
    await flushPromises();

    // Cùng vị trí (index 2), cùng loại entry, nên vẫn là component đó.
    expect(wrapper.text()).toContain('Reports');
    expect(groupIsOpen(wrapper, '/reports/weekly')).toBe(false);
  });

  it('opens a reused group when the group swapped in does contain the active child', async () => {
    // Vế còn lại của cùng cơ chế: nhóm mới phải khởi tạo theo **trạng thái active
    // của chính nó**, không phải luôn `false`. Đóng cứng mọi lần đổi prop cũng
    // sai, chỉ khác chiều.
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/reports/weekly',
    });

    // Nhóm `Reports` chưa tồn tại ở lần render này.
    expect(groupIsOpen(wrapper, '/reports/weekly')).toBe(false);

    await wrapper.setProps({ nav: swappedNav() });
    await flushPromises();

    expect(groupIsOpen(wrapper, '/reports/weekly')).toBe(true);
    expect(wrapper.find('a[href="/reports/weekly"]').attributes('data-active')).toBe('true');
  });

  it('marks the plain item matching the current path as active, and only that one', () => {
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/settings',
    });

    // `data-slot` KHONG dung duoc o day: nut menu co tooltip di qua
    // `TooltipTrigger as-child`, va trigger do ghi de `data-slot` thanh
    // `tooltip-trigger`. `data-sidebar="menu-button"` moi la thu con lai tren
    // chinh the `<a>`.
    const active = wrapper.findAll('a[data-sidebar="menu-button"][data-active="true"]');

    expect(active).toHaveLength(1);
    expect(active[0]?.attributes('href')).toBe('/settings');
  });

  it('renders the app-owned slots, not placeholder markup of its own', () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(wrapper.text()).toContain('Ecoma');
    expect(wrapper.text()).toContain('Account');
    expect(wrapper.text()).toContain('Actions');
  });
});

describe('AppShell direction', () => {
  it('moves the sidebar and tells reka, so RTL is not sidebar-only', () => {
    const rtl = mountShell({ preferences: { themeColor: 'default', direction: 'rtl' } });

    expect(rtl.find('[data-side="right"]').exists()).toBe(true);
    expect(rtl.find('[data-probe-direction]').attributes('data-probe-direction')).toBe('rtl');
  });

  it('keeps the sidebar on the left for LTR', () => {
    const ltr = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(ltr.find('[data-side="left"]').exists()).toBe(true);
    expect(ltr.find('[data-probe-direction]').attributes('data-probe-direction')).toBe('ltr');
  });

  it('derives the sidebar side from the direction instead of taking it as a setting', () => {
    // Hợp đồng công khai chính là danh sách prop: không có prop nào cho vị trí
    // sidebar, biến thể sidebar hay typography, nên app không thể đặt chúng.
    // `AppShell['props']` chứ không `AppShell.props`: tsconfig của lib bật
    // `noPropertyAccessFromIndexSignature`.
    expect(Object.keys(AppShell['props']).toSorted()).toEqual([
      'bottomItems',
      'commands',
      'currentPath',
      'homeLabel',
      'labels',
      'links',
      'nav',
      'preferences',
    ]);
  });
});

describe('AppShell settings panel', () => {
  it('offers only the colour and direction controls', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });
    const panel = await openSettingsPanel();
    const text = panel.textContent ?? '';

    expect(text).toContain('Theming');
    expect(text).toContain('Layout');
    expect(text).toContain('Color');
    expect(text).toContain('Direction');
    expect(text).toContain('teal');
  });

  it('does not resurrect the controls the shell dropped', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });
    const panel = await openSettingsPanel();
    const text = panel.textContent ?? '';

    // Bốn nhóm điều khiển của nguồn không còn ở đây: navbar type
    // (sidebar/floating/inset), typography (default/scaled/mono) và
    // light/dark/system.
    for (const dropped of ['Navbar', 'Mono', 'Scaled', 'Floating', 'Inset', 'System']) {
      expect(text).not.toContain(dropped);
    }
  });

  it('emits the new colour and leaves the direction untouched', async () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'rtl' } });

    await openSettingsPanel();

    const teal = findByText('button', 'teal');

    expect(teal).toBeDefined();
    teal?.click();
    await nextTick();

    expect(wrapper.emitted('update:preferences')?.at(0)).toEqual([
      { themeColor: 'teal', direction: 'rtl' },
    ]);
  });

  it('emits the new direction and leaves the colour untouched', async () => {
    const wrapper = mountShell({ preferences: { themeColor: 'violet', direction: 'ltr' } });

    await openSettingsPanel();

    const rtl = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'RTL',
    );

    expect(rtl).toBeDefined();
    rtl?.click();
    await nextTick();

    // Khong kem theo truong nao khac: doi chieu khong keo theo doi vi tri
    // sidebar, va shell khong con truong nao luu vi tri sidebar de ma doi.
    expect(wrapper.emitted('update:preferences')?.at(0)).toEqual([
      { themeColor: 'violet', direction: 'rtl' },
    ]);
  });

  it('opens as a sheet on a wide viewport', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });
    await openSettingsPanel();

    expect(document.body.querySelector('[data-slot="sheet-content"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="drawer-content"]')).toBeNull();
  });

  it('opens as a drawer on a narrow viewport', async () => {
    setViewport(true);
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });
    await openSettingsPanel();

    expect(document.body.querySelector('[data-slot="drawer-content"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  /**
   * Bảng phải phản ánh `preferences` **hiện tại**, chứ không phải giá trị lúc
   * mount. Cái bẫy có tên: `createReusableTemplate` của `@vueuse/core` bị đánh
   * giá là "chụp slot một lần rồi `cloneVNode`", tức là mọi binding động trong
   * đó bị đóng băng. Thực tế `@vueuse/core@15` (phần lib này resolve) chỉ lưu
   * `slots.default` trong một `shallowRef` và **gọi lại** hàm slot ở mỗi lần
   * render của `Reuse`, nên binding được tính lại và render effect của `Reuse`
   * có đọc tới `preferences` — đọc mã nguồn và một phép đo cô lập đều xác nhận
   * điều đó, nên bảng đã đúng từ đầu và không cần tách component con.
   *
   * Vì sao vẫn giữ test này: nó ghim đúng bất biến đó ở mức DOM. Nếu sau này
   * có người thay cơ chế chia sẻ markup bằng thứ thực sự đóng băng (chụp vnode
   * một lần), test này đỏ ngay chứ không xanh im lặng.
   */
  it('reflects current preferences when they change, without freezing bindings', async () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });
    await openSettingsPanel();

    const tealButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('teal'),
    ) as HTMLButtonElement | undefined;
    expect(tealButton).toBeDefined();
    expect(tealButton?.querySelector('svg')).toBeNull();

    await wrapper.setProps({ preferences: { themeColor: 'teal', direction: 'ltr' } });
    await flushPromises();
    await nextTick();

    const tealButtonAfter = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('teal'),
    ) as HTMLButtonElement | undefined;
    expect(tealButtonAfter).toBeDefined();
    expect(tealButtonAfter?.querySelector('svg')).not.toBeNull();
  });
});

describe('AppShell media query reactivity', () => {
  it('switches branch when the viewport changes after mount, not only on mount', async () => {
    // Nhánh thứ hai của `useAppShellMediaQuery`: nó đọc `media.matches` một lần
    // trong `onMounted` rồi cập nhật state **qua listener `change`**. Stub cũ chỉ
    // ghi lại giá trị `matches` mà không bắn event, nên nhánh đó không có test nào
    // chạm tới: mọi spec đều đặt viewport **trước** khi mount và đi qua đường
    // `onMounted`, xanh kể cả khi listener bị nối sai hoặc bị bỏ.
    //
    // Vì vậy phép đo ở đây đổi viewport **sau** mount và bắt buộc cây DOM phải
    // render lại, cả ở sidebar (mobile sheet) lẫn bảng tuỳ chỉnh (drawer).
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    await flushPromises();

    expect(wrapper.find('[data-slot="sidebar-rail"]').exists()).toBe(true);
    expect(document.body.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();

    setViewport(true);
    await flushPromises();
    await nextTick();

    // `SidebarRail` chỉ render ở chế độ desktop, nên việc nó biến mất là bằng
    // chứng trực tiếp rằng state đã đổi **sau** mount chứ không phải lúc mount.
    expect(wrapper.find('[data-slot="sidebar-rail"]').exists()).toBe(false);

    // Trên mobile sidebar thu gọn thành sheet đóng sẵn, nên phần tử
    // `data-mobile="true"` chỉ vào DOM khi mở bằng nút trigger ở header.
    const sidebarTrigger = wrapper.find('[data-sidebar="trigger"]');

    expect(sidebarTrigger.exists()).toBe(true);
    await sidebarTrigger.trigger('click');
    await flushPromises();

    expect(document.body.querySelector('[data-slot="sidebar"][data-mobile="true"]')).not.toBeNull();

    // Bảng tuỳ chỉnh đọc cùng cơ chế qua query `(min-width: 768px)`: ở viewport
    // hẹp nó phải mở bằng `Drawer`, không phải `Sheet`.
    const trigger = document.body.querySelector<HTMLElement>('button.fixed');

    expect(trigger).not.toBeNull();
    trigger?.click();
    await flushPromises();
    await nextTick();

    expect(document.body.querySelector('[data-slot="drawer-content"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });
});

describe('AppShell responsive sidebar', () => {
  it('renders the desktop sidebar with a rail, not the mobile sheet', () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(wrapper.find('[data-slot="sidebar-rail"]').exists()).toBe(true);
    expect(document.body.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
  });

  it('opens the sidebar by default on desktop, and the header button collapses then reopens it', async () => {
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    await flushPromises();

    // Mặc định của shell là sidebar **hiện**. Đây là khẳng định bắt đúng lỗi đã
    // xảy ra lúc port: prop `open` của `SidebarProvider` khai thiếu giá trị mặc
    // định `undefined`, nên Vue ép nó thành `false`, và `data-state` đứng nguyên ở
    // `collapsed` — sidebar biến mất khỏi màn hình dù không app nào yêu cầu thu
    // gọn, mà không có lỗi nào được ném ra.
    const sidebar = () => wrapper.find('[data-slot="sidebar"]');

    expect(sidebar().attributes('data-state')).toBe('expanded');
    expect(sidebar().attributes('data-collapsible')).toBe('');

    const trigger = wrapper.find('[data-sidebar="trigger"]');

    expect(trigger.exists()).toBe(true);

    await trigger.trigger('click');
    await flushPromises();
    expect(sidebar().attributes('data-state')).toBe('collapsed');

    await trigger.trigger('click');
    await flushPromises();
    expect(sidebar().attributes('data-state')).toBe('expanded');
  });

  it('opens the sidebar as a mobile sheet from the header trigger, on the RTL side', async () => {
    setViewport(true);
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'rtl' } });

    await flushPromises();

    // Trên mobile sidebar thu gọn thành sheet đóng sẵn; nút trigger ở header là
    // đường mở duy nhất, nên nếu port làm mất `SidebarTrigger` thì người dùng
    // mobile không còn cách nào mở menu.
    const trigger = wrapper.find('[data-sidebar="trigger"]');

    expect(trigger.exists()).toBe(true);
    expect(document.body.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();

    await trigger.trigger('click');
    await flushPromises();

    const mobile = document.body.querySelector<HTMLElement>(
      '[data-slot="sidebar"][data-mobile="true"]',
    );

    expect(mobile).not.toBeNull();
    // `SheetContent` nhan `side` nhu prop nen no khong thanh attribute: phia cua
    // sheet nam trong class vi tri (`right-0`), va do la thu thuc su dat no.
    expect(mobile?.className).toContain('right-0');
    expect(wrapper.find('[data-slot="sidebar-rail"]').exists()).toBe(false);
  });
});

describe('AppShell command palette', () => {
  it('stays closed until it is asked for', () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens from the sidebar button', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    const search = findByText('button', 'Search');

    expect(search).toBeDefined();
    search?.click();
    await flushPromises();

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('opens from the keyboard shortcut, which outlives the collapsed sidebar', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    await flushPromises();

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('lists the commands the app passed in, as links', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    await flushPromises();

    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/palette/reports"]');

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Reports');
  });

  it('keeps a group the user opened by hand when the app rebuilds nav with identical content', async () => {
    // Bẫy có tên: app dựng nav bằng `computed`, nên mỗi lần computed chạy lại
    // thì mọi object nhóm đều là object **mới** dù nội dung y nguyên. Nếu danh
    // tính nhóm được so theo **tham chiếu object** của prop `group`, watcher sẽ
    // chạy và ghi đè `open` — tự đóng nhóm người dùng vừa mở tay. Test này cố
    // tình dựng lại nav với nội dung **y hệt** nhưng object mới, và phải giữ
    // nguyên trạng thái mở.
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    // Nhóm Billing đóng sẵn (currentPath `/dashboard` không thuộc nhóm).
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(false);

    await clickGroupTrigger('Billing');
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);

    // Giữ ĐÚNG hình dạng dữ liệu: mục lá không có key `children`, nhóm thì có —
    // `isAppShellNavGroup` phân loại theo `'children' in entry`, nên thêm key
    // `children: undefined` vào mục lá sẽ biến nó thành nhóm một cách giả tạo.
    const rebuilt = NAV.map((section) => ({
      heading: section.heading,
      items: section.items.map((item) =>
        isAppShellNavGroup(item)
          ? { ...item, children: item.children.map((child) => ({ ...child })) }
          : { ...item },
      ),
    }));

    await wrapper.setProps({ nav: rebuilt });
    await flushPromises();

    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);
  });

  it('keeps the manual state when only a group child is added, not the group replaced', async () => {
    // Vế hẹp hơn của cùng bất biến: thêm một mục con (ví dụ quyền hạn đổi) không
    // biến nhóm thành nhóm khác, nên không được ghi đè trạng thái mở/đóng tay.
    // Nhóm đang mở tay thì vẫn mở (và mục con mới hiện ra trong đó, đúng như một
    // nhóm đang mở).
    const wrapper = mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });

    await clickGroupTrigger('Billing');
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);

    const withExtraChild = NAV.map((section) => ({
      heading: section.heading,
      items: section.items.map((item) =>
        isAppShellNavGroup(item)
          ? { ...item, children: [...item.children, { title: 'Usage', href: '/billing/usage' }] }
          : { ...item },
      ),
    }));

    await wrapper.setProps({ nav: withExtraChild });
    await flushPromises();

    // Còn mở, và mục con mới nằm trong nhóm đang mở đó.
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);
    expect(wrapper.find('a[href="/billing/usage"]').exists()).toBe(true);
  });

  it('does not reopen a group the user closed when only a group child is added', async () => {
    // Chiều còn lại: nhóm đang chứa mục được xem nhưng người dùng đã đóng tay,
    // rồi app thêm một mục con. Không được nhân dịp đó mở lại nhóm.
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      currentPath: '/billing/invoices',
    });

    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(true);

    await clickGroupTrigger('Billing');
    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(false);

    const withExtraChild = NAV.map((section) => ({
      heading: section.heading,
      items: section.items.map((item) =>
        isAppShellNavGroup(item)
          ? { ...item, children: [...item.children, { title: 'Usage', href: '/billing/usage' }] }
          : { ...item },
      ),
    }));

    await wrapper.setProps({ nav: withExtraChild });
    await flushPromises();

    expect(groupIsOpen(wrapper, '/billing/invoices')).toBe(false);
  });
});

/**
 * `labels` là đường duy nhất để app dịch chuỗi hiển thị của shell. Bất biến cần
 * ghim không phải "app truyền được nhãn" (hiển nhiên) mà là:
 *
 * - không truyền `labels` ⇒ chuỗi **y hệt** trước khi thêm prop, tức llm-console
 *   và llm-seller không bị đổi một chữ nào;
 * - truyền `labels` ⇒ **mọi** chuỗi hardcode cũ đều biến mất khỏi DOM, kể cả
 *   nhãn của ô tìm kiếm. Chỉ khẳng định có mặt chuỗi mới là chưa đủ: một chuỗi
 *   hardcode còn sót lại vẫn xanh nếu test chỉ `toContain` chuỗi mới.
 */
describe('AppShell labels', () => {
  const LABELS: AppShellLabels = {
    settings: {
      title: 'Tuy chinh giao dien',
      description: 'Xem truoc theo thoi gian thuc',
      theming: 'Mau sac',
      layout: 'Bo cuc',
      color: 'Mau chu dao',
      direction: 'Chieu van ban',
      directionLtr: 'Trai sang phai',
      directionRtl: 'Phai sang trai',
    },
    search: {
      buttonLabel: 'Tim kiem',
      placeholder: 'Nhap lenh hoac tu khoa...',
      emptyLabel: 'Khong tim thay ket qua.',
      dialogTitle: 'Bang lenh',
      dialogDescription: 'Tim mot lenh de chay...',
    },
  };

  it('renders the built-in English labels when none are passed', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' } });
    const sidebar = document.body.textContent ?? '';

    expect(sidebar).toContain(DEFAULT_APP_SHELL_LABELS.search.buttonLabel);

    const panel = await openSettingsPanel();
    const text = panel.textContent ?? '';

    expect(text).toContain(DEFAULT_APP_SHELL_LABELS.settings.title);
    expect(text).toContain(DEFAULT_APP_SHELL_LABELS.settings.description);
    expect(text).toContain(DEFAULT_APP_SHELL_LABELS.settings.theming);
    expect(text).toContain(DEFAULT_APP_SHELL_LABELS.settings.layout);
    expect(text).toContain(DEFAULT_APP_SHELL_LABELS.settings.color);
    expect(text).toContain(DEFAULT_APP_SHELL_LABELS.settings.direction);
  });

  it('replaces every settings panel string and leaves no English behind', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' }, labels: LABELS });
    const panel = await openSettingsPanel();
    const text = panel.textContent ?? '';

    for (const label of Object.values(LABELS.settings)) {
      expect(text).toContain(label);
    }

    for (const stale of Object.values(DEFAULT_APP_SHELL_LABELS.settings)) {
      expect(text).not.toContain(stale);
    }
  });

  it('replaces the command palette labels', async () => {
    mountShell({ preferences: { themeColor: 'default', direction: 'ltr' }, labels: LABELS });

    expect(findByText('button', LABELS.search.buttonLabel)).toBeDefined();

    // Ô tìm kiếm chỉ tồn tại khi app có lệnh, nên nhánh này chỉ chạy được vì
    // `mountShell` truyền `COMMANDS`; mở palette để chạm tới placeholder.
    const trigger = findByText('button', LABELS.search.buttonLabel);

    expect(trigger).toBeDefined();
    trigger?.click();
    await flushPromises();
    await nextTick();

    const input = document.body.querySelector<HTMLInputElement>('[data-slot="command-input"]');

    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe(LABELS.search.placeholder);

    // Tiêu đề và mô tả của dialog nằm trong `sr-only`: không có textContent
    // nhưng vẫn được trình đọc màn hình đọc, nên vẫn là chuỗi phải dịch.
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');

    expect(dialog?.textContent ?? '').toContain(LABELS.search.dialogTitle);
    expect(dialog?.textContent ?? '').toContain(LABELS.search.dialogDescription);
    expect(dialog?.textContent ?? '').not.toContain(
      DEFAULT_APP_SHELL_LABELS.search.dialogDescription,
    );

    // `CommandEmpty` chỉ hiện khi có truy vấn và không truy vấn nào khớp, nên
    // phải gõ đã — hiện rỗng ngay từ đầu là trạng thái cmdk không có. Palette
    // teleport vào `document.body` nên `wrapper.find` không với tới; bọc phần
    // tử thật trong `DOMWrapper` để dùng đúng đường `setValue` của test-utils.
    const typing = new DOMWrapper(input as HTMLInputElement);

    await typing.setValue('khong-ton-tai');
    await flushPromises();
    await nextTick();

    expect(document.body.textContent ?? '').toContain(LABELS.search.emptyLabel);
    expect(document.body.textContent ?? '').not.toContain(
      DEFAULT_APP_SHELL_LABELS.search.emptyLabel,
    );
  });

  it('takes effect when the labels prop changes at runtime', async () => {
    const wrapper = mountShell({
      preferences: { themeColor: 'default', direction: 'ltr' },
      labels: LABELS,
    });

    expect(findByText('button', LABELS.search.buttonLabel)).toBeDefined();

    await wrapper.setProps({ labels: DEFAULT_APP_SHELL_LABELS });
    await flushPromises();

    expect(findByText('button', DEFAULT_APP_SHELL_LABELS.search.buttonLabel)).toBeDefined();
    expect(findByText('button', LABELS.search.buttonLabel)).toBeUndefined();
  });
});
