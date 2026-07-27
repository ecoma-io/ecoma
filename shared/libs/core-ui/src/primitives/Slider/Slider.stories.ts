import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Slider from "./Slider.vue";
import SliderDemo from "./SliderDemo.vue";
import SliderDemoSource from "./SliderDemo.vue?raw";

const meta: Meta<typeof Slider> = {
  title: "Components/Primitives/Slider",
  component: Slider,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Slider>;

export const Default: Story = {
  args: { modelValue: 0.65, min: 0, max: 1, step: 0.01, disabled: false },
  render: (args) => ({
    components: { Slider },
    setup: () => ({ args }),
    template: '<Slider v-bind="args" aria-label="Opacity" />',
  }),
};

export const Disabled: Story = {
  args: { modelValue: 0.3, min: 0, max: 1, step: 0.01, disabled: true },
  render: (args) => ({
    components: { Slider },
    setup: () => ({ args }),
    template: '<Slider v-bind="args" aria-label="Opacity" />',
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { SliderDemo }, template: "<SliderDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<SliderDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: SliderDemoSource, language: "vue" } } },
};
