import type { Meta, StoryObj } from "@storybook/vue3-vite";
import TextField from "./TextField.vue";
import TextFieldDemo from "./TextFieldDemo.vue";
import TextFieldDemoSource from "./TextFieldDemo.vue?raw";

const meta: Meta<typeof TextField> = {
  title: "Components/Primitives/TextField",
  component: TextField,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof TextField>;

export const Default: Story = {
  args: { modelValue: "", placeholder: "Nhập họ tên", ariaLabel: "Họ tên" },
  render: (args) => ({
    components: { TextField },
    setup: () => ({ args }),
    template: '<TextField v-bind="args" />',
  }),
};

export const Invalid: Story = {
  args: { modelValue: "not-an-email", invalid: true, ariaLabel: "Email" },
  render: (args) => ({
    components: { TextField },
    setup: () => ({ args }),
    template: '<TextField v-bind="args" />',
  }),
};

export const Disabled: Story = {
  args: { modelValue: "", disabled: true, placeholder: "Không thể nhập", ariaLabel: "Disabled" },
  render: (args) => ({
    components: { TextField },
    setup: () => ({ args }),
    template: '<TextField v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { TextFieldDemo }, template: "<TextFieldDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<TextFieldDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: TextFieldDemoSource, language: "vue" } } },
};
