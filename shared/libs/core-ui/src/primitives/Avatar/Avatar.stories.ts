import type { Meta, StoryObj } from "@storybook/vue3-vite";
import Avatar from "./Avatar.vue";
import AvatarDemo from "./AvatarDemo.vue";
import AvatarDemoSource from "./AvatarDemo.vue?raw";

const meta: Meta<typeof Avatar> = {
  title: "Components/Primitives/Avatar",
  component: Avatar,
  // Hide example stories from the sidebar so this component surfaces as a
  // single leaf (its Docs page). "!dev" removes them from the sidebar only —
  // they still render inside the MDX via <Canvas of={…}> and still run in the
  // a11y/vitest ("test") pass.
  tags: ["!dev"],
};
export default meta;

type Story = StoryObj<typeof Avatar>;

export const Default: Story = {
  args: { fallback: "AL", alt: "Ada Lovelace" },
  render: (args) => ({
    components: { Avatar },
    setup: () => ({ args }),
    template: '<Avatar v-bind="args" />',
  }),
};

export const WithImage: Story = {
  args: {
    src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23e85d3f'/%3E%3C/svg%3E",
    alt: "Ada Lovelace",
    fallback: "AL",
  },
  render: (args) => ({
    components: { Avatar },
    setup: () => ({ args }),
    template: '<Avatar v-bind="args" />',
  }),
};

export const Sizes: Story = {
  render: () => ({
    components: { Avatar },
    template: `
      <div style="display: flex; align-items: center; gap: 0.75rem">
        <Avatar size="sm" fallback="SM" alt="Small" />
        <Avatar size="md" fallback="MD" alt="Medium" />
        <Avatar size="lg" fallback="LG" alt="Large" />
      </div>
    `,
  }),
};

export const Demo: StoryObj = {
  render: () => ({ components: { AvatarDemo }, template: "<AvatarDemo />" }),
  // "Show code" shows the real demo SFC (via ?raw) instead of the wrapper
  // "<AvatarDemo />" — the snippet is the actual component usage and never drifts.
  parameters: { docs: { source: { code: AvatarDemoSource, language: "vue" } } },
};
