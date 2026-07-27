import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runE2e, shouldUseXvfb } from "./run-e2e.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const realPlatform = process.platform;
const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

describe("shouldUseXvfb", () => {
  it("wraps only Linux, where CI/sandbox has no window server", () => {
    expect(shouldUseXvfb("linux")).toBe(true);
    // macOS/Windows always have a native window server → run directly.
    expect(shouldUseXvfb("darwin")).toBe(false);
    expect(shouldUseXvfb("win32")).toBe(false);
  });
});

describe("runE2e", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // vi.restoreAllMocks leaves vi.fn call history in place
  });
  afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
  });

  it("wraps the run in xvfb-run on Linux and forwards extra args to `playwright test`", () => {
    setPlatform("linux");
    vi.mocked(spawnSync).mockReturnValue({ status: 0 });

    expect(runE2e(["--grep", "smoke"])).toBe(0);

    const [command, args, opts] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe("xvfb-run");
    expect(args.slice(0, 2)).toEqual(["--auto-servernum", process.execPath]);
    expect(args[2]).toMatch(/playwright/); // the resolved cli.js, not the PATH shim
    expect(args.slice(3)).toEqual(["test", "--grep", "smoke"]);
    expect(opts).toEqual({ stdio: "inherit" });
  });

  it("runs Playwright directly under node on platforms with a window server", () => {
    setPlatform("darwin");
    vi.mocked(spawnSync).mockReturnValue({ status: 0 });

    expect(runE2e()).toBe(0);

    const [command, args] = vi.mocked(spawnSync).mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/playwright/);
    expect(args[1]).toBe("test");
  });

  it("propagates Playwright's exit code, treating a missing status as failure", () => {
    setPlatform("darwin");
    vi.mocked(spawnSync).mockReturnValue({ status: 3 });
    expect(runE2e()).toBe(3);

    vi.mocked(spawnSync).mockReturnValue({ status: null });
    expect(runE2e()).toBe(1);
  });

  it("explains how to install Xvfb when xvfb-run is absent on Linux", () => {
    setPlatform("linux");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(spawnSync).mockReturnValue({ error: Object.assign(new Error(), { code: "ENOENT" }) });

    expect(runE2e()).toBe(127);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("xvfb"));
  });

  it("rethrows spawn errors that are not a missing xvfb-run", () => {
    setPlatform("darwin");
    const boom = new Error("spawn failed");
    vi.mocked(spawnSync).mockReturnValue({ error: boom });

    expect(() => runE2e()).toThrow(boom);
  });
});
