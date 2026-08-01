import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

// The floor is a workspace value, not this project's — the repo-root
// `coverage.config.json` says why it lives there and who else reads it.
// `createRequire` rather than a static relative import: the file sits outside
// this Nx project, so a relative import is an edge the project graph cannot see.
const { thresholds } = createRequire(import.meta.url)("../../../coverage.config.json");

// One co-located unit tier (`*.test.ts`) over pure TS — no jsdom needed, no
// component to mount. The unit under test is `app/i18n/messages.ts` and only
// it: the pages and plugins are pinned by the site-e2e gate against the BUILT
// artifact, so coverage scope here names the one file this tier actually owns
// (Rule 11 — coverage that quietly excludes what it does not test).
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["app/i18n/messages.ts"],
      thresholds,
    },
  },
});
