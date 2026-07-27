import { defineConfig } from "vitest/config";

// Node environment; `.mjs` config because this project, like dev-cli, has no
// TS toolchain. Default pool is fine: no test chdirs or mutates process.env
// (the integration test passes absolute fixture paths through the resolver
// contract instead of relying on the working directory).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.mjs", "index.mjs"],
      exclude: ["src/**/*.test.mjs"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
