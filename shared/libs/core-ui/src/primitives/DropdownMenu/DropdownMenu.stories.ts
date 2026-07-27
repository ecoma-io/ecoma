import type { Meta, StoryObj } from "@storybook/vue3-vite";
import DropdownMenu from "./DropdownMenu.vue";
import Button from "../Button/Button.vue";
import DropdownMenuDemo from "./DropdownMenuDemo.vue";
import DropdownMenuDemoSource from "./DropdownMenuDemo.vue?raw";

const meta: Meta<typeof DropdownMenu> = {
  title: "Components/Primitives/DropdownMenu",
  component: DropdownMenu,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof DropdownMenu>;

const items = [
  { heading: true, label: "Scene" },
  { label: "Nhân bản", value: "duplicate", shortcut: "⌘D" },
  { separator: true },
  { label: "Không khả dụng", value: "noop", disabled: true },
  { label: "Xoá", value: "delete", danger: true },
];

/** Rendered open so the a11y ("test") pass exercises the menu items, not just the trigger. */
export const Open: Story = {
  args: { items, open: true },
  render: (args) => ({
    components: { DropdownMenu, Button },
    setup: () => ({ args }),
    template: `
      <div style="padding: 1rem 8rem 12rem 1rem;">
        <DropdownMenu v-bind="args">
          <template #trigger><Button variant="outline">Thao tác</Button></template>
        </DropdownMenu>
      </div>
    `,
  }),
  // A modal Reka menu marks the background (the story root that still holds the
  // focusable trigger) `aria-hidden` while focus is trapped in the open menu —
  // intentional focus-containment that axe's `aria-hidden-focus` flags. Scoped
  // off here (the rest of the WCAG rule set still runs) since the finding is
  // reka's focus management, not this component's markup.
  parameters: {
    a11y: { options: { rules: { "aria-hidden-focus": { enabled: false } } } },
  },
};

export const Demo: StoryObj = {
  render: () => ({ components: { DropdownMenuDemo }, template: "<DropdownMenuDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<DropdownMenuDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: DropdownMenuDemoSource, language: "vue" } } },
};
