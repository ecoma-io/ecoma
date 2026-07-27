<script setup lang="ts">
import { Plus, SlidersHorizontal } from "@lucide/vue";
import PageHeader from "./PageHeader.vue";
import Button from "../../primitives/Button/Button.vue";
import Surface from "../../primitives/Surface/Surface.vue";

/** Enough rows to scroll under the band — the pinning is the point of the demo. */
const rows = ["Bản tin video", "Dọn kho mã", "Bài blog theo từ khoá", "Tổng hợp bình luận"];
</script>

<template>
  <!-- The scroll container the header pins against. A surface owns its own
       scrolling so the band stays put while only the work area moves. -->
  <div class="h-80 overflow-y-auto rounded-lg border border-border bg-background">
    <PageHeader
      title="Quy trình"
      :count="12"
      description="Quy trình đã dựng — chạy, theo dõi, và duyệt khi cần người."
    >
      <template #actions>
        <Button variant="outline" size="sm">
          <SlidersHorizontal aria-hidden="true" />
          Bộ lọc
        </Button>
        <Button size="sm">
          <Plus aria-hidden="true" />
          Tạo quy trình
        </Button>
      </template>
    </PageHeader>
    <div class="flex flex-col gap-2 p-6">
      <Surface v-for="(row, i) in [...rows, ...rows, ...rows]" :key="i" pad="sm">
        <p class="text-body text-foreground">{{ row }}</p>
      </Surface>
    </div>
  </div>
</template>
