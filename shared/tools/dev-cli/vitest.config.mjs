import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// The floor is a workspace value, not this project's — the repo-root
// `coverage.config.json` says why it lives there and who else reads it.
// `createRequire` rather than a static relative import: the file sits outside
// this Nx project, so a relative import is an edge the project graph cannot see.
const { thresholds } = createRequire(import.meta.url)("../../../coverage.config.json");

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
      thresholds,
    },
  },
});
