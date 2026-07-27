import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Tooltip from "./Tooltip.vue";
import Button from "../Button/Button.vue";
import TooltipDemo from "./TooltipDemo.vue";
import TooltipDemoSource from "./TooltipDemo.vue?raw";

const meta: Meta<typeof Tooltip> = {
  title: "Components/Primitives/Tooltip",
  component: Tooltip,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Tooltip>;

/** Rendered open so the a11y ("test") pass exercises the tip content, not just the trigger. */
export const Open: Story = {
  args: { content: "Cắt clip tại playhead", open: true, side: "bottom" },
  render: (args) => ({
    components: { Tooltip, Button },
    setup: () => ({ args }),
    template: `
      <div style="padding: 4rem;">
        <Tooltip v-bind="args">
          <template #trigger><Button variant="subtle">Cắt</Button></template>
        </Tooltip>
      </div>
    `,
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { TooltipDemo }, template: "<TooltipDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<TooltipDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: TooltipDemoSource, language: "vue" } } },
};
