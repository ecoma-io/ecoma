import type { Meta, StoryObj } from "@storybook/vue3-vite";
import WindowControls from "./WindowControls.vue";
import WindowControlsDemo from "./WindowControlsDemo.vue";
import WindowControlsDemoSource from "./WindowControlsDemo.vue?raw";

const meta: Meta<typeof WindowControls> = {
  title: "Components/Primitives/WindowControls",
  component: WindowControls,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof WindowControls>;

export const Default: Story = {
  args: { isMaximized: false },
  render: (args) => ({
    components: { WindowControls },
    setup: () => ({ args }),
    template: '<WindowControls v-bind="args" />',
  }),
};

export const Maximized: Story = {
  args: { isMaximized: true },
  render: (args) => ({
    components: { WindowControls },
    setup: () => ({ args }),
    template: '<WindowControls v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { WindowControlsDemo }, template: "<WindowControlsDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<WindowControlsDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: WindowControlsDemoSource, language: "vue" } } },
};
