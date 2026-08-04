// Tailwind config for the RBA desktop shell. Theme comes from core-ui's shared
// preset — this app contributes no theme of its own, which is what keeps every
// Ecoma surface reading as one product.
//
// The preset import is relative across projects for the same reason the
// design-system app's is: jiti loads this file at build time and resolves
// neither tsconfig `paths` nor the internal-only `@ecoma-io/ui` package name.
// The exemption is scoped to this one line.
// @type {import('tailwindcss').Config}
// eslint-disable-next-line @nx/enforce-module-boundaries -- jiti cannot resolve the `@ecoma-io/ui` alias (see header)
import preset from "../../../shared/libs/core-ui/tailwind.preset.js";

export default {
  presets: [preset],
  content: [
    "./index.html",
    "./src/**/*.{vue,ts}",
    "../../../shared/libs/core-ui/src/**/*.{vue,ts}",
  ],
};
