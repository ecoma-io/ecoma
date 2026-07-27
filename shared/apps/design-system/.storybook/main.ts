import type { StorybookConfig } from "@storybook/vue3-vite";
import remarkGfm from "remark-gfm";

/**
 * The design-system app's Storybook: the workspace-owned host that renders
 * `core-ui`'s stories and design docs. Its built output (`storybook-static`)
 * is the artifact the `design-system-e2e` gates scan.
 */
const config: StorybookConfig = {
  framework: "@storybook/vue3-vite",
  stories: [
    "../../../libs/core-ui/src/**/*.stories.@(ts|vue)",
    "../../../libs/core-ui/src/**/*.mdx",
    "../../../libs/core-ui/docs/**/*.stories.@(ts|vue)", // demo-host stories embedded by design/components MDX via <Canvas of={…}>
    "../../../libs/core-ui/docs/**/*.mdx",
  ],
  addons: [
    {
      // remark-gfm so GFM tables / strikethrough / autolinks parse in MDX
      // (addon-docs does NOT enable it by default — without this every
      //  `| a | b |` table renders as raw pipe text).
      name: "@storybook/addon-docs",
      options: {
        mdxPluginOptions: {
          mdxCompileOptions: { remarkPlugins: [remarkGfm] },
        },
      },
    },
    "@storybook/addon-a11y",
  ],
  features: {
    sidebarOnboardingChecklist: false,
  },
  core: { disableTelemetry: true, builder: "@storybook/builder-vite" },
  docs: { defaultName: "Docs" },
  async viteFinal(cfg) {
    const { fileURLToPath } = await import("node:url");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const vue = (await import("@vitejs/plugin-vue")).default;
    // ESM config: no __dirname. Derive the repo root from this file's URL.
    const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
    // No pnpm-workspace.yaml (Single Version Policy, see CLAUDE.md) means Vite's
    // workspace-root auto-detection stops at this project — verified by calling
    // `searchForWorkspaceRoot()` on this directory, which returns the project
    // itself, not the repo root. `server.fs` would then be confined here and deny
    // every request for a root-hoisted node_modules package, and in a
    // single-package monorepo that is where ALL of them live. Widening to the
    // repo root is what makes the dev server able to serve its own dependencies.
    cfg.server = { ...cfg.server, fs: { allow: [rootDir] } };
    // @storybook/vue3-vite ships no @vitejs/plugin-vue dependency of its own
    // (consumers are expected to already have a root vite.config.ts that
    // registers it; this package has none) — register it ourselves.
    // Cast to unknown[]: flat(Infinity) over Vite's recursive Plugin type
    // blows TS's instantiation depth (TS2589); we only probe `name` anyway.
    const hasVue = ((cfg.plugins ?? []) as unknown[])
      .flat(Infinity)
      .some(
        (p) =>
          p &&
          typeof p === "object" &&
          "name" in p &&
          String((p as { name?: unknown }).name).includes("vite:vue"),
      );
    // Must run BEFORE the framework's vue-docgen-plugin (already present in
    // cfg.plugins at this point): docgen's transform appends
    // `_sfc_main.__docgenInfo = ...` to the module source assuming it already
    // IS the compiled JS (it references `_sfc_main`), so @vitejs/plugin-vue's
    // own transform of the bare `.vue` id must execute first in plugin-array
    // order. Prepending (not appending) puts it ahead of the already-queued
    // docgen plugin.
    if (!hasVue) cfg.plugins = [vue(), ...(cfg.plugins ?? [])];
    // Alias resolution is DERIVED from tsconfig.base.json's `paths` at config
    // time, never restated here (Rule 14) — a hand-copied map would drift the
    // day an alias is added or retargeted. It exists because this app is a
    // different project from `core-ui`: preview.ts and PreviewSurface.vue must
    // import it through its public `@ecoma-io/ui` aliases (relative imports
    // across projects are banned by @nx/enforce-module-boundaries), and Vite
    // knows nothing about tsconfig `paths` on its own. A non-wildcard key
    // becomes an exact-match regex so `@ecoma-io/ui` can never shadow its own
    // subpath entries; a `/*` key becomes a plain prefix entry (the alias
    // array matches those only at a `/` boundary).
    const { paths } = (
      JSON.parse(readFileSync(join(rootDir, "tsconfig.base.json"), "utf8")) as {
        compilerOptions: { paths: Record<string, string[]> };
      }
    ).compilerOptions;
    const derived = Object.entries(paths).map(([key, [target]]) =>
      key.endsWith("/*")
        ? { find: key.slice(0, -2), replacement: join(rootDir, target.slice(0, -2)) }
        : {
            find: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
            replacement: join(rootDir, target),
          },
    );
    const existingAlias = cfg.resolve?.alias;
    const existingEntries = Array.isArray(existingAlias)
      ? existingAlias
      : Object.entries(existingAlias ?? {}).map(([find, replacement]) => ({ find, replacement }));
    cfg.resolve = { ...cfg.resolve, alias: [...existingEntries, ...derived] };
    return cfg;
  },
};

export default config;
