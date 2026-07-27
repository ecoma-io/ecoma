import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Popover from "./Popover.vue";
import Button from "../Button/Button.vue";
import PopoverDemo from "./PopoverDemo.vue";
import PopoverDemoSource from "./PopoverDemo.vue?raw";

const meta: Meta<typeof Popover> = {
  title: "Components/Primitives/Popover",
  component: Popover,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Popover>;

/** Rendered open so the a11y ("test") pass exercises the panel, not just the trigger. */
export const Open: Story = {
  args: { open: true },
  render: (args) => ({
    components: { Popover, Button },
    setup: () => ({ args }),
    template: `
      <div style="padding: 6rem 4rem;">
        <Popover v-bind="args">
          <template #trigger><Button variant="outline">Bộ lọc</Button></template>
          <div class="text-sm">Nội dung popover</div>
        </Popover>
      </div>
    `,
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { PopoverDemo }, template: "<PopoverDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<PopoverDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: PopoverDemoSource, language: "vue" } } },
};
