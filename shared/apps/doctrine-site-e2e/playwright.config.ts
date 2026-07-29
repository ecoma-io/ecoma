import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "playwright/test";

// Same provisioning quirk design-system-e2e documents: when the runtime exposes
// a Chromium of a different build than the installed Playwright expects, point
// at it so the suite still runs. Guarded by existsSync, so on CI this returns
// undefined and default resolution is unchanged.
function chromiumExecutablePath(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(path.join(base, "chromium"))) return path.join(base, "chromium");
  return undefined;
}

const chromiumExe = chromiumExecutablePath();

// Drives the BUILT site, which `webServer` only serves — building it is the Nx
// `e2e` target's `dependsOn`, deliberately not a step in this command.
//
// The two oddities below are copied deliberately, not cargo-culted; both are
// explained at length in design-system-e2e's config and hold for the same
// reasons here. `exec` keeps the process Playwright tracks as the one holding
// the port, and Vite is launched as `node <resolved cli>` because there is no
// `node_modules/.bin` beside an app in a single-package monorepo.
export default defineConfig({
  testDir: "./src",
  use: {
    baseURL: "http://127.0.0.1:4175/doctrine/",
    browserName: "chromium",
    headless: true,
    ...(chromiumExe ? { launchOptions: { executablePath: chromiumExe } } : {}),
  },
  webServer: {
    command:
      "exec node ../../../node_modules/vite/bin/vite.js preview --outDir dist --base /doctrine/ --host 127.0.0.1 --port 4175 --strictPort",
    cwd: "../doctrine-site",
    url: "http://127.0.0.1:4175/doctrine/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
