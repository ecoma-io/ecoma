import { describe, expect, it } from "vitest";

import {
  auditRootReadme,
  auditSubsystemReadme,
  deriveSubsystemRoots,
} from "./check-subsystem-readmes.mjs";

// Mirrors readme-schema.mjs's expectedNavLine() output — kept as literal
// fixture strings (not imported) so this stays a true unit test.
const NAV_LINES = {
  en: "> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)",
  vi: "> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)",
  zh: "> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**",
};

const valid = (
  dir = "platform",
  lang = "en",
  description = "The Ecoma product — libraries and apps",
) =>
  `---\nname: ${dir}\nlang: ${lang}\ndescription: ${description}\n---\n\n${NAV_LINES[lang]}\n\n# ${dir}\n\nBody.\n`;

describe("deriveSubsystemRoots", () => {
  it("keeps top-level non-dot directories that hold tracked files, sorted", () => {
    const roots = deriveSubsystemRoots([
      "shared/tools/dev-cli/src/main.mjs",
      "platform/README.md",
      ".github/workflows/ci.yml",
      "README.md",
      "rpa/CLAUDE.md",
    ]);
    expect(roots).toEqual(["platform", "rpa", "shared"]);
  });

  it("never treats a root-level file as a subsystem", () => {
    expect(deriveSubsystemRoots(["package.json", "CLAUDE.md"])).toEqual([]);
  });
});

describe("auditSubsystemReadme", () => {
  it("accepts the canonical block, nav line, title, and content after it", () => {
    expect(auditSubsystemReadme("platform", "en", valid())).toEqual([]);
  });

  it("accepts a non-English variant with its own nav line and lang", () => {
    expect(auditSubsystemReadme("platform", "vi", valid("platform", "vi"))).toEqual([]);
  });

  it("reports a missing variant as missing", () => {
    expect(auditSubsystemReadme("platform", "en", null)).toEqual([
      expect.stringContaining("missing"),
    ]);
  });

  it("rejects a README that does not open with the block, or reorders it", () => {
    expect(auditSubsystemReadme("platform", "en", "# Platform\n")).toHaveLength(1);
    expect(
      auditSubsystemReadme(
        "platform",
        "en",
        "---\ndescription: The Ecoma product subsystem root\nname: platform\nlang: en\n---\n",
      ),
    ).toHaveLength(1);
    expect(auditSubsystemReadme("platform", "en", `\n${valid()}`)).toHaveLength(1);
  });

  it("pins name to the directory — the area label derives from it", () => {
    expect(auditSubsystemReadme("platform", "en", valid("platfrom"))).toContainEqual(
      expect.stringContaining('"platfrom"'),
    );
  });

  it("pins lang to the file's own filename", () => {
    expect(auditSubsystemReadme("platform", "en", valid("platform", "vi"))).toContainEqual(
      expect.stringContaining('lang is "vi"'),
    );
  });

  it("bounds the description — it is the classifier's map, not a slogan or an essay", () => {
    expect(auditSubsystemReadme("platform", "en", valid("platform", "en", "tiny"))).toEqual([
      expect.stringContaining("20–200"),
    ]);
    expect(
      auditSubsystemReadme("platform", "en", valid("platform", "en", "x".repeat(201))),
    ).toEqual([expect.stringContaining("20–200")]);
  });

  it("requires the language-switcher nav line", () => {
    const noNav = `---\nname: platform\nlang: en\ndescription: The Ecoma product — libraries and apps\n---\n\n# platform\n\nBody.\n`;
    expect(auditSubsystemReadme("platform", "en", noNav)).toEqual([
      expect.stringContaining("nav line"),
    ]);
  });

  it("requires the H1 to name the directory", () => {
    const badTitle = valid("platform").replace("# platform", "# Something Else");
    expect(auditSubsystemReadme("platform", "en", badTitle)).toEqual([
      expect.stringContaining("Something Else"),
    ]);
  });

  it("accepts the canonical block on a CRLF checkout, same as LF", () => {
    expect(auditSubsystemReadme("platform", "en", valid().replace(/\n/g, "\r\n"))).toEqual([]);
  });

  it("reports its own directory-prefixed path, unlike the frontmatter-free root audit", () => {
    expect(auditSubsystemReadme("platform", "en", null)).toEqual([
      expect.stringContaining("platform/README.md: missing"),
    ]);
  });
});

describe("auditRootReadme", () => {
  it("accepts a frontmatter-free body that opens with the nav line", () => {
    expect(auditRootReadme("en", `${NAV_LINES.en}\n\n# Ecoma\n\nBody.\n`)).toEqual([]);
  });

  it("accepts a non-English variant with its own nav line", () => {
    expect(auditRootReadme("vi", `${NAV_LINES.vi}\n\n# Ecoma\n\nBody.\n`)).toEqual([]);
  });

  it("reports a missing variant as missing, with no directory prefix", () => {
    expect(auditRootReadme("en", null)).toEqual([expect.stringContaining("README.md: missing")]);
  });

  it("requires the nav line as the very first line — no frontmatter to open with instead", () => {
    expect(auditRootReadme("en", "# Ecoma\n\nBody.\n")).toEqual([
      expect.stringContaining("nav line"),
    ]);
  });

  it("accepts the nav line on a CRLF checkout, same as LF", () => {
    expect(auditRootReadme("en", `${NAV_LINES.en}\r\n\r\n# Ecoma\r\n`)).toEqual([]);
  });
});
