import { defineConfig } from "vitest/config";

// Node environment — this is a CLI tool, nothing renders. `.mjs` config (not
// `.ts` like the other projects') because this project, like dev-cli, has no
// TS toolchain.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.mjs"],
      exclude: ["src/**/*.test.mjs"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
