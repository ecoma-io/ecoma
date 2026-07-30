import { describe, expect, it, vi } from "vitest";

import { listRoadmapIds, roadmapVocabulary } from "./list-roadmap-ids.mjs";

const ROADMAP_TEXT = `## 1b. Tracks

| Track | Note |
| --- | --- |
| **A — Engine** | … |
| **R — Repo & harness** | … |

| Gate | Freezes |
| --- | --- |
| **G0** | the entry schema |
| **G1** | the filler interface |

## 4. Milestones

### M0 — A backbone

### M1 — The wedge

## 6b. Coverage

| ID | Cluster | Track | Gate | Home |
| --- | --- | --- | --- | --- |
| A.1 | Event Log | A | ◆G0 | spec |
| R.4 | Board | R | — | here |
| — | Unnumbered | S | — | — |
`;

const read = () => ROADMAP_TEXT;

describe("the vocabulary a second consumer reads", () => {
  it("lists the registry ids", () => {
    expect(roadmapVocabulary(read).ids).toEqual(["A.1", "R.4"]);
  });

  it("drops the em-dash placeholder, which no label could ever name", () => {
    expect(roadmapVocabulary(read).ids).not.toContain("—");
  });

  it("carries the track, gate and milestone vocabularies alongside the ids", () => {
    const vocab = roadmapVocabulary(read);
    expect(vocab.tracks).toEqual(["A", "R"]);
    expect(vocab.gates).toEqual(["◆G0", "◆G1"]);
    expect(vocab.milestones).toEqual(["M0", "M1"]);
  });
});

describe("the command's output", () => {
  it("emits one parseable object under --json, which is what a caller spawns it for", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(listRoadmapIds(["--json"], read)).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).ids).toEqual(["A.1", "R.4"]);
    log.mockRestore();
  });

  it("emits kind-tagged lines by default, so a human can grep one kind", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(listRoadmapIds([], read)).toBe(0);
    const lines = log.mock.calls.map((c) => c[0]);
    expect(lines).toContain("ids\tA.1");
    expect(lines).toContain("gates\t◆G0");
    log.mockRestore();
  });
});
