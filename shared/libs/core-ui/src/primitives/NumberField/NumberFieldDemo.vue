<script setup lang="ts">
import { ref } from "vue";
import NumberField from "./NumberField.vue";

const x = ref(120);
const rotation = ref(45);
const opacity = ref(80);
const locked = ref(50);

function logCommit(label: string, value: number) {
  // Illustrative only — a real host writes this to composition.mutate.
  console.log(`[NumberField] commit ${label}:`, value);
}
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 22rem">
    <div class="flex flex-col gap-2">
      <span id="numberfield-demo-x-label" class="text-xs text-muted-foreground">x (mặc định)</span>
      <NumberField
        v-model="x"
        unit="px"
        aria-labelledby="numberfield-demo-x-label"
        @commit="(v) => logCommit('x', v)"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="numberfield-demo-rotation-label" class="text-xs text-muted-foreground"
        >rotation (min/max kẹp -180…180)</span
      >
      <NumberField
        v-model="rotation"
        :min="-180"
        :max="180"
        unit="deg"
        aria-labelledby="numberfield-demo-rotation-label"
        @commit="(v) => logCommit('rotation', v)"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="numberfield-demo-opacity-label" class="text-xs text-muted-foreground"
        >opacity (không đơn vị)</span
      >
      <NumberField
        v-model="opacity"
        :min="0"
        :max="100"
        aria-labelledby="numberfield-demo-opacity-label"
        @commit="(v) => logCommit('opacity', v)"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="numberfield-demo-locked-label" class="text-xs text-muted-foreground"
        >width (đã khoá — disabled)</span
      >
      <NumberField
        :model-value="locked"
        unit="px"
        disabled
        aria-labelledby="numberfield-demo-locked-label"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="numberfield-demo-invalid-label" class="text-xs text-muted-foreground"
        >duration (invalid — mâu thuẫn với field khác)</span
      >
      <NumberField
        :model-value="0"
        unit="s"
        invalid
        aria-labelledby="numberfield-demo-invalid-label"
      />
    </div>
  </div>
</template>
