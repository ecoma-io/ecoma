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
      <!-- Nút đổi color mode nằm cạnh language selector: hai control shell duy nhất
           của header, cùng một hàng. Component đọc ngữ cảnh của `AppShell` (nên phải
           render bên trong nó) và phát `update:colorMode` lên đây để ghi cookie. -->
      <AppShellColorModeToggle :labels="shellLabels.colorMode" />
      <RemoteCacheAppLanguageSelect />
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
import RemoteCacheAppLanguageSelect from './components/RemoteCacheAppLanguageSelect.vue';
import { useRemoteCacheAppI18n } from './composables/use-remote-cache-app-i18n';

const route = useRoute();
const { t } = useI18n();

// Cookie lựa chọn phải sống qua các phiên — cùng tuổi thọ với cookie locale của
// app (`use-remote-cache-app-locale.ts`), vì cùng một loại dữ liệu: lựa chọn
// người dùng không nhạy cảm.
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

// Nơi DUY NHẤT ghi `locale` của composer — xem `use-remote-cache-app-i18n.ts`.
// Không có lệnh gọi này thì language selector chỉ đổi `<html lang>` và cookie,
// còn toàn bộ văn bản vẫn nằm ở `DEFAULT_REMOTE_CACHE_APP_LOCALE`.
// `dir` đi cùng nguồn: suy ra từ registry của locale đang chọn, không phải lựa
// chọn người dùng (issue #213).
const { language, dir } = useRemoteCacheAppI18n();

// Nguồn duy nhất của cấu hình shell còn lại — color mode, một lựa chọn người dùng
// (light/dark/system). Cookie chứ không `localStorage`: script bootstrap nằm ở
// `<head>` đọc `document.cookie` để quyết định class `dark` trước first paint.
const colorModeCookie = useCookie<string>(APP_SHELL_COLOR_MODE_COOKIE, {
  sameSite: 'lax',
  path: '/',
  maxAge: ONE_YEAR_IN_SECONDS,
});

// Cookie là dữ liệu người dùng sửa được, nên phải đi qua validator của library
// trước khi dùng: giá trị lạ rơi về `system` — không có `default:` ở `useCookie`
// vì "không có lựa chọn" và "lựa chọn hỏng" cùng về một giá trị mặc định.
const colorMode = computed(() => parseAppShellColorMode(colorModeCookie.value));

function setColorMode(next: AppShellColorMode): void {
  // Giá trị đến từ `AppShellColorModeToggle` với kiểu đã thu hẹp, nên ghi thẳng
  // được; class `dark` không đặt ở đây — watcher của shell cập nhật sau hydration,
  // render Vue không bao giờ chạm vào class đó.
  colorModeCookie.value = next;
}

// useHead đăng ký `lang` + `dir` của `<html>`. Script bootstrap của color mode
// **không** nằm ở đây — app chạy `ssr: false`, nên `useHead` chỉ áp dụng sau
// khi bundle mount, quá muộn so với first paint; script được chèn tĩnh vào
// `app.head` trong `nuxt.config.ts`, render thẳng vào HTML shell lúc build.
// Class `dark` cũng **không** nằm ở đây — script quyết định nó trước first
// paint, Vue/unhead không quản lý class này nên hydration không bao giờ
// dispute với script.
useHead(() => ({
  htmlAttrs: { lang: language.value, dir: dir.value },
}));

const shellLabels = computed(() => appShellLabels((key) => t(key)));

const homeLabel = computed(() => t('shell.home'));

// Chỉ **một** mục nav, trỏ tới route duy nhất đang tồn tại. Thêm mục cho một
// route chưa có là dựng một liên kết chết trên giao diện.
const nav = computed<AppShellNavSection[]>(() => [
  {
    heading: t('nav.admin'),
    items: [{ title: t('nav.overview'), href: '/' }],
  },
]);
</script>
