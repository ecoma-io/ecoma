<script setup lang="ts">
import { ref } from "vue";
import Dialog from "./Dialog.vue";
import Button from "../Button/Button.vue";

const open = ref(false);
const confirmOpen = ref(false);
const wideOpen = ref(false);

function confirmDelete() {
  confirmOpen.value = false;
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <Dialog
      v-model:open="open"
      title="Đổi tên composition"
      description="Tên mới sẽ áp dụng ngay cho toàn bộ scene."
    >
      <template #trigger><Button variant="outline">Đổi tên</Button></template>
      <p class="text-sm text-muted-foreground">Nhập tên gợi nhớ để tìm lại nhanh trong thư viện.</p>
      <template #footer>
        <Button variant="subtle" @click="open = false">Huỷ</Button>
        <Button variant="primary" @click="open = false">Lưu</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="confirmOpen"
      title="Xoá scene?"
      description="Hành động này không thể hoàn tác."
    >
      <template #trigger><Button variant="destructive">Xoá scene</Button></template>
      <template #footer>
        <Button variant="subtle" @click="confirmOpen = false">Giữ lại</Button>
        <Button variant="destructive" @click="confirmDelete">Xoá vĩnh viễn</Button>
      </template>
    </Dialog>

    <!-- size="xl": an authoring surface living in a dialog — the panel widens,
         the width stays the primitive's decision. -->
    <Dialog
      v-model:open="wideOpen"
      size="xl"
      title="Soạn quy trình"
      description="Bề mặt authoring — size xl (64rem)."
    >
      <template #trigger><Button variant="outline">Mở editor (xl)</Button></template>
      <p class="text-sm text-muted-foreground">
        Form dài nhiều section sống thoải mái ở bề ngang này thay vì cuộn trong hộp confirm.
      </p>
      <template #footer>
        <Button variant="subtle" @click="wideOpen = false">Đóng</Button>
      </template>
    </Dialog>
  </div>
</template>
