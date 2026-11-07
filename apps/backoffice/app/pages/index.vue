<script setup lang="ts">
/**
 * Overview.
 *
 * ⚠️ **Không mock dashboard, không business metric.** Issue #218 chốt "Trang
 * Overview giữ nguyên là trang trống có chủ ý", và tài liệu thiết kế chưa định
 * nghĩa một operational metric nào của `backoffice` (`01-architecture.md` §10
 * còn để ngỏ cả storage). Một con số bịa ra ở đây — "12 staff", "3 role đang
 * hoạt động" — sẽ là chính xác loại claim mà prototype không có quyền đưa ra.
 *
 * Thay vào đó trang là một landing page trung thực: tự nói nó là gì, và dẫn
 * sang ba khu vực prototype. Ba link đó là điều khiển **thực**: mỗi cái trỏ tới
 * một route có thật, nên không có mục nav nào dẫn tới chỗ chết.
 *
 * Giữ đúng **một** `<h1>` localized.
 */
import { useI18n } from '#i18n';

const { t } = useI18n();

/** Khu vực prototype — dùng cho cả link nhanh trên trang này. */
const areas = [
  { titleKey: 'nav.staff', href: '/staff' },
  { titleKey: 'nav.roles', href: '/roles' },
  { titleKey: 'nav.permissions', href: '/permissions' },
] as const;
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <BackofficePageHeader
      :title="t('pages.overview.title')"
      :description="t('pages.overview.description')"
    />

    <BackofficeSampleNotice :message="t('prototype.notice.body')" />

    <nav :aria-label="t('pages.overview.title')">
      <ul class="grid gap-3 sm:grid-cols-3">
        <li v-for="area in areas" :key="area.href">
          <NuxtLink
            :to="area.href"
            class="flex h-full flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
            :data-testid="`overview-area-${area.href.slice(1)}`"
          >
            <span class="font-medium">{{ t(area.titleKey) }}</span>
          </NuxtLink>
        </li>
      </ul>
    </nav>
  </section>
</template>
