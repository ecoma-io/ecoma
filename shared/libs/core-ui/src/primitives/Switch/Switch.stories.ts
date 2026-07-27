import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Switch from "./Switch.vue";
import SwitchDemo from "./SwitchDemo.vue";
import SwitchDemoSource from "./SwitchDemo.vue?raw";

const meta: Meta<typeof Switch> = {
  title: "Components/Primitives/Switch",
  component: Switch,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Switch>;

export const Default: Story = {
  args: { modelValue: false },
  render: (args) => ({
    components: { Switch },
    setup: () => ({ args }),
    template: '<Switch v-bind="args" aria-label="Gửi telemetry ẩn danh" />',
  }),
};

export const Checked: Story = {
  args: { modelValue: true },
  render: (args) => ({
    components: { Switch },
    setup: () => ({ args }),
    template: '<Switch v-bind="args" aria-label="Gửi telemetry ẩn danh" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SwitchDemo }, template: "<SwitchDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SwitchDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SwitchDemoSource, language: "vue" } } },
};
