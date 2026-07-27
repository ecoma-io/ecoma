<script setup lang="ts">
import { ref } from "vue";
import Textarea from "./Textarea.vue";

const bio = ref("Đạo diễn hình ảnh, 8 năm kinh nghiệm dựng phim quảng cáo.");
const notes = ref("");
const feedback = ref("thiếu dấu chấm câu");
</script>

<template>
  <div class="flex flex-col gap-6" style="max-width: 24rem">
    <div class="flex flex-col gap-2">
      <span id="ta-demo-bio" class="text-xs text-muted-foreground">Giới thiệu</span>
      <Textarea v-model="bio" aria-labelledby="ta-demo-bio" placeholder="Giới thiệu bản thân" />
    </div>

    <div class="flex flex-col gap-2">
      <span id="ta-demo-notes" class="text-xs text-muted-foreground"
        >Ghi chú (không cho co giãn)</span
      >
      <Textarea
        v-model="notes"
        resize="none"
        :rows="5"
        aria-labelledby="ta-demo-notes"
        placeholder="Nhập ghi chú…"
      />
    </div>

    <div class="flex flex-col gap-2">
      <span id="ta-demo-feedback" class="text-xs text-muted-foreground"
        >Phản hồi (trạng thái lỗi)</span
      >
      <Textarea
        v-model="feedback"
        invalid
        aria-labelledby="ta-demo-feedback"
        placeholder="Nhập phản hồi…"
      />
    </div>

    <Textarea aria-label="Vô hiệu hoá" disabled placeholder="Không thể nhập" />
  </div>
</template>
