import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Textarea from "./Textarea.vue";
import TextareaDemo from "./TextareaDemo.vue";
import TextareaDemoSource from "./TextareaDemo.vue?raw";

const meta: Meta<typeof Textarea> = {
  title: "Components/Primitives/Textarea",
  component: Textarea,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Textarea>;

export const Default: Story = {
  args: { modelValue: "", placeholder: "Giới thiệu bản thân", ariaLabel: "Giới thiệu" },
  render: (args) => ({
    components: { Textarea },
    setup: () => ({ args }),
    template: '<Textarea v-bind="args" />',
  }),
};

export const Invalid: Story = {
  args: { modelValue: "thiếu dấu chấm câu", invalid: true, ariaLabel: "Phản hồi" },
  render: (args) => ({
    components: { Textarea },
    setup: () => ({ args }),
    template: '<Textarea v-bind="args" />',
  }),
};

export const Disabled: Story = {
  args: { modelValue: "", disabled: true, placeholder: "Không thể nhập", ariaLabel: "Disabled" },
  render: (args) => ({
    components: { Textarea },
    setup: () => ({ args }),
    template: '<Textarea v-bind="args" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { TextareaDemo }, template: "<TextareaDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<TextareaDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: TextareaDemoSource, language: "vue" } } },
};
