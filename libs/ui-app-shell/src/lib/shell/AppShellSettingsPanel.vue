<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { Check, Settings } from '@lucide/vue';
import { createReusableTemplate } from '@vueuse/core';
import { ref } from 'vue';
import { useAppShellMediaQuery } from '../media-query';
import { APP_SHELL_THEME_COLORS } from '../preferences';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '../ui/drawer';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import { Separator } from '../ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../ui/sheet';
import { useAppShell } from './context';
import { DEFAULT_APP_SHELL_LABELS } from './labels';
import type { AppShellSettingsLabels } from './types';

/**
 * Bảng tuỳ chỉnh của shell: **chỉ** màu chủ đạo và chiều văn bản.
 *
 * Nguồn có thêm ba nhóm điều khiển — Navbar Type (sidebar/floating/inset),
 * Type (default/scaled/mono) và Theme (light/dark/system). Ở đây cả ba đã bị
 * **gỡ cả phần tử điều khiển lẫn logic đổi state**, không phải chỉ ẩn đi:
 * `defineProps`/emits của shell không còn nhận ba giá trị đó, `parseAppShellPreferences`
 * loại chúng khi đọc cookie cũ, và CSS không còn `.theme-mono`/`.theme-scaled`
 * để bật. Một nút bị ẩn nhưng state vẫn đổi được thì vẫn là một cấu hình
 * người dùng chạm tới được.
 *
 * Việc ghi class màu lên DOM cũng đổi cách làm so với nguồn: nguồn tự
 * `document.body.classList.add('color-x')` trong một `watch`. Ở đây shell chỉ
 * gọi `setThemeColor` của context, app lưu vào cookie rồi render lại
 * `<html class dir>` qua `useHead`. Nhờ vậy SSR và client dùng đúng một nguồn,
 * và không có đoạn code nào ghi DOM trong lúc render.
 *
 * Nút mở bảng vẫn là một tab nổi giữa cạnh phải (bên trái khi RTL) như nguồn;
 * desktop mở `Sheet`, mobile mở `Drawer` — cùng lý do như nguồn: sheet kéo ngang
 * hợp màn rộng, drawer kéo lên hợp màn hẹp.
 *
 * Toàn bộ chuỗi hiển thị ở đây lấy từ `labels`. Shell không biết locale nào
 * tồn tại và không dịch gì: app i18n (backoffice) truyền bản dịch của mình,
 * app không i18n (llm-console gọi thẳng component này) nhận đúng chuỗi cũ nhờ
 * default `DEFAULT_APP_SHELL_LABELS.settings`.
 */
const { preferences, setThemeColor, setDirection } = useAppShell();

const { labels = DEFAULT_APP_SHELL_LABELS.settings } = defineProps<{
  labels?: AppShellSettingsLabels;
}>();

// `useAppShellMediaQuery` chứ không `useMediaQuery` của VueUse. Nguồn dùng
// `useMediaQuery` với plugin `provideSSRWidth(1024)`, tức là trên SSR cây DOM là
// **desktop**; nhưng `useMediaQuery` đọc `matchMedia` ngay trong `watchEffect`
// lúc setup, nên lần render đầu ở client trên màn rộng lại tính ra `true` trong
// khi HTML nhận được là `false` — lệch cây DOM ngay tại hydration. Ở đây mặc
// định truyền vào là `true` (đúng bằng kết quả 1024px của nguồn), và giá trị
// thật chỉ được đọc trong `onMounted`; wide vẫn ra Sheet, hẹp chuyển sang Drawer
// **sau** hydration thay vì trong lúc hydrate.
const isDesktop = useAppShellMediaQuery('(min-width: 768px)', true);
const isOpen = ref(false);

// Nguồn dùng `createReusableTemplate` để hai nhánh Sheet/Drawer dùng chung một
// khối điều khiển; giữ nguyên cách đó để hai nhánh không trôi khỏi nhau. Nguồn
// có hai khối (ThemeCustomize cho phần Theming, một khối Layout), ở đây cũng
// hai khối: màu chủ đạo và chiều văn bản.
const [DefineColorControls, ReuseColorControls] = createReusableTemplate();
const [DefineDirectionControls, ReuseDirectionControls] = createReusableTemplate();
</script>

<template>
  <DefineColorControls>
    <div class="space-y-1.5">
      <Label>{{ labels.color }}</Label>
      <div class="grid grid-cols-3 gap-2">
        <template v-for="color in APP_SHELL_THEME_COLORS" :key="color.name">
          <Button
            class="justify-start gap-2"
            variant="outline"
            :class="{
              '!border-primary border-2 !bg-primary/10': preferences.themeColor === color.name,
            }"
            @click="setThemeColor(color.name)"
          >
            <span
              class="h-5 w-5 flex items-center justify-center rounded-full border border-white"
              :style="{ backgroundColor: color.swatch }"
            >
              <Check v-if="preferences.themeColor === color.name" class="text-white" :size="16" />
            </span>
            <span class="text-xs capitalize">{{ color.name }}</span>
          </Button>
        </template>
      </div>
    </div>
  </DefineColorControls>

  <DefineDirectionControls>
    <div class="space-y-1.5">
      <Label>{{ labels.direction }}</Label>
      <div class="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          :class="{ '!border-primary border-2 !bg-primary/10': preferences.direction === 'ltr' }"
          @click="setDirection('ltr')"
        >
          {{ labels.directionLtr }}
        </Button>
        <Button
          variant="outline"
          :class="{ '!border-primary border-2 !bg-primary/10': preferences.direction === 'rtl' }"
          @click="setDirection('rtl')"
        >
          {{ labels.directionRtl }}
        </Button>
      </div>
    </div>
  </DefineDirectionControls>

  <Sheet v-if="isDesktop" v-model:open="isOpen">
    <SheetTrigger as-child>
      <Button
        class="fixed top-1/2 z-50"
        :class="preferences.direction === 'rtl' ? '-left-3 pl-6' : '-right-3 pr-6'"
      >
        <!--
          `animate-spin-slow` giữ nguyên như nguồn. Nguồn không định nghĩa
          animation này ở đâu cả, nên ở đó nó không có tác dụng gì; giữ lại đúng
          chuỗi class để bản port không tự thêm một chuyển động mà nguồn không có.
        -->
        <Settings class="animate-spin-slow" :size="18" />
      </Button>
    </SheetTrigger>
    <SheetContent :side="preferences.direction === 'rtl' ? 'left' : 'right'">
      <SheetHeader class="p-6 pb-0">
        <SheetTitle>{{ labels.title }}</SheetTitle>
        <SheetDescription>{{ labels.description }}</SheetDescription>
      </SheetHeader>
      <ScrollArea class="h-[calc(100vh-100px)]">
        <div class="flex flex-col gap-6 px-6">
          <div class="space-y-3">
            <Badge>{{ labels.theming }}</Badge>
            <ReuseColorControls />
          </div>
          <Separator />
          <div class="space-y-3">
            <Badge>{{ labels.layout }}</Badge>
            <ReuseDirectionControls />
          </div>
        </div>
      </ScrollArea>
    </SheetContent>
  </Sheet>

  <Drawer v-else v-model:open="isOpen">
    <DrawerTrigger as-child>
      <Button class="fixed top-1/2 z-50 pr-6 -right-3">
        <Settings class="animate-spin-slow" :size="18" />
      </Button>
    </DrawerTrigger>
    <DrawerContent class="max-h-[97%]">
      <DrawerHeader class="text-center sm:text-center">
        <DrawerTitle>{{ labels.title }}</DrawerTitle>
        <DrawerDescription>{{ labels.description }}</DrawerDescription>
      </DrawerHeader>
      <div class="mx-auto max-w-md w-full overflow-auto overflow-y-auto px-4 pb-6 space-y-6">
        <div class="space-y-3">
          <Badge>Theming</Badge>
          <ReuseColorControls />
        </div>
        <Separator />
        <div class="space-y-3">
          <Badge>Layout</Badge>
          <ReuseDirectionControls />
        </div>
      </div>
    </DrawerContent>
  </Drawer>
</template>
