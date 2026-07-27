<script setup lang="ts">
import { ref } from "vue";
import Toast, { type ToastVariant } from "./Toast.vue";
import Button from "../Button/Button.vue";

const open = ref(false);
const variant = ref<ToastVariant>("success");
const title = ref("Đã lưu composition");
const description = ref("Bản nháp được đồng bộ lúc 14:32.");

function show(v: ToastVariant, t: string, d: string) {
  variant.value = v;
  title.value = t;
  description.value = d;
  // Re-open cleanly so the enter animation replays on each click.
  open.value = false;
  window.setTimeout(() => (open.value = true), 0);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <Button variant="outline" @click="show('success', 'Đã lưu composition', 'Đồng bộ lúc 14:32.')">
      Thành công
    </Button>
    <Button
      variant="outline"
      @click="show('destructive', 'Render thất bại', 'Thiếu codec H.264 trên máy.')"
    >
      Lỗi
    </Button>
    <Button
      variant="outline"
      @click="show('ai', 'AI đã dựng xong bản nháp', 'Xem lại trước khi render.')"
    >
      AI
    </Button>

    <Toast
      v-model:open="open"
      :variant="variant"
      :title="title"
      :description="description"
      action-label="Hoàn tác"
    />
  </div>
</template>
