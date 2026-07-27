import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auditSubprojectReadme,
  checkSubprojectReadmes,
  findProjectReadmeIssues,
} from "./check-subproject-readmes.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn(), existsSync: vi.fn() }));

// Mirrors readme-schema.mjs's expectedNavLine() output — kept as literal
// fixture strings (not imported) so this stays a true unit test.
const NAV_LINES = {
  en: "> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)",
  vi: "> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)",
  zh: "> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**",
};

const SECTIONS =
  "<!-- readme:why -->\nWhy.\n\n" +
  "<!-- readme:consumers -->\nWho.\n\n" +
  "<!-- readme:ecosystem -->\nWhere.\n\n" +
  "<!-- readme:boundary -->\nNot.\n\n" +
  "<!-- readme:status -->\nSee [CLAUDE.md](./CLAUDE.md).\n";

const valid = (
  name = "dev-cli",
  subsystem = "shared",
  lang = "en",
  description = "Local developer commands enforcing repo conventions.",
) =>
  `---\nname: ${name}\nsubsystem: ${subsystem}\nlang: ${lang}\ndescription: ${description}\n---\n\n${NAV_LINES[lang]}\n\n# ${name}\n\n${SECTIONS}`;

describe("auditSubprojectReadme", () => {
  it("accepts the canonical block, nav line, title, sections, and CLAUDE.md pointer", () => {
    expect(
      auditSubprojectReadme("shared/tools/dev-cli", "shared", "dev-cli", "en", valid()),
    ).toEqual([]);
  });

  it("accepts a non-English variant with its own nav line and lang", () => {
    expect(
      auditSubprojectReadme(
        "shared/tools/dev-cli",
        "shared",
        "dev-cli",
        "vi",
        valid("dev-cli", "shared", "vi"),
      ),
    ).toEqual([]);
  });

  it("reports a missing variant as missing", () => {
    expect(auditSubprojectReadme("shared/tools/dev-cli", "shared", "dev-cli", "en", null)).toEqual([
      expect.stringContaining("missing"),
    ]);
  });

  it("rejects a README that does not open with the block", () => {
    expect(
      auditSubprojectReadme("shared/tools/dev-cli", "shared", "dev-cli", "en", "# dev-cli\n"),
    ).toHaveLength(1);
  });

  it("pins name to the project.json name, not the directory basename", () => {
    expect(
      auditSubprojectReadme("shared/tools/dev-cli", "shared", "dev-cli", "en", valid("dev-clii")),
    ).toContainEqual(expect.stringContaining('"dev-clii"'));
  });

  it("pins subsystem to the project's top-level directory", () => {
    expect(
      auditSubprojectReadme(
        "shared/tools/dev-cli",
        "shared",
        "dev-cli",
        "en",
        valid("dev-cli", "platform"),
      ),
    ).toContainEqual(expect.stringContaining('subsystem is "platform"'));
  });

  it("pins lang to the file's own filename", () => {
    expect(
      auditSubprojectReadme(
        "shared/tools/dev-cli",
        "shared",
        "dev-cli",
        "en",
        valid("dev-cli", "shared", "vi"),
      ),
    ).toContainEqual(expect.stringContaining('lang is "vi"'));
  });

  it("requires all 5 ordered section markers", () => {
    const noSections = valid().replace(SECTIONS, "Just prose, no sections.\n");
    const errors = auditSubprojectReadme(
      "shared/tools/dev-cli",
      "shared",
      "dev-cli",
      "en",
      noSections,
    );
    expect(errors).toContainEqual(expect.stringContaining("readme:why"));
    expect(errors).toContainEqual(expect.stringContaining("readme:status"));
  });

  it("requires the status section to link ./CLAUDE.md", () => {
    const noPointer = valid().replace("See [CLAUDE.md](./CLAUDE.md).", "Stable.");
    expect(
      auditSubprojectReadme("shared/tools/dev-cli", "shared", "dev-cli", "en", noPointer),
    ).toContainEqual(expect.stringContaining("./CLAUDE.md"));
  });
});

describe("findProjectReadmeIssues", () => {
  it("audits every project's 3 variants and flags a triad name mismatch", () => {
    const files = { "shared/tools/dev-cli/project.json": JSON.stringify({ name: "dev-cli" }) };
    const readmes = {
      "shared/tools/dev-cli/README.md": valid(),
      "shared/tools/dev-cli/README.vi.md": valid("dev-cli", "shared", "vi"),
      "shared/tools/dev-cli/README.zh.md": valid("wrong-name", "shared", "zh"),
    };
    const readFile = (p) => files[p] ?? readmes[p];
    const exists = (p) => p in files || p in readmes;

    const errors = findProjectReadmeIssues(["shared/tools/dev-cli/project.json"], readFile, exists);
    expect(errors).toContainEqual(expect.stringContaining("disagree on frontmatter name"));
  });

  it("skips a project.json without a name", () => {
    const readFile = () => JSON.stringify({});
    const exists = () => false;
    expect(findProjectReadmeIssues(["a/project.json"], readFile, exists)).toEqual([]);
  });

  it("reports nothing when all 3 variants are compliant", () => {
    const files = { "shared/tools/dev-cli/project.json": JSON.stringify({ name: "dev-cli" }) };
    const readmes = {
      "shared/tools/dev-cli/README.md": valid(),
      "shared/tools/dev-cli/README.vi.md": valid("dev-cli", "shared", "vi"),
      "shared/tools/dev-cli/README.zh.md": valid("dev-cli", "shared", "zh"),
    };
    const readFile = (p) => files[p] ?? readmes[p];
    const exists = (p) => p in files || p in readmes;

    expect(
      findProjectReadmeIssues(["shared/tools/dev-cli/project.json"], readFile, exists),
    ).toEqual([]);
  });
});

describe("checkSubprojectReadmes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails loudly, naming each missing README variant", () => {
    vi.mocked(execFileSync).mockReturnValue("some-project/project.json\n");
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ name: "some-project" }));
    vi.mocked(existsSync).mockReturnValue(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkSubprojectReadmes()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("missing"));
  });

  it("ignores files that merely end in project.json (e.g. subproject.json)", () => {
    vi.mocked(execFileSync).mockReturnValue("no-such-dir/subproject.json\n");
    expect(checkSubprojectReadmes()).toBe(0);
  });
});
