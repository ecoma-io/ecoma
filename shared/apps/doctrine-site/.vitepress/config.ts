import { defineConfig } from "vitepress";

/**
 * Sidebar order is declared here, not derived from the directory listing:
 * alphabetical order would put `charter` before `north-star`, which is not a
 * reading order anyone chose.
 *
 * The two-way check that keeps this honest — a section in the tree but not in
 * the order, or the reverse — lives in `@ecoma-io/doctrine` and is wired in
 * when the ceiling documents land. It cannot be wired here yet: VitePress
 * bundles this file with esbuild, which externalises bare imports before any
 * Vite alias applies, so `@ecoma-io/doctrine` does not resolve at config-load
 * time. Until that is solved, `implicitDependencies` in `project.json` carries
 * the graph edge so `nx affected` still rebuilds this site when a document
 * changes.
 */
const SECTIONS = [
  {
    text: "Overview",
    collapsed: false,
    items: [{ text: "Reading order", link: "/overview/reading-order" }],
  },
];

export default defineConfig({
  title: "Ecoma Doctrine",
  description:
    "The design ecoma commits to: North Stars, specifications, charters and the review rubric.",
  // Mounted as a path on the one domain, beside /design and /hub — the edge
  // router owns the mount, this only has to agree with it (Website Charter).
  base: "/doctrine/",
  srcDir: "content",
  outDir: "dist",
  cleanUrls: true,
  themeConfig: { sidebar: SECTIONS },
});
