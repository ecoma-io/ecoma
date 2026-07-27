<script setup lang="ts">
import { ref } from "vue";
import TitleBar from "./TitleBar.vue";
import type { MenubarMenu } from "../../primitives/Menubar/Menubar.vue";

const isMaximized = ref(false);
const last = ref("—");

const menus: MenubarMenu[] = [
  {
    id: "file",
    label: "File",
    items: [
      { label: "Mở dự án…", command: "file.open", shortcut: "Ctrl+O" },
      { separator: true, label: "" },
      { label: "Cài đặt", command: "nav.settings" },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      { label: "Ẩn/hiện Sidebar", command: "view.sidebar", shortcut: "Ctrl+B" },
      { label: "Command Palette", command: "view.palette", shortcut: "Ctrl+K" },
    ],
  },
  { id: "help", label: "Help", items: [{ label: "Giới thiệu", command: "help.about" }] },
];
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- rounded/overflow-hidden so the bar reads as the top of a window -->
    <div class="overflow-hidden rounded-lg border border-border shadow-sm">
      <TitleBar
        app-name="MyApp"
        title="teaser-ra-mat.mp4 — Dự án Demo"
        :menus="menus"
        :is-maximized="isMaximized"
        @select="last = $event"
        @minimize="last = 'window.minimize'"
        @maximize="((isMaximized = !isMaximized), (last = 'window.maximize'))"
        @close="last = 'window.close'"
      />
      <div class="grid h-24 place-items-center bg-background text-xs text-muted-foreground">
        (thân ứng dụng)
      </div>
    </div>
    <div class="text-xs text-muted-foreground">
      Sự kiện gần nhất: <code class="tabular text-foreground">{{ last }}</code>
    </div>
  </div>
</template>
