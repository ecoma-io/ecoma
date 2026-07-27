import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "playwright/test";

// When the runtime pre-provisions a Chromium of a different build than the
// installed Playwright version expects (the cloud dev container exposes one
// via PLAYWRIGHT_BROWSERS_PATH), point Playwright at it so the suite still
// runs. Guarded by existsSync: on CI/local, where Playwright resolves its own
// browser, this returns undefined and default behavior is unchanged.
function chromiumExecutablePath(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(path.join(base, "chromium"))) return path.join(base, "chromium");
  return undefined;
}

const chromiumExe = chromiumExecutablePath();

// Drives the BUILT Storybook, which `webServer` only SERVES — building it is
// the Nx `e2e` target's `dependsOn`, deliberately not a step in this command.
// The a11y suite generates one test per story and reads the story list off
// `storybook-static/index.json`, so the artifact has to exist before Playwright
// collects tests, which is strictly earlier than webServer starts.
//
// Two things about the serve command look odd and are both load-bearing:
//
//  - It deliberately does NOT go through an Nx target. Nx runs commands inside
//    its own pty/session, which Playwright's process-group kill cannot reach,
//    so the preview server would outlive every run. A direct child stays in
//    Playwright's process group and is reaped on teardown.
//  - Vite is launched as `node <resolved cli>`, not `pnpm exec vite`. This is a
//    single-package monorepo: there is no `node_modules/.bin` beside a lib, so
//    from this cwd `pnpm exec vite` fails with
//    ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL — observed, not hypothetical, and it
//    surfaces only as a webServer timeout. Same reasoning as
//    `dev-cli/src/run-e2e.mjs` resolving Playwright's cli.js under node.
//
// `--host 127.0.0.1` pins the bind address to the one `url` polls; Vite's
// default `localhost` can resolve to ::1 alone and leave the poll unanswered.
export default defineConfig({
  testDir: "./src",
  // Every story is an independent test, so they parallelize — but only with
  // `fullyParallel`, which is what actually distributes them: Playwright's
  // default keeps tests from ONE file in a single worker, so raising the worker
  // count alone changed nothing (measured flat at 1/4/8/16). Worker count is
  // left to Playwright, which sizes it to the machine. Measured over 99
  // stories: 47.7s in the old single-worker sweep, 27.4s here.
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    headless: true,
    // axe reads the COMPUTED colour, so an element part-way through an entrance
    // animation blends toward its backdrop and is reported as a contrast
    // violation it does not have. Waiting the animations out cannot close this:
    // `document.getAnimations()` never reports a GSAP tween (rAF over inline
    // styles), which is what the Motion demos use. Reduced motion removes the
    // window instead of racing it — global.css collapses every CSS animation to
    // 0.01ms here and GsapAccentDemo skips its timeline for the end state, so
    // every story is at its final paint before the scan. Measured over 4 full
    // sweeps: axe checks exactly 3319 nodes every run, versus 3237-3242 and
    // three sweeps out of four red without it.
    // (`contextOptions`, not a top-level `use` key: Playwright exposes this one
    // through the browser-context options — see its own example in test.d.ts.)
    contextOptions: { reducedMotion: "reduce" },
    ...(chromiumExe ? { launchOptions: { executablePath: chromiumExe } } : {}),
  },
  webServer: {
    // `exec` is load-bearing, not a flourish. Playwright runs this through
    // `/bin/sh -c`, and its teardown kills that shell — leaving the `node` child
    // holding the port, so the NEXT run dies with "4174 is already used" while
    // the leaked server ages out minutes later. `exec` replaces the shell with
    // node, so the process Playwright tracks is the one holding the port.
    command:
      "exec node ../../../node_modules/vite/bin/vite.js preview --outDir storybook-static --host 127.0.0.1 --port 4174 --strictPort",
    cwd: "../design-system",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
