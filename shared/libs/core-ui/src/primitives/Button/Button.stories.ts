import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Button from "./Button.vue";
import ButtonDemo from "./ButtonDemo.vue";
import ButtonDemoSource from "./ButtonDemo.vue?raw";

/**
 * Component-level Storybook host for Button — proves the a11y (WCAG/axe) gate
 * can live inside @ecoma-io/ui itself, independent of the docs Storybook.
 */
const meta: Meta<typeof Button> = {
  title: "Components/Primitives/Button",
  component: Button,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: { variant: "primary", size: "md" },
  render: (args) => ({
    components: { Button },
    setup: () => ({ args }),
    template: '<Button v-bind="args">Save</Button>',
  }),
};

export const Loading: Story = {
  args: { variant: "primary", size: "md", loading: true, loadingText: "Đang lưu…" },
  render: (args) => ({
    components: { Button },
    setup: () => ({ args }),
    template: '<Button v-bind="args">Save</Button>',
  }),
};

export const Disabled: Story = {
  args: { variant: "primary", size: "md", disabled: true },
  render: (args) => ({
    components: { Button },
    setup: () => ({ args }),
    template: '<Button v-bind="args">Save</Button>',
  }),
};

/** Gallery of every variant/size side by side — the page shown on the design doc (Button.mdx). */
export const Demo: StoryObj = {
  render: () => ({ components: { ButtonDemo }, template: "<ButtonDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<ButtonDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: ButtonDemoSource, language: "vue" } } },
};
