import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Skeleton from "./Skeleton.vue";
import SkeletonDemo from "./SkeletonDemo.vue";
import SkeletonDemoSource from "./SkeletonDemo.vue?raw";

const meta: Meta<typeof Skeleton> = {
  title: "Components/Primitives/Skeleton",
  component: Skeleton,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Skeleton>;

export const Default: Story = {
  args: { variant: "text" },
  render: (args) => ({
    components: { Skeleton },
    setup: () => ({ args }),
    template: '<Skeleton v-bind="args" class="w-32" />',
  }),
};

export const Circle: Story = {
  args: { variant: "circle" },
  render: (args) => ({
    components: { Skeleton },
    setup: () => ({ args }),
    template: '<Skeleton v-bind="args" class="h-10 w-10" />',
  }),
};

export const Rect: Story = {
  args: { variant: "rect" },
  render: (args) => ({
    components: { Skeleton },
    setup: () => ({ args }),
    template: '<Skeleton v-bind="args" class="h-24 w-40" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SkeletonDemo }, template: "<SkeletonDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SkeletonDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SkeletonDemoSource, language: "vue" } } },
};
