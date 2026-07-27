import type { Meta, StoryObj } from "@storybook/vue3-vite";
import RowActions from "./RowActions.vue";
import RowActionsDemo from "./RowActionsDemo.vue";
import RowActionsDemoSource from "./RowActionsDemo.vue?raw";

const meta: Meta<typeof RowActions> = {
  title: "Components/Blocks/RowActions",
  component: RowActions,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page) — they still render inside the MDX and still
  // run in the a11y/vitest pass.
  tags: ["!dev"],
};
export default meta;

/** A hairline-divided list whose row actions stay quiet until hover or focus — the page shown on RowActions.mdx. */
export const Demo: StoryObj = {
  render: () => ({ components: { RowActionsDemo }, template: "<RowActionsDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper.
  parameters: { docs: { source: { code: RowActionsDemoSource, language: "vue" } } },
};
