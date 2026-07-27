<script setup lang="ts">
import { ref } from "vue";
import { Inbox } from "@lucide/vue";
import EmptyState from "./EmptyState.vue";
import Button from "../../primitives/Button/Button.vue";

// Re-keying remounts the block so the staggered entrance replays.
const replayKey = ref(0);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-lg border border-border bg-card">
      <EmptyState
        :key="replayKey"
        title="Chưa có quy trình nào"
        description="Tạo quy trình đầu tiên để giao việc cho agent của bạn."
      >
        <template #icon><Inbox /></template>
        <template #action>
          <Button variant="primary">Tạo quy trình</Button>
        </template>
      </EmptyState>
    </div>
    <Button variant="subtle" size="sm" class="self-start" @click="replayKey++">Diễn lại</Button>
  </div>
</template>
