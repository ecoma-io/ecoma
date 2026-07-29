import { describe, expect, it } from "vitest";

import { groupVariants } from "./variants";

const LANGS = ["vi", "zh"];

describe("groupVariants", () => {
  it("keeps a translation out of the document list, so a reader is not shown one specification once per language", () => {
    const docs = groupVariants(["spec/role.md", "spec/role.vi.md", "spec/role.zh.md"], LANGS);
    expect(docs.map((d) => d.path)).toEqual(["spec/role.md"]);
  });

  it("reports each translation on the document it belongs to, so the page can offer the other languages", () => {
    const [role] = groupVariants(["spec/role.md", "spec/role.zh.md", "spec/role.vi.md"], LANGS);
    expect(role.variants).toEqual([
      { lang: "zh", path: "spec/role.zh.md" },
      { lang: "vi", path: "spec/role.vi.md" },
    ]);
  });

  it("finds the canonical of a translation listed before it, because a directory listing fixes no order", () => {
    const docs = groupVariants(["spec/role.vi.md", "spec/role.md"], LANGS);
    expect(docs).toEqual([
      { path: "spec/role.md", variants: [{ lang: "vi", path: "spec/role.vi.md" }] },
    ]);
  });

  it("treats a suffix that is not a published language as part of the document's own name", () => {
    const docs = groupVariants(["spec/release-compat.md", "spec/rpa.driver.md"], LANGS);
    expect(docs.map((d) => d.path)).toEqual(["spec/release-compat.md", "spec/rpa.driver.md"]);
  });

  it("refuses a translation whose canonical did not travel with it, naming the document it expected", () => {
    expect(() => groupVariants(["spec/role.md", "spec/task.vi.md"], LANGS)).toThrow(
      /spec\/task\.vi\.md \(expected spec\/task\.md\)/,
    );
  });

  it("preserves the order the caller listed documents in, leaving reading order a content decision", () => {
    const docs = groupVariants(["spec/task.md", "spec/role.md"], LANGS);
    expect(docs.map((d) => d.path)).toEqual(["spec/task.md", "spec/role.md"]);
  });

  it("reads the published languages from the caller rather than assuming a triad", () => {
    const docs = groupVariants(["spec/role.md", "spec/role.vi.md"], []);
    expect(docs.map((d) => d.path)).toEqual(["spec/role.md", "spec/role.vi.md"]);
  });
});
