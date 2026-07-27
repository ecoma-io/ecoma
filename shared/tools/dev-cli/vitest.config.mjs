import { defineConfig } from "vitest/config";

// Node environment — this is a CLI tool, nothing renders. `.mjs` config (not
// `.ts` like the other projects') because dev-cli deliberately has no TS
// toolchain.
//
// `pool: "forks"` — the command modules read the repository from the process
// working directory, so the integration tests covering them (`check-doc-links`,
// `check-claude-md`, `check-journey-markers`, `scaffold-lib`) `process.chdir`
// into their fixture, which the threads pool does not allow. Forks also give
// each test file its own `process.env`, which `setupFiles` relies on.
//
// `setupFiles` — strips the git variables that select a repository out of every
// test process; see `vitest.setup.mjs` and `src/git-fixture.mjs`.
export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    setupFiles: ["./vitest.setup.mjs"],
    include: ["src/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.mjs"],
      // main.mjs calls process.exit at import time, so it is exercised
      // end-to-end by main.integration.test.mjs through a spawned subprocess —
      // which in-process V8 coverage cannot see.
      exclude: ["src/**/*.test.mjs", "src/main.mjs"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
