import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkDocLinks, findBrokenLinks, linkTargets } from "./check-doc-links.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("findBrokenLinks", () => {
  it("reports only absent relative Markdown targets, with 1-based lines", () => {
    const present = new Set(["/repo/README.md", "/repo/vider/CLAUDE.md"]);
    const text = [
      "See [readme](../README.md) and [vider](../vider/CLAUDE.md).", // both present
      "External [site](https://example.com) and [mail](mailto:a@b.co) ignored.",
      "Anchor [top](#intro), route [r](/vider), dir [d](../assets), image [i](./p.png) ignored.",
      "Broken [x](../missing/FILE.md) and [y](./nope.mdx#frag).",
    ].join("\n");

    const broken = findBrokenLinks(text, "/repo/docs/x.md", (p) => present.has(p));
    expect(broken.map((b) => b.target)).toEqual(["../missing/FILE.md", "./nope.mdx"]);
    expect(broken[0].line).toBe(4);
  });

  it("unwraps angle-bracket targets and drops query/fragment before resolving", () => {
    const broken = findBrokenLinks("[x](<./gone away.md>)", "/repo/doc.md", () => false);
    expect(broken.map((b) => b.target)).toEqual(["./gone away.md"]);
  });
});

describe("checkDocLinks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails when a tracked doc links to a Markdown file that no longer exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-doc-links-"));
    const doc = join(dir, "guide.md");
    writeFileSync(doc, "See [gone](./moved-elsewhere.md).");
    vi.mocked(execFileSync).mockReturnValue(`${doc}\n`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkDocLinks()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("./moved-elsewhere.md"));
  });

  it("passes when every doc link resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-doc-links-"));
    const doc = join(dir, "guide.md");
    writeFileSync(join(dir, "README.md"), "# readme");
    writeFileSync(doc, "See [readme](./README.md) and [site](https://example.com).");
    vi.mocked(execFileSync).mockReturnValue(`${doc}\n`);

    expect(checkDocLinks()).toBe(0);
  });

  it("skips unreadable listed files instead of crashing", () => {
    vi.mocked(execFileSync).mockReturnValue("no/such/file.md\n");
    expect(checkDocLinks()).toBe(0);
  });
});

describe("linkTargets", () => {
  it("resolves a link against the linking document's own directory, which is what a second reader needs", () => {
    expect(linkTargets("[Role](../spec/role.md)", "docs/overview/index.md")[0]).toMatchObject({
      target: "../spec/role.md",
      resolved: resolve("docs/spec/role.md"),
    });
  });

  it("returns every link, not only the broken ones", () => {
    const text = "[a](./a.md) and [b](./b.md)";
    expect(linkTargets(text, "docs/index.md").map((l) => l.target)).toEqual(["./a.md", "./b.md"]);
  });
});
