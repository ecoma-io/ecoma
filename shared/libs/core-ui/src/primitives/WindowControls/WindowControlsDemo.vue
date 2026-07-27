<script setup lang="ts">
import { ref } from "vue";
import WindowControls from "./WindowControls.vue";

const isMaximized = ref(false);
const last = ref("—");

const onClose = () => (last.value = "close");
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Shown on a title-bar-like strip so hover targets read correctly -->
    <div class="flex h-9 items-center justify-end rounded-lg border border-border bg-card">
      <WindowControls
        :is-maximized="isMaximized"
        @minimize="last = 'minimize'"
        @maximize="((isMaximized = !isMaximized), (last = 'maximize'))"
        @close="onClose"
      />
    </div>
    <div class="text-xs text-muted-foreground">
      Intent gần nhất: <code class="tabular text-foreground">{{ last }}</code> · maximized:
      <code class="tabular text-foreground">{{ isMaximized }}</code>
      <span class="ml-2">— di chuột để thấy hover; nút Close hoá đỏ (destructive).</span>
    </div>
  </div>
</template>
