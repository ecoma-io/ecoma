<script setup lang="ts">
import { ref } from "vue";
import Button from "./Button.vue";

const loading = ref(false);
function fakeRun() {
  loading.value = true;
  // Illustrative only; resets so the kinetic swap replays on each click.
  window.setTimeout(() => (loading.value = false), 1600);
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center gap-3">
      <Button variant="primary" @click="fakeRun">Tạo composition</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="subtle">Subtle</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Xoá scene</Button>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Play">▶</Button>
      <Button size="icon-sm" variant="ghost" aria-label="Xoá hàng">✕</Button>
      <Button :loading="loading" loading-text="Đang chạy AI…" @click="fakeRun">
        Bấm để xem loading
      </Button>
      <Button disabled>Disabled</Button>
    </div>
  </div>
</template>
