import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// The floor is a workspace value, not this project's — the repo-root
// `coverage.config.json` says why it lives there and who else reads it.
// `createRequire` rather than a static relative import: the file sits outside
// this Nx project, so a relative import is an edge the project graph cannot see.
const { thresholds } = createRequire(import.meta.url)("../../../coverage.config.json");

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds,
    },
  },
});
