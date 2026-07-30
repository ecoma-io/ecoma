import { describe, expect, it, vi } from "vitest";

import {
  auditRoadmapLabels,
  findLabelFaults,
  findUncardedIds,
  readVocabulary,
} from "./audit-roadmap-labels.mjs";

const VOCAB = {
  ids: ["A.1", "R.4"],
  tracks: ["A", "R"],
  gates: ["G0", "G1"],
  milestones: ["M0"],
};

const issue = (number, ...labels) => ({ number, labels: labels.map((name) => ({ name })) });

describe("reading the vocabulary from the roadmap's own gate", () => {
  it("strips the gate marker, which a label cannot carry but the roadmap spells", () => {
    const vocab = readVocabulary(() => JSON.stringify({ ...VOCAB, gates: ["◆G0", "◆G1"] }));
    expect(vocab.gates).toEqual(["G0", "G1"]);
  });

  it("fails loud on unreadable output rather than auditing against an empty vocabulary", () => {
    expect(() => readVocabulary(() => "not json")).toThrow(/roadmap vocabulary/);
  });
});

describe("a card that traces to no id", () => {
  it("passes labels that all resolve", () => {
    expect(findLabelFaults([issue(1, "roadmap:A.1", "track:A", "gate:G0", "bug")], VOCAB)).toEqual(
      [],
    );
  });

  it("catches a roadmap id the document no longer defines", () => {
    expect(findLabelFaults([issue(7, "roadmap:A.99")], VOCAB)).toEqual([
      { issue: 7, label: "roadmap:A.99", kind: "ids" },
    ]);
  });

  it("catches a renamed track, gate and milestone too, not just an id", () => {
    const faults = findLabelFaults([issue(8, "track:Z", "gate:G9", "milestone:M9")], VOCAB);
    expect(faults.map((f) => f.kind)).toEqual(["tracks", "gates", "milestones"]);
  });

  it("ignores labels outside the roadmap vocabulary, which are none of its business", () => {
    expect(findLabelFaults([issue(9, "enhancement", "area:shared")], VOCAB)).toEqual([]);
  });

  it("reads a closed card the same as an open one, since a wrong id is wrong either way", () => {
    expect(
      findLabelFaults([{ number: 3, state: "closed", labels: ["roadmap:A.99"] }], VOCAB),
    ).toHaveLength(1);
  });
});

describe("an id that carries no card", () => {
  it("lists the ids nobody has opened a card for", () => {
    expect(findUncardedIds([issue(1, "roadmap:A.1")], VOCAB)).toEqual(["R.4"]);
  });

  it("is reported and never failed, because a plan ahead of its cards is normal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await auditRoadmapLabels([], {
      vocabulary: VOCAB,
      client: { listIssues: async () => [issue(1, "roadmap:A.1")] },
    });
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join(" ")).toContain("R.4");
    log.mockRestore();
  });
});

describe("the command's exit code", () => {
  it("fails only on a card that traces nowhere", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await auditRoadmapLabels([], {
      vocabulary: VOCAB,
      client: { listIssues: async () => [issue(4, "roadmap:B.2")] },
    });
    expect(code).toBe(1);
    expect(error.mock.calls[0][0]).toContain("#4");
    vi.restoreAllMocks();
  });
});
