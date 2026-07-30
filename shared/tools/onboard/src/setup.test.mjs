import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSetup } from "./setup.mjs";

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

const PACKAGE_JSON = JSON.stringify({
  engines: { node: ">=22" },
  packageManager: "pnpm@10.32.1",
});

/**
 * Wires `spawnSync`/`existsSync`/`readFileSync` to a small in-memory fixture:
 * `present` is the set of command basenames that exist on a single fake PATH
 * entry, so `commandExists` (a real PATH scan against `existsSync`) resolves
 * the way each test needs without touching a real filesystem. `process.chdir`
 * is stubbed too — `runSetup` calls it unconditionally as its first action,
 * and letting it run for real would move this test process's actual cwd.
 */
function fixture({
  present = new Set(["git", "node", "pnpm", "go", "cargo", "uv"]),
  goWork = false,
  nodeModules = true,
  gitHooks = true,
  chromiumExecutable = "/fake/chromium",
  nodeVersion = "22.10.0",
  pnpmVersion = "10.32.1",
  golangciVersion = "2.5.0",
} = {}) {
  vi.stubEnv("PATH", BIN_DIR);
  vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE", chromiumExecutable);
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "");
  vi.spyOn(process, "chdir").mockImplementation(() => {});

  vi.mocked(existsSync).mockImplementation((p) => {
    const path = String(p);
    if (path === chromiumExecutable) return true;
    if (path.startsWith(`${BIN_DIR}/`)) return present.has(path.slice(BIN_DIR.length + 1));
    if (path.endsWith("/go.work")) return goWork;
    if (path.endsWith("/node_modules")) return nodeModules;
    if (path.endsWith(".git/hooks/pre-commit")) return gitHooks;
    return false;
  });

  vi.mocked(readFileSync).mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith("package.json")) return PACKAGE_JSON;
    if (path.endsWith("go.work")) return "go 1.23\n";
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  });

  vi.mocked(spawnSync).mockImplementation((cmd, args = []) => {
    const key = `${cmd} ${args.join(" ")}`.trim();
    const table = {
      "git rev-parse --show-toplevel": { stdout: `${REPO_ROOT}\n` },
      "git --version": { stdout: "git version 2.43.0\n" },
      "node --version": { stdout: `v${nodeVersion}\n` },
      "pnpm --version": { stdout: `${pnpmVersion}\n` },
      "go version": { stdout: "go version go1.23.0 linux/amd64\n" },
      "cargo clippy --version": { status: 0, error: null },
      "cargo fmt --version": { status: 0, error: null },
      "rustc --version": { stdout: "rustc 1.82.0 (abcdef 2024-01-01)\n" },
      "golangci-lint version": { stdout: `golangci-lint has version ${golangciVersion}\n` },
      "uv --version": { stdout: "uv 0.5.0\n" },
    };
    return table[key] ?? { stdout: "", status: 1, error: null };
  });
}

describe("runSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

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
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("everything in place");
  });

  it("--check reports node as missing and fails when the binary is absent from PATH", () => {
    fixture({ present: new Set(["git", "pnpm", "go", "cargo", "uv"]) });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(1);
    expect(log.mock.calls.flat().join("\n")).toContain("node — install it");
  });

  it("--check skips golangci-lint entirely when go.work does not exist", () => {
    fixture({ goWork: false, present: new Set(["git", "node", "pnpm", "go", "cargo", "uv"]) });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("golangci-lint not needed");
  });

  it("--check requires golangci-lint once go.work exists, and fails when it is missing", () => {
    fixture({ goWork: true, present: new Set(["git", "node", "pnpm", "go", "cargo", "uv"]) });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(1);
    expect(log.mock.calls.flat().join("\n")).toContain("golangci-lint v2");
  });

  it("--check passes once golangci-lint is present alongside go.work", () => {
    fixture({
      goWork: true,
      present: new Set(["git", "node", "pnpm", "go", "cargo", "uv", "golangci-lint"]),
    });
    expect(runSetup(["--check"])).toBe(0);
  });

  it("--check fails when node is older than the version pinned in package.json", () => {
    fixture({ nodeVersion: "18.19.0" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runSetup(["--check"])).toBe(1);
    expect(log.mock.calls.flat().join("\n")).toContain("older than the required");
  });

  it("--check never installs anything or spawns pnpm install", () => {
    fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    runSetup(["--check"]);
    const calls = vi
      .mocked(spawnSync)
      .mock.calls.map(([cmd, args]) => `${cmd} ${(args ?? []).join(" ")}`);
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
