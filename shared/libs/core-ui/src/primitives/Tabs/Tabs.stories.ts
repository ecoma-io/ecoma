import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Tabs from "./Tabs.vue";
import TabsDemo from "./TabsDemo.vue";
import TabsDemoSource from "./TabsDemo.vue?raw";

const meta: Meta<typeof Tabs> = {
  title: "Components/Primitives/Tabs",
  component: Tabs,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Tabs>;

const tabs = [
  { value: "overview", label: "Tổng quan" },
  { value: "activity", label: "Hoạt động" },
  { value: "settings", label: "Cài đặt", disabled: true },
];

export const Default: Story = {
  args: { modelValue: "overview", tabs },
  render: (args) => ({
    components: { Tabs },
    setup: () => ({ args }),
    template: `
      <Tabs v-bind="args">
        <template #overview>Nội dung tổng quan.</template>
        <template #activity>Nội dung hoạt động.</template>
        <template #settings>Nội dung cài đặt.</template>
      </Tabs>
    `,
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { TabsDemo }, template: "<TabsDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<TabsDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: TabsDemoSource, language: "vue" } } },
};
