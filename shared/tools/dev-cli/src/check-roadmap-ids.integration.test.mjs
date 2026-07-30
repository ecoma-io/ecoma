import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROADMAP,
  findIdFaults,
  gateVocabulary,
  milestoneVocabulary,
  registry,
  trackVocabulary,
} from "./check-roadmap-ids.mjs";

/**
 * The gate reads the real roadmap through four structural anchors — a track
 * table row `| **A — …** |`, a gate table row `| **G0** |`, a milestone heading
 * `### M0 — …`, and the `## 6b.` section holding the registry.
 *
 * Every one of them is deliberately language-independent: the letter, the digit
 * and the em-dash carry the meaning, and the prose around them is free. That is
 * what let the document be translated without touching this command.
 *
 * Nothing proved it, though, and the failure it guards against is quiet in the
 * wrong way: rename the section or reshape a table and the vocabularies come
 * back **empty**, at which point `findIdFaults` reports every id as citing an
 * undefined track — thirty-four confusing errors instead of one true one. These
 * tests read the live document and assert each anchor still yields something,
 * so a structural edit fails here, naming the anchor it broke.
 */
describe("the gate against the real roadmap", () => {
  // `ROADMAP` is repo-relative, and the nx `test` target runs with the project
  // as cwd, so the root is derived from this file's own location rather than
  // from the process. It breaks loudly if the file ever moves, which is right.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const text = readFileSync(join(repoRoot, ROADMAP), "utf8");

  it("finds the track table, so a reshaped row does not read as an undefined track", () => {
    expect([...trackVocabulary(text)].sort()).toEqual(["A", "B", "C", "D", "E", "R", "S"]);
  });

  it("finds the gate table, so a renamed freeze does not read as an undefined gate", () => {
    expect([...gateVocabulary(text)].sort()).toEqual(["◆G0", "◆G1", "◆G2", "◆G3", "◆G4"]);
  });

  it("finds the milestone headings, which the board binds to 1:1", () => {
    expect([...milestoneVocabulary(text)].sort()).toEqual([
      "M0",
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
      "M6",
      "M7",
    ]);
  });

  it("finds the §6b registry, so renaming the section cannot silently empty it", () => {
    const rows = registry(text);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.id !== "—").length).toBeGreaterThan(30);
  });

  it("passes the published roadmap, so the gate is proven against its real subject", () => {
    expect(findIdFaults(text)).toEqual([]);
  });
});
