import type { Meta, StoryObj } from "@storybook/vue3-vite";
import PageHeader from "./PageHeader.vue";
import PageHeaderDemo from "./PageHeaderDemo.vue";
import PageHeaderDemoSource from "./PageHeaderDemo.vue?raw";

const meta: Meta<typeof PageHeader> = {
  title: "Components/Blocks/PageHeader",
  component: PageHeader,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page) — they still render inside the MDX and still
  // run in the a11y/vitest pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof PageHeader>;

export const Default: Story = {
  args: {
    title: "Thành viên",
    count: 3,
    description: "Người dùng và persona AI cùng đứng trong một danh sách.",
  },
  render: (args) => ({
    components: { PageHeader },
    setup: () => ({ args }),
    template: '<PageHeader v-bind="args" />',
  }),
};

/** Pinned over a scrolling work area, with the surface's actions — the page shown on PageHeader.mdx. */
export const Demo: StoryObj = {
  render: () => ({ components: { PageHeaderDemo }, template: "<PageHeaderDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper.
  parameters: { docs: { source: { code: PageHeaderDemoSource, language: "vue" } } },
};
