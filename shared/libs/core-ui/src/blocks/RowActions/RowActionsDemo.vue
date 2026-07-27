<script setup lang="ts">
import { Eye, Pencil, Trash2 } from "@lucide/vue";
import RowActions from "./RowActions.vue";
import Button from "../../primitives/Button/Button.vue";
import Surface from "../../primitives/Surface/Surface.vue";

const rows = [
  { name: "Dựng bản tin video hằng ngày", meta: "2 bước · cron mỗi 60 phút" },
  { name: "Dọn kho mã hằng tuần", meta: "1 bước · thủ công" },
  { name: "Viết bài blog theo từ khoá", meta: "3 bước · webhook" },
];
</script>

<template>
  <div class="flex flex-col gap-3">
    <Surface pad="none" class="overflow-hidden">
      <ul class="divide-y divide-border">
        <!-- `group` on the ROW is what scopes the reveal — without it every
             row's actions would light up at once. -->
        <li v-for="row in rows" :key="row.name" class="group flex items-center gap-3 px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-body font-medium text-foreground">{{ row.name }}</p>
            <p class="truncate text-small text-muted-foreground">{{ row.meta }}</p>
          </div>
          <RowActions>
            <Button size="icon-sm" variant="ghost" :aria-label="`Chi tiết ${row.name}`">
              <Eye />
            </Button>
            <Button size="icon-sm" variant="ghost" :aria-label="`Sửa ${row.name}`">
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              class="hover:bg-destructive/10 hover:text-destructive"
              :aria-label="`Xóa ${row.name}`"
            >
              <Trash2 />
            </Button>
          </RowActions>
          <Button size="sm" variant="outline">Chạy</Button>
        </li>
      </ul>
    </Surface>
    <p class="text-small text-muted-foreground">
      Trỏ chuột vào một hàng để thấy nhóm hành động hiện ra — hoặc bấm Tab vào hàng đó, vì cùng một
      cú lộ diện chạy theo <code class="font-mono text-micro">focus-within</code>.
    </p>
  </div>
</template>
