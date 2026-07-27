<script setup lang="ts">
import { ref } from "vue";
import Slider from "./Slider.vue";

const volume = ref(0.65);
const locked = ref(0.3);

function logCommit(value: number) {
  // Illustrative only — a real host writes this to composition.mutate.
  console.log("[Slider] commit volume:", value);
}
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 20rem">
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span id="slider-demo-volume-label" class="text-xs text-muted-foreground"
          >volume (giá trị giữa)</span
        >
        <span class="tabular text-xs text-muted-foreground">{{ volume.toFixed(2) }}</span>
      </div>
      <Slider v-model="volume" aria-labelledby="slider-demo-volume-label" @commit="logCommit" />
    </div>
    <div class="flex flex-col gap-2 opacity-60">
      <span id="slider-demo-locked-label" class="text-xs text-muted-foreground"
        >trần cache (đã khoá — disabled)</span
      >
      <Slider :model-value="locked" disabled aria-labelledby="slider-demo-locked-label" />
    </div>
  </div>
</template>
