import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Badge from "./Badge.vue";
import BadgeDemo from "./BadgeDemo.vue";
import BadgeDemoSource from "./BadgeDemo.vue?raw";

const meta: Meta<typeof Badge> = {
  title: "Components/Primitives/Badge",
  component: Badge,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Badge>;

export const Default: Story = {
  args: { variant: "neutral" },
  render: (args) => ({
    components: { Badge },
    setup: () => ({ args }),
    template: '<Badge v-bind="args">neutral</Badge>',
  }),
};

export const Ai: Story = {
  args: { variant: "ai" },
  render: (args) => ({
    components: { Badge },
    setup: () => ({ args }),
    template: '<Badge v-bind="args">✦ AI</Badge>',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { BadgeDemo }, template: "<BadgeDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<BadgeDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: BadgeDemoSource, language: "vue" } } },
};
