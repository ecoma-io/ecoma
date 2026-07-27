<script setup lang="ts">
import { Info, Scissors, Wand2 } from "@lucide/vue";
import Tooltip from "./Tooltip.vue";
import Button from "../Button/Button.vue";
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <Tooltip content="Cắt clip tại playhead (S)">
      <template #trigger>
        <Button variant="subtle" size="icon" aria-label="Cắt clip">
          <Scissors class="h-4 w-4" />
        </Button>
      </template>
    </Tooltip>

    <Tooltip content="Gợi ý AI cho scene này" side="bottom">
      <template #trigger>
        <Button variant="subtle" size="icon" aria-label="Gợi ý AI">
          <Wand2 class="h-4 w-4" />
        </Button>
      </template>
    </Tooltip>

    <Tooltip side="right">
      <template #trigger>
        <Button variant="ghost" size="icon" aria-label="Thông tin">
          <Info class="h-4 w-4" />
        </Button>
      </template>
      <div class="max-w-[14rem]">
        Tooltip chỉ là <b>gợi ý</b> — không đặt nội dung tương tác vào đây.
      </div>
    </Tooltip>
  </div>
</template>
