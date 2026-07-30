import { defineConfig } from "vitest/config";

// Node environment — this is a CLI tool, nothing renders. `.mjs` config (not
// `.ts` like the other projects') because this project, like dev-cli, has no
// TS toolchain.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.mjs"],
  },
});
