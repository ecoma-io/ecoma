<script setup lang="ts">
import { ref } from "vue";
import Button from "../../../src/primitives/Button/Button.vue";
import Badge from "../../../src/primitives/Badge/Badge.vue";
import Surface from "../../../src/primitives/Surface/Surface.vue";

const loading = ref(false);
function fakeRun() {
  loading.value = true;
  // Purely illustrative; resets so the shimmer is visible on each click.
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
      <Button :loading="loading" @click="fakeRun">
        {{ loading ? "Đang chạy AI…" : "Bấm để xem shimmer" }}
      </Button>
      <Button disabled>Disabled</Button>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Badge variant="ai">✦ AI</Badge>
      <Badge variant="primary">Flare</Badge>
      <Badge variant="info">selection</Badge>
      <Badge variant="success">rendered</Badge>
      <Badge variant="outline">draft</Badge>
      <Badge>neutral</Badge>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Surface variant="card">
        <div class="text-sm font-medium">Surface · card</div>
        <div class="mt-1 text-xs text-muted-foreground">Hairline border, no shadow.</div>
      </Surface>
      <Surface variant="muted">
        <div class="text-sm font-medium">Surface · muted</div>
        <div class="mt-1 text-xs text-muted-foreground">Recessed panel fill.</div>
      </Surface>
      <Surface variant="stage">
        <div class="text-sm font-medium">Surface · stage</div>
        <div class="mt-1 text-xs opacity-70">Dark media backdrop — cả 2 theme.</div>
      </Surface>
    </div>
  </div>
</template>
