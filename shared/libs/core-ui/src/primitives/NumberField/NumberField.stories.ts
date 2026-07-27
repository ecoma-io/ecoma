import type { Meta, StoryObj } from "@storybook/vue3-vite";
import NumberField from "./NumberField.vue";
import NumberFieldDemo from "./NumberFieldDemo.vue";
import NumberFieldDemoSource from "./NumberFieldDemo.vue?raw";

/**
 * Component-level Storybook host for NumberField — proves the a11y (WCAG/axe)
 * gate can live inside @ecoma-io/ui itself, independent of the docs Storybook.
 */
const meta: Meta<typeof NumberField> = {
  title: "Components/Primitives/NumberField",
  component: NumberField,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof NumberField>;

export const Default: Story = {
  args: { modelValue: 120, unit: "px" },
  render: (args) => ({
    components: { NumberField },
    setup: () => ({ args }),
    template: '<NumberField v-bind="args" aria-label="Width" />',
  }),
};

export const Disabled: Story = {
  args: { modelValue: 50, unit: "px", disabled: true },
  render: (args) => ({
    components: { NumberField },
    setup: () => ({ args }),
    template: '<NumberField v-bind="args" aria-label="Width" />',
  }),
};

/** Gallery of every state side by side — the page shown on the design doc (NumberField.mdx). */
export const Demo: StoryObj = {
  render: () => ({ components: { NumberFieldDemo }, template: "<NumberFieldDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<NumberFieldDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: NumberFieldDemoSource, language: "vue" } } },
};
