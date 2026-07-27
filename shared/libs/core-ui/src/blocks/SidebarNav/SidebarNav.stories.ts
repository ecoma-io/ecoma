import type { Meta, StoryObj } from "@storybook/vue3-vite";
import SidebarNav from "./SidebarNav.vue";
import SidebarNavDemo from "./SidebarNavDemo.vue";
import SidebarNavDemoSource from "./SidebarNavDemo.vue?raw";

const meta: Meta<typeof SidebarNav> = {
  title: "Components/Blocks/SidebarNav",
  component: SidebarNav,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page) — they still render inside the MDX and still
  // run in the a11y/vitest pass.
  tags: ["!dev"],
};
export default meta;

/** Sections + a collapse toggle, framed as the operator console's own rail — the page shown on SidebarNav.mdx. */
export const Demo: StoryObj = {
  render: () => ({ components: { SidebarNavDemo }, template: "<SidebarNavDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper.
  parameters: { docs: { source: { code: SidebarNavDemoSource, language: "vue" } } },
};
