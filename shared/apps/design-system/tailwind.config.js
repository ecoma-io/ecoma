// Tailwind config for the design-system app's Storybook (the a11y-gated host
// for core-ui's stories and design docs). Theme comes from core-ui's shared
// Loom preset; content scans the component source this Storybook renders plus
// this app's own .storybook files — nothing else contributes markup.
//
// The preset import is relative across projects on purpose: jiti loads this
// file at build time (`@config` in .storybook/tailwind.css) and resolves
// neither tsconfig `paths` nor the internal-only `@ecoma-io/ui` package name,
// so the alias form cannot work here. The exemption is scoped to this one line.
// @type {import('tailwindcss').Config}
// eslint-disable-next-line @nx/enforce-module-boundaries -- jiti cannot resolve the `@ecoma-io/ui` alias (see header)
import preset from "../../libs/core-ui/tailwind.preset.js";

export default {
  presets: [preset],
  content: ["../../libs/core-ui/src/**/*.{vue,ts}", "./.storybook/**/*.{vue,ts}"],
};
