import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Select from "./Select.vue";
import SelectDemo from "./SelectDemo.vue";
import SelectDemoSource from "./SelectDemo.vue?raw";

const meta: Meta<typeof Select> = {
  title: "Components/Primitives/Select",
  component: Select,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Select>;

const options = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

export const Default: Story = {
  args: { modelValue: "en", options, placeholder: "Chọn ngôn ngữ" },
  render: (args) => ({
    components: { Select },
    setup: () => ({ args }),
    template: '<Select v-bind="args" aria-label="Ngôn ngữ" />',
  }),
};

export const Disabled: Story = {
  args: {
    modelValue: "en",
    options,
    placeholder: "Chọn ngôn ngữ",
    disabled: true,
  },
  render: (args) => ({
    components: { Select },
    setup: () => ({ args }),
    template: '<Select v-bind="args" aria-label="Ngôn ngữ" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SelectDemo }, template: "<SelectDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SelectDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SelectDemoSource, language: "vue" } } },
};
