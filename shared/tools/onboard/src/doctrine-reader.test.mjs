import { describe, it, expect } from "vitest";

import {
  frontmatter,
  tableRows,
  parseGlossary,
  parseEndState,
  parseSystemShape,
  parseMilestones,
  parseGaps,
} from "./doctrine-reader.mjs";

describe("frontmatter", () => {
  it("parses key: value pairs from the leading --- block", () => {
    const text = "---\ntitle: Test\ntags: a, b\n---\n\n# Body";
    expect(frontmatter(text)).toEqual({ title: "Test", tags: "a, b" });
  });

  it("returns {} when no frontmatter", () => {
    expect(frontmatter("# Just a heading")).toEqual({});
  });

  it("returns {} for empty frontmatter", () => {
    expect(frontmatter("---\n---\n\n# Body")).toEqual({});
  });
});

describe("tableRows", () => {
  const table = `## Section
| A     | B        |
| ----- | -------- |
| alpha | beta     |
| gamma | delta    |
`;

  it("returns all non-separator rows including header", () => {
    const rows = tableRows(table, "## Section");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(["A", "B"]);
    expect(rows[1]).toEqual(["alpha", "beta"]);
    expect(rows[2]).toEqual(["gamma", "delta"]);
  });

  it("returns [] when heading not found", () => {
    expect(tableRows(table, "## Missing")).toEqual([]);
  });

  it("stops at the next heading", () => {
    const t = table + "\n## Next section\n| x | y |\n";
    expect(tableRows(t, "## Section")).toHaveLength(3);
  });
});

describe("parseGlossary", () => {
  it("extracts term: definition pairs with em dash", () => {
    const text =
      "## Canonical glossary\n\n**Role** — a position of labour\n**Task** — an instance of work\n";
    const gloss = parseGlossary(text);
    expect(gloss).toHaveLength(2);
    expect(gloss[0].term).toBe("Role");
    expect(gloss[0].definition).toBe("a position of labour");
    expect(gloss[1].term).toBe("Task");
    expect(gloss[1].definition).toBe("an instance of work");
  });

  it("returns [] when no glossary section", () => {
    expect(parseGlossary("# No glossary")).toEqual([]);
  });
});

describe("parseEndState", () => {
  const fixture = `## The end state

**Ecoma is a fair-code system.** It is built as one monorepo.

## The four mechanism principles

1. **First principle** — symmetry
2. **Second principle** — lineage
3. **Third principle** — parameters
4. **Fourth principle** — complexity

## The five invariants

1. **Invariant one** — same Role
2. **Invariant two** — Checkpoint path
3. **Invariant three** — attention measured
4. **Invariant four** — tenant data
5. **Invariant five** — durable state

## The primitives

| Specification | Purpose |
|---|---|
| Role | A capability slot |
| Task | An instance of work |
| Checkpoint | A blocking Gate |

## Product architecture

| Layer | What it is | Contents |
|---|---|---|
| 1 | Core engine | Primitives, event log |
| 2 | Agent runtime | Internal agent fillers |
`;

  it("extracts vision from ## The end state", () => {
    const result = parseEndState(fixture);
    expect(result.vision).toBe("Ecoma is a fair-code system.");
  });

  it("extracts 4 principles", () => {
    const result = parseEndState(fixture);
    expect(result.principles).toHaveLength(4);
    expect(result.principles[0]).toContain("First principle");
  });

  it("extracts 5 invariants", () => {
    const result = parseEndState(fixture);
    expect(result.invariants).toHaveLength(5);
    expect(result.invariants[3]).toContain("tenant data");
  });

  it("extracts primitives from the spec table", () => {
    const result = parseEndState(fixture);
    expect(result.primitives).toHaveLength(3);
    expect(result.primitives[0].name).toBe("Role");
  });

  it("extracts product layers", () => {
    const result = parseEndState(fixture);
    expect(result.layers).toHaveLength(2);
    expect(result.layers[0]).toEqual({
      layer: 1,
      name: "Core engine",
      contents: "Primitives, event log",
    });
  });

  it("returns empty arrays when sections are missing", () => {
    const result = parseEndState("# Minimal");
    expect(result.principles).toEqual([]);
    expect(result.invariants).toEqual([]);
    expect(result.primitives).toEqual([]);
    expect(result.layers).toEqual([]);
  });
});

describe("parseSystemShape", () => {
  it("extracts text from a code block under ## System shape", () => {
    const text = `## System shape\n\`\`\`\n3 domains: Platform | RPA | Hub\n\`\`\`\n`;
    expect(parseSystemShape(text)).toBe("3 domains: Platform | RPA | Hub");
  });

  it("returns null when section is missing", () => {
    expect(parseSystemShape("# No shape")).toBeNull();
  });
});

describe("parseMilestones", () => {
  it("extracts M0–M7 milestones with name and condition", () => {
    const text = `### M0 — Backbone _(ICP-independent)_\n### M1 — Wedge _(ICP-independent)_\n### M5 — Beachhead _(ICP-GATED)_\n`;
    const ms = parseMilestones(text);
    expect(ms).toHaveLength(3);
    expect(ms[0]).toEqual({ id: "M0", name: "Backbone", condition: "(ICP-independent)" });
    expect(ms[2]).toEqual({ id: "M5", name: "Beachhead", condition: "(ICP-GATED)" });
  });

  it("returns [] when no milestones", () => {
    expect(parseMilestones("# No milestones")).toEqual([]);
  });
});

describe("parseGaps", () => {
  const text = `## Known gaps\n\n| Gap | Kind | Reason |\n|---|---|---|\n| **ICP** | Commercial | Unconfirmed |\n| **CI/CD** | Private | No workflow |\n| **Charter** | Private | Scope narrowed |\n`;

  it("extracts known gap rows from the gaps table", () => {
    const gaps = parseGaps(text);
    expect(gaps).toHaveLength(3);
    expect(gaps[0].item).toBe("**ICP**");
    expect(gaps[0].kind).toBe("Commercial");
  });

  it("returns [] when no gaps section", () => {
    expect(parseGaps("# No gaps")).toEqual([]);
  });
});
