/**
 * Prints the roadmap's own vocabulary — the §6b registry ids, plus the track,
 * gate and milestone vocabularies §1b and §4 define — derived live from the
 * document by the same functions `check-roadmap-ids` judges against.
 *
 * It exists because a second consumer needs that vocabulary and cannot import
 * it. `repo-care`'s `audit-roadmap-labels` holds the board half of §0's two-way
 * law — an issue whose `roadmap:` label names an id the roadmap does not define
 * — and a relative import across two Nx projects would be an edge the project
 * graph cannot see, the same reason `languages.config.json` sits at the repo
 * root. Spawning this command is the seam instead: one derivation, one document,
 * and a caller that cannot drift from it (Rule 14 rung 1).
 *
 * Default output is one `<kind>\t<value>` line per entry, which is greppable;
 * `--json` emits the four vocabularies as an object for tooling.
 */
import { readFileSync } from "node:fs";
import {
  ROADMAP,
  gateVocabulary,
  milestoneVocabulary,
  registry,
  trackVocabulary,
} from "./check-roadmap-ids.mjs";

/** The four vocabularies as plain data. `read` is injectable for tests. */
export function roadmapVocabulary(read = readFileSync) {
  const text = read(ROADMAP, "utf8");
  return {
    // The registry uses an em-dash where a row deliberately carries no id;
    // that is a placeholder, never something a label could name.
    ids: registry(text)
      .map((r) => r.id)
      .filter((id) => /^[A-Z]\.\d+$/.test(id)),
    tracks: [...trackVocabulary(text)],
    gates: [...gateVocabulary(text)],
    milestones: [...milestoneVocabulary(text)],
  };
}

/** CLI entry. Returns a process exit code. */
export function listRoadmapIds(args = [], read = readFileSync) {
  const vocab = roadmapVocabulary(read);
  if (args.includes("--json")) {
    console.log(JSON.stringify(vocab));
    return 0;
  }
  for (const [kind, values] of Object.entries(vocab)) {
    for (const value of values) console.log(`${kind}\t${value}`);
  }
  return 0;
}
