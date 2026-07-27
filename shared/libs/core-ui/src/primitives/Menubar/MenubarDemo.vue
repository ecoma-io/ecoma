<script setup lang="ts">
import { ref } from "vue";
import Menubar from "./Menubar.vue";
import type { MenubarMenu } from "./Menubar.vue";

const last = ref<string>("—");

const menus: MenubarMenu[] = [
  {
    id: "file",
    label: "File",
    items: [
      { label: "Mở dự án…", command: "file.open", shortcut: "Ctrl+O" },
      { separator: true, label: "" },
      { label: "Cài đặt", command: "nav.settings", shortcut: "Ctrl+," },
      { separator: true, label: "" },
      { label: "Thoát", command: "app.quit" },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      { label: "Ẩn/hiện Sidebar", command: "view.sidebar", shortcut: "Ctrl+B" },
      { label: "Ẩn/hiện Panel", command: "view.panel", shortcut: "Ctrl+J" },
      { label: "Ẩn/hiện AI Chat", command: "view.ai", shortcut: "Ctrl+I" },
      { separator: true, label: "" },
      { label: "Command Palette", command: "view.palette", shortcut: "Ctrl+K" },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { label: "Tài liệu", command: "help.docs" },
      { label: "Giới thiệu Vider", command: "help.about" },
      { label: "Kiểm tra cập nhật (sắp có)", disabled: true },
    ],
  },
];
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="rounded-lg border border-border bg-card px-1.5 py-1">
      <Menubar :menus="menus" @select="last = $event" />
    </div>
    <div class="text-xs text-muted-foreground">
      Lệnh vừa chọn: <code class="tabular text-foreground">{{ last }}</code>
      <span class="ml-2">— bấm một menu; thử phím ↑ ↓ ← → · Esc.</span>
    </div>
  </div>
</template>
