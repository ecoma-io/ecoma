import type { Meta, StoryObj } from "@storybook/vue3-vite";
import DashboardGrid from "./DashboardGrid.vue";
import DashboardGridDemo from "./DashboardGridDemo.vue";
import DashboardGridDemoSource from "./DashboardGridDemo.vue?raw";

const meta: Meta<typeof DashboardGrid> = {
  title: "Components/Blocks/DashboardGrid",
  component: DashboardGrid,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page) — they still render inside the MDX and still
  // run in the a11y/vitest pass.
  tags: ["!dev"],
};
export default meta;

/** A KPI row plus two wider panels — the page shown on DashboardGrid.mdx. */
export const Demo: StoryObj = {
  render: () => ({ components: { DashboardGridDemo }, template: "<DashboardGridDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper.
  parameters: { docs: { source: { code: DashboardGridDemoSource, language: "vue" } } },
};
