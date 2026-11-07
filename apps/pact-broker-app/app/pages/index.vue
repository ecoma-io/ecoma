<script setup lang="ts">
/**
 * Overview.
 *
 * ⚠️ **Không hiển thị metric bịa.** Dashboard chưa có dữ liệu tổng hợp nào được
 * định nghĩa trong tài liệu thiết kế — một con số bịa ("12 pacts", "3 service")
 * là chính xác loại claim mà app không có quyền đưa ra. Trang là landing page
 * trung thực: tự nói nó là gì, dẫn sang ba khu vực còn lại, và ba link đó là
 * điều khiển **thực** — mỗi cái trỏ tới một route có thật.
 *
 * Giữ đúng **một** `<h1>` localized.
 */
import { useI18n } from '#i18n';

const { t } = useI18n();

/** Khu vực dashboard — dùng cho cả link nhanh trên trang này. */
const areas = [
  { titleKey: 'nav.pacts', href: '/pacts' },
  { titleKey: 'nav.environments', href: '/environments' },
  { titleKey: 'nav.tokens', href: '/tokens' },
] as const;
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <PactBrokerPageHeader :title="t('overview.title')" :description="t('overview.description')" />

    <nav :aria-label="t('overview.title')">
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
