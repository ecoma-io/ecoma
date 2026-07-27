<script setup lang="ts">
import { ref } from "vue";
import Popover from "./Popover.vue";
import Button from "../Button/Button.vue";
import Slider from "../Slider/Slider.vue";

const open = ref(false);
const opacity = ref(0.8);
</script>

<template>
  <div class="flex flex-wrap items-start gap-4">
    <Popover v-model:open="open">
      <template #trigger>
        <Button variant="outline">Bộ lọc</Button>
      </template>
      <div class="flex flex-col gap-3">
        <div class="text-sm font-medium">Hiển thị</div>
        <div class="flex flex-col gap-2 text-xs text-muted-foreground">
          <span id="popover-demo-opacity">Độ mờ lớp</span>
          <Slider
            v-model="opacity"
            :min="0"
            :max="1"
            :step="0.01"
            aria-labelledby="popover-demo-opacity"
          />
        </div>
      </div>
    </Popover>

    <Popover :side="'right'">
      <template #trigger>
        <Button variant="subtle" size="icon" aria-label="Trợ giúp">?</Button>
      </template>
      <div class="max-w-[16rem]">
        <div class="text-sm font-medium">Mẹo</div>
        <p class="mt-1 text-xs text-muted-foreground">
          Popover dành cho nội dung phụ người dùng chủ động mở — khác tooltip (chỉ gợi ý) và dialog
          (chặn cả màn).
        </p>
      </div>
    </Popover>
  </div>
</template>
