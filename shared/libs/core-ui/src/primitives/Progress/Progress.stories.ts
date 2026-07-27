import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Progress from "./Progress.vue";
import ProgressDemo from "./ProgressDemo.vue";
import ProgressDemoSource from "./ProgressDemo.vue?raw";

const meta: Meta<typeof Progress> = {
  title: "Components/Primitives/Progress",
  component: Progress,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Progress>;

export const Default: Story = {
  args: { modelValue: 40, ariaLabel: "Đang tải" },
  render: (args) => ({
    components: { Progress },
    setup: () => ({ args }),
    template: '<Progress v-bind="args" />',
  }),
};

export const Complete: Story = {
  args: { modelValue: 100, ariaLabel: "Đang tải" },
  render: (args) => ({
    components: { Progress },
    setup: () => ({ args }),
    template: '<Progress v-bind="args" />',
  }),
};

export const Indeterminate: Story = {
  args: { modelValue: null, ariaLabel: "Đang tải" },
  render: (args) => ({
    components: { Progress },
    setup: () => ({ args }),
    template: '<Progress v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { ProgressDemo }, template: "<ProgressDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<ProgressDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: ProgressDemoSource, language: "vue" } } },
};
