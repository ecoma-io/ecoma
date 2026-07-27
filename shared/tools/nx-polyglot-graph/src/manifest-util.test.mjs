import { describe, expect, it } from "vitest";

import { normalizePath, parseManifest } from "./manifest-util.mjs";

describe("parseManifest", () => {
  it("parses TOML and returns null on malformed input", () => {
    expect(parseManifest('[package]\nname = "x"').package.name).toBe("x");
    expect(parseManifest("[package\nbroken")).toBeNull();
  });
});

describe("normalizePath", () => {
  it("normalizes ../ and ./ segments against a base directory", () => {
    expect(normalizePath("acme/libs/alpha", "../beta")).toBe("acme/libs/beta");
    expect(normalizePath("acme/libs/alpha", "./sub")).toBe("acme/libs/alpha/sub");
  });
});
