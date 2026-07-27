import type { Meta, StoryObj } from "@storybook/vue3-vite";
import TitleBar from "./TitleBar.vue";
import TitleBarDemo from "./TitleBarDemo.vue";
import TitleBarDemoSource from "./TitleBarDemo.vue?raw";
import type { MenubarMenu } from "../../primitives/Menubar/Menubar.vue";

/**
 * Component-level Storybook host for TitleBar — proves the a11y (WCAG/axe) gate
 * can live inside @ecoma-io/ui itself, independent of the docs Storybook.
 */
const meta: Meta<typeof TitleBar> = {
  title: "Components/Blocks/TitleBar",
  component: TitleBar,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof TitleBar>;

const sampleMenus: MenubarMenu[] = [
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

export const Default: Story = {
  args: { appName: "MyApp", title: "Untitled Project", menus: sampleMenus, isMaximized: false },
  render: (args) => ({
    components: { TitleBar },
    setup: () => ({ args }),
    template: '<TitleBar v-bind="args" />',
  }),
};

/** Gallery-style demo with a live drag-region mock — the page shown on the design doc (TitleBar.mdx). */
export const Demo: StoryObj = {
  render: () => ({ components: { TitleBarDemo }, template: "<TitleBarDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<TitleBarDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: TitleBarDemoSource, language: "vue" } } },
};
