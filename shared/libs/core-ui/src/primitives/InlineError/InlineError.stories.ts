import type { Meta, StoryObj } from "@storybook/vue3-vite";
import InlineError from "./InlineError.vue";
import InlineErrorDemo from "./InlineErrorDemo.vue";
import InlineErrorDemoSource from "./InlineErrorDemo.vue?raw";

const meta: Meta<typeof InlineError> = {
  title: "Components/Primitives/InlineError",
  component: InlineError,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof InlineError>;

export const Default: Story = {
  args: { message: "This folder isn't a Vider project. It may have moved or been deleted." },
  render: (args) => ({
    components: { InlineError },
    setup: () => ({ args }),
    template: '<InlineError v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { InlineErrorDemo }, template: "<InlineErrorDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<InlineErrorDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: InlineErrorDemoSource, language: "vue" } } },
};
