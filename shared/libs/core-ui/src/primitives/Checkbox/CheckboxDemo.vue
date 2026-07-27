<script setup lang="ts">
import { ref } from "vue";
import Checkbox from "./Checkbox.vue";

const unchecked = ref(false);
const checked = ref(true);
const indeterminate = ref<boolean | "indeterminate">("indeterminate");
</script>

<template>
  <div class="flex flex-col gap-3" style="max-width: 20rem">
    <Checkbox v-model="unchecked" label="Chưa chọn" />
    <Checkbox v-model="checked" label="Đã chọn" />
    <Checkbox v-model="indeterminate" label="Chọn một phần (cha của nhóm con)" />
    <Checkbox v-model="checked" label="Vô hiệu hoá" disabled />
    <Checkbox aria-label="Chỉ có tên trợ năng, không có nhãn hiển thị" />
  </div>
</template>
