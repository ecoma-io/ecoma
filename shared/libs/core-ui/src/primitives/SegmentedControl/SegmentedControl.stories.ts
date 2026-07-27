import type { Meta, StoryObj } from "@storybook/vue3-vite";
import SegmentedControl from "./SegmentedControl.vue";
import SegmentedControlDemo from "./SegmentedControlDemo.vue";
import SegmentedControlDemoSource from "./SegmentedControlDemo.vue?raw";

const meta: Meta<typeof SegmentedControl> = {
  title: "Components/Primitives/SegmentedControl",
  component: SegmentedControl,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof SegmentedControl>;

const themeOptions = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Sáng" },
  { value: "dark", label: "Tối" },
];

export const Default: Story = {
  args: { modelValue: "system", options: themeOptions, size: "default" },
  render: (args) => ({
    components: { SegmentedControl },
    setup: () => ({ args }),
    template: '<SegmentedControl v-bind="args" />',
  }),
};

export const Small: Story = {
  args: { modelValue: "system", options: themeOptions, size: "sm" },
  render: (args) => ({
    components: { SegmentedControl },
    setup: () => ({ args }),
    template: '<SegmentedControl v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SegmentedControlDemo }, template: "<SegmentedControlDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SegmentedControlDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SegmentedControlDemoSource, language: "vue" } } },
};
