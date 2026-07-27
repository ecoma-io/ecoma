import type { Preview, Decorator } from "@storybook/vue3-vite";
import { h } from "vue";
import PreviewSurface, { BARE_PARAM } from "./PreviewSurface.vue";

import "./tailwind.css"; // Tailwind v4 engine + Alloy theme (@config) — load first.
// Cross-project imports go through core-ui's public aliases (resolved by the
// derived alias entries in main.ts's viteFinal) — a relative path into another
// project is banned by @nx/enforce-module-boundaries.
import "@ecoma-io/ui/styles/global.css";
import { applyAlloyIconDefaults } from "@ecoma-io/ui";
// Shared with the design-system-e2e axe gate so the panel and the gate can't
// disagree on what counts as a violation — see that module's header.
import { WCAG_TAGS } from "@ecoma-io/ui/a11y";

applyAlloyIconDefaults(); // lucide size 16 / stroke 1.5 — Design System › Iconography

/**
 * Wrap every demo in the inline viewport preview surface (toolbar is hidden —
 * see manager.ts). The surface renders a chosen preset inside a nested
 * `iframe.html`, and that nested load comes back through this same decorator —
 * so the flag it carries has to short-circuit the wrapping, or each frame
 * would grow a picker of its own without end.
 *
 * Read once at module scope: a story's URL does not change identity mid-run,
 * and this keeps the decorator itself allocation-free.
 */
const renderBare =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has(BARE_PARAM);

const withPreviewSurface: Decorator = (story, context) => () =>
  renderBare
    ? h(story())
    : h(PreviewSurface, { storyId: context.id }, { default: () => h(story()) });

const preview: Preview = {
  decorators: [withPreviewSurface],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    // Live a11y panel in the dev Storybook. The BLOCKING scan is
    // design-system-e2e's axe gate over the built Storybook; `test: "error"`
    // here keeps the panel reporting at the same severity so a dev sees what
    // the gate will fail on.
    a11y: {
      test: "error",
      options: { runOnly: WCAG_TAGS },
    },
    options: {
      // Convention-derived sort: Design System leads, then the component
      // layers; each layer's index pages are pinned, everything else falls
      // through to "*" (alphabetical). Never hand-list individual component
      // pages here — that list drifts.
      storySort: {
        order: [
          "Design System",
          [
            "Introduction",
            "Principles",
            "Color",
            "Typography",
            "Motion",
            "Iconography",
            "Logo",
            "Elevation",
          ],
          "Components",
          ["Overview", "Primitives", "Blocks", "*"],
          "*",
        ],
      },
    },
  },
};

export default preview;
