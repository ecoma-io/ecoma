import { createLucideIcon } from "@lucide/vue";

/**
 * BrandMark — the Ecoma brand mark: one face, two forces. The left half is
 * human (almond eye), the right half is the agent (rectangular eye), and the
 * dividing line is a nose bridge — both halves belong to the same face, the
 * organization. Built with createLucideIcon so it takes the exact same props
 * as any Lucide icon (size, strokeWidth, color, …) — consumers can't tell
 * custom icons from stock ones. Custom domain icons live in this folder and
 * follow the same recipe: 24-grid geometry, stroke via currentColor. The
 * duotone version (steel and ember halves) lives in the brand assets
 * (shared/libs/core-ui/docs/design/assets/), not here — an icon stays mono.
 */
const BrandMark = createLucideIcon("brand-mark", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "4" }],
  ["path", { d: "M12 3c0 2.2-.1 3.9-.3 5.4 1.7 1.1 1.7 3.1 0 4.2.2 1.4.3 2.7.3 3.9V21" }],
  ["circle", { cx: "7.8", cy: "10.6", r: "1.3", fill: "currentColor", stroke: "none" }],
  [
    "rect",
    {
      x: "14.8",
      y: "9.3",
      width: "2.9",
      height: "2.6",
      rx: "0.8",
      fill: "currentColor",
      stroke: "none",
    },
  ],
]);

export default BrandMark;
