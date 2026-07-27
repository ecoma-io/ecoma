import type { Meta, StoryObj } from "@storybook/vue3-vite";
import RadioGroup from "./RadioGroup.vue";
import RadioGroupDemo from "./RadioGroupDemo.vue";
import RadioGroupDemoSource from "./RadioGroupDemo.vue?raw";

const meta: Meta<typeof RadioGroup> = {
  title: "Components/Primitives/RadioGroup",
  component: RadioGroup,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof RadioGroup>;

export const Default: Story = {
  args: {
    modelValue: "pro",
    options: [
      { value: "free", label: "Miễn phí" },
      { value: "pro", label: "Pro" },
      { value: "enterprise", label: "Enterprise" },
    ],
  },
  render: (args) => ({
    components: { RadioGroup },
    setup: () => ({ args }),
    template: '<RadioGroup v-bind="args" />',
  }),
};

export const Disabled: Story = {
  args: {
    modelValue: "pro",
    disabled: true,
    options: [
      { value: "free", label: "Miễn phí" },
      { value: "pro", label: "Pro" },
    ],
  },
  render: (args) => ({
    components: { RadioGroup },
    setup: () => ({ args }),
    template: '<RadioGroup v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { RadioGroupDemo }, template: "<RadioGroupDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<RadioGroupDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: RadioGroupDemoSource, language: "vue" } } },
};
