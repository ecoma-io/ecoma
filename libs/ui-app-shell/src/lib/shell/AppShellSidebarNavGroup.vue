<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
  type SidebarMenuButtonVariants,
} from '../ui/sidebar';
import { useAppShell } from './context';
import type { AppShellNavGroup } from './types';

/**
 * Nhóm nav có mục con: mục cha là `CollapsibleTrigger`, các mục con nằm trong
 * `SidebarMenuSub`. Giữ nguyên cấu trúc và chuyển động của nguồn (mũi tên xoay
 * 90° khi mở, qua `group-data-[state=open]/collapsible:rotate-90`).
 *
 * Nguồn mở/đóng bằng state cục bộ `openCollapsible`; ở đây giữ đúng như vậy
 * nhưng tự mở sẵn khi có mục con đang active — nếu không, vào thẳng
 * `/settings/account` sẽ thấy nhóm đóng và không thấy mục đang xem.
 *
 * Phải `watch` chứ không khởi tạo một lần: `AppShell` nằm trong `app.vue` và
 * sống suốt vòng đời app, còn nhóm thì key theo `index`, nên component này
 * **không** remount khi điều hướng. Khởi tạo một lần thì `/dashboard` →
 * `/billing/invoices` để lại nhóm đóng và mục đang xem biến mất.
 *
 * Hai nguồn thay đổi khác nhau phải được xử lý khác nhau, và không có `id` nào
 * được thêm vào hợp đồng công khai chỉ để phục vụ state nội bộ này: hợp đồng của
 * `AppShellNav` vẫn là mảng nhóm mà app đã resolve.
 */
const {
  group,
  size = 'default',
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  group: AppShellNavGroup;
  size?: SidebarMenuButtonVariants['size'];
}>();

const { currentPath } = useAppShell();
const { setOpenMobile } = useSidebar();

function isChildActive(href: string): boolean {
  return href === currentPath.value;
}

/** Nhóm đang chứa mục được xem hay không, tính từ `group` hiện tại. */
function containsActiveChild(target: AppShellNavGroup): boolean {
  return target.children.some((child) => isChildActive(child.href));
}

const hasActiveChild = computed(() => containsActiveChild(group));

const open = ref(false);

// Theo dõi `currentPath` chứ không chỉ `hasActiveChild`. Hai lý do, và cả hai
// đều là im lặng khi sai:
//
// - `hasActiveChild` giữ nguyên `true` khi đi từ `/billing/invoices` sang
//   `/billing/plans`, nên watcher theo nó **không chạy**; người dùng đã đóng
//   tay nhóm Billing thì mục đang xem mới vẫn nằm trong nhóm đóng.
// - Watcher chỉ được **mở**, không bao giờ gán `open = hasActiveChild`: gán như
//   vậy ở mỗi lần điều hướng sẽ xoá trạng thái mở tay của người dùng (rời nhóm
//   sang route khác là nhóm tự đóng lại), đúng thứ mà hợp đồng cấm.
watch(
  currentPath,
  () => {
    if (hasActiveChild.value) open.value = true;
  },
  { immediate: true },
);

// Nhóm được key theo `index` ở `AppShellNav`, nên khi app thay một nhóm ở đúng
// vị trí đó, Vue **tái sử dụng** component này và state cục bộ ở lại. Nhóm mới
// không được thừa hưởng `open` của nhóm cũ: khởi tạo lại theo trạng thái active
// của chính nhóm mới — lần này cả hai chiều, vì nhóm mới có thể không có mục con
// nào đang active trong khi nhóm cũ đang mở.
//
// Danh tính nhóm lấy theo **tiêu đề**, không theo tham chiếu object của prop.
// App dựng nav bằng `computed` (phụ thuộc quyền hạn, locale, dữ liệu tải về),
// nên mỗi lần computed chạy lại thì mọi object nhóm đều là object **mới** dù nội
// dung y nguyên. So theo tham chiếu sẽ coi đó là "nhóm khác", watcher chạy, và
// `open` bị ghi đè — tức là tự đóng nhóm người dùng vừa mở tay, đúng thứ mà
// watcher `currentPath` ngay trên cấm. Tiêu đề là thứ người dùng dùng để nhận ra
// "nhóm này", nên nó là danh tính đúng.
//
// Cũng KHÔNG lấy `children` làm danh tính: thêm/bớt một mục con (ví dụ quyền hạn
// đổi) không biến nhóm thành nhóm khác, mà lại làm watcher chạy và ghi đè trạng
// thái mở/đóng tay — tái diễn đúng lỗi vừa nêu ở một dạng hẹp hơn.
watch(
  () => group.title,
  () => {
    open.value = containsActiveChild(group);
  },
);
</script>

<template>
  <SidebarMenu>
    <Collapsible v-model:open="open" as-child class="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger as-child>
          <SidebarMenuButton :tooltip="group.title" :size="size">
            <component :is="group.icon" v-if="group.icon" />
            <span>{{ group.title }}</span>
            <span
              v-if="group.badge"
              class="rounded-md bg-[#adfa1d] px-1.5 py-0.5 text-xs text-black leading-none group-hover:no-underline"
            >
              {{ group.badge }}
            </span>
            <ChevronRight
              class="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            <SidebarMenuSubItem v-for="child in group.children" :key="child.href">
              <SidebarMenuSubButton as-child :data-active="isChildActive(child.href)">
                <NuxtLink :to="child.href" @click="setOpenMobile(false)">
                  <span>{{ child.title }}</span>
                  <span
                    v-if="child.badge"
                    class="rounded-md bg-[#adfa1d] px-1.5 py-0.5 text-xs text-black leading-none group-hover:no-underline"
                  >
                    {{ child.badge }}
                  </span>
                </NuxtLink>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  </SidebarMenu>
</template>
