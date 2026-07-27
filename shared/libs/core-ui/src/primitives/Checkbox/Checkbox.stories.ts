import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Checkbox from "./Checkbox.vue";
import CheckboxDemo from "./CheckboxDemo.vue";
import CheckboxDemoSource from "./CheckboxDemo.vue?raw";

const meta: Meta<typeof Checkbox> = {
  title: "Components/Primitives/Checkbox",
  component: Checkbox,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Checkbox>;

export const Default: Story = {
  args: { modelValue: false, label: "Ghi nhớ đăng nhập" },
  render: (args) => ({
    components: { Checkbox },
    setup: () => ({ args }),
    template: '<Checkbox v-bind="args" />',
  }),
};

export const Checked: Story = {
  args: { modelValue: true, label: "Đã chọn" },
  render: (args) => ({
    components: { Checkbox },
    setup: () => ({ args }),
    template: '<Checkbox v-bind="args" />',
  }),
};

export const Indeterminate: Story = {
  args: { modelValue: "indeterminate", label: "Chọn một phần" },
  render: (args) => ({
    components: { Checkbox },
    setup: () => ({ args }),
    template: '<Checkbox v-bind="args" />',
  }),
};

export const Disabled: Story = {
  args: { modelValue: true, disabled: true, label: "Vô hiệu hoá" },
  render: (args) => ({
    components: { Checkbox },
    setup: () => ({ args }),
    template: '<Checkbox v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { CheckboxDemo }, template: "<CheckboxDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<CheckboxDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: CheckboxDemoSource, language: "vue" } } },
};
