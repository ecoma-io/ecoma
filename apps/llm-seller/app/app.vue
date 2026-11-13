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
      <AppShellColorModeToggle :labels="shellLabels.colorMode" />
      <LlmSellerLanguageSelect />
    </template>
    <NuxtPage />
  </AppShell>
</template>

<script setup lang="ts">
import {
  APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT,
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
import LlmSellerLanguageSelect from './components/LlmSellerLanguageSelect.vue';
import { useLlmSellerI18n } from './composables/use-llm-seller-i18n';

const route = useRoute();
const { t } = useI18n();

// Nơi DUY NHẤT ghi `locale` của composer — xem `use-llm-seller-i18n.ts`.
// Không có lệnh gọi này thì language selector chỉ đổi `<html lang>` và cookie,
// còn toàn bộ văn bản vẫn nằm ở `DEFAULT_LLM_SELLER_LOCALE`.
const { language, dir } = useLlmSellerI18n();

// Nguồn duy nhất của cấu hình màu là cookie này. Chiều văn bản KHÔNG nằm đây:
// `dir` là thuộc tính của ngôn ngữ và đến từ locale registry (issue #213).
const colorModeCookie = useCookie<string>(APP_SHELL_COLOR_MODE_COOKIE);

// Cookie là dữ liệu người dùng sửa được, nên phải đi qua validator của library
// trước khi render — giá trị lạ (kể cả cookie vắng mặt) rơi về `system`, đi theo
// hệ điều hành. Không cần `default` cho cookie: validator đã xử lý `undefined`.
const colorMode = computed(() => parseAppShellColorMode(colorModeCookie.value));

function setColorMode(next: AppShellColorMode): void {
  colorModeCookie.value = next;
}

// Gộp lang + dir + script bootstrap color mode vào một useHead duy nhất.
//
// Script nằm trong `<head>` quyết định class `dark` trên `<html>` TRƯỚC first
// paint; unhead cố ý KHÔNG quản lý class này — không có `class` nào trong
// `htmlAttrs` (invariant mới của issue #213): render Vue không đọc môi trường,
// nên hydration không bao giờ dispute với script.
useHead(() => {
  return {
    htmlAttrs: { lang: language.value, dir: dir.value },
    script: [{ textContent: APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT }],
  };
});

const shellLabels = computed(() => appShellLabels((key) => t(key)));

const homeLabel = computed(() => t('shell.home'));

// CHỈ mục đã có route thật: seller portal hiện có đúng một trang (`/`). Thêm
// nav item trỏ tới route chưa tồn tại sẽ đưa người dùng tới trang 404 của SPA.
const nav = computed<AppShellNavSection[]>(() => [
  {
    heading: t('nav.seller'),
    items: [{ title: t('nav.overview'), href: '/' }],
  },
]);
</script>
