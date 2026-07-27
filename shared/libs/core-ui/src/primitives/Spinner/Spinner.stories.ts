import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Spinner from "./Spinner.vue";
import SpinnerDemo from "./SpinnerDemo.vue";
import SpinnerDemoSource from "./SpinnerDemo.vue?raw";

const meta: Meta<typeof Spinner> = {
  title: "Components/Primitives/Spinner",
  component: Spinner,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Spinner>;

export const Default: Story = {
  args: { size: "md", label: "Đang tải" },
  render: (args) => ({
    components: { Spinner },
    setup: () => ({ args }),
    template: '<Spinner v-bind="args" />',
  }),
};

export const Small: Story = {
  args: { size: "sm", label: "Đang tải" },
  render: (args) => ({
    components: { Spinner },
    setup: () => ({ args }),
    template: '<Spinner v-bind="args" />',
  }),
};

export const Large: Story = {
  args: { size: "lg", label: "Đang tải" },
  render: (args) => ({
    components: { Spinner },
    setup: () => ({ args }),
    template: '<Spinner v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SpinnerDemo }, template: "<SpinnerDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SpinnerDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SpinnerDemoSource, language: "vue" } } },
};
