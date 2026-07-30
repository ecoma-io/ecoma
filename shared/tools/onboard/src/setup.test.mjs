import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INSTALL_COMMANDS, runSetup, verGe } from "./setup.mjs";

// Real side effects (installing toolchains, writing to the filesystem,
// spawning `pnpm install`/Playwright) are exactly what this suite must never
// do — mock the two boundaries `setup.mjs` touches, the same convention
// `dev-cli` uses for scripts with real side effects (see e.g.
// `check-project-conventions.test.mjs`, `run-e2e.test.mjs`).
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  readSync: vi.fn(),
}));

const REPO_ROOT = "/repo";
const BIN_DIR = "/usr/bin";
const HOME_DIR = "/home/dev";
const DEFAULT_PRESENT = ["git", "node", "pnpm", "go", "cargo", "uv"];
// PATHEXT suffixes `commandExists` appends on Windows; the fixture strips them
// so one `present` set describes a fake PATH on either platform.
const WIN_EXT_RE = /\.(exe|cmd|bat|com)$/i;
const ESC = "\u001b";
const ANSI_RE = new RegExp(`${ESC}\\[\\d+m`, "g");

const PACKAGE_JSON = JSON.stringify({
  engines: { node: ">=22" },
  packageManager: "pnpm@10.32.1",
});

/**
 * Descriptor-restoring stub for the `process` properties `vi.stubEnv` cannot
 * reach (`platform`, `stdout.isTTY`, `stdin.isTTY`). Restores run in `afterEach`.
 */
const propertyRestores = [];
function stubProperty(target, key, value) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  propertyRestores.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete target[key];
  });
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

function restoreStubbedProperties() {
  while (propertyRestores.length > 0) propertyRestores.pop()();
}

/**
 * Returns `runSetup` from a freshly evaluated module instance.
 *
 * `setup.mjs` freezes two facts at module load — `WIN32` and the ANSI colour
 * constants derived from `process.stdout.isTTY` — while reading
 * `process.platform` again at call time elsewhere (the platform guard, the
 * Linux/macOS branches, the Playwright hint). Stubbing the platform without
 * reloading therefore yields an impossible hybrid: the call-time reads see
 * Windows while the six `WIN32`-gated branches still see the host platform.
 * Reloading after the stub is what makes a Windows assertion mean anything.
 */
async function loadSetup({ platform, stdoutIsTTY } = {}) {
  if (platform !== undefined) stubProperty(process, "platform", platform);
  if (stdoutIsTTY !== undefined) stubProperty(process.stdout, "isTTY", stdoutIsTTY);
  vi.resetModules();
  return (await import("./setup.mjs")).runSetup;
}

/**
 * Wires `spawnSync`/`existsSync`/`readFileSync`/`readSync` to a small in-memory
 * fixture: `present` is the set of command basenames that exist on a single
 * fake PATH entry, so `commandExists` (a real PATH scan against `existsSync`)
 * resolves the way each test needs without touching a real filesystem.
 * `process.chdir` is stubbed too — `runSetup` calls it unconditionally as its
 * first action, and letting it run for real would move this test process's
 * actual cwd.
 *
 * Returns the mutable `state` the mocks read, and takes an `onSpawn` hook, so a
 * test covering an installer can make the tool appear exactly when its install
 * command runs. That is the difference between "the installer was invoked" and
 * "the installer worked" — two outcomes `setup.mjs` reports differently.
 */
function fixture({
  present = DEFAULT_PRESENT,
  goWork = false,
  goWorkText = "go 1.23\n",
  nodeModules = true,
  gitHooks = true,
  chromiumExecutable = "/fake/chromium",
  browsersPath = "",
  repoRootPath = REPO_ROOT,
  procVersion = null,
  nodeVersion = "22.10.0",
  pnpmVersion = "10.32.1",
  golangciVersion = "2.5.0",
  // The repo-root pin file setup.mjs now reads instead of hardcoding
  // GOLANGCI_LINT_VERSION; null simulates it being missing from the repo.
  golangciLintVersionFile = "v2.5.0",
  claudeEnvFile = "",
  stdinReplies = [],
  spawn = {},
  onSpawn = () => {},
  // Overridable so a test can prove the Node install hints are DERIVED from
  // engines.node rather than merely matching it by coincidence — see "names
  // the Node install hint's major version from engines.node, not a fixed 22".
  packageJson = PACKAGE_JSON,
} = {}) {
  const state = {
    present: new Set(present),
    goWork,
    nodeModules,
    gitHooks,
    chromiumExecutable,
    browsersPath,
  };

  vi.stubEnv("PATH", BIN_DIR);
  vi.stubEnv("HOME", HOME_DIR);
  vi.stubEnv("CLAUDE_ENV_FILE", claudeEnvFile);
  vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE", chromiumExecutable ?? "");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", browsersPath);
  vi.spyOn(process, "chdir").mockImplementation(() => {});

  vi.mocked(existsSync).mockImplementation((p) => {
    const path = String(p);
    if (state.chromiumExecutable && path === state.chromiumExecutable) return true;
    if (state.browsersPath && path === join(state.browsersPath, "chromium")) return true;
    if (path.startsWith(`${BIN_DIR}/`)) {
      const base = path.slice(BIN_DIR.length + 1);
      return state.present.has(base) || state.present.has(base.replace(WIN_EXT_RE, ""));
    }
    if (path.endsWith("/go.work")) return state.goWork;
    if (path.endsWith("/node_modules")) return state.nodeModules;
    if (path.endsWith(".git/hooks/pre-commit")) return state.gitHooks;
    if (path.endsWith(".golangci-lint-version")) return golangciLintVersionFile !== null;
    return false;
  });

  vi.mocked(readFileSync).mockImplementation((p) => {
    const path = String(p);
    if (path === "/proc/version") {
      if (procVersion === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return procVersion;
    }
    if (path.endsWith("package.json")) return packageJson;
    if (path.endsWith("go.work")) return goWorkText;
    if (path.endsWith(".golangci-lint-version") && golangciLintVersionFile !== null)
      return `${golangciLintVersionFile}\n`;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  });

  const replies = [...stdinReplies];
  vi.mocked(readSync).mockImplementation((_fd, buf) => {
    if (replies.length === 0) return 0;
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return buf.write(next, "utf8");
  });

  vi.mocked(spawnSync).mockImplementation((cmd, args = []) => {
    const key = `${cmd} ${args.join(" ")}`.trim();
    const table = {
      "git rev-parse --show-toplevel": { stdout: `${repoRootPath}\n` },
      "git --version": { stdout: "git version 2.43.0\n" },
      "node --version": { stdout: `v${nodeVersion}\n` },
      "pnpm --version": { stdout: `${pnpmVersion}\n` },
      "go version": { stdout: "go version go1.23.0 linux/amd64\n" },
      "go env GOPATH": { stdout: `${HOME_DIR}/go\n` },
      "cargo clippy --version": { status: 0, error: null },
      "cargo fmt --version": { status: 0, error: null },
      "rustc --version": { stdout: "rustc 1.82.0 (abcdef 2024-01-01)\n" },
      "golangci-lint version": { stdout: `golangci-lint has version ${golangciVersion}\n` },
      "uv --version": { stdout: "uv 0.5.0\n" },
      "corepack enable": { status: 0, error: null },
      "pnpm install": { status: 0, error: null },
      "pnpm lefthook install": { status: 0, error: null },
      "pnpm exec playwright install --dry-run chromium": { stdout: "" },
      "pnpm exec playwright install chromium": { status: 0, error: null },
      ...spawn,
    };
    const entry = table[key];
    const result =
      typeof entry === "function"
        ? entry(state)
        : (entry ?? { stdout: "", status: 1, error: null });
    onSpawn(key, state);
    return result;
  });

  return state;
}

/**
 * Everything `runSetup` wrote through `console.log`, joined and stripped of
 * ANSI colour codes — assertions here are about the message, not the colouring
 * (which "emits ANSI colour codes only when stdout is a terminal" pins on its
 * own, against the raw stream).
 */
function captureLog() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return () => log.mock.calls.flat().join("\n").replace(ANSI_RE, "");
}

/** Every command `runSetup` spawned, as `"cmd arg arg"` strings. */
function spawnedCommands() {
  return vi.mocked(spawnSync).mock.calls.map(([cmd, args]) => `${cmd} ${(args ?? []).join(" ")}`);
}

/**
 * One of `setup.mjs`'s install commands in the `"cmd arg arg"` form that both
 * `spawnedCommands()` and the fixture's `onSpawn` key use, so a test matches an
 * installer by whole-command equality. Substring-matching a host would not
 * distinguish the installers `setup.mjs` picks between — `rustup.rs` sits
 * inside `sh.rustup.rs`, `win.rustup.rs` and the `https://rustup.rs` hint
 * alike — and would keep matching if the command around it changed, which is
 * how a negative assertion quietly stops proving anything.
 */
function commandLine({ cmd, args }) {
  return `${cmd} ${args.join(" ")}`;
}

function resetBetweenTests() {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restoreStubbedProperties();
}

describe("runSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("derives the repo root from git instead of this file's own location, and chdirs into it", () => {
    fixture();
    runSetup(["--check"]);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(process.chdir).toHaveBeenCalledWith(REPO_ROOT);
  });

  it("--check succeeds with exit code 0 when every tool and the repo are already provisioned", () => {
    fixture();
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(0);
    expect(log()).toContain("everything in place");
  });

  it("--check reports node as missing and fails when the binary is absent from PATH", () => {
    fixture({ present: ["git", "pnpm", "go", "cargo", "uv"] });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("node — install it");
  });

  it("--check skips golangci-lint entirely when go.work does not exist", () => {
    fixture({ goWork: false });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(0);
    expect(log()).toContain("golangci-lint not needed");
  });

  it("--check requires golangci-lint once go.work exists, and fails when it is missing", () => {
    fixture({ goWork: true });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("golangci-lint v2");
  });

  it("--check passes once golangci-lint is present alongside go.work", () => {
    fixture({ goWork: true, present: [...DEFAULT_PRESENT, "golangci-lint"] });
    expect(runSetup(["--check"])).toBe(0);
  });

  it("fails loudly instead of silently falling back when .golangci-lint-version is missing from the repo root", () => {
    fixture({ golangciLintVersionFile: null });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(".golangci-lint-version"));
  });

  it("--check fails when node is older than the version pinned in package.json", () => {
    fixture({ nodeVersion: "18.19.0" });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("older than the required");
  });

  it("--check never installs anything or spawns pnpm install", () => {
    fixture();
    captureLog();
    runSetup(["--check"]);
    const calls = spawnedCommands();
    expect(calls.some((c) => c.startsWith("pnpm install"))).toBe(false);
    expect(calls.some((c) => c.includes("playwright install"))).toBe(false);
  });

  it("--help prints usage and returns 0 without touching PATH-based tool checks", () => {
    fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runSetup(["--help"])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: pnpm run setup"));
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("rejects an unknown flag with exit code 2", () => {
    fixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runSetup(["--bogus"])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("unknown option '--bogus'"));
  });

  it("accepts -y as the short form of --yes", () => {
    fixture({ present: ["git", "node", "go", "cargo", "uv", "corepack"] });
    captureLog();
    runSetup(["-y"]);
    expect(spawnedCommands()).toContain("corepack enable");
  });

  it("accepts -h as the short form of --help", () => {
    fixture();
    const log = captureLog();
    expect(runSetup(["-h"])).toBe(0);
    expect(log()).toContain("Usage: pnpm run setup");
  });

  it("reports git as missing and exits cleanly instead of crashing when spawnSync can't resolve it", () => {
    // Regression: spawnSync (shell: true) doesn't always set `result.error`
    // when git is unresolvable — it can return an empty stdout with no error
    // field. repoRoot() must treat that as failure too, or runSetup would
    // chdir into "" and throw an uncaught ENOENT.
    fixture();
    vi.mocked(spawnSync).mockImplementation((cmd, args = []) => {
      const key = `${cmd} ${args.join(" ")}`.trim();
      if (key === "git rev-parse --show-toplevel") return { stdout: "" };
      return { stdout: "", status: 1, error: null };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => runSetup(["--check"])).not.toThrow();
    expect(runSetup(["--check"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("git — install it"));
    expect(process.chdir).not.toHaveBeenCalled();
  });

  it("reports git as missing when the git spawn fails outright and returns no stdout field", () => {
    fixture({ spawn: { "git rev-parse --show-toplevel": { error: new Error("ENOENT") } } });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("git — install it"));
    expect(process.chdir).not.toHaveBeenCalled();
  });

  it("refuses an unsupported platform with exit code 1", () => {
    fixture();
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "sunos", configurable: true });
    try {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(runSetup([])).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform"));
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });
});

describe("version comparison", () => {
  it("counts a version part the shorter operand omits as zero, on either side", () => {
    expect(verGe("22", "22.0.0")).toBe(true);
    expect(verGe("22.0.0", "22")).toBe(true);
    expect(verGe("22", "22.1")).toBe(false);
    expect(verGe("22.1", "22")).toBe(true);
  });
});

describe("PATH lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("skips an empty PATH entry instead of resolving a tool against the working directory", () => {
    fixture();
    // A duplicated/trailing separator yields empty segments; joining a command
    // name onto one probes a relative path, i.e. whatever sits in the cwd.
    vi.stubEnv("PATH", `${BIN_DIR}::`);
    captureLog();
    expect(runSetup(["--check"])).toBe(0);
    expect(vi.mocked(existsSync).mock.calls.map(([p]) => String(p))).not.toContain("git");
  });

  it("reports a tool as present even when its version banner carries no version number", () => {
    fixture({ spawn: { "git --version": { stdout: "git (unknown build)\n" } } });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(0);
    expect(log().split("\n")).toContain("  ok      git ");
  });
});

describe("platform detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("names WSL2 separately from plain Linux when /proc/version identifies a Microsoft kernel", async () => {
    const setup = await loadSetup({ platform: "linux" });
    fixture({ procVersion: "Linux version 5.15.0-microsoft-standard-WSL2 #1 SMP\n" });
    const log = captureLog();
    expect(setup(["--check"])).toBe(0);
    expect(log()).toContain("Linux (WSL2)");
  });

  it("warns a WSL2 developer whose clone sits on the mounted Windows filesystem", async () => {
    const setup = await loadSetup({ platform: "linux" });
    fixture({
      procVersion: "Linux version 5.15.0-microsoft-standard-WSL2\n",
      repoRootPath: "/mnt/c/dev/ecoma",
    });
    const log = captureLog();
    setup(["--check"]);
    expect(log()).toContain("repo lives on the Windows filesystem (/mnt/c/dev/ecoma)");
  });

  it("leaves a WSL2 clone on the Linux filesystem unwarned", async () => {
    const setup = await loadSetup({ platform: "linux" });
    fixture({
      procVersion: "Linux version 5.15.0-microsoft-standard-WSL2\n",
      repoRootPath: "/home/dev/ecoma",
    });
    const log = captureLog();
    setup(["--check"]);
    expect(log()).toContain("Linux (WSL2)");
    expect(log()).not.toContain("repo lives on the Windows filesystem");
  });

  it("recognises macOS and names Homebrew for the runtimes it refuses to install itself", async () => {
    const setup = await loadSetup({ platform: "darwin" });
    fixture({ present: ["brew", "pnpm", "cargo", "uv"] });
    const log = captureLog();
    expect(setup(["--check"])).toBe(1);
    expect(log()).toContain("macOS");
    expect(log()).toContain("brew install git");
    expect(log()).toContain("brew install node@22");
    expect(log()).toContain("brew install go");
  });

  it.each([
    ["apt-get", "sudo apt-get install git", "nodesource", "sudo apt-get install golang-go"],
    ["dnf", "sudo dnf install git", "sudo dnf install nodejs22", "sudo dnf install golang"],
    ["pacman", "sudo pacman -S git", "sudo pacman -S nodejs npm", "sudo pacman -S go"],
  ])(
    "names %s as the way to install the runtimes it refuses to install itself",
    (manager, gitHint, nodeHint, goHint) => {
      fixture({ present: [manager, "pnpm", "cargo", "uv"] });
      const log = captureLog();
      expect(runSetup(["--check"])).toBe(1);
      expect(log()).toContain(gitHint);
      expect(log()).toContain(nodeHint);
      expect(log()).toContain(goHint);
    },
  );

  it.each([
    ["brew", "brew install node@24"],
    ["apt-get", "install Node.js 24 via"],
    ["dnf", "sudo dnf install nodejs24 (or your version manager)"],
  ])(
    "derives the Node install hint's major version from engines.node rather than a fixed 22 (%s)",
    (manager, nodeHint) => {
      fixture({
        present: [manager, "pnpm", "cargo", "uv"],
        packageJson: JSON.stringify({ engines: { node: ">=24" }, packageManager: "pnpm@10.32.1" }),
      });
      const log = captureLog();
      expect(runSetup(["--check"])).toBe(1);
      expect(log()).toContain(nodeHint);
      expect(log()).not.toContain("22");
    },
  );

  it("emits ANSI colour codes only when stdout is a terminal", async () => {
    const onTerminal = await loadSetup({ stdoutIsTTY: true });
    fixture();
    const terminalLog = vi.spyOn(console, "log").mockImplementation(() => {});
    onTerminal(["--check"]);
    expect(terminalLog.mock.calls.flat().join("\n")).toContain(ESC);

    vi.restoreAllMocks();
    const piped = await loadSetup({ stdoutIsTTY: false });
    fixture();
    const pipedLog = vi.spyOn(console, "log").mockImplementation(() => {});
    piped(["--check"]);
    expect(pipedLog.mock.calls.flat().join("\n")).not.toContain(ESC);
  });
});

describe("Windows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("names the winget commands for the runtimes it refuses to install itself", async () => {
    const setup = await loadSetup({ platform: "win32" });
    fixture({ present: ["pnpm", "cargo", "uv"] });
    const log = captureLog();
    expect(setup(["--check"])).toBe(1);
    expect(log()).toContain("Windows");
    expect(log()).toContain("winget install Git.Git");
    expect(log()).toContain("winget install OpenJS.NodeJS.LTS");
    expect(log()).toContain("winget install GoLang.Go");
  });

  it("derives the winget Node hint's major version from engines.node rather than a fixed 22", async () => {
    const setup = await loadSetup({ platform: "win32" });
    fixture({
      present: ["pnpm", "cargo", "uv"],
      packageJson: JSON.stringify({ engines: { node: ">=24" }, packageManager: "pnpm@10.32.1" }),
    });
    const log = captureLog();
    expect(setup(["--check"])).toBe(1);
    expect(log()).toContain("winget install OpenJS.NodeJS.LTS (>= 24)");
  });

  it("appends every PATHEXT extension when resolving a command on PATH", async () => {
    const setup = await loadSetup({ platform: "win32" });
    fixture({ present: ["git", "pnpm", "cargo", "uv"] });
    vi.stubEnv("PATHEXT", ".EXE;.CMD");
    captureLog();
    setup(["--check"]);
    const probed = vi.mocked(existsSync).mock.calls.map(([p]) => String(p));
    expect(probed).toContain(`${BIN_DIR}/git.EXE`);
    // node is absent, so the scan must have tried both extensions before giving up.
    expect(probed).toContain(`${BIN_DIR}/node.EXE`);
    expect(probed).toContain(`${BIN_DIR}/node.CMD`);
  });

  it("installs pnpm with the official PowerShell installer rather than curl piped into sh", async () => {
    const setup = await loadSetup({ platform: "win32" });
    fixture({ present: ["git", "node", "go", "cargo", "uv"] });
    captureLog();
    setup(["--yes"]);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining([expect.stringContaining("get.pnpm.io/install.ps1")]),
      expect.anything(),
    );
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining([expect.stringContaining("$env:PNPM_VERSION='10.32.1'")]),
      expect.anything(),
    );
    expect(spawnedCommands().some((c) => c.startsWith("sh -c"))).toBe(false);
  });

  it("installs rustup from win.rustup.rs rather than the shell installer", async () => {
    const setup = await loadSetup({ platform: "win32" });
    fixture({ present: ["git", "node", "pnpm", "go", "uv"] });
    captureLog();
    setup(["--yes"]);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining([expect.stringContaining("https://win.rustup.rs/x86_64")]),
      expect.anything(),
    );
    expect(spawnedCommands()).not.toContain(commandLine(INSTALL_COMMANDS.rustupPosix()));
  });

  it("installs uv from its PowerShell install script rather than its shell one", async () => {
    const setup = await loadSetup({ platform: "win32" });
    fixture({ present: ["git", "node", "pnpm", "go", "cargo"] });
    captureLog();
    setup(["--yes"]);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining([expect.stringContaining("astral.sh/uv/install.ps1")]),
      expect.anything(),
    );
    expect(spawnedCommands()).not.toContain(commandLine(INSTALL_COMMANDS.uvPosix()));
  });
});

describe("install consent", () => {
  const withoutPnpm = ["git", "node", "go", "cargo", "uv", "corepack"];

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("asks before installing and proceeds when the answer is yes", () => {
    fixture({ present: withoutPnpm, stdinReplies: ["y\n"] });
    stubProperty(process.stdin, "isTTY", true);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captureLog();
    runSetup([]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("install pnpm 10.32.1"));
    expect(spawnedCommands()).toContain("corepack enable");
  });

  it("installs nothing when the answer is not yes", () => {
    fixture({ present: withoutPnpm, stdinReplies: ["n\n"] });
    stubProperty(process.stdin, "isTTY", true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = captureLog();
    expect(runSetup([])).toBe(1);
    expect(spawnedCommands()).not.toContain("corepack enable");
    expect(log()).toContain("https://pnpm.io/installation");
  });

  it("reads a reply that arrives in several chunks before deciding", () => {
    fixture({ present: withoutPnpm, stdinReplies: ["y", "es\n"] });
    stubProperty(process.stdin, "isTTY", true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captureLog();
    runSetup([]);
    expect(spawnedCommands()).toContain("corepack enable");
  });

  it("declines rather than blocking when stdin closes without a reply", () => {
    fixture({ present: withoutPnpm, stdinReplies: [] });
    stubProperty(process.stdin, "isTTY", true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captureLog();
    expect(runSetup([])).toBe(1);
    expect(spawnedCommands()).not.toContain("corepack enable");
  });

  it("declines rather than crashing when reading stdin throws", () => {
    fixture({
      present: withoutPnpm,
      stdinReplies: [Object.assign(new Error("EAGAIN"), { code: "EAGAIN" })],
    });
    stubProperty(process.stdin, "isTTY", true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captureLog();
    expect(runSetup([])).toBe(1);
    expect(spawnedCommands()).not.toContain("corepack enable");
  });

  it("installs nothing when stdin is not a terminal and --yes was not passed", () => {
    fixture({ present: withoutPnpm });
    stubProperty(process.stdin, "isTTY", false);
    const log = captureLog();
    expect(runSetup([])).toBe(1);
    expect(spawnedCommands()).not.toContain("corepack enable");
    expect(log()).toContain("repository setup skipped");
  });
});

describe("pnpm provisioning", () => {
  const withoutPnpm = ["git", "node", "go", "cargo", "uv"];
  const appearsAfter = (trigger) => (key, state) => {
    if (key === trigger) state.present.add("pnpm");
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("--check reports a missing pnpm instead of installing it", () => {
    fixture({ present: withoutPnpm });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("missing pnpm >= 10.32.1");
    expect(spawnedCommands()).not.toContain("corepack enable");
  });

  it("--check reports a pnpm older than the packageManager pin as missing", () => {
    fixture({ pnpmVersion: "9.0.0" });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("missing pnpm >= 10.32.1");
  });

  it("prefers corepack, which resolves the exact packageManager pin", () => {
    fixture({
      present: [...withoutPnpm, "corepack"],
      onSpawn: appearsAfter("corepack enable"),
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(log()).toContain("pnpm 10.32.1 (installed)");
    expect(spawnedCommands()).not.toContain(commandLine(INSTALL_COMMANDS.pnpmPosix()));
  });

  it("retries corepack into a user-writable directory and puts that directory on PATH", () => {
    const userBin = join(HOME_DIR, ".local", "bin");
    fixture({
      present: [...withoutPnpm, "corepack"],
      claudeEnvFile: "/session/env.sh",
      spawn: { "corepack enable": { status: 1, error: null } },
      onSpawn: appearsAfter(`corepack enable --install-directory ${userBin}`),
    });
    captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "corepack",
      ["enable", "--install-directory", userBin],
      expect.anything(),
    );
    expect(process.env.PATH.startsWith(`${userBin}:`)).toBe(true);
    // Inside a Claude Code session the PATH addition must outlive this process.
    expect(vi.mocked(appendFileSync)).toHaveBeenCalledWith(
      "/session/env.sh",
      `export PATH="${userBin}:$PATH"\n`,
    );
  });

  it("falls back to USERPROFILE for corepack's install directory when HOME is unset", () => {
    // Windows sets USERPROFILE rather than HOME; without the fallback the
    // retry directory would resolve to the filesystem root.
    const userBin = join("C:/Users/dev", ".local", "bin");
    fixture({
      present: [...withoutPnpm, "corepack"],
      spawn: { "corepack enable": { status: 1, error: null } },
      onSpawn: appearsAfter(`corepack enable --install-directory ${userBin}`),
    });
    vi.stubEnv("HOME", undefined);
    vi.stubEnv("USERPROFILE", "C:/Users/dev");
    captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "corepack",
      ["enable", "--install-directory", userBin],
      expect.anything(),
    );
  });

  it("falls back to the get.pnpm.io script pinned to packageManager when corepack is absent", () => {
    fixture({
      present: withoutPnpm,
      onSpawn: appearsAfter(commandLine(INSTALL_COMMANDS.pnpmPosix())),
    });
    captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("get.pnpm.io/install.sh")],
      expect.objectContaining({ env: expect.objectContaining({ PNPM_VERSION: "10.32.1" }) }),
    );
  });

  it("reports the install as failed when it leaves no usable pnpm on PATH", () => {
    fixture({ present: [...withoutPnpm, "corepack"] });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("the install did not leave a usable pnpm");
  });

  it("does not offer to install pnpm when Node itself is missing", () => {
    fixture({ present: ["git", "go", "cargo", "uv", "corepack"] });
    captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(spawnedCommands()).not.toContain("corepack enable");
  });
});

describe("Rust provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("--check reports a cargo without clippy and rustfmt as an incomplete toolchain", () => {
    fixture({ spawn: { "cargo clippy --version": { status: 1, error: null } } });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("rust (rustup stable with clippy and rustfmt)");
  });

  it("adds the missing components through rustup instead of reinstalling the toolchain", () => {
    fixture({
      present: [...DEFAULT_PRESENT, "rustup"],
      spawn: {
        "cargo fmt --version": (state) =>
          state.present.has("rustfmt") ? { status: 0, error: null } : { status: 1, error: null },
      },
      onSpawn: (key, state) => {
        if (key === "rustup component add clippy rustfmt") state.present.add("rustfmt");
      },
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(spawnedCommands()).toContain("rustup component add clippy rustfmt");
    expect(log()).toContain("(components installed)");
    expect(spawnedCommands()).not.toContain(commandLine(INSTALL_COMMANDS.rustupPosix()));
  });

  it("reports a component add that did not produce working components", () => {
    fixture({
      present: [...DEFAULT_PRESENT, "rustup"],
      spawn: { "cargo fmt --version": { status: 1, error: null } },
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("did not produce working components");
  });

  it("installs rustup without letting it edit shell profiles, and puts cargo's bin on PATH", () => {
    const cargoBin = join(HOME_DIR, ".cargo", "bin");
    fixture({
      present: ["git", "node", "pnpm", "go", "uv"],
      onSpawn: (key, state) => {
        if (key === commandLine(INSTALL_COMMANDS.rustupPosix())) state.present.add("cargo");
      },
    });
    captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "sh",
      ["-c", expect.stringContaining("--no-modify-path")],
      expect.anything(),
    );
    expect(process.env.PATH.startsWith(`${cargoBin}:`)).toBe(true);
  });

  it("reports a rustup install that left no working cargo on PATH", () => {
    fixture({ present: ["git", "node", "pnpm", "go", "uv"] });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("the rustup install did not leave a working cargo");
  });

  it("points at rustup.rs when the developer declines the install", () => {
    fixture({ present: ["git", "node", "pnpm", "go", "uv"] });
    stubProperty(process.stdin, "isTTY", false);
    const log = captureLog();
    expect(runSetup([])).toBe(1);
    expect(log()).toContain("install rustup (https://rustup.rs)");
  });
});

describe("golangci-lint provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("installs the exact version the repo-root pin file names, and adds GOPATH/bin to PATH", () => {
    fixture({
      goWork: true,
      golangciLintVersionFile: "v2.6.1",
      onSpawn: (key, state) => {
        if (key.startsWith("go install")) state.present.add("golangci-lint");
      },
    });
    captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "go",
      ["install", "github.com/golangci/golangci-lint/cmd/golangci-lint@v2.6.1"],
      expect.anything(),
    );
    expect(process.env.PATH.startsWith(`${join(HOME_DIR, "go", "bin")}:`)).toBe(true);
  });

  it("reports a go install that left no working v2 binary on PATH", () => {
    fixture({ goWork: true });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("did not leave a working v2 binary");
  });

  it("rejects a golangci-lint older than v2 even when the binary is on PATH", () => {
    fixture({
      goWork: true,
      present: [...DEFAULT_PRESENT, "golangci-lint"],
      golangciVersion: "1.64.0",
    });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("golangci-lint v2 (go.work exists");
  });

  it("does not offer the go install when Go itself is missing", () => {
    fixture({ goWork: true, present: ["git", "node", "pnpm", "cargo", "uv"] });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(spawnedCommands().some((c) => c.startsWith("go install"))).toBe(false);
    expect(log()).toContain("golangci-lint v2 — https://golangci-lint.run");
  });

  it("reports the go.work directive as unknown instead of failing when the file declares none", () => {
    fixture({
      goWork: true,
      goWorkText: "use ./svc\n",
      present: [...DEFAULT_PRESENT, "golangci-lint"],
    });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(0);
    expect(log()).toContain("go.work pins ?");
  });
});

describe("uv provisioning", () => {
  const withoutUv = ["git", "node", "pnpm", "go", "cargo"];

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("--check reports a missing uv instead of installing it", () => {
    fixture({ present: withoutUv });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    expect(log()).toContain("uv (Python toolchain manager)");
    expect(spawnedCommands()).not.toContain(commandLine(INSTALL_COMMANDS.uvPosix()));
  });

  it("installs uv from astral.sh and persists its bin directory for the rest of the session", () => {
    const userBin = join(HOME_DIR, ".local", "bin");
    fixture({
      present: withoutUv,
      claudeEnvFile: "/session/env.sh",
      onSpawn: (key, state) => {
        if (key === commandLine(INSTALL_COMMANDS.uvPosix())) state.present.add("uv");
      },
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(log()).toContain("uv 0.5.0 (installed)");
    expect(process.env.PATH.startsWith(`${userBin}:`)).toBe(true);
    expect(vi.mocked(appendFileSync)).toHaveBeenCalledWith(
      "/session/env.sh",
      `export PATH="${userBin}:$PATH"\n`,
    );
  });

  it("reports an install that left uv off PATH", () => {
    fixture({ present: withoutUv });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("the install did not leave uv on PATH");
  });

  it("points at the uv install docs when the developer declines", () => {
    fixture({ present: withoutUv });
    stubProperty(process.stdin, "isTTY", false);
    const log = captureLog();
    expect(runSetup([])).toBe(1);
    expect(log()).toContain("uv — https://docs.astral.sh/uv/getting-started/installation/");
  });
});

describe("repository setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(resetBetweenTests);

  it("installs dependencies, git hooks and Chromium, and never asks for root to do it", () => {
    fixture({ chromiumExecutable: null });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    const calls = spawnedCommands();
    expect(calls).toContain("pnpm install");
    expect(calls).toContain("pnpm exec playwright install chromium");
    expect(log()).toContain("Playwright Chromium installed");
    expect(calls.some((c) => c.startsWith("sudo"))).toBe(false);
  });

  it("tells a Linux developer how to install Chromium's system libraries, the one step needing root", () => {
    fixture({ chromiumExecutable: null });
    const log = captureLog();
    runSetup(["--yes"]);
    expect(log()).toContain("sudo pnpm exec playwright install-deps chromium");
  });

  it("installs the git hooks itself when pnpm install left none behind", () => {
    fixture({
      gitHooks: false,
      onSpawn: (key, state) => {
        if (key === "pnpm lefthook install") state.gitHooks = true;
      },
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(spawnedCommands()).toContain("pnpm lefthook install");
    expect(log()).toContain("git hooks installed (lefthook)");
  });

  it("fails when lefthook install leaves no pre-commit hook behind", () => {
    fixture({ gitHooks: false });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("left no .git/hooks/pre-commit");
  });

  it("stops at a failed pnpm install instead of reporting hooks and Chromium as done", () => {
    fixture({ spawn: { "pnpm install": { status: 1, error: null } } });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("pnpm install failed");
    expect(spawnedCommands().some((c) => c.includes("playwright install"))).toBe(false);
  });

  it("reports a failed Playwright download, naming the suite that needs the browser", () => {
    fixture({
      chromiumExecutable: null,
      spawn: { "pnpm exec playwright install chromium": { status: 1, error: null } },
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(1);
    expect(log()).toContain("design-system-e2e");
  });

  it("skips the Chromium download when PLAYWRIGHT_CHROMIUM_EXECUTABLE points at one", () => {
    fixture();
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(log()).toContain("Playwright Chromium already provisioned");
    expect(spawnedCommands().some((c) => c.includes("playwright install"))).toBe(false);
  });

  it("skips the Chromium download when PLAYWRIGHT_BROWSERS_PATH already holds one", () => {
    fixture({ chromiumExecutable: null, browsersPath: "/opt/browsers" });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(log()).toContain("Playwright Chromium already provisioned");
    expect(spawnedCommands().some((c) => c.includes("playwright install"))).toBe(false);
  });

  it("asks Playwright itself whether Chromium is installed when no environment override names one", () => {
    fixture({
      chromiumExecutable: null,
      spawn: {
        "pnpm exec playwright install --dry-run chromium": {
          stdout: "browser: chromium\n  /ms-playwright/chromium is already installed\n",
        },
      },
    });
    const log = captureLog();
    expect(runSetup(["--yes"])).toBe(0);
    expect(log()).toContain("Playwright Chromium already provisioned");
    expect(spawnedCommands()).not.toContain("pnpm exec playwright install chromium");
  });

  it("does not ask Playwright anything before the dependencies it would run from exist", () => {
    fixture({ chromiumExecutable: null, nodeModules: false });
    captureLog();
    runSetup(["--check"]);
    expect(spawnedCommands().some((c) => c.includes("playwright install --dry-run"))).toBe(false);
  });

  it("--check reports each unprovisioned part of the repository separately", () => {
    fixture({ chromiumExecutable: null, nodeModules: false, gitHooks: false });
    const log = captureLog();
    expect(runSetup(["--check"])).toBe(1);
    const output = log();
    expect(output).toContain("dependencies — run pnpm run setup");
    expect(output).toContain("git hooks — run pnpm run setup");
    expect(output).toContain("Playwright Chromium — run pnpm run setup");
  });
});
