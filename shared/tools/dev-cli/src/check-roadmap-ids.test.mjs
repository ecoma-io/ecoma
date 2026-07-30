import { describe, expect, it } from "vitest";

import {
  findIdFaults,
  gateVocabulary,
  milestoneVocabulary,
  registry,
  trackVocabulary,
} from "./check-roadmap-ids.mjs";

/**
 * A roadmap small enough to read, carrying one row of every shape the real
 * document has: a plain item, a gateless item, and a covering row that defers.
 * Written out rather than loaded from the tree so a doctrine edit can never
 * turn one of these tests green by accident.
 */
const roadmap = (rows) =>
  [
    "## 1b. Track model",
    "",
    "| ◆ Gate | Freeze |",
    "| --- | --- |",
    "| **G0** | Entry-schema Event Log |",
    "| **G4** | Projection read-API |",
    "",
    "| Track | Nội dung |",
    "| --- | --- |",
    "| **A — Platform core** | Tầng 0 |",
    "| **E — Surfaces** | Design system |",
    "",
    "## 4. Milestone",
    "",
    "### M0 — Xương sống có sổ",
    "### M3 — Dogfood",
    "",
    "## 6b. End-state coverage",
    "",
    "| ID | Cụm end-state | Track | Gate chặn | Nhà trong roadmap |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## 7. Nhật ký",
  ].join("\n");

const CORE = "| A.1 | Core engine | A | ◆G0 | M0 |";

describe("vocabularies", () => {
  it("reads tracks from the track table, so renaming one never needs an edit here", () => {
    expect([...trackVocabulary(roadmap([CORE]))]).toEqual(["A", "E"]);
  });

  it("reads gates from the gate table rather than assuming the ◆G0–◆G4 range", () => {
    expect([...gateVocabulary(roadmap([CORE]))]).toEqual(["◆G0", "◆G4"]);
  });

  it("reads milestones from §4's own headings, which is the list §0 binds the board to 1:1", () => {
    expect([...milestoneVocabulary(roadmap([CORE]))]).toEqual(["M0", "M3"]);
  });

  it("skips the separator row so an alignment line is never read as an item", () => {
    expect(registry(roadmap([CORE]))).toEqual([
      { id: "A.1", cluster: "Core engine", track: "A", gate: "◆G0", home: "M0" },
    ]);
  });
});

describe("findIdFaults", () => {
  it("passes a registry whose ids, tracks, gates and milestones all resolve", () => {
    expect(findIdFaults(roadmap([CORE, "| E.2 | Pair-design | E | ◆G4 | M3 |"]))).toEqual([]);
  });

  it("reports one id used twice, because a card pointing at it names neither item", () => {
    const faults = findIdFaults(roadmap([CORE, "| A.1 | Agent runtime | A | ◆G0 | M0 |"]));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("used twice");
  });

  it("reports an id whose letter disagrees with its own track column", () => {
    expect(findIdFaults(roadmap(["| A.1 | Pair-design | E | ◆G4 | M3 |"]))[0]).toContain(
      "the id's own letter says 'A'",
    );
  });

  it("reports a track the track table does not define, catching a letter invented at the card", () => {
    expect(findIdFaults(roadmap(["| Z.1 | Something | Z | ◆G0 | M0 |"]))[0]).toContain(
      "§1b does not define",
    );
  });

  it("reports a gate the gate table does not define, so a renamed freeze cannot be cited stale", () => {
    expect(findIdFaults(roadmap(["| A.1 | Core engine | A | ◆G9 | M0 |"]))[0]).toContain("◆G9");
  });

  it("reports a milestone §4 does not define, which is how a typo'd home hides an orphan", () => {
    expect(findIdFaults(roadmap(["| A.1 | Core engine | A | ◆G0 | M9 |"]))[0]).toContain("M9");
  });

  it("accepts a gap in a track's numbering, since §0 forbids reuse and cancellation leaves holes", () => {
    expect(findIdFaults(roadmap([CORE, "| A.7 | Memory | A | — | M3 |"]))).toEqual([]);
  });

  it("accepts a covering row with no id when it names the ids carrying the work", () => {
    expect(findIdFaults(roadmap([CORE, "| — | Doanh thu | — | — | Trỏ A.1 |"]))).toEqual([]);
  });

  it("reports a covering row that defers to nothing, which is a promise nobody is nurturing", () => {
    expect(findIdFaults(roadmap([CORE, "| — | Doanh thu | — | — | policy thuần |"]))[0]).toContain(
      "names no id it defers to",
    );
  });

  it("reports an empty registry rather than passing a document with the law switched off", () => {
    expect(findIdFaults(roadmap([]))[0]).toContain("no id registry");
  });
});
