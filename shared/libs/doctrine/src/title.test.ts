import { describe, expect, it } from "vitest";

import { extractTitle } from "./title";

describe("extractTitle", () => {
  it("takes the document's own H1, so the nav never becomes a second place to rename a title", () => {
    expect(extractTitle("# Ecoma Spec: Role\n\nbody", "spec/role.md")).toBe("Ecoma Spec: Role");
  });

  it("takes the first-level heading rather than the first line or a deeper one", () => {
    expect(extractTitle("intro\n\n# Real Heading\n\n## Sub", "spec/x.md")).toBe("Real Heading");
  });

  it("falls back to the file stem when the document carries no heading, rather than rendering an empty entry", () => {
    expect(extractTitle("no heading here", "spec/platform/role.md")).toBe("role");
  });
});
