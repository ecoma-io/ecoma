import { defineConfig } from "vitest/config";

// Node environment — this is a CLI tool, nothing renders. `.mjs` config (not
// `.ts`) because repo-care, like dev-cli, deliberately has no TS toolchain.
export default defineConfig({
  test: {
    environment: "node",
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
