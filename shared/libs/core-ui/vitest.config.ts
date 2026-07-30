import { createRequire } from "node:module";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// The floor is a workspace value, not this project's — the repo-root
// `coverage.config.json` says why it lives there and who else reads it.
// `createRequire` rather than a static relative import: the file sits outside
// this Nx project, so a relative import is an edge the project graph cannot see.
const { thresholds } = createRequire(import.meta.url)("../../../coverage.config.json");

// Both co-located tiers, one jsdom runtime: `*.test.ts` (unit — every
// project-internal collaborator mocked, enforced by
// `local/no-unmocked-internal-imports`) and `*.integration.test.ts` (real
// collaborators, where the composition itself is the behaviour under test).
// The include glob covers both — an integration file IS a `.test.ts`.
//
// Nothing here launches a browser. Real-browser proof is design-system-e2e's
// axe gate over the BUILT Storybook (root CLAUDE.md test taxonomy: e2e is
// never co-located).
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    // One worker, deliberately. Creating a jsdom per isolated file dominates
    // the run, so several at once oversubscribe the machine and turn
    // timing-sensitive tests (RadioGroup/Tabs, see #89) flaky rather than
    // faster. The trade is wall-clock for determinism, and it is the right
    // trade for a suite this size. Raise it only with a measurement showing
    // the contention is gone, not because a run felt slow.
    maxWorkers: 1,
    // Contention budget, not a slow-test budget: a loaded machine stretches a
    // test far past Vitest's 5s default. Measured here: slowest test ~0.7s
    // idle, ~3.4s under load.
    //
    // Honest about its basis: this tier was NOT reproduced failing at the 5s
    // default. It is set PRECAUTIONARILY, on a jsdom-per-file contention
    // mechanism that is not specific to this project, and on #89's report of
    // RadioGroup/Tabs going red under load. One number for the whole tier
    // rather than one scaled per test: contention stretch is a property of how
    // oversubscribed the machine is, not of how expensive the test is, so
    // scaling the budget by idle cost models the wrong thing and only adds a
    // knob to drift.
    //
    // A real hang never resolves and still fails; a test whose IDLE cost
    // approaches this is a defect to fix, not a budget to raise.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.{ts,vue}"],
      exclude: ["src/**/*.test.ts", "src/**/*.stories.ts", "src/**/*Demo.vue", "src/**/*.d.ts"],
      thresholds,
    },
  },
});
