import { fc, test } from "@fast-check/vitest";
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

// A technical token as an author writes one: a command, path or API name, so
// no backticks and no whitespace of its own — whitespace inside a rendered
// token is exactly what the wrap rule below is about.
const token = fc
  .array(fc.constantFrom(..."abcdefgh-_/.:@"), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));
// Prose that can hold no token and open no fence of its own.
const prose = fc.array(fc.constantFrom(..."abcdefg "), { maxLength: 24 }).map((c) => c.join(""));
const lang = fc.constantFrom(...LANGS);

/** A README body naming exactly `tokens`, one per paragraph of prose. */
const bodyNaming = (tokens) => tokens.map((t) => `some prose \`${t}\` more prose`).join("\n\n");

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

  // Generator and validator are one pair, and adding a language moves both at
  // once: the line each variant must open with is the line this module writes
  // for it, and no other variant's line passes in its place. Checking that on
  // today's three by hand leaves the fourth language to whoever adds it.
  test.prop([lang, fc.string()])(
    "accepts the nav line it generates for a language, whatever body follows",
    (variant, rest) => {
      expect(auditNavLine(variant, `\n${expectedNavLine(variant)}\n${rest}`)).toEqual([]);
    },
  );

  test.prop([lang, lang])(
    "accepts a variant's nav line only in that variant's own file",
    (variant, other) => {
      const errors = auditNavLine(variant, `\n${expectedNavLine(other)}\n`);
      expect(errors.length === 0).toBe(variant === other);
    },
  );
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

  // Two examples cover one missing marker and one swapped pair; the section
  // contract has 32 subsets and 120 arrangements, and an arrangement that
  // slipped through would let a translated README quietly reorder the reading
  // path the markers exist to fix.
  test.prop([fc.subarray(SUBPROJECT_SECTIONS)])(
    "names every section marker a body leaves out",
    (present) => {
      const body = present.map((marker) => `${marker}\n\ntext\n`).join("");
      expect(auditSectionMarkers(body)).toHaveLength(SUBPROJECT_SECTIONS.length - present.length);
    },
  );

  test.prop([
    fc.shuffledSubarray(SUBPROJECT_SECTIONS, {
      minLength: SUBPROJECT_SECTIONS.length,
      maxLength: SUBPROJECT_SECTIONS.length,
    }),
  ])("accepts the declared order of the section markers and no other", (arrangement) => {
    const body = arrangement.map((marker) => `${marker}\n\ntext\n`).join("");
    const declaredOrder = arrangement.every((marker, i) => marker === SUBPROJECT_SECTIONS[i]);
    expect(auditSectionMarkers(body).length === 0).toBe(declaredOrder);
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

  // A README is arbitrary prose, and this scan runs over all of it: a token
  // carrying a stray newline or an unbalanced backtick would be compared
  // against the other variants as such, failing the gate on a file that is
  // fine. Whatever the text, a token renders as a single line with no
  // backtick and no whitespace run in it.
  test.prop([fc.string({ unit: fc.constantFrom(..."`~ \nabc-") })])(
    "yields tokens in rendered form only, whatever the markdown around them",
    (body) => {
      for (const found of technicalTokens(body)) {
        expect(found).not.toBe("");
        expect(found).not.toContain("`");
        expect(found).toBe(found.trim());
        expect(found).not.toMatch(/\s\s|\n/);
      }
    },
  );

  test.prop([token, prose, fc.constantFrom("```", "```sh", "~~~", "~~~toml")])(
    "reads a code span inside a fenced block as a sample, whatever the fence",
    (fenced, filler, fence) => {
      const close = fence.startsWith("`") ? "```" : "~~~";
      const body = [fence, filler, `run \`${fenced}\` now`, filler, close].join("\n");
      expect(technicalTokens(body)).toEqual(new Set());
    },
  );

  // The rendered-form rule, over every name rather than the two hand cases: a
  // wrap at an existing space is invisible to a reader and must stay invisible
  // to the gate, while a wrap inside a name renders a name nobody meant — the
  // typo the parity audit exists to catch.
  test.prop([token, token])(
    "separates a wrap at a space, which renders the same token, from a wrap inside a name",
    (left, right) => {
      expect(technicalTokens(`\`${left} ${right}\``)).toEqual(
        technicalTokens(`\`${left}\n${right}\``),
      );
      expect(technicalTokens(`\`${left}${right}\``)).toEqual(new Set([`${left}${right}`]));
      expect(
        auditTokenParity({ en: `\`${left}${right}\``, vi: `\`${left}\n${right}\`` }),
      ).toHaveLength(1);
    },
  );
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

  // The gate's whole promise, stated over arbitrary token sets rather than the
  // one-token-added and one-token-dropped examples above: a variant passes
  // exactly when it names the same set — no fixed number of differences, and no
  // dependence on which side is longer.
  test.prop([fc.uniqueArray(token, { maxLength: 6 }), fc.uniqueArray(token, { maxLength: 6 })])(
    "passes a translation exactly when it names the same tokens as the canonical",
    (canonical, translated) => {
      const errors = auditTokenParity({
        en: bodyNaming(canonical),
        vi: bodyNaming(translated),
        zh: bodyNaming(canonical),
      });
      const sameSet =
        canonical.length === translated.length && canonical.every((t) => translated.includes(t));
      expect(errors.length === 0).toBe(sameSet);
    },
  );

  test.prop([fc.uniqueArray(token, { minLength: 1, maxLength: 6 }), fc.nat()])(
    "names the dropped token in the error, so the fix does not need a diff",
    (canonical, index) => {
      const dropped = canonical[index % canonical.length];
      const [error] = auditTokenParity({
        en: bodyNaming(canonical),
        vi: bodyNaming(canonical.filter((t) => t !== dropped)),
      });
      expect(error).toContain(`\`${dropped}\``);
    },
  );
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
