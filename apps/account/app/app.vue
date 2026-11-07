<script setup lang="ts">
/**
 * Gốc của app account — nhỏ để còn merge được với Account Foundation.
 *
 * ⚠️ Việc nối i18n và nạp preference nằm ở đây chứ không nằm trong layout: layout
 * có thể bị đổi (ba trang dùng layout khác), nhưng locale và timezone phải đúng ở
 * **mọi** route kể cả khi không layout nào render. Một `<NuxtLayout>` bọc quanh
 * nó, và `NuxtRouteAnnouncer` phục vụ điều hướng bằng screen reader.
 *
 * ⚠️ File này không có `<style>` và chỉ import những gì phải chạy đúng **một lần**
 * cho cả app: Foundation PR có thể chạm vào nó, và một app.vue dài sẽ thành điểm
 * đục độ không cần thiết.
 */
import { useAccountI18n } from './composables/use-account-i18n';
import { useAccountShellPreferences } from './composables/use-account-shell-preferences';

useAccountI18n();
useAccountShellPreferences();
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
