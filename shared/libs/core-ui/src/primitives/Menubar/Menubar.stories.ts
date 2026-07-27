import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Menubar from "./Menubar.vue";
import type { MenubarMenu } from "./Menubar.vue";
import MenubarDemo from "./MenubarDemo.vue";
import MenubarDemoSource from "./MenubarDemo.vue?raw";

const meta: Meta<typeof Menubar> = {
  title: "Components/Primitives/Menubar",
  component: Menubar,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Menubar>;

const sampleMenus: MenubarMenu[] = [
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
      { separator: true, label: "" },
      { label: "Command Palette", command: "view.palette", shortcut: "Ctrl+K" },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { label: "Tài liệu", command: "help.docs" },
      { label: "Kiểm tra cập nhật (sắp có)", disabled: true },
    ],
  },
];

export const Default: Story = {
  args: { menus: sampleMenus },
  render: (args) => ({
    components: { Menubar },
    setup: () => ({ args }),
    template: '<Menubar v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { MenubarDemo }, template: "<MenubarDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<MenubarDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: MenubarDemoSource, language: "vue" } } },
};
