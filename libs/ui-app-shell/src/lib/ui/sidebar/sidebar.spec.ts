import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { h } from 'vue';
import { Sidebar, SidebarRail } from '.';
import { setMediaQueryMatches } from '../../testing/nuxt-env';
import SidebarProvider from './SidebarProvider.vue';

/**
 * Hợp đồng trạng thái mở/đóng của `SidebarProvider`.
 *
 * Đây là chỗ dễ vỡ im lặng nhất của cả thư viện, và đã vỡ một lần trong lúc
 * port: prop `open` khai `open?: boolean` mà **không** có `default` bị Vue ép
 * `false` khi vắng mặt (boolean casting), nên `props.open ?? defaultOpen` trả
 * `false` vĩnh viễn và sidebar đứng nguyên ở `collapsed`; bấm trigger hay
 * `Ctrl+B` đều không mở được, không có lỗi nào được ném ra. Vì triệu chứng duy
 * nhất nằm ở giá trị `data-state`, các test dưới đây khẳng định trực tiếp giá
 * trị đó, và khẳng định **cả hai chiều** để một setter hỏng không lọt qua.
 *
 * `matchMedia` phải khai tường minh: mặc định của stub là mọi query `false`,
 * tức là sidebar luôn chọn nhánh mobile (sheet đóng sẵn) và phép đo
 * `data-state` sẽ nói về nhánh desktop không hề được render.
 */

const MOBILE_QUERY = '(max-width: 768px)';
const SIDEBAR_COOKIE = 'sidebar_state';

interface MountOptions {
  readonly props?: Record<string, unknown>;
}

const mountedWrappers: VueWrapper[] = [];

/**
 * Mount thẳng cặp `SidebarProvider` + `Sidebar` của nguồn, không qua `AppShell`.
 *
 * `Sidebar` nằm trong slot nên instance cha của nó vẫn là provider — `inject` đi
 * theo cây instance chứ không theo cây render — nên context được cấp đúng như
 * khi shell dùng. Mount ở đây thay vì qua `AppShell` để phép đo nói về chính
 * provider, không bị phụ thuộc vào việc shell có truyền `open`/`defaultOpen` hay
 * không.
 */
function mountSidebarSidebar({ props = {} }: MountOptions = {}): VueWrapper {
  setMediaQueryMatches(MOBILE_QUERY, false);

  const wrapper = mount(SidebarProvider, {
    attachTo: document.body,
    props,
    // `SidebarRail` là component riêng và nằm trong slot của `Sidebar`, đúng như
    // `AppShell` lắp; nó là bề mặt bấm gọi `toggleSidebar` của provider.
    slots: { default: () => h(Sidebar, null, { default: () => h(SidebarRail) }) },
  });

  mountedWrappers.push(wrapper as VueWrapper);

  return wrapper as VueWrapper;
}

function sidebarState(wrapper: VueWrapper): string | undefined {
  return wrapper.find('[data-slot="sidebar"]').attributes('data-state');
}

/**
 * Bấm qua chính nút rail — đường vào duy nhất dùng `toggleSidebar` của
 * provider. `data-slot="sidebar-trigger"` (nút trên header) cũng gọi cùng hàm
 * này, nhưng nó nằm ngoài `SidebarProvider` khi đo ở đây.
 */
async function toggleViaRail(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-slot="sidebar-rail"]').trigger('click');
  await flushPromises();
}

/**
 * Cookie `sidebar_state` là **trạng thái dùng chung của jsdom**, không phải của
 * từng wrapper: provider ghi nó mỗi lần thu gọn/mở, và đọc lại lúc mount. Không
 * xoá giữa các test thì test sau mount lên trạng thái của test trước — đúng thứ
 * đã làm một khẳng định ở đây đỏ vì lý do không liên quan tới nó.
 */
function clearSidebarCookie(): void {
  document.cookie = `${SIDEBAR_COOKIE}=; path=/; max-age=0`;
}

beforeEach(() => {
  clearSidebarCookie();
});

afterEach(() => {
  for (const wrapper of mountedWrappers.toReversed()) {
    wrapper.unmount();
  }
  mountedWrappers.length = 0;
  document.body.innerHTML = '';
  clearSidebarCookie();
});

describe('SidebarProvider open state', () => {
  it('opens by default on desktop when nothing is passed', () => {
    const wrapper = mountSidebarSidebar();

    expect(sidebarState(wrapper)).toBe('expanded');
    // `data-collapsible` chỉ mang giá trị khi đã thu gọn (`state === 'collapsed'
    // ? collapsible : ''`), nên chuỗi rỗng ở đây là bằng chứng thứ hai, độc lập
    // với `data-state`, rằng CSS `group-data-[collapsible=offcanvas]:w-0` không
    // được kích hoạt.
    expect(wrapper.find('[data-slot="sidebar"]').attributes('data-collapsible')).toBe('');
  });

  it('collapses then reopens with the same button', async () => {
    const wrapper = mountSidebarSidebar();

    await toggleViaRail(wrapper);
    expect(sidebarState(wrapper)).toBe('collapsed');
    expect(wrapper.find('[data-slot="sidebar"]').attributes('data-collapsible')).toBe('offcanvas');

    await toggleViaRail(wrapper);
    expect(sidebarState(wrapper)).toBe('expanded');
  });

  it('honours `defaultOpen` in uncontrolled mode', () => {
    const wrapper = mountSidebarSidebar({ props: { defaultOpen: false } });

    expect(sidebarState(wrapper)).toBe('collapsed');
  });

  it('honours the `open` prop in controlled mode, and does not change state on its own', async () => {
    const wrapper = mountSidebarSidebar({ props: { open: false } });

    expect(sidebarState(wrapper)).toBe('collapsed');

    // Ở chế độ controlled, `open` là nguồn duy nhất nên thao tác thu gọn chỉ
    // phát `update:open`; app quyết định có ghi lại giá trị đó hay không.
    await toggleViaRail(wrapper);

    expect(sidebarState(wrapper)).toBe('collapsed');
  });

  it('emits `update:open` when the uncontrolled state changes', async () => {
    const wrapper = mountSidebarSidebar({ props: { defaultOpen: true } });

    await toggleViaRail(wrapper);

    expect(wrapper.emitted('update:open')).toEqual([[false]]);
  });

  it('restores the persisted state at mount, after hydration', async () => {
    document.cookie = `${SIDEBAR_COOKIE}=false; path=/`;

    const wrapper = mountSidebarSidebar();

    await flushPromises();

    expect(sidebarState(wrapper)).toBe('collapsed');
  });

  it('does not emit `update:open` when only restoring the persisted state', async () => {
    document.cookie = `${SIDEBAR_COOKIE}=false; path=/`;

    const wrapper = mountSidebarSidebar();

    await flushPromises();

    // Khôi phục là việc của component lúc mount. Nếu nó đi qua setter của `open`
    // thì mỗi lần tải trang lại — lúc cookie đã có — app nhận một `update:open`
    // dù không ai bấm gì, và app controlled phản ứng lại bằng cách ghi tiếp.
    expect(wrapper.emitted('update:open')).toBeUndefined();
  });
});
