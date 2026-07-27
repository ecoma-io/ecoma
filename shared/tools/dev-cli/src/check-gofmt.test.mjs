import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkGofmt } from "./check-gofmt.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("checkGofmt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes when gofmt -l reports no files", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    expect(checkGofmt()).toBe(0);
  });

  it("fails loudly, naming every unformatted file", () => {
    vi.mocked(execFileSync).mockReturnValue("foo.go\nbar/baz.go\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkGofmt()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("foo.go"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("bar/baz.go"));
  });

  it("shells out to gofmt -l . (list-only, never -w)", () => {
    vi.mocked(execFileSync).mockReturnValue("");
    checkGofmt();
    expect(execFileSync).toHaveBeenCalledWith("gofmt", ["-l", "."], expect.any(Object));
  });
});
