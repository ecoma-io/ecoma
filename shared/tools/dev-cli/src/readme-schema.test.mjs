import { describe, expect, it } from "vitest";

import {
  auditClaudeMdPointer,
  auditDescription,
  auditNavLine,
  auditSectionMarkers,
  auditTitle,
  auditTokenParity,
  expectedNavLine,
  LANGS,
  readmeFilename,
  SUBPROJECT_SECTIONS,
  technicalTokens,
} from "./readme-schema.mjs";

describe("readmeFilename", () => {
  it("is the un-suffixed README.md for English, suffixed for the others", () => {
    expect(readmeFilename("en")).toBe("README.md");
    expect(readmeFilename("vi")).toBe("README.vi.md");
    expect(readmeFilename("zh")).toBe("README.zh.md");
  });

  it("rejects an unknown lang", () => {
    expect(() => readmeFilename("fr")).toThrow(/unknown lang/);
  });
});

describe("expectedNavLine", () => {
  it("bolds the file's own language and links the other two, in LANGS order", () => {
    expect(expectedNavLine("en")).toBe(
      "> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)",
    );
    expect(expectedNavLine("vi")).toBe(
      "> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)",
    );
    expect(expectedNavLine("zh")).toBe(
      "> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**",
    );
  });

  it("covers every declared language", () => {
    for (const lang of LANGS) expect(() => expectedNavLine(lang)).not.toThrow();
  });
});

describe("auditNavLine", () => {
  it("accepts a blank line then the exact expected nav line", () => {
    expect(auditNavLine("en", `\n${expectedNavLine("en")}\n\n# Title\n`)).toEqual([]);
  });

  it("rejects a missing blank line before the nav line", () => {
    expect(auditNavLine("en", `${expectedNavLine("en")}\n`)).toHaveLength(1);
  });

  it("rejects the wrong language's nav line", () => {
    expect(auditNavLine("en", `\n${expectedNavLine("vi")}\n`)).toEqual([
      expect.stringContaining("nav line"),
    ]);
  });

  it("accepts a CRLF-checked-out nav line, same as LF", () => {
    expect(auditNavLine("en", `\r\n${expectedNavLine("en")}\r\n\r\n# Title\r\n`)).toEqual([]);
  });
});

describe("auditTitle", () => {
  it("accepts a top-level heading containing the name, case-insensitively", () => {
    expect(auditTitle("dev-cli", "\n# Dev-CLI\n\nBody.\n")).toEqual([]);
  });

  it("rejects a missing top-level heading", () => {
    expect(auditTitle("dev-cli", "\nNo heading here.\n")).toEqual([
      expect.stringContaining("top-level"),
    ]);
  });

  it("rejects a heading that omits the name", () => {
    expect(auditTitle("dev-cli", "\n# Something Else\n")).toEqual([
      expect.stringContaining("Something Else"),
    ]);
  });

  it("does not accept a ## as the title", () => {
    expect(auditTitle("dev-cli", "\n## dev-cli\n")).toEqual([expect.stringContaining("top-level")]);
  });
});

describe("auditDescription", () => {
  it("bounds the description — 20 to 200 chars", () => {
    expect(auditDescription("Local developer commands for this workspace.")).toEqual([]);
    expect(auditDescription("tiny")).toEqual([expect.stringContaining("20–200")]);
    expect(auditDescription("x".repeat(201))).toEqual([expect.stringContaining("20–200")]);
  });
});

describe("auditSectionMarkers", () => {
  const complete = SUBPROJECT_SECTIONS.map((m) => `${m}\nSome text.\n`).join("\n");

  it("accepts all 5 markers present in order", () => {
    expect(auditSectionMarkers(complete)).toEqual([]);
  });

  it("reports each missing marker", () => {
    const missingTwo = complete.replace(`${SUBPROJECT_SECTIONS[1]}\n`, "");
    expect(auditSectionMarkers(missingTwo)).toEqual([
      expect.stringContaining(SUBPROJECT_SECTIONS[1]),
    ]);
  });

  it("reports markers present but out of order", () => {
    const [why, consumers, ...restMarkers] = SUBPROJECT_SECTIONS;
    const reordered = [consumers, why, ...restMarkers].map((m) => `${m}\nText.\n`).join("\n");
    expect(auditSectionMarkers(reordered)).toEqual([expect.stringContaining("out of order")]);
  });
});

describe("technicalTokens", () => {
  it("collects inline code spans and ignores the prose around them", () => {
    expect(technicalTokens("Run `pnpm nx test` before `git push`, always.")).toEqual(
      new Set(["pnpm nx test", "git push"]),
    );
  });

  it("counts a name once however often the prose repeats it", () => {
    expect(technicalTokens("`dev-cli` calls `dev-cli` from `dev-cli`.")).toEqual(
      new Set(["dev-cli"]),
    );
  });

  it("keeps the space a line ending inside a code span renders as", () => {
    // CommonMark converts the newline to a space, so this renders
    // "eslint-local- rules" — a different name than the one intended, which
    // is the typo the parity audit exists to surface.
    expect(technicalTokens("peer to `eslint-local-\nrules` today")).toEqual(
      new Set(["eslint-local- rules"]),
    );
  });

  it("reads a span wrapped at an existing space as the same token as an unwrapped one", () => {
    expect(technicalTokens('`implicitDependencies:\n["core-ui"]`')).toEqual(
      technicalTokens('`implicitDependencies: ["core-ui"]`'),
    );
  });

  it("ignores fenced blocks, whose content is a sample rather than a token", () => {
    const body = "Inline `real-token` here.\n\n```sh\npnpm nx run build\n```\n\nAnd `other`.\n";
    expect(technicalTokens(body)).toEqual(new Set(["real-token", "other"]));
  });
});

describe("auditTokenParity", () => {
  it("accepts variants that name the same tokens through different prose", () => {
    expect(
      auditTokenParity({
        en: "Runs `pnpm nx lint` in CI.",
        vi: "Chạy `pnpm nx lint` trong CI.",
        zh: "在 CI 中运行 `pnpm nx lint`。",
      }),
    ).toEqual([]);
  });

  it("reports a token the English canonical names but a translation drops", () => {
    const errors = auditTokenParity({
      en: "Wired into `lint` and `typecheck`.",
      vi: "Nối vào `lint`.",
    });
    expect(errors).toEqual([expect.stringContaining("README.vi.md")]);
    expect(errors[0]).toContain("absent here: `typecheck`");
  });

  it("reports a token a translation adds that the English canonical does not name", () => {
    const errors = auditTokenParity({ en: "Runs `lint`.", zh: "运行 `lint` 与 `build`。" });
    expect(errors[0]).toContain("absent from README.md: `build`");
  });

  it("skips a language whose body is absent, leaving that to the variant audit", () => {
    expect(auditTokenParity({ en: "Runs `lint`." })).toEqual([]);
  });

  it("stays silent with no English canonical to compare against", () => {
    expect(auditTokenParity({ vi: "Chạy `lint`.", zh: "运行 `build`。" })).toEqual([]);
  });
});

describe("auditClaudeMdPointer", () => {
  it("accepts a status section linking to ./CLAUDE.md", () => {
    expect(
      auditClaudeMdPointer("<!-- readme:status -->\nStable. See [CLAUDE.md](./CLAUDE.md).\n"),
    ).toEqual([]);
  });

  it("rejects a status section without the CLAUDE.md link", () => {
    expect(auditClaudeMdPointer("<!-- readme:status -->\nStable.\n")).toEqual([
      expect.stringContaining("./CLAUDE.md"),
    ]);
  });

  it("stays silent when the status marker itself is missing (auditSectionMarkers' job)", () => {
    expect(auditClaudeMdPointer("no status marker here")).toEqual([]);
  });
});
