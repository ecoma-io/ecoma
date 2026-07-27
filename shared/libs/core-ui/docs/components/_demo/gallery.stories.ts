import type { Meta, StoryObj } from "@storybook/vue3-vite";
import PrimitiveGallery from "./PrimitiveGallery.vue";

/**
 * Demo host story for the Components/Overview page.
 * Referenced by the MDX doc via <Canvas of={…} />.
 * '!dev' hides it from the sidebar; '!test' keeps it out of the vitest a11y
 * gate — it is doc scaffolding (the primitives it composes are gated by their
 * own stories), not a component under test. It stays indexed for <Canvas of>.
 */
const meta: Meta = {
  title: "Demos/ComponentsOverview",
  tags: ["!dev", "!test"],
};
export default meta;

export const Primitives: StoryObj = {
  render: () => ({ components: { PrimitiveGallery }, template: "<PrimitiveGallery />" }),
};
