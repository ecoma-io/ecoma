<template>
  <AppShell
    :dir="dir"
    :color-mode="colorMode"
    :nav="nav"
    :current-path="route.path"
    :home-label="homeLabel"
    :labels="shellLabels"
    @update:color-mode="setColorMode"
  >
    <template #brand>
      <NuxtLink to="/" class="flex items-center gap-2 px-1">
        <EcomaLogo aria-label="Ecoma" class="h-5 w-auto" />
      </NuxtLink>
    </template>
    <template #actions>
      <LlmConsoleLanguageSelect />
      <AppShellColorModeToggle />
    </template>
    <NuxtPage />
  </AppShell>
</template>

<script setup lang="ts">
import {
  APP_SHELL_COLOR_MODE_COOKIE,
  AppShell,
  AppShellColorModeToggle,
  parseAppShellColorMode,
  type AppShellColorMode,
  type AppShellNavSection,
} from '@ecoma-io/ui-app-shell';
import { EcomaLogo } from '@ecoma-io/ui-ecoma-logo';
import { useI18n } from '#i18n';

import { appShellLabels } from './utils/app-shell-labels';
import LlmConsoleLanguageSelect from './components/LlmConsoleLanguageSelect.vue';
import { useLlmConsoleI18n } from './composables/use-llm-console-i18n';

const route = useRoute();
const { t } = useI18n();

// Nơi DUY NHẤT ghi `locale` của composer — xem `use-llm-console-i18n.ts`.
// Không có lệnh gọi này thì language selector chỉ đổi `<html lang>` và cookie,
// còn toàn bộ văn bản vẫn nằm ở `DEFAULT_LLM_CONSOLE_LOCALE`.
const { language, dir } = useLlmConsoleI18n();

// Nguồn duy nhất của cấu hình shell là cookie này. Sau issue #213 nó chỉ còn
// chứa **một** lựa chọn của người dùng — chế độ màu; `dir` không nằm ở đây vì
// hướng chữ là thuộc tính của ngôn ngữ, suy ra từ registry locale.
const colorModeCookie = useCookie<string>(APP_SHELL_COLOR_MODE_COOKIE);

// Cookie là dữ liệu người dùng sửa được, nên phải đi qua validator của library
// trước khi render — giá trị lạ rơi về `system` thay vì render trạng thái vô nghĩa.
const colorMode = computed(() => parseAppShellColorMode(colorModeCookie.value));

function setColorMode(next: AppShellColorMode): void {
  colorModeCookie.value = next;
}

// useHead chỉ đăng ký `lang`/`dir` của `<html>`: hai thuộc tính của cùng ngôn
// ngữ, cùng tra từ definition của locale đang dùng trong registry (xem
// `use-llm-console-i18n.ts`). Script bootstrap của color mode **không** nằm ở
// đây — app chạy `ssr: false`, nên `useHead` chỉ áp dụng sau khi bundle mount,
// quá muộn so với first paint; script được chèn tĩnh vào `app.head` trong
// `nuxt.config.ts`, render thẳng vào HTML shell lúc build. Vue và unhead cũng
// **không** quản lý class `dark` — không có `class` trong `htmlAttrs`, không có
// `bodyAttrs` nào ở đây — nên hydration không bao giờ hoàn tác giá trị mà script
// đã đặt.
useHead(() => {
  return {
    htmlAttrs: { lang: language.value, dir: dir.value },
  };
});

const shellLabels = computed(() => appShellLabels((key) => t(key)));

const homeLabel = computed(() => t('shell.home'));

// Chỉ **một** mục nav, trỏ tới route duy nhất đang tồn tại. Thêm mục cho một
// route chưa có là dựng một liên kết chết trên giao diện.
const nav = computed<AppShellNavSection[]>(() => [
  {
    heading: t('nav.console'),
    items: [{ title: t('nav.overview'), href: '/' }],
  },
]);
</script>
