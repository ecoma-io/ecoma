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
      <BackofficeLanguageSelect />
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
import BackofficeLanguageSelect from './components/BackofficeLanguageSelect.vue';
import { useBackofficeI18n } from './composables/use-backoffice-i18n';

const route = useRoute();
const { t } = useI18n();

// Nơi DUY NHẤT ghi `locale` của composer — xem `use-backoffice-i18n.ts`.
// Không có lệnh gọi này thì language selector chỉ đổi `<html lang>` và cookie,
// còn toàn bộ văn bản vẫn nằm ở `DEFAULT_BACKOFFICE_LOCALE`.
const { language, dir } = useBackofficeI18n();

// Chế độ màu là lựa chọn người dùng **duy nhất** còn lại của shell (issue #213):
// `dir` không phải cấu hình — nó đi theo locale từ registry ở trên. Nguồn sự
// thật là cookie này, đúng tên mà script bootstrap (`APP_SHELL_COLOR_MODE_
// BOOTSTRAP_SCRIPT`) đọc trước first paint — hai phía không được lệch tên khoá.
const colorModeCookie = useCookie<string>(APP_SHELL_COLOR_MODE_COOKIE);

// Cookie là dữ liệu người dùng sửa được, nên phải đi qua validator của library
// trước khi render. Không cần `default:` — giá trị vắng mặt hoặc rác rơi về
// `'system'` theo hợp đồng của `parseAppShellColorMode`.
const colorMode = computed<AppShellColorMode>(() => parseAppShellColorMode(colorModeCookie.value));

function setColorMode(mode: AppShellColorMode): void {
  colorModeCookie.value = mode;
}

// Chỉ đăng ký lang + dir qua useHead. Script bootstrap color mode **không**
// nằm ở đây: app chạy `ssr: false`, nên `useHead` chỉ áp dụng client-side sau
// khi bundle mount — quá muộn so với first paint. Script được chèn tĩnh vào
// `app.head` trong `nuxt.config.ts`, render thẳng vào HTML shell lúc build.
//
// ⚠️ **Không** đăng ký class `dark` ở đây: class đó do script bootstrap quyết
// định trước first paint, còn sau hydration thì watcher của `AppShell` cập nhật
// khi người dùng đổi mode. Vue/unhead không quản lý class này — đăng ký nó ở
// head là hoàn tác giá trị mà script đã đặt (FOUC + hydration dispute, lý do
// `appShellHeadAttributes` cũ bị xoá).
useHead(() => ({
  htmlAttrs: { lang: language.value, dir: dir.value },
}));

const shellLabels = computed(() => appShellLabels((key) => t(key)));

const homeLabel = computed(() => t('shell.home'));

const nav = computed<AppShellNavSection[]>(() => [
  {
    heading: t('nav.platform'),
    items: [
      { title: t('nav.overview'), href: '/' },
      { title: t('nav.staff'), href: '/staff' },
      { title: t('nav.roles'), href: '/roles' },
      { title: t('nav.permissions'), href: '/permissions' },
      { title: t('nav.audit'), href: '/audit' },
    ],
  },
]);
</script>
