<script setup lang="ts">
import { ref } from "vue";
import ToastStack, { type ToastStackItem } from "./ToastStack.vue";
import Button from "../../primitives/Button/Button.vue";

// A miniature host queue — the real one lives host-side (e.g. a host app's
// toast.ts); the block only renders whatever the host says is visible.
let nextId = 1;
const items = ref<ToastStackItem[]>([]);

function push(variant: ToastStackItem["variant"], title: string, description?: string) {
  items.value = [...items.value, { id: nextId++, title, description, variant }].slice(-4);
}

function dismiss(id: string | number) {
  items.value = items.value.filter((item) => item.id !== id);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <Button variant="outline" size="sm" @click="push('success', 'Đã lưu quy trình', 'SEO tuần')">
      Toast success
    </Button>
    <Button variant="outline" size="sm" @click="push('info', 'Đã xóa thành viên', 'Biên kịch')">
      Toast info
    </Button>
    <Button
      variant="outline"
      size="sm"
      @click="
        push('success', 'Đã thêm thành viên', 'John');
        push('info', 'Đã cập nhật quy trình', 'SEO tuần');
      "
    >
      Hai toast cùng lúc — xếp chồng có gap
    </Button>

    <ToastStack :items="items" @dismiss="dismiss" />
  </div>
</template>
