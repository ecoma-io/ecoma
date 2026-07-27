<script setup lang="ts">
import { ref } from "vue";
import Select from "./Select.vue";

const locale = ref("en");
const resolution = ref("1920x1080");

const localeOptions = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

const resolutionOptions = [
  { value: "1280x720", label: "1280×720 · HD" },
  { value: "1920x1080", label: "1920×1080 · Full HD" },
  { value: "3840x2160", label: "3840×2160 · 4K" },
];
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 20rem">
    <div class="flex flex-col gap-2">
      <span id="select-demo-locale-label" class="text-xs text-muted-foreground">Ngôn ngữ</span>
      <Select
        v-model="locale"
        :options="localeOptions"
        placeholder="Chọn ngôn ngữ"
        aria-labelledby="select-demo-locale-label"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="select-demo-resolution-label" class="text-xs text-muted-foreground"
        >Độ phân giải</span
      >
      <Select
        v-model="resolution"
        :options="resolutionOptions"
        aria-labelledby="select-demo-resolution-label"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="select-demo-invalid-label" class="text-xs text-muted-foreground"
        >Invalid (trong một Field đang báo lỗi)</span
      >
      <Select
        :options="localeOptions"
        placeholder="Bắt buộc chọn"
        invalid
        aria-labelledby="select-demo-invalid-label"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span id="select-demo-sizes-label" class="text-xs text-muted-foreground"
        >Sizes — cùng thang với TextField</span
      >
      <div class="flex items-center gap-2" aria-labelledby="select-demo-sizes-label">
        <Select :options="localeOptions" size="sm" placeholder="sm" aria-label="Chọn cỡ sm" />
        <Select :options="localeOptions" size="md" placeholder="md" aria-label="Chọn cỡ md" />
        <Select :options="localeOptions" size="lg" placeholder="lg" aria-label="Chọn cỡ lg" />
      </div>
    </div>
  </div>
</template>
