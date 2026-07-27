import type { Meta, StoryObj } from "@storybook/vue3-vite";
import ToastStack from "./ToastStack.vue";
import ToastStackDemo from "./ToastStackDemo.vue";
import ToastStackDemoSource from "./ToastStackDemo.vue?raw";

const meta: Meta<typeof ToastStack> = {
  title: "Components/Blocks/ToastStack",
  component: ToastStack,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page) — same convention as every primitive/block.
  tags: ["!dev"],
};
export default meta;

/** Interactive queue demo — push one or several toasts; simultaneous ones stack with a gap. */
export const Demo: StoryObj = {
  render: () => ({ components: { ToastStackDemo }, template: "<ToastStackDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper —
  // the snippet is the actual usage and never drifts.
  parameters: { docs: { source: { code: ToastStackDemoSource, language: "vue" } } },
};
