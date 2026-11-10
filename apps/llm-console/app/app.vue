<template>
  <AppShell
    :preferences="preferences"
    :nav="nav"
    :current-path="route.path"
    :home-label="homeLabel"
    :labels="shellLabels"
    @update:preferences="updatePreferences"
  >
    <template #brand>
      <NuxtLink to="/" class="flex items-center gap-2 px-1">
        <EcomaLogo aria-label="Ecoma" class="h-5 w-auto" />
      </NuxtLink>
    </template>
    <template #actions>
      <LlmConsoleLanguageSelect />
    </template>
    <NuxtPage />
  </AppShell>
</template>

<script setup lang="ts">
import {
  APP_SHELL_PREFERENCES_COOKIE,
  AppShell,
  DEFAULT_APP_SHELL_PREFERENCES,
  appShellHeadAttributes,
  parseAppShellPreferences,
  type AppShellNavSection,
  type AppShellPreferences,
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
const { language } = useLlmConsoleI18n();

// Nguồn duy nhất của cấu hình shell là cookie này.
const shellCookie = useCookie<AppShellPreferences>(APP_SHELL_PREFERENCES_COOKIE, {
  default: () => DEFAULT_APP_SHELL_PREFERENCES,
});

// Cookie là dữ liệu người dùng sửa được, nên phải đi qua validator của library trước khi render.
const preferences = computed(() => parseAppShellPreferences(shellCookie.value));

function updatePreferences(next: AppShellPreferences): void {
  shellCookie.value = next;
}

// Gộp lang + htmlAttrs(bodyAttrs từ shell) vào một useHead duy nhất.
useHead(() => {
  const { htmlAttrs, bodyAttrs } = appShellHeadAttributes(preferences.value);

  return {
    htmlAttrs: { lang: language.value, ...htmlAttrs },
    bodyAttrs,
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
