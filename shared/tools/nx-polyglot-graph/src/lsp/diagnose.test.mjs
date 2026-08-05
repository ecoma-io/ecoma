import { beforeEach, describe, expect, it, vi } from "vitest";

import { diagnoseDocument } from "./diagnose.mjs";

// Both collaborators are mocked, and not only because the unit tier requires
// it: what has to be pinned here is what happens when they FAIL, and a real
// analyzer cannot be made to throw on demand without feeding it a file whose
// failure mode is itself a moving target.
vi.mock("../analysis/analyze.mjs", () => ({ analyzeFile: vi.fn() }));
vi.mock("../rules/index.mjs", () => ({ evaluate: vi.fn() }));

const { analyzeFile } = await import("../analysis/analyze.mjs");
const { evaluate } = await import("../rules/index.mjs");

const SOURCE_FILE = "libs/inner/main.go";
const TEXT = 'package inner\n\nimport "example.test/outer"\n';
const REQUEST = {
  sourceFile: SOURCE_FILE,
  text: TEXT,
  index: { workspace: {}, graph: { nodes: {} } },
  config: { depConstraints: [], options: {} },
};

// A clean tree is the default each case starts from, so every failure below is
// visibly the one thing that case introduced.
beforeEach(() => {
  vi.resetAllMocks();
  analyzeFile.mockReturnValue({ imports: [], failures: [] });
  evaluate.mockReturnValue([]);
});

describe("an empty diagnostic list means no violation, and nothing else", () => {
  it("reports analyzed only when the analyzer AND the rule engine both returned", () => {
    // This is the flag the publisher keys on. It is `true` on exactly one path,
    // so a caller can refuse to publish an empty list any other way.
    expect(diagnoseDocument(REQUEST)).toEqual({ analyzed: true, diagnostics: [] });
  });

  it("publishes the throw when a language has no analyzer, never a clean file", () => {
    // `analyzeFile` throws for a language its extension table claims and no
    // analyzer implements — the scaffold staying loud (`../analysis/analyze.mjs`).
    // Swallowing it would paint every file of that language green.
    analyzeFile.mockImplementation(() => {
      throw new Error("no elvish import analyzer is implemented yet");
    });

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("no elvish import analyzer is implemented yet");
    expect(diagnostics[0].message).toContain("NOT a clean result");
  });

  it("publishes the throw when the rule engine refuses the input it was handed", () => {
    // `evaluate` throws when the graph and the records describe different trees.
    // Every verdict after that point would be guesswork, so there is no partial
    // answer to fall back to — and no answer must not look like a clean one.
    analyzeFile.mockReturnValue({ imports: [{ sourceFile: SOURCE_FILE }], failures: [] });
    evaluate.mockImplementation(() => {
      throw new Error("the graph and the analysis records describe different trees");
    });

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics.at(-1).message).toContain("describe different trees");
  });

  it("shows what could not be read even when every rule that did run passed", () => {
    // A parse failure is data, not an exception (`../analysis/contract.md`), so
    // the analyzer returns imports AND failures. Publishing only the violations
    // would report a file as clean when part of it was never judged.
    analyzeFile.mockReturnValue({
      imports: [],
      failures: [
        { sourceFile: SOURCE_FILE, line: 3, column: 8, reason: "parse error: '}' expected." },
      ],
    });
    evaluate.mockReturnValue([]);

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    // `analyzed` is still true — the pipeline completed — but the list is NOT
    // empty, which is what a reader actually sees.
    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("'}' expected.");
    expect(diagnostics[0].severity).toBe(2);
  });

  it("refuses a verdict the engine returned about a different file", () => {
    // The engine is handed only this document's sites, so this cannot happen
    // unless the two disagree about which file they are discussing — at which
    // point the verdict for the open file is not trustworthy and must not be
    // published as if it were.
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([
      {
        sourceFile: "libs/other/main.go",
        line: 1,
        column: 1,
        specifier: "x",
        messageId: "noImportsOfApps",
        message: "Imports of apps are forbidden",
      },
    ]);

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics.at(-1).message).toContain("cannot be trusted");
  });
});

describe("a verdict that did reach a conclusion", () => {
  it("renders one diagnostic per violation, positioned at the import it is about", () => {
    const specifier = "example.test/outer";
    const offset = TEXT.indexOf(`"${specifier}"`);
    const linesBefore = TEXT.slice(0, offset).split("\n");
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([
      {
        sourceFile: SOURCE_FILE,
        line: linesBefore.length,
        column: linesBefore.at(-1).length + 1,
        specifier,
        messageId: "onlyTagsConstraintViolation",
        message:
          'A project tagged with "zone:inner" can only depend on libs tagged with zone:inner',
      },
    ]);

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("onlyTagsConstraintViolation");
    expect(diagnostics[0].severity).toBe(1);
    expect(
      TEXT.split("\n")[diagnostics[0].range.start.line].slice(
        diagnostics[0].range.start.character,
        diagnostics[0].range.end.character,
      ),
    ).toBe(`"${specifier}"`);
  });
});
