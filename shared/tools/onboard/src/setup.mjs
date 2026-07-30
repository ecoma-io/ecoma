#!/usr/bin/env node
/**
 * setup.mjs — verify the developer toolchain and set up the repository.
 *
 * Supported platforms: Linux, macOS, and native Windows.
 *
 * What it does:
 *   1. Verifies every required tool. Version pins come from the repo itself
 *      (package.json `engines` / `packageManager`, `.golangci-lint-version`,
 *      go.work when it exists) so the script never carries a second copy of a
 *      pin the repo already owns.
 *   2. Installs missing tools that have an official user-space installer
 *      (pnpm, rustup, uv, golangci-lint), asking first unless --yes. System
 *      runtimes (Git, Node.js, Go) are never installed by this script — it
 *      prints the exact command for the detected platform instead. The script
 *      never invokes sudo or an elevated prompt.
 *   3. Sets up the repo: `pnpm install` (which installs the git hooks via
 *      lefthook's prepare script) and the Playwright Chromium the e2e
 *      suite drives.
 *
 * The workspace is polyglot (TypeScript/Go/Rust/Python), so the baseline
 * covers all four toolchains. Claude Code cloud sessions run this same script
 * non-interactively via the SessionStart hook
 * (.claude/hooks/session-start-remote.mjs); PATH additions made by installers
 * are persisted for the session through CLAUDE_ENV_FILE when it is set.
 *
 * Usage: pnpm run setup -- [--check] [--yes]
 *   --check  verify only; change nothing (exit 1 if anything is missing)
 *   --yes    install without prompting (also required to install when stdin
 *            is not a terminal)
 *
 * Exported as `runSetup(args)` (returns a process exit code) so
 * `.claude/hooks/session-start-remote.mjs` can call it in-process instead of
 * spawning a child process.
 */
import { existsSync, appendFileSync, readFileSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIN32 = process.platform === "win32";

const HELP_TEXT = `setup.mjs — verify the developer toolchain and set up the repository.

Supported platforms: Linux, macOS, and native Windows.

What it does:
  1. Verifies every required tool. Version pins come from the repo itself
     (package.json engines/packageManager, .golangci-lint-version, go.work
     when it exists) so the script never carries a second copy of a pin the
     repo already owns.
  2. Installs missing tools that have an official user-space installer
     (pnpm, rustup, uv, golangci-lint), asking first unless --yes. System
     runtimes (Git, Node.js, Go) are never installed by this script — it
     prints the exact command for the detected platform instead. The script
     never invokes sudo or an elevated prompt.
  3. Sets up the repo: pnpm install (which installs the git hooks via
     lefthook's prepare script) and the Playwright Chromium the e2e
     suite drives.

Usage: pnpm run setup -- [--check] [--yes]
  --check  verify only; change nothing (exit 1 if anything is missing)
  --yes    install without prompting (also required to install when stdin
           is not a terminal)`;

/**
 * The exact `spawnSync` invocation for each toolchain this script installs
 * itself, as `{ cmd, args }`.
 *
 * They sit here as one named source rather than inline at each call site
 * because `setup.test.mjs` matches installers against these very strings
 * (Rule 14). A test that restated an installer's command would be a second
 * copy free to drift from what this script actually spawns, and a negative
 * assertion built on a drifted copy stops matching anything — it would pass
 * whether or not the installer ran. Substring-matching a host instead is
 * equally unsound: `rustup.rs` is a substring of both `sh.rustup.rs` and
 * `win.rustup.rs`, so such a check cannot tell the two installers apart.
 */
export const INSTALL_COMMANDS = {
  pnpmWindows: (pnpmPin) => ({
    cmd: "powershell",
    args: [
      "-NoProfile",
      "-Command",
      `$env:PNPM_VERSION='${pnpmPin}'; irm https://get.pnpm.io/install.ps1 | iex`,
    ],
  }),
  pnpmPosix: () => ({
    cmd: "sh",
    args: [
      "-c",
      'curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION="$PNPM_VERSION" sh -',
    ],
  }),
  rustupWindows: () => ({
    cmd: "powershell",
    args: [
      "-NoProfile",
      "-Command",
      "Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile $env:TEMP\\rustup-init.exe; " +
        "& $env:TEMP\\rustup-init.exe -y --default-host x86_64-pc-windows-msvc",
    ],
  }),
  rustupPosix: () => ({
    cmd: "sh",
    args: [
      "-c",
      "curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path",
    ],
  }),
  uvWindows: () => ({
    cmd: "powershell",
    args: ["-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
  }),
  uvPosix: () => ({
    cmd: "sh",
    args: ["-c", "curl -fsSL https://astral.sh/uv/install.sh | sh"],
  }),
};

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const isTTYOut = Boolean(process.stdout.isTTY);
const C_OK = isTTYOut ? "\x1b[32m" : "";
const C_WARN = isTTYOut ? "\x1b[33m" : "";
const C_ERR = isTTYOut ? "\x1b[31m" : "";
const C_OFF = isTTYOut ? "\x1b[0m" : "";

function makeReporter() {
  let failed = 0;
  return {
    ok: (msg) => console.log(`  ${C_OK}ok${C_OFF}      ${msg}`),
    warn: (msg) => console.log(`  ${C_WARN}warn${C_OFF}    ${msg}`),
    fail: (msg) => {
      console.log(`  ${C_ERR}missing${C_OFF} ${msg}`);
      failed += 1;
    },
    section: (title) => console.log(`\n${title}`),
    failedCount: () => failed,
  };
}

/** Blocking single-line prompt (mirrors bash's `read -r reply`). */
function promptSync(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(4096);
  let input = "";
  while (!input.includes("\n")) {
    let bytesRead;
    try {
      bytesRead = readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytesRead <= 0) break;
    input += buf.toString("utf8", 0, bytesRead);
  }
  return input.split("\n")[0].trim();
}

function confirm(what, assumeYes) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false; // non-interactive without --yes: do not install
  const reply = promptSync(`  install ${what}? [y/N] `);
  return /^y(es)?$/i.test(reply);
}

/**
 * Prepends `dir` to PATH for this run; inside a Claude Code session
 * (CLAUDE_ENV_FILE set) also persists it for the rest of the session. The
 * consumer of CLAUDE_ENV_FILE is always the Linux cloud sandbox's bash
 * SessionStart hook, so the persisted line is bash export syntax regardless
 * of the platform this script itself runs on.
 */
function pathAdd(dir) {
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) appendFileSync(envFile, `export PATH="${dir}:$PATH"\n`);
}

/**
 * True when dotted version `a` >= `b` (missing parts count as 0).
 * Exported so tests pinning the repo's own version-pin invariants (e.g.
 * node-version-pin.integration.test.mjs) reuse this comparison instead of
 * re-deriving it.
 */
export function verGe(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** First dotted version number in `cmd`'s stdout, or "" when none is found. */
function firstVersion(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", shell: true });
  const match = (result.stdout ?? "").match(/\d+\.\d+(\.\d+)?/);
  return match ? match[0] : "";
}

/**
 * Node/pnpm version pins the repo already declares in package.json
 * (`engines.node`'s floor, `packageManager`'s exact pnpm pin) — read once
 * here rather than re-parsed anywhere else that needs them (Rule 14).
 */
export function readVersionPins(pkgJson) {
  return {
    nodeMin: pkgJson.engines?.node?.match(/>=\s*([\d.]+)/)?.[1],
    pnpmPin: pkgJson.packageManager?.match(/^pnpm@([\d.]+)/)?.[1],
  };
}

/** PATH lookup only — mirrors `command -v`, never executes the binary. */
function commandExists(cmd) {
  const exts = WIN32 ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

/** Runs `cmd` and reports whether it exited 0 (existence already checked by the caller). */
function runOk(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "ignore", shell: true });
  return result.error == null && result.status === 0;
}

/**
 * The repository root, derived from git rather than from this file's own
 * location — this script moved once already (root → `shared/tools/onboard/`),
 * and a path derived from `import.meta.url` would have silently pointed at
 * the wrong directory after that move. `git rev-parse --show-toplevel`
 * resolves from the process's cwd (or `GIT_DIR`), so it stays correct
 * regardless of where this file lives, matching how the rest of the
 * workspace's tooling finds the repo root (e.g. dev-cli's
 * `check-journey-markers.mjs`).
 *
 * Returns "" when git is missing/unresolvable or the output isn't a usable
 * path — `spawnSync` (with `shell: true`) doesn't always set `result.error`
 * on that failure, so `result.error` alone can't be trusted; the caller must
 * treat an empty return as "git is required" rather than chdir into it.
 *
 * Exported so tests pinning repo-root version-pin invariants (e.g.
 * node-version-pin.integration.test.mjs) resolve the same root this script
 * uses, rather than guessing one from Vitest's own cwd.
 */
export function repoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    shell: true,
  });
  const root = (result.stdout ?? "").trim();
  return result.error || !root ? "" : root;
}

/**
 * Package-manager install hint for git — the one tool hint needed before
 * REPO_ROOT can resolve (repoRoot() itself needs git), so it can't sit in
 * the node/go hint block below, which only runs once REPO_ROOT is known.
 */
function gitInstallHint() {
  if (WIN32) return "winget install Git.Git (or https://git-scm.com/downloads)";
  if (commandExists("brew")) return "brew install git";
  if (commandExists("apt-get")) return "sudo apt-get install git";
  if (commandExists("dnf")) return "sudo dnf install git";
  if (commandExists("pacman")) return "sudo pacman -S git";
  return "https://git-scm.com/downloads";
}

export function runSetup(argv) {
  const REPO_ROOT = repoRoot();
  if (!REPO_ROOT) {
    console.error(`setup.mjs: git — install it: ${gitInstallHint()}`);
    return 1;
  }
  process.chdir(REPO_ROOT);
  const { ok, warn, fail, section, failedCount } = makeReporter();

  // -------------------------------------------------------------------------
  // Args
  // -------------------------------------------------------------------------
  let checkOnly = false;
  let assumeYes = false;
  for (const arg of argv) {
    if (arg === "--check") checkOnly = true;
    else if (arg === "--yes" || arg === "-y") assumeYes = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      return 0;
    } else {
      console.error(`setup.mjs: unknown option '${arg}' (try --help)`);
      return 2;
    }
  }

  // -------------------------------------------------------------------------
  // Platform guard
  // -------------------------------------------------------------------------
  if (!["linux", "darwin", "win32"].includes(process.platform)) {
    console.error(`Unsupported platform: ${process.platform} (supported: Linux, macOS, Windows)`);
    return 1;
  }

  section("Platform");
  if (process.platform === "linux") {
    let isWsl = false;
    try {
      isWsl = /microsoft/i.test(readFileSync("/proc/version", "utf8"));
    } catch {
      // no /proc/version — not WSL, nothing to detect
    }
    if (isWsl) {
      ok("Linux (WSL2)");
      if (REPO_ROOT.startsWith("/mnt/")) {
        warn(
          `repo lives on the Windows filesystem (${REPO_ROOT}) — clone it under the Linux ` +
            "filesystem (e.g. ~/) or builds and file watching will be painfully slow",
        );
      }
    } else {
      ok("Linux");
    }
  } else if (process.platform === "darwin") {
    ok("macOS");
  } else {
    ok("Windows");
  }

  // -------------------------------------------------------------------------
  // Version pins owned by the repo
  //
  // nodeMin stays the engines.node FLOOR, not an exact pin: a developer on a
  // newer Node than CI's exact version must still pass `--check`. The exact
  // CI/dev pin lives in .node-version at the repo root, read directly by
  // .github/actions/setup/action.yml (and the repo-care workflows) via
  // actions/setup-node's `node-version-file` — this script deliberately does
  // not duplicate that read, since its own check is the looser floor.
  // -------------------------------------------------------------------------
  const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const { nodeMin, pnpmPin } = readVersionPins(pkgJson);
  // .golangci-lint-version at the repo root is this pin's single source
  // (Rule 14) — .github/workflows/ci.yml's "Read the golangci-lint version
  // pin" step reads the same file, so the two can never drift apart the way
  // a restated literal would.
  const golangciLintPinPath = join(REPO_ROOT, ".golangci-lint-version");
  const GOLANGCI_LINT_VERSION = existsSync(golangciLintPinPath)
    ? readFileSync(golangciLintPinPath, "utf8").trim()
    : "";
  if (!nodeMin || !pnpmPin || !GOLANGCI_LINT_VERSION) {
    console.error(
      "setup.mjs: could not read a required version pin — package.json's engines/packageManager " +
        "fields, or the repo-root .golangci-lint-version file. Was one of them changed or removed?",
    );
    return 1;
  }

  // Package-manager hint for the tools this script refuses to install itself
  // (git's hint is computed separately by gitInstallHint(), needed earlier).
  // The Node hints name a MAJOR version, derived from nodeMin (engines.node's
  // floor) rather than .node-version's exact pin: nodeMin is the same number
  // the "is older than the required X" failure message already cites just
  // below, so the install target these hints name always agrees with the
  // requirement the script just stated in the same breath. `.node-version`
  // can move independently of the floor (a newer exact CI pin the floor does
  // not yet demand), and citing it here would risk a hint that asks for a
  // version stricter than what "required" actually means.
  const nodeMajor = nodeMin.split(".")[0];
  let pkgHintNode;
  let pkgHintGo;
  if (WIN32) {
    pkgHintNode = `winget install OpenJS.NodeJS.LTS (>= ${nodeMajor}) or https://nodejs.org`;
    pkgHintGo = "winget install GoLang.Go (or https://go.dev/dl/)";
  } else if (commandExists("brew")) {
    pkgHintNode = `brew install node@${nodeMajor}`;
    pkgHintGo = "brew install go";
  } else if (commandExists("apt-get")) {
    pkgHintNode = `install Node.js ${nodeMajor} via https://github.com/nodesource/distributions or your version manager (fnm/nvm/mise)`;
    pkgHintGo = "sudo apt-get install golang-go (or https://go.dev/dl/)";
  } else if (commandExists("dnf")) {
    pkgHintNode = `sudo dnf install nodejs${nodeMajor} (or your version manager)`;
    pkgHintGo = "sudo dnf install golang";
  } else if (commandExists("pacman")) {
    pkgHintNode = "sudo pacman -S nodejs npm";
    pkgHintGo = "sudo pacman -S go";
  } else {
    pkgHintNode = `https://nodejs.org (>= ${nodeMajor}) or a version manager (fnm/nvm/mise)`;
    pkgHintGo = "https://go.dev/dl/";
  }

  // -------------------------------------------------------------------------
  // Core tools: git, Node.js, pnpm
  // -------------------------------------------------------------------------
  section("Core tools");

  if (commandExists("git")) {
    ok(`git ${firstVersion("git", ["--version"])}`);
  } else {
    fail(`git — install it: ${gitInstallHint()}`);
  }

  let nodeOk = false;
  if (commandExists("node")) {
    const nodeVersion = firstVersion("node", ["--version"]);
    if (verGe(nodeVersion, nodeMin)) {
      ok(`node ${nodeVersion} (>= ${nodeMin})`);
      nodeOk = true;
    } else {
      fail(`node ${nodeVersion} is older than the required ${nodeMin} — upgrade: ${pkgHintNode}`);
    }
  } else {
    fail(`node — install it: ${pkgHintNode}`);
  }

  function installPnpm() {
    if (commandExists("corepack")) {
      // corepack ships with Node and resolves the exact packageManager pin.
      if (!runOk("corepack", ["enable"])) {
        const dir = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".local", "bin");
        runOk("corepack", ["enable", "--install-directory", dir]);
        pathAdd(dir);
      }
    } else if (WIN32) {
      const { cmd, args } = INSTALL_COMMANDS.pnpmWindows(pnpmPin);
      spawnSync(cmd, args, { stdio: "inherit", shell: true });
    } else {
      const { cmd, args } = INSTALL_COMMANDS.pnpmPosix();
      spawnSync(cmd, args, {
        stdio: "inherit",
        env: { ...process.env, PNPM_VERSION: pnpmPin },
      });
      pathAdd(join(process.env.HOME ?? "", ".local", "share", "pnpm"));
    }
  }

  let pnpmOk = false;
  function checkPnpm() {
    if (!commandExists("pnpm")) return false;
    const pnpmVersion = firstVersion("pnpm", ["--version"]);
    // The packageManager field makes pnpm itself (via corepack) or CI enforce
    // the exact pin; here >= is enough to know the install will work.
    return verGe(pnpmVersion, pnpmPin);
  }

  if (checkPnpm()) {
    ok(`pnpm ${firstVersion("pnpm", ["--version"])} (>= ${pnpmPin})`);
    pnpmOk = true;
  } else if (checkOnly) {
    fail(`pnpm >= ${pnpmPin}`);
  } else if (nodeOk && confirm(`pnpm ${pnpmPin} (via corepack or get.pnpm.io)`, assumeYes)) {
    installPnpm();
    if (checkPnpm()) {
      ok(`pnpm ${firstVersion("pnpm", ["--version"])} (installed)`);
      pnpmOk = true;
    } else {
      fail(
        "pnpm — the install did not leave a usable pnpm >= " +
          `${pnpmPin} on PATH (open a new shell and re-run pnpm run setup)`,
      );
    }
  } else {
    fail(
      `pnpm >= ${pnpmPin} — with Node installed: 'corepack enable', or https://pnpm.io/installation`,
    );
  }

  // -------------------------------------------------------------------------
  // Go and Rust. Both are required even before any Go/Rust project exists:
  // dev-cli's scaffold-lib integration tests drive the real `go vet` and
  // `cargo check` on every test run (CI installs both unconditionally for the
  // same reason — see .github/workflows/ci.yml).
  // -------------------------------------------------------------------------
  section("Polyglot toolchains");

  let goOk = false;
  if (commandExists("go")) {
    const goVersion = firstVersion("go", ["version"]);
    if (existsSync(join(REPO_ROOT, "go.work"))) {
      const goWork = readFileSync(join(REPO_ROOT, "go.work"), "utf8");
      const goDirective = goWork.match(/^go ([\d.]+)$/m)?.[1] ?? "?";
      // Go auto-fetches the exact pinned toolchain, so >= the directive is
      // informational; presence is what matters.
      ok(`go ${goVersion} (go.work pins ${goDirective}; Go fetches pinned toolchains itself)`);
    } else {
      ok(`go ${goVersion}`);
    }
    goOk = true;
  } else {
    fail(`go — install it: ${pkgHintGo}`);
  }

  function checkRust() {
    return (
      commandExists("cargo") &&
      runOk("cargo", ["clippy", "--version"]) &&
      runOk("cargo", ["fmt", "--version"])
    );
  }

  if (checkRust()) {
    ok(`rust ${firstVersion("rustc", ["--version"])} with clippy and rustfmt`);
  } else if (checkOnly) {
    fail("rust (rustup stable with clippy and rustfmt)");
  } else if (
    commandExists("rustup") &&
    confirm("the clippy and rustfmt components (rustup component add)", assumeYes)
  ) {
    spawnSync("rustup", ["component", "add", "clippy", "rustfmt"], {
      stdio: "inherit",
      shell: true,
    });
    if (checkRust()) {
      ok(`rust ${firstVersion("rustc", ["--version"])} (components installed)`);
    } else {
      fail("rust — 'rustup component add clippy rustfmt' did not produce working components");
    }
  } else if (!commandExists("rustup") && confirm("rustup (stable toolchain)", assumeYes)) {
    if (WIN32) {
      const { cmd, args } = INSTALL_COMMANDS.rustupWindows();
      spawnSync(cmd, args, { stdio: "inherit", shell: true });
    } else {
      const { cmd, args } = INSTALL_COMMANDS.rustupPosix();
      spawnSync(cmd, args, { stdio: "inherit" });
      pathAdd(join(process.env.HOME ?? "", ".cargo", "bin"));
    }
    if (checkRust()) {
      ok(
        `rust ${firstVersion("rustc", ["--version"])} (installed — ensure the cargo bin directory is on PATH)`,
      );
    } else {
      fail("rust — the rustup install did not leave a working cargo/clippy/rustfmt on PATH");
    }
  } else {
    fail("rust — install rustup (https://rustup.rs), stable profile with clippy and rustfmt");
  }

  // golangci-lint stays keyed off the go.work marker: it only matters once a
  // real Go project (and its lint target) exists. Installed via `go install`
  // on every platform — one method that already works identically on Linux,
  // macOS, and Windows, since Go is a required prerequisite already.
  if (existsSync(join(REPO_ROOT, "go.work"))) {
    function checkGolangci() {
      return (
        commandExists("golangci-lint") && verGe(firstVersion("golangci-lint", ["version"]), "2")
      );
    }
    if (checkGolangci()) {
      ok(`golangci-lint ${firstVersion("golangci-lint", ["version"])}`);
    } else if (checkOnly) {
      fail("golangci-lint v2 (go.work exists, so the Go lint targets need it)");
    } else if (goOk && confirm(`golangci-lint ${GOLANGCI_LINT_VERSION} (go install)`, assumeYes)) {
      spawnSync(
        "go",
        ["install", `github.com/golangci/golangci-lint/cmd/golangci-lint@${GOLANGCI_LINT_VERSION}`],
        { stdio: "inherit", shell: true },
      );
      const gopathResult = spawnSync("go", ["env", "GOPATH"], { encoding: "utf8", shell: true });
      pathAdd(join(gopathResult.stdout.trim(), "bin"));
      if (checkGolangci()) {
        ok(`golangci-lint ${firstVersion("golangci-lint", ["version"])} (installed)`);
      } else {
        fail("golangci-lint — the install did not leave a working v2 binary on PATH");
      }
    } else {
      fail("golangci-lint v2 — https://golangci-lint.run/docs/welcome/install/");
    }
  } else {
    ok("golangci-lint not needed (no go.work at the repo root yet)");
  }

  // uv is baseline like Go and Rust: the workspace is polyglot and uv is the
  // entire Python story (it installs the pinned Python itself; ruff/pyright/
  // pytest run through `uv run`), so a dev machine is Python-ready up front.
  if (commandExists("uv")) {
    ok(`uv ${firstVersion("uv", ["--version"])}`);
  } else if (checkOnly) {
    fail("uv (Python toolchain manager)");
  } else if (confirm("uv", assumeYes)) {
    if (WIN32) {
      const { cmd, args } = INSTALL_COMMANDS.uvWindows();
      spawnSync(cmd, args, { stdio: "inherit", shell: true });
    } else {
      const { cmd, args } = INSTALL_COMMANDS.uvPosix();
      spawnSync(cmd, args, { stdio: "inherit" });
      pathAdd(join(process.env.HOME ?? "", ".local", "bin"));
    }
    if (commandExists("uv")) {
      ok(`uv ${firstVersion("uv", ["--version"])} (installed)`);
    } else {
      fail(
        "uv — the install did not leave uv on PATH (open a new shell and re-run pnpm run setup)",
      );
    }
  } else {
    fail("uv — https://docs.astral.sh/uv/getting-started/installation/");
  }

  // -------------------------------------------------------------------------
  // Repository setup: dependencies, git hooks, test browser
  // -------------------------------------------------------------------------
  section("Repository");

  // Mirrors shared/libs/core-ui/vitest.config.ts: a pre-provisioned Chromium
  // (cloud dev containers) short-circuits the Playwright download.
  function chromiumProvisioned() {
    const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    if (exe && existsSync(exe)) return true;
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (browsersPath && existsSync(join(browsersPath, "chromium"))) return true;
    if (!pnpmOk || !existsSync(join(REPO_ROOT, "node_modules"))) return false;
    const result = spawnSync("pnpm", ["exec", "playwright", "install", "--dry-run", "chromium"], {
      encoding: "utf8",
      shell: true,
    });
    return (result.stdout ?? "").includes("is already installed");
  }

  if (checkOnly) {
    if (existsSync(join(REPO_ROOT, "node_modules"))) {
      ok("dependencies installed (node_modules present)");
    } else {
      fail("dependencies — run pnpm run setup (or pnpm install)");
    }
    const hooksInstalled = existsSync(join(REPO_ROOT, ".git", "hooks", "pre-commit"));
    if (hooksInstalled) {
      ok("git hooks installed (lefthook)");
    } else {
      fail(
        "git hooks — run pnpm run setup (or pnpm install; its prepare script runs lefthook install)",
      );
    }
    if (chromiumProvisioned()) {
      ok("Playwright Chromium provisioned");
    } else {
      fail("Playwright Chromium — run pnpm run setup (or pnpm exec playwright install chromium)");
    }
  } else if (pnpmOk) {
    console.log("  running pnpm install (also installs the git hooks via lefthook) ...");
    const install = spawnSync("pnpm", ["install"], { stdio: "inherit", shell: true });
    if (install.status === 0) {
      ok("dependencies installed");
      const hooksPath = join(REPO_ROOT, ".git", "hooks", "pre-commit");
      if (!existsSync(hooksPath))
        spawnSync("pnpm", ["lefthook", "install"], { stdio: "inherit", shell: true });
      if (existsSync(hooksPath)) {
        ok("git hooks installed (lefthook)");
      } else {
        fail("git hooks — 'pnpm lefthook install' left no .git/hooks/pre-commit");
      }
      if (chromiumProvisioned()) {
        ok("Playwright Chromium already provisioned");
      } else if (
        spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
          stdio: "inherit",
          shell: true,
        }).status === 0
      ) {
        ok("Playwright Chromium installed");
        if (process.platform === "linux") {
          warn(
            "if the e2e run fails on missing system libraries, run: sudo pnpm exec playwright " +
              "install-deps chromium (the only step that needs root, hence not run here)",
          );
        }
      } else {
        fail(
          "Playwright Chromium — 'pnpm exec playwright install chromium' failed (the design-system-e2e Playwright suite needs it)",
        );
      }
    } else {
      fail("dependencies — pnpm install failed (see output above)");
    }
  } else {
    fail("repository setup skipped — it needs a working pnpm (see above)");
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  section("Summary");
  if (failedCount() === 0) {
    ok("everything in place");
    console.log("");
    console.log("Next steps:");
    console.log("  pnpm nx run design-system:serve                   # design-system Storybook");
    console.log("  pnpm nx affected -t lint test typecheck build e2e # definition of done");
    return 0;
  }
  console.log(
    `  ${C_ERR}${failedCount()} problem(s)${C_OFF} — fix the lines marked missing above, then re-run pnpm run setup`,
  );
  return 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(runSetup(process.argv.slice(2)));
