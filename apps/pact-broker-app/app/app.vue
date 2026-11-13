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
      <PactBrokerLanguageSelect />
      <AppShellColorModeToggle :labels="shellLabels.colorMode" />
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
import PactBrokerLanguageSelect from './components/PactBrokerLanguageSelect.vue';
import { usePactBrokerI18n } from './composables/use-pact-broker-i18n';

const route = useRoute();
const { t } = useI18n();

// Nơi DUY NHẤT ghi `locale` của composer — xem `use-pact-broker-i18n.ts`.
// Không có lệnh gọi này thì language selector chỉ đổi `<html lang>` và cookie,
// còn toàn bộ văn bản vẫn nằm ở `DEFAULT_PACT_BROKER_LOCALE`.
const { language, dir } = usePactBrokerI18n();

// Nguồn duy nhất của color mode là cookie này — lựa chọn người dùng duy nhất mà
// shell còn nhận sau khi bảng tuỳ chỉnh bị gỡ (issue #213).
const colorModeCookie = useCookie<string>(APP_SHELL_COLOR_MODE_COOKIE);

// Cookie là dữ liệu người dùng sửa được, nên giá trị đọc ra phải đi qua
// validator của library trước khi render; giá trị lạ rơi về `'system'`.
const colorMode = computed(() => parseAppShellColorMode(colorModeCookie.value));

function setColorMode(next: AppShellColorMode): void {
  colorModeCookie.value = next;
}

// useHead đăng ký `lang` + `dir` của `<html>` — hai thuộc tính của cùng ngôn
// ngữ. Script bootstrap của color mode **không** nằm ở đây: app chạy
// `ssr: false`, nên `useHead` chỉ áp dụng sau khi bundle mount, quá muộn so
// với first paint; script được chèn tĩnh vào `app.head` trong `nuxt.config.ts`,
// render thẳng vào HTML shell lúc build và chạy lúc parse trước một pixel nào
// được vẽ. Sau hydration, watcher của chính `AppShell` cập nhật class `dark`
// khi người dùng đổi mode — unhead không đụng chạm hay hoàn tác giá trị mà
// script đã đặt.
useHead(() => ({
  htmlAttrs: { lang: language.value, dir: dir.value },
}));

const shellLabels = computed(() => appShellLabels((key) => t(key)));

const homeLabel = computed(() => t('shell.home'));

const nav = computed<AppShellNavSection[]>(() => [
  {
    heading: t('nav.broker'),
    items: [
      { title: t('nav.overview'), href: '/' },
      { title: t('nav.pacts'), href: '/pacts' },
      { title: t('nav.environments'), href: '/environments' },
      { title: t('nav.tokens'), href: '/tokens' },
    ],
  },
]);
</script>
