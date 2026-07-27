import type { Meta, StoryObj } from "@storybook/vue3-vite";
import AppHeader from "./AppHeader.vue";
import AppHeaderDemo from "./AppHeaderDemo.vue";
import AppHeaderDemoSource from "./AppHeaderDemo.vue?raw";

const meta: Meta<typeof AppHeader> = {
  title: "Components/Blocks/AppHeader",
  component: AppHeader,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page) — they still render inside the MDX and still
  // run in the a11y/vitest pass.
  tags: ["!dev"],
};
export default meta;

/** Pinned over a scrolling app shell, with brand, search, and the trailing account cluster — the page shown on AppHeader.mdx. */
export const Demo: StoryObj = {
  render: () => ({ components: { AppHeaderDemo }, template: "<AppHeaderDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper.
  parameters: { docs: { source: { code: AppHeaderDemoSource, language: "vue" } } },
};
