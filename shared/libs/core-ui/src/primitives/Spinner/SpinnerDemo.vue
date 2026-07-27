<script setup lang="ts">
import Spinner from "./Spinner.vue";
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center gap-4 text-primary">
      <Spinner size="sm" label="Đang tải mục nhỏ" />
      <Spinner size="md" label="Đang tải" />
      <Spinner size="lg" label="Đang tải trang" />
    </div>

    <div class="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground">
      <Spinner size="sm" label="Đang lưu thay đổi" />
      <span>Đang lưu thay đổi…</span>
    </div>
  </div>
</template>
