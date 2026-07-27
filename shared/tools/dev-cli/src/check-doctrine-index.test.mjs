import { describe, expect, it } from "vitest";

import { findQuoteLine, normalize, validateIndex } from "./check-doctrine-index.mjs";

const SOURCE = [
  "# Guide",
  "",
  "- **A rule.** Never spawn git without pinning",
  "  the repository.",
].join("\n");

/** A card that passes every rule, so each test can break exactly one thing. */
function pathCard(overrides = {}) {
  return {
    id: "a-rule",
    scope: ["src/**"],
    summary: "Never spawn git without pinning the repository.",
    source: "GUIDE.md",
    quote: "Never spawn git without pinning the repository",
    gate: null,
    gateNote: "no lint rule covers this yet",
    ...overrides,
  };
}

function diffCard(overrides = {}) {
  return {
    id: "b-rule",
    summary: "The diff hand-rolls what a built-in already does.",
    source: "GUIDE.md",
    quote: "Never spawn git without pinning the repository",
    gate: null,
    gateNote: "requires knowing the stdlib",
    ...overrides,
  };
}

const read = (path) => {
  if (path !== "GUIDE.md") throw new Error("ENOENT");
  return SOURCE;
};
const TRACKED = ["src/index.ts", "docs/readme.md"];

const validate = (index) => validateIndex(index, read, TRACKED);
const only = (card) => validate({ pathCards: [card], diffCards: [] });
const onlyDiff = (card) => validate({ pathCards: [], diffCards: [card] });

describe("normalize", () => {
  it("collapses the wrapping that separates a quote from its source", () => {
    expect(normalize("a\n  b\t c ")).toBe("a b c");
  });
});

describe("findQuoteLine", () => {
  it("locates a quote that the source hard-wraps across lines", () => {
    expect(findQuoteLine(SOURCE, "Never spawn git without pinning the repository")).toBe(3);
  });

  it("reports absence rather than guessing when the cited text is gone", () => {
    expect(findQuoteLine(SOURCE, "Always spawn git freely")).toBeNull();
  });

  it("does not stitch a match out of lines too far apart to be one passage", () => {
    const spread = ["start of it", ...Array(10).fill("filler"), "end of it"].join("\n");
    expect(findQuoteLine(spread, "start of it end of it")).toBeNull();
  });
});

describe("validateIndex", () => {
  it("accepts an index whose cards all cite text their source still contains", () => {
    expect(validate({ pathCards: [pathCard()], diffCards: [diffCard()] })).toEqual([]);
  });

  it("fails when a card's quote no longer appears in its source", () => {
    expect(only(pathCard({ quote: "Always spawn git however you like" }))).toEqual([
      expect.stringContaining("quote not found in GUIDE.md"),
    ]);
  });

  it("fails when a card points at a source file that does not exist", () => {
    expect(only(pathCard({ source: "MISSING.md" }))).toEqual([
      expect.stringContaining("does not exist"),
    ]);
  });

  it("rejects a quote too short to survive the rule it cites being deleted", () => {
    expect(only(pathCard({ quote: "Never spawn" }))).toEqual([
      expect.stringContaining("at least 20 characters"),
    ]);
  });

  it("rejects a scope glob that matches no tracked file, since it routes nowhere", () => {
    expect(only(pathCard({ scope: ["deleted-dir/**"] }))).toEqual([
      expect.stringContaining("dead routing"),
    ]);
  });

  it("requires a path card to declare where it applies", () => {
    expect(only(pathCard({ scope: [] }))).toEqual([
      expect.stringContaining("need a non-empty scope"),
    ]);
  });

  it("rejects a scope on a diff card, which is judged against the diff and not paths", () => {
    expect(onlyDiff(diffCard({ scope: ["src/**"] }))).toEqual([
      expect.stringContaining("drop 'scope'"),
    ]);
  });

  it("requires every card to answer whether a deterministic gate could hold the rule", () => {
    const { gate, ...noGate } = pathCard();
    expect(only(noGate)).toEqual([expect.stringContaining("missing 'gate'")]);
    expect(only(pathCard({ gateNote: "  " }))).toEqual([expect.stringContaining("empty gateNote")]);
  });

  it("rejects a duplicate id across both card kinds, so a lookup stays unambiguous", () => {
    const problems = validate({
      pathCards: [pathCard({ id: "same" })],
      diffCards: [diffCard({ id: "same" })],
    });
    expect(problems).toEqual([expect.stringContaining("duplicate id")]);
  });

  it("rejects an id that is not kebab-case", () => {
    expect(only(pathCard({ id: "Not Kebab" }))).toEqual([expect.stringContaining("kebab-case")]);
  });

  it("reports a malformed index instead of throwing on it", () => {
    expect(validate({})).toEqual([
      expect.stringContaining("'pathCards' must be an array"),
      expect.stringContaining("'diffCards' must be an array"),
    ]);
  });
});
