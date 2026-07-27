<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown } from "@lucide/vue";
import DropdownMenu, { type DropdownMenuEntry } from "./DropdownMenu.vue";
import Button from "../Button/Button.vue";

const last = ref<string>("—");

const items: DropdownMenuEntry[] = [
  { heading: true, label: "Scene" },
  { label: "Nhân bản", value: "duplicate", shortcut: "⌘D" },
  { label: "Đổi tên", value: "rename", shortcut: "F2" },
  { separator: true },
  { label: "Xuất video", value: "export" },
  { label: "Không khả dụng", value: "noop", disabled: true },
  { separator: true },
  { label: "Xoá scene", value: "delete", danger: true, shortcut: "⌫" },
];

function onSelect(value: string) {
  last.value = value;
}
</script>

<template>
  <div class="flex flex-col items-start gap-3">
    <DropdownMenu :items="items" @select="onSelect">
      <template #trigger>
        <Button variant="outline">
          Thao tác
          <ChevronDown class="h-4 w-4" />
        </Button>
      </template>
    </DropdownMenu>
    <p class="text-xs text-muted-foreground">Lệnh vừa chọn: {{ last }}</p>
  </div>
</template>
