/**
 * Runs the Playwright e2e suite with the display setup each OS needs.
 *
 * A desktop shell has no true headless mode — it must create a real window — so
 * on Linux (CI and this workspace's cloud sandbox have no X server) the run is
 * wrapped in `xvfb-run` to supply a virtual display. macOS and Windows always
 * have a native window server, so Playwright runs directly. Hard-coding
 * `xvfb-run` instead would pin the suite to Linux.
 *
 * Playwright is launched via its resolved `cli.js` under `node`, not the
 * `playwright` shim on PATH, so nothing depends on the platform-specific bin
 * (a `.cmd` shim on Windows). Extra args are forwarded to `playwright test` and
 * its exit code is propagated.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * True when the run must be wrapped in `xvfb-run` — i.e. on Linux, which has no
 * window server in CI or this workspace's sandbox. macOS/Windows run directly.
 * Pure.
 */
export function shouldUseXvfb(platform) {
  return platform === "linux";
}

/** Absolute path to Playwright's CLI entry (the target of its `playwright` bin). */
function playwrightCli() {
  const pkgPath = require.resolve("playwright/package.json");
  const { bin } = JSON.parse(readFileSync(pkgPath, "utf8"));
  return join(dirname(pkgPath), typeof bin === "string" ? bin : bin.playwright);
}

/** Runs `playwright test` (via xvfb-run on Linux). Returns a process exit code. */
export function runE2e(args = []) {
  let cli;
  try {
    cli = playwrightCli();
  } catch {
    console.error("run-e2e: `playwright` is not installed — install workspace deps first.");
    return 1;
  }

  const [command, prefix] = shouldUseXvfb(process.platform)
    ? ["xvfb-run", ["--auto-servernum", process.execPath, cli]]
    : [process.execPath, [cli]];

  const result = spawnSync(command, [...prefix, "test", ...args], { stdio: "inherit" });

  if (result.error) {
    if (result.error.code === "ENOENT" && command === "xvfb-run") {
      console.error(
        "run-e2e: `xvfb-run` not found — install Xvfb (e.g. `apt-get install xvfb`) to run desktop e2e on Linux.",
      );
      return 127;
    }
    throw result.error;
  }
  return result.status ?? 1;
}
