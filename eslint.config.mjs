import js from "@eslint/js";
import nx from "@nx/eslint-plugin";
import vue from "eslint-plugin-vue";
import vueA11y from "eslint-plugin-vuejs-accessibility";
import globals from "globals";
import * as jsoncParser from "jsonc-eslint-parser";
import tseslint from "typescript-eslint";
import { depConstraints, moduleBoundaryOptions } from "./module-boundaries.config.mjs";
import noFocusedOrSkippedTests from "./shared/tools/eslint-local-rules/no-focused-or-skipped-tests.mjs";
import noJourneyMarkerNames from "./shared/tools/eslint-local-rules/no-journey-marker-names.mjs";
import noJourneyMarkers from "./shared/tools/eslint-local-rules/no-journey-markers.mjs";
import noUnmockedInternalImports from "./shared/tools/eslint-local-rules/no-unmocked-internal-imports.mjs";
import requireProjectTags from "./shared/tools/eslint-local-rules/require-project-tags.mjs";

/**
 * Flat ESLint config for the whole workspace.
 *
 * Only our own code (`@ecoma-io/*` + the app) carries a `lint` target. The
 * `ignores` below keep build artifacts out of any stray run.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.nx/**",
      "tmp/**",
      "**/*.d.ts",
      // Third-party reference clones and Storybook build output — never ours to lint.
      "docs/references/**",
      "**/storybook-static/**",
      "**/.nuxt/**",
      "**/.output/**",
      // VitePress writes one module per page here while it builds and removes
      // them when it finishes. `build` and `lint` are separate targets on the
      // same project, so Nx runs them at once and a lint that overlaps a build
      // sees them: doctrine prose reaches the generated module inside a
      // template literal, which `no-irregular-whitespace` does not skip. Green
      // or red then depends on which task wins, so the ignore is what makes the
      // gate deterministic rather than lucky.
      "**/.vitepress/.temp/**",
      "**/.vitepress/cache/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/essential"],
  ...vueA11y.configs["flat/recommended"],

  // Nx module boundaries — enforce the type/scope/layer/licence tags declared in
  // each project.json. The table and the eight option values come from the
  // workspace's single boundary config; ESLint is one of its two readers, and
  // the reason it stopped owning them is that it can only judge JS and TS
  // (`module-boundaries.config.mjs` header; root CLAUDE.md, Rule 14).
  {
    plugins: { "@nx": nx },
    rules: {
      "@nx/enforce-module-boundaries": ["error", { ...moduleBoundaryOptions, depConstraints }],
    },
  },

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // TypeScript (noUnusedLocals/Parameters) already reports unused symbols.
      "@typescript-eslint/no-unused-vars": "off",
      // App components (StatusBar, ActivityBar…) are single-word by design — this
      // rule targets shared libraries, not an application's own components.
      "vue/multi-word-component-names": "off",
    },
  },

  // Local rules — registered once here, enabled per file type below.
  // Rule 13: comments/test titles describe behavior, not the phase, review
  // round, or ticket that produced it — and exported names describe the end
  // state, never the journey (v2, wip, trailing new/old/temp, phase-N).
  {
    plugins: {
      local: {
        rules: {
          "no-journey-markers": noJourneyMarkers,
          "no-journey-marker-names": noJourneyMarkerNames,
          "require-project-tags": requireProjectTags,
          "no-focused-or-skipped-tests": noFocusedOrSkippedTests,
          "no-unmocked-internal-imports": noUnmockedInternalImports,
        },
      },
    },
    rules: {
      "local/no-journey-markers": "error",
      "local/no-journey-marker-names": "error",
    },
  },

  // Focused/disabled tests must never land in committed code (CLAUDE.md —
  // scaffold openly, never fake done). Test files only; `.todo` is allowed.
  {
    files: ["**/*.spec.*", "**/*.test.*", "**/*.e2e.*"],
    rules: { "local/no-focused-or-skipped-tests": "error" },
  },

  // Unit tests isolate their dependencies (CLAUDE.md test taxonomy): a unit test
  // mocks every project-internal collaborator. Integration/e2e tiers, which
  // exercise real collaborators, are exempt by their filename infix.
  //
  // Matched by extension wildcard, like the focused-test block above, so the
  // taxonomy holds for every language the workspace tests in — the `.mjs` tools
  // under `shared/tools` are unit-tested too, and an extension list left the
  // rule silently off for all of them.
  {
    files: ["**/*.test.*"],
    ignores: ["**/*.integration.test.*", "**/*.e2e.test.*"],
    rules: { "local/no-unmocked-internal-imports": "error" },
  },

  // Every Nx project.json must carry type:/scope: tags, or it silently escapes
  // the module-boundary constraints above. Parsed with the JSONC parser since
  // the default (espree) can't read a JSON object as a program.
  {
    files: ["**/project.json"],
    languageOptions: { parser: jsoncParser },
    rules: { "local/require-project-tags": "error" },
  },

  // Vue SFCs carry `<script setup lang="ts">` — parse their scripts with the TS parser.
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
);
