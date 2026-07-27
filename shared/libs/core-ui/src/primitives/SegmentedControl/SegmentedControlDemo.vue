<script setup lang="ts">
import { ref } from "vue";
import SegmentedControl from "./SegmentedControl.vue";

const theme = ref("system");
const level = ref("simple");

const themeOptions = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Sáng" },
  { value: "dark", label: "Tối" },
];

// Mức mật độ — hai giá trị loại-trừ; Studio khoá tới 0.2. Code KHÔNG nằm đây:
// nó là lens toggle riêng (Vision §2), không phải segment mật độ.
const levelOptions = [
  { value: "simple", label: "Simple" },
  { value: "studio", label: "Studio", disabled: true },
];
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-2">
      <span class="text-xs text-muted-foreground">Giao diện</span>
      <SegmentedControl v-model="theme" :options="themeOptions" />
    </div>
    <div class="flex flex-col gap-2">
      <span class="text-xs text-muted-foreground"
        >Mức mật độ (Studio khoá tới 0.2; Code là toggle riêng)</span
      >
      <SegmentedControl v-model="level" :options="levelOptions" />
    </div>
  </div>
</template>
