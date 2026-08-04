import type { Meta, StoryObj } from "@storybook/vue3-vite";
import MotionGallery from "./MotionGallery.vue";
import SignatureGallery from "./SignatureGallery.vue";
import LogoGallery from "./LogoGallery.vue";
import IconographyDemo from "./IconographyDemo.vue";
import GsapAccentDemo from "./GsapAccentDemo.vue";

/**
 * Demo host stories for the Design layer (Loom foundations). Referenced
 * by the MDX docs via <Canvas of={…} />.
 * '!dev' hides them from the sidebar; '!test' keeps them out of the vitest
 * a11y gate — they are doc scaffolding (GSAP/animation showcases, not
 * components under test). They stay indexed for <Canvas of>.
 */
const meta: Meta = {
  title: "Demos/Design",
  tags: ["!dev", "!test"],
};
export default meta;

export const Motion: StoryObj = {
  render: () => ({ components: { MotionGallery }, template: "<MotionGallery />" }),
};

export const Signature: StoryObj = {
  render: () => ({ components: { SignatureGallery }, template: "<SignatureGallery />" }),
};

export const Logo: StoryObj = {
  render: () => ({ components: { LogoGallery }, template: "<LogoGallery />" }),
};

export const Iconography: StoryObj = {
  render: () => ({ components: { IconographyDemo }, template: "<IconographyDemo />" }),
};

export const GsapAccent: StoryObj = {
  render: () => ({ components: { GsapAccentDemo }, template: "<GsapAccentDemo />" }),
};
