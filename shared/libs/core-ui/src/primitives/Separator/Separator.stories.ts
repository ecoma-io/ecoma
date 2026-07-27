import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Separator from "./Separator.vue";
import SeparatorDemo from "./SeparatorDemo.vue";
import SeparatorDemoSource from "./SeparatorDemo.vue?raw";

const meta: Meta<typeof Separator> = {
  title: "Components/Primitives/Separator",
  component: Separator,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Separator>;

export const Default: Story = {
  args: { orientation: "horizontal" },
  render: (args) => ({
    components: { Separator },
    setup: () => ({ args }),
    template: '<Separator v-bind="args" />',
  }),
};

export const Vertical: Story = {
  args: { orientation: "vertical" },
  render: (args) => ({
    components: { Separator },
    setup: () => ({ args }),
    template: '<div class="flex h-8 items-center"><Separator v-bind="args" /></div>',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SeparatorDemo }, template: "<SeparatorDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SeparatorDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SeparatorDemoSource, language: "vue" } } },
};
