<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { useEventListener } from '@vueuse/core';
import { TooltipProvider } from 'reka-ui';
import { computed, onMounted, ref } from 'vue';
import { useAppShellMediaQuery } from '../../media-query';
import { cn } from '../../utils';
import {
  provideSidebarContext,
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_ICON,
} from './utils';

/**
 * Ba khác biệt so với nguồn, đều để SSR và client hydrate ra cùng một cây DOM:
 *
 * 1. `defaultOpen` cố định `true`. Nguồn đọc `defaultDocument?.cookie` ngay
 *    trong giá trị mặc định của prop, nên SSR luôn thấy `true` còn client có
 *    thể thấy `false` — cùng một request, hai trạng thái. Ở đây cookie được
 *    đọc trong `onMounted`, sau hydration.
 * 2. `isMobile` dùng `useAppShellMediaQuery` với mặc định desktop thay vì
 *    `useMediaQuery` (trên SSR luôn `false`, lệch với client ở viewport hẹp).
 *    Mặc định desktop khớp với hành vi `provideSSRWidth(1024)` của nguồn.
 * 3. Ghi cookie đi qua `writeSidebarStateCookie`, có guard `document` để hàm
 *    không thể chạm DOM nếu bị gọi ngoài môi trường browser.
 */
const {
  defaultOpen = true,
  // `open: openProp = undefined` là **bắt buộc**, không phải trang trí — giống nguồn.
  //
  // Prop khai `open?: boolean` được biên dịch thành `{ type: Boolean }`, và với
  // prop kiểu Boolean mà **không có** `default`, Vue ép giá trị vắng mặt thành
  // `false` (boolean casting) chứ không để `undefined`. Khi đó prop là `false` —
  // khác `undefined` — nên `openProp ?? uncontrolledOpen.value` trả `false` mãi
  // mãi, và guard `openProp === undefined` trong setter không bao giờ đúng:
  // sidebar không thể mở ra, `data-state` đứng nguyên ở `collapsed` dù bấm
  // trigger hay Ctrl+B.
  //
  // Khai tường minh `undefined` làm `hasDefault` thành true, nên nhánh ép kiểu
  // `isAbsent && !hasDefault` không chạy và prop vắng mặt giữ đúng `undefined`.
  // Đây là mẫu chuẩn cho prop boolean vừa controlled vừa uncontrolled; nguồn
  // cũng khai đúng dòng này trong `withDefaults`.
  //
  // Prop được **đổi tên** khi destructure, không dùng thẳng `open = undefined`:
  // file này còn khai `const open = computed(...)` ngay dưới, nên tên `open` bị
  // trùng (nguồn không trùng vì giữ nguyên cả props object qua `withDefaults`).
  open: openProp = undefined,
  class: className = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  defaultOpen?: boolean;
  open?: boolean;
  class?: HTMLAttributes['class'];
}>();

const emits = defineEmits<{
  'update:open': [open: boolean];
}>();

const isMobile = useAppShellMediaQuery('(max-width: 768px)', false);
const openMobile = ref(false);

// Trạng thái uncontrolled chỉ được khởi tạo từ `defaultOpen`; prop `open` là
// chế độ controlled nên được đọc riêng, và không bao giờ bị ghi đè.
const uncontrolledOpen = ref(defaultOpen);

const open = computed<boolean>({
  get: () => openProp ?? uncontrolledOpen.value,
  set: (value: boolean) => {
    if (openProp === undefined) {
      uncontrolledOpen.value = value;
    }
    emits('update:open', value);
  },
});

function writeSidebarStateCookie(value: boolean): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${value}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
}

function setOpen(value: boolean): void {
  open.value = value;

  // This sets the cookie to keep the sidebar state.
  writeSidebarStateCookie(open.value);
}

function setOpenMobile(value: boolean): void {
  openMobile.value = value;
}

// Helper to toggle the sidebar.
function toggleSidebar(): void {
  return isMobile.value ? setOpenMobile(!openMobile.value) : setOpen(!open.value);
}

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    toggleSidebar();
  }
});

// Khôi phục trạng thái đã lưu SAU hydration, không phải trong giá trị mặc định
// của prop — xem khác biệt (1) ở đầu file.
//
// Ghi thẳng vào `uncontrolledOpen`, **không** qua `open.value`: setter của `open`
// phát `update:open`, và đó là sự kiện "người dùng vừa đổi trạng thái". Khôi phục
// cookie là việc của chính component lúc mount, không phải một thay đổi của người
// dùng, nên nếu đi qua setter thì mỗi lần tải trang lại — khi cookie đã có — app
// nhận một `update:open` mà không ai bấm gì; app controlled ghi lại giá trị đó và
// tự tạo một vòng cập nhật. Nguồn không có nhánh này vì nó đọc cookie ngay trong
// `withDefaults` (không phát sự kiện); đây là chỗ bản port phải giữ đúng ý nghĩa
// của sự kiện.
onMounted(() => {
  if (openProp !== undefined) {
    return;
  }
  const stored = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${SIDEBAR_COOKIE_NAME}=`))
    ?.slice(SIDEBAR_COOKIE_NAME.length + 1);
  if (stored === 'true' || stored === 'false') {
    uncontrolledOpen.value = stored === 'true';
  }
});

// We add a state so that we can do data-state="expanded" or "collapsed".
// This makes it easier to style the sidebar with Tailwind classes.
const state = computed(() => (open.value ? 'expanded' : 'collapsed'));

provideSidebarContext({
  state,
  open,
  setOpen,
  isMobile,
  openMobile,
  setOpenMobile,
  toggleSidebar,
});
</script>

<template>
  <TooltipProvider :delay-duration="0">
    <div
      data-slot="sidebar-wrapper"
      :style="{
        '--sidebar-width': SIDEBAR_WIDTH,
        '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
      }"
      :class="
        cn(
          'group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full',
          className,
        )
      "
      v-bind="$attrs"
    >
      <slot />
    </div>
  </TooltipProvider>
</template>
