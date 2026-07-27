import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Field from "./Field.vue";
import TextField from "../TextField/TextField.vue";
import FieldDemo from "./FieldDemo.vue";
import FieldDemoSource from "./FieldDemo.vue?raw";

const meta: Meta<typeof Field> = {
  title: "Components/Primitives/Field",
  component: Field,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Field>;

export const Default: Story = {
  args: { label: "Họ tên", for: "field-story-name", hint: "Tên hiển thị công khai" },
  render: (args) => ({
    components: { Field, TextField },
    setup: () => ({ args }),
    template:
      '<Field v-bind="args"><TextField id="field-story-name" placeholder="Nhập họ tên" /></Field>',
  }),
};

export const WithError: Story = {
  args: {
    label: "Email",
    for: "field-story-email",
    error: "Email không đúng định dạng",
    required: true,
  },
  render: (args) => ({
    components: { Field, TextField },
    setup: () => ({ args }),
    template:
      '<Field v-bind="args"><TextField id="field-story-email" type="email" invalid placeholder="you@example.com" /></Field>',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { FieldDemo }, template: "<FieldDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<FieldDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: FieldDemoSource, language: "vue" } } },
};
