import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// The floor is a workspace value, not this project's — the repo-root
// `coverage.config.json` says why it lives there and who else reads it.
// `createRequire` rather than a static relative import: the file sits outside
// this Nx project, so a relative import is an edge the project graph cannot see.
const { thresholds } = createRequire(import.meta.url)("../../../coverage.config.json");

// Node environment; `.mjs` config because this project, like dev-cli, has no
// TS toolchain. Default pool is fine: no test chdirs or mutates process.env
// (the integration test passes absolute fixture paths through the resolver
// contract instead of relying on the working directory).
export default defineConfig({
  test: {
    environment: "node",
    // Pins fast-check's seed on CI — the repo-root setup every
    // property-testing project loads, never a per-project copy of the
    // constant (Rule 14); the why lives in that file and the write-test skill.
    setupFiles: ["../../../vitest.property-seed.mjs"],
    include: ["src/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      enabled: true,
      // `index.mjs` is named because Nx loads it and nothing else; it is
      // exercised in-process by the graph integration test. `cli.mjs` and
      // `lsp.mjs` are deliberately absent: both call `process.exit` and are
      // driven end-to-end as spawned subprocesses, which in-process V8
      // coverage cannot see (same reason dev-cli excludes its `main.mjs`).
      include: ["src/**/*.mjs", "index.mjs"],
      exclude: ["src/**/*.test.mjs"],
      thresholds,
    },
  },
});
