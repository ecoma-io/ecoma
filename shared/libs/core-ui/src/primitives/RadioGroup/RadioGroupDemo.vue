<script setup lang="ts">
import { ref } from "vue";
import RadioGroup, { type RadioOption } from "./RadioGroup.vue";

const options: RadioOption[] = [
  { value: "free", label: "Miễn phí", description: "Giới hạn 1 dự án, watermark khi xuất." },
  { value: "pro", label: "Pro", description: "Không giới hạn dự án, xuất không watermark." },
  { value: "enterprise", label: "Enterprise", description: "SSO, hỗ trợ ưu tiên." },
  { value: "legacy", label: "Gói cũ (ngừng bán)", disabled: true },
];

const plan = ref("pro");
</script>

<template>
  <div style="max-width: 24rem">
    <RadioGroup v-model="plan" :options="options" name="plan" />
  </div>
</template>
