<script setup lang="ts">
import { ACCOUNT_NAV_ITEMS, isActiveNavItem } from '../layout/account-nav';

/**
 * Shell của bề mặt tài khoản: header + điều hướng + `<main>`.
 *
 * Layout này dùng cho **tám** trang đã đăng nhập. Ba trang `/login`,
 * `/login/continue`, `/consent` dùng layout `auth` — xem `auth.vue`.
 *
 * ⚠️ Điều hướng được render **một** lần ở `<nav>` desktop và **một** lần trong
 * `<details>` mobile, từ cùng `ACCOUNT_NAV_ITEMS`. Hai bản render không phải hai
 * nguồn sự thật: mục nào được thêm vào registry thì xuất hiện ở cả hai, không
 * thể lệch.
 *
 * ⚠️ Hai `<nav>` mang **cùng** accessible name (`shell.navLabel`). Ở mỗi
 * breakpoint chỉ một cái nằm trong cây truy cập (`lg:block` / `lg:hidden` đối
 * nghịch), nên không có hai landmark trùng tên cùng lúc. Đổi tên riêng mỗi bản
 * là một thông tin không có ở đâu.
 *
 * `<details>` thay vì menu tự dựng: mobile menu đóng/mở không cần JavaScript, nên
 * SSR và hydrate cho ra cùng một HTML, và `Escape` không cần xử lý thủ công.
 *
 * ⚠️ Banner "preview data" là ở đây chứ không phải ở từng trang: nó nói đúng một
 * điều về **toàn bộ** app, và lặp lại nó ở mỗi trang sẽ khiến người xuống dưới
 * phải đọc tám lần. Nó hiện khi `adapter.isPreview` — cờ do lớp dữ liệu đặt, không
 * phải biến build-time, nên khi adapter thật thay mock vào thì banner tự biến mất
 * mà không phải sửa template này.
 */
const i18n = useI18n();
const route = useRoute();
const adapter = useAccountAdapter();
</script>

<template>
  <div class="min-h-screen bg-surface">
    <a
      href="#account-main"
      class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-field focus:bg-brand focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
    >
      {{ i18n.t('shell.skipToContent') }}
    </a>

    <header class="border-b border-line bg-surface-raised">
      <div
        class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 lg:px-8"
      >
        <NuxtLink to="/" class="text-lg font-semibold text-foam" data-testid="account-shell-title">
          {{ i18n.t('shell.title') }}
        </NuxtLink>
        <AccountLanguageSelect
          :authenticated="true"
          :save-failed-label="i18n.t('preferences.saveFailed')"
          :saved-label="i18n.t('states.saved')"
        />
      </div>
    </header>

    <p
      v-if="adapter.isPreview"
      class="border-b border-warning-line bg-warning-soft px-4 py-2 text-center text-xs text-foam"
      role="note"
      data-testid="account-preview-banner"
    >
      <strong class="font-semibold">{{ i18n.t('shell.mockBadge') }}</strong> —
      {{ i18n.t('shell.mockNotice') }}
    </p>

    <div class="mx-auto flex max-w-6xl gap-8 px-4 py-6 lg:px-8 lg:py-10">
      <nav :aria-label="i18n.t('shell.navLabel')" class="hidden w-60 shrink-0 lg:block">
        <ul class="sticky top-6 space-y-1">
          <li v-for="item in ACCOUNT_NAV_ITEMS" :key="item.to">
            <NuxtLink
              :to="item.to"
              class="block rounded-field px-3 py-2 text-sm font-medium text-muted hover:bg-surface hover:text-foam"
              :class="{ 'bg-surface text-foam': isActiveNavItem(route, item) }"
              :aria-current="isActiveNavItem(route, item) ? 'page' : undefined"
              :data-testid="`account-nav-${item.to === '/' ? 'personal' : item.to.slice(1)}`"
            >
              {{ i18n.t(item.labelKey) }}
            </NuxtLink>
          </li>
        </ul>
      </nav>

      <div class="min-w-0 flex-1">
        <details class="mb-4 rounded-card border border-line bg-surface-raised lg:hidden">
          <summary
            class="cursor-pointer px-4 py-3 text-sm font-semibold text-foam"
            data-testid="account-mobile-nav-summary"
          >
            {{ i18n.t('shell.navLabel') }}
          </summary>
          <nav :aria-label="i18n.t('shell.navLabel')" class="border-t border-line px-2 py-2">
            <ul class="space-y-1">
              <li v-for="item in ACCOUNT_NAV_ITEMS" :key="item.to">
                <NuxtLink
                  :to="item.to"
                  class="block rounded-field px-3 py-2 text-sm font-medium text-muted"
                  :class="{ 'bg-surface text-foam': isActiveNavItem(route, item) }"
                  :aria-current="isActiveNavItem(route, item) ? 'page' : undefined"
                >
                  {{ i18n.t(item.labelKey) }}
                </NuxtLink>
              </li>
            </ul>
          </nav>
        </details>

        <main id="account-main" class="min-w-0" data-testid="account-main">
          <slot />
        </main>
      </div>
    </div>
  </div>
</template>
