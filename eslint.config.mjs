import js from "@eslint/js";
import nx from "@nx/eslint-plugin";
import vue from "eslint-plugin-vue";
import vueA11y from "eslint-plugin-vuejs-accessibility";
import globals from "globals";
import * as jsoncParser from "jsonc-eslint-parser";
import tseslint from "typescript-eslint";
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
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/essential"],
  ...vueA11y.configs["flat/recommended"],

  // Nx module boundaries — enforce the scope/type tags declared in each project.json.
  {
    plugins: { "@nx": nx },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          depConstraints: [
            // Layer axis: apps consume libs; libs never import apps.
            { sourceTag: "type:app", onlyDependOnLibsWithTags: ["type:lib"] },
            { sourceTag: "type:lib", onlyDependOnLibsWithTags: ["type:lib"] },
            // An e2e project drives a built artifact from the outside; it may
            // name a lib's public API (shared a11y scope, fixture types) but
            // never another e2e suite, and never an app's internals.
            { sourceTag: "type:e2e", onlyDependOnLibsWithTags: ["type:lib"] },
            // Scope axis: a product domain gets its own scope tag when it takes
            // root, constrained to its own libs plus shared ones; shared libs
            // never reach into a product domain. Only the scope that has a
            // project today appears here — a scope is added in the change that
            // lands its first project, never in anticipation of one.
            { sourceTag: "scope:shared", onlyDependOnLibsWithTags: ["scope:shared"] },
            {
              sourceTag: "scope:website",
              onlyDependOnLibsWithTags: ["scope:website", "scope:shared"],
            },
            // Hex layer axis (domain/port/adapter/view + util), enforced from the
            // first brick so an import flowing the wrong way fails lint at once.
            // A dep must satisfy every one of its source's tag constraints, so
            // these compose with the scope/type axes above.
            //   util    → cross-cutting pure helpers (hashing…), leaf-agnostic
            //   domain  → pure types/logic; depends only on domain + util
            //   port    → an interface a domain exposes; may name domain types
            //   adapter → implements a port; may use port + domain
            //   view    → presentational; may use domain, never adapter, and never
            //             the desktop host runtime (it emits intents, the shell wires them)
            //   app     → application-service (agent-runtime, tool-proxy): orchestrates
            //             over ports; may use port + domain + util + peer app, but
            //             NEVER an adapter directly — reaching an engine/store means
            //             going through its port, so the engine stays swappable
            { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
            { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
            {
              sourceTag: "layer:port",
              onlyDependOnLibsWithTags: ["layer:domain", "layer:port", "layer:util"],
            },
            {
              sourceTag: "layer:adapter",
              onlyDependOnLibsWithTags: [
                "layer:domain",
                "layer:port",
                "layer:adapter",
                "layer:util",
              ],
            },
            {
              sourceTag: "layer:view",
              onlyDependOnLibsWithTags: ["layer:view", "layer:domain", "layer:util"],
              // A view lib emits intents and lets the shell wire them, so it must
              // not reach the desktop host runtime directly. Named for the shell
              // this workspace actually ships (Tauri) — a banned import for a
              // package no longer installed enforces nothing. Adding a second
              // shell means adding its runtime here in the same pass.
              bannedExternalImports: ["@tauri-apps/*"],
            },
            {
              sourceTag: "layer:app",
              onlyDependOnLibsWithTags: ["layer:app", "layer:port", "layer:domain", "layer:util"],
            },
            // Licence axis — the carve-outs in the root LICENSE, made executable.
            // `LICENSE` decides terms by path; `check-project-conventions` makes
            // each project's `license:*` tag agree with its path; these four
            // constraints make the import graph respect the result. Without them
            // the boundary is a sentence in a legal document that the build has
            // no way to hold anyone to.
            //
            //   sul   → may use SUL and Apache code. NEVER `ee`: an SUL file that
            //           imports an Enterprise module ships paid code to everyone
            //           who self-hosts, and the dependency is one line.
            //   apache→ Apache only, and this direction is the load-bearing one.
            //           A `packages/` unit is what third parties receive under
            //           Apache 2.0; importing SUL code would hand them SUL code
            //           under Apache terms, which we cannot grant and cannot undo.
            //   ee    → may use everything public. This is the one-way half of
            //           the rule the ceiling states: `ee` imports `sul`, never back.
            //   proprietary → the operator control plane calls public mechanisms
            //           and patches none, so it may depend on them, and nothing
            //           public may depend on it (it is absent from a contributor's
            //           clone, so such an import would not even resolve).
            {
              sourceTag: "license:sul",
              onlyDependOnLibsWithTags: ["license:sul", "license:apache"],
            },
            { sourceTag: "license:apache", onlyDependOnLibsWithTags: ["license:apache"] },
            {
              sourceTag: "license:ee",
              onlyDependOnLibsWithTags: ["license:ee", "license:sul", "license:apache"],
            },
            {
              sourceTag: "license:proprietary",
              onlyDependOnLibsWithTags: [
                "license:proprietary",
                "license:ee",
                "license:sul",
                "license:apache",
              ],
            },
          ],
        },
      ],
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
