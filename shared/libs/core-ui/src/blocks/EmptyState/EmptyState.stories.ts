import type { Meta, StoryObj } from "@storybook/vue3-vite";
import EmptyState from "./EmptyState.vue";
import EmptyStateDemo from "./EmptyStateDemo.vue";
import EmptyStateDemoSource from "./EmptyStateDemo.vue?raw";

/**
 * Component-level Storybook host for EmptyState — proves the a11y (WCAG/axe)
 * gate can live inside @ecoma-io/ui itself, independent of the docs Storybook.
 */
const meta: Meta<typeof EmptyState> = {
  title: "Components/Blocks/EmptyState",
  component: EmptyState,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {
  args: { title: "Chưa có mục nào", description: "Mọi thứ bạn tạo sẽ xuất hiện ở đây." },
  render: (args) => ({
    components: { EmptyState },
    setup: () => ({ args }),
    template: '<EmptyState v-bind="args" />',
  }),
};

/** Gallery with icon + CTA and a replay control — the page shown on EmptyState.mdx. */
export const Demo: StoryObj = {
  render: () => ({ components: { EmptyStateDemo }, template: "<EmptyStateDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<EmptyStateDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: EmptyStateDemoSource, language: "vue" } } },
};
