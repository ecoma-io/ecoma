<script setup lang="ts">
/**
 * Overview — trang duy nhất của scaffold `llm-console`.
 *
 * ⚠️ **Không hiển thị metric bịa.** Chưa có API, chưa có contract dữ liệu nào
 * được hiện thực, nên một con số hay bảng số liệu ở đây là claim mà app không có
 * quyền đưa ra. Trang chỉ nói đúng sự thật: khung dashboard và đa ngôn ngữ đã
 * sẵn sàng, các tính năng nghiệp vụ (tài khoản, API key, định tuyến, mức sử
 * dụng, thanh toán) **chưa** được triển khai.
 *
 * Không có link tới route chưa tồn tại, không có mock table, không có fixture.
 *
 * Giữ đúng **một** `<h1>` localized.
 */
import { useI18n } from '#i18n';

const { t } = useI18n();
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <LlmConsolePageHeader :title="t('overview.title')" :description="t('overview.description')" />

    <div
      class="rounded-lg border border-border bg-card px-4 py-4"
      data-testid="llm-console-scaffold-notice"
    >
      <h2 class="text-sm font-semibold">{{ t('overview.scaffoldTitle') }}</h2>
      <p class="mt-1 max-w-2xl text-sm text-muted-foreground">
        {{ t('overview.scaffoldBody') }}
      </p>
    </div>
  </section>
</template>
