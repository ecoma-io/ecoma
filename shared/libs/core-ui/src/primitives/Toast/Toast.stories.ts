import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Toast from "./Toast.vue";
import ToastDemo from "./ToastDemo.vue";
import ToastDemoSource from "./ToastDemo.vue?raw";

const meta: Meta<typeof Toast> = {
  title: "Components/Primitives/Toast",
  component: Toast,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Toast>;

/** Rendered open so the a11y ("test") pass exercises the notification, not an empty viewport. */
export const Open: Story = {
  args: {
    open: true,
    variant: "success",
    title: "Đã lưu composition",
    description: "Bản nháp được đồng bộ lúc 14:32.",
    actionLabel: "Hoàn tác",
    // Effectively no auto-dismiss during the render-only a11y pass.
    duration: 1000000,
  },
  render: (args) => ({
    components: { Toast },
    setup: () => ({ args }),
    template: '<Toast v-bind="args" />',
  }),
  // Reka's Toast renders sr-only focus proxies (`aria-hidden` + `tabindex="0"`)
  // around the viewport for its F6 focus-hotkey — an intentional library
  // pattern that axe's `aria-hidden-focus` flags. Scoped off here (the WCAG
  // rule set otherwise runs) since the finding is reka's internal focus
  // management, not this component's markup.
  parameters: {
    a11y: { options: { rules: { "aria-hidden-focus": { enabled: false } } } },
  },
};

export const Demo: StoryObj = {
  render: () => ({ components: { ToastDemo }, template: "<ToastDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<ToastDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: ToastDemoSource, language: "vue" } } },
};
