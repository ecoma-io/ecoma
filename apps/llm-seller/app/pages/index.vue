<script setup lang="ts">
/**
 * Overview.
 *
 * ⚠️ **Không hiển thị metric bịa.** Seller portal chưa có dữ liệu nghiệp vụ nào
 * được định nghĩa — một con số bịa ("12 offers", "3 endpoint") là chính xác loại
 * claim mà app không có quyền đưa ra. Trang nói đúng sự thật: shell và
 * localization đã sẵn sàng, còn onboarding, verification, offer, pricing,
 * earnings và payout **chưa** được hiện thực.
 *
 * Trang cũng **không** dẫn sang route nào khác vì chưa có route nào khác — nav
 * chỉ có mục Overview trỏ về `/`.
 *
 * Giữ đúng **một** `<h1>` localized.
 */
import { useI18n } from '#i18n';

const { t } = useI18n();
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <LlmSellerPageHeader :title="t('overview.title')" :description="t('overview.description')" />

    <div
      class="rounded-lg border border-border bg-card px-4 py-6"
      data-testid="llm-seller-scaffold-notice"
    >
      <p class="text-sm font-semibold">{{ t('overview.scaffoldTitle') }}</p>
      <p class="mt-1 max-w-2xl text-sm text-muted-foreground">{{ t('overview.scaffoldBody') }}</p>
    </div>
  </section>
</template>
