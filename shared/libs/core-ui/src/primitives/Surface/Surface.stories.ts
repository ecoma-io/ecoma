import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Surface from "./Surface.vue";
import SurfaceDemo from "./SurfaceDemo.vue";
import SurfaceDemoSource from "./SurfaceDemo.vue?raw";

const meta: Meta<typeof Surface> = {
  title: "Components/Primitives/Surface",
  component: Surface,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Surface>;

export const Default: Story = {
  args: { variant: "card", pad: "md" },
  render: (args) => ({
    components: { Surface },
    setup: () => ({ args }),
    template: '<Surface v-bind="args">Panel content</Surface>',
  }),
};

export const Overlay: Story = {
  args: { variant: "overlay", pad: "md" },
  render: (args) => ({
    components: { Surface },
    setup: () => ({ args }),
    template: '<Surface v-bind="args">Floating menu / popover</Surface>',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SurfaceDemo }, template: "<SurfaceDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SurfaceDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SurfaceDemoSource, language: "vue" } } },
};
