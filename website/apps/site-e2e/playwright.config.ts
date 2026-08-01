import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "playwright/test";

// When the runtime pre-provisions a Chromium of a different build than the
// installed Playwright version expects (the cloud dev container exposes one
// via PLAYWRIGHT_BROWSERS_PATH), point Playwright at it so the suite still
// runs. Guarded by existsSync: on CI/local, where Playwright resolves its own
// browser, this returns undefined and default behavior is unchanged. Same
// rationale as the design-system-e2e and doctrine-site-e2e copies.
function chromiumExecutablePath(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(path.join(base, "chromium"))) return path.join(base, "chromium");
  return undefined;
}

const chromiumExe = chromiumExecutablePath();

// Drives the BUILT site (`dist/`, produced by `nuxt generate`), which
// `webServer` only SERVES — building it is the Nx `e2e` target's `dependsOn`,
// deliberately not a step in this command. The serve mechanics (direct
// child process, `exec` prefix, `node <resolved cli>` instead of `pnpm exec`)
// are the same load-bearing decisions the other e2e suites document — do not
// "tidy" them back to an Nx target or a bare command.
export default defineConfig({
  testDir: "./src",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4176",
    browserName: "chromium",
    headless: true,
    ...(chromiumExe ? { launchOptions: { executablePath: chromiumExe } } : {}),
  },
  webServer: {
    command:
      "exec node ../../../node_modules/vite/bin/vite.js preview --outDir dist --host 127.0.0.1 --port 4176 --strictPort",
    cwd: "../site",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
