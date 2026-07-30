/**
 * The roadmap's own two-way law, machine-checked (`method/roadmap.md` §0).
 *
 * The roadmap owns *scope · dependency order · exit-litmus*; a GitHub Projects
 * board owns *execution state*. That split only holds while every card can
 * name exactly one roadmap item, which needs the items to have stable names —
 * so §0 declares an id scheme, `<Track>.<seq>`, append-only and never reused.
 *
 * An id scheme nobody checks decays in one specific way, and it is silent: two
 * rows drift onto the same id, or a row cites a track or a gate that no longer
 * exists, and every card pointing at either is now pointing at something the
 * reader has to guess. Nothing renders wrong. The board still looks complete.
 *
 * **Every vocabulary here is derived from the document, never restated.** The
 * tracks come from §1b's track table, the gates from its gate table, the
 * milestones from §4's own headings. That is the whole reason this gate can be
 * trusted to outlive an edit: rename a track and this file needs no change,
 * because it never held a copy of the name to go stale (Rule 14).
 *
 * **What it deliberately does not check: reuse.** §0 forbids re-issuing the
 * number of a cancelled item, and one snapshot of the file cannot see that —
 * the id looks the same either way, and only its *subject* changed. Detecting
 * it means comparing each id's row against every past version of that row.
 * Uniqueness within the file is checked; reuse across history stays with the
 * reviewer, and saying so is better than a gate whose name implies more than
 * it does.
 *
 * The other half of §0's law — a *card* that traces to no id — lives on the
 * board, not in this repository, and needs the Projects GraphQL API. It is a
 * separate command by the same reasoning: this one runs offline on every
 * commit, and a gate that needs a network token is a gate that gets skipped.
 */
import { readFileSync } from "node:fs";

import { DOCTRINE_ROOT } from "./check-doctrine.mjs";

/** The living document this gate reads. Its only consumer is this command. */
export const ROADMAP = `${DOCTRINE_ROOT}/method/roadmap.md`;

/** A row of the §6b registry, already split into cells. */
const tableRows = (text, heading) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
};

/**
 * Track letters, read from §1b's own track table rather than listed here. Its
 * rows open `| **A — Platform core**`, and the letter before the dash is the
 * track — the same string §6b's Track column must use.
 */
export function trackVocabulary(text) {
  return new Set([...text.matchAll(/^\|\s*\*\*([A-Z])\s+—\s+[^*]+\*\*\s*\|/gm)].map((m) => m[1]));
}

/** Gate names, read from §1b's gate table rows (`| **G0** | …`). */
export function gateVocabulary(text) {
  return new Set([...text.matchAll(/^\|\s*\*\*(G\d)\*\*\s*\|/gm)].map((m) => `◆${m[1]}`));
}

/** Milestone names, read from §4's own headings (`### M0 — …`). */
export function milestoneVocabulary(text) {
  return new Set([...text.matchAll(/^###\s+(M\d)\s+—/gm)].map((m) => m[1]));
}

/** The §6b registry rows, as `{ id, cluster, track, gate, home }`. */
export function registry(text) {
  return tableRows(text, "## 6b.")
    .filter((cells) => cells.length === 5 && cells[0] !== "ID")
    .map(([id, cluster, track, gate, home]) => ({ id, cluster, track, gate, home }));
}

/**
 * Every violation of §0's id law in `text`, as human-readable lines. Pure, so
 * the rules are testable without a doctrine tree on disk.
 */
export function findIdFaults(text) {
  const tracks = trackVocabulary(text);
  const gates = gateVocabulary(text);
  const milestones = milestoneVocabulary(text);
  const rows = registry(text);
  const faults = [];
  const seen = new Map();

  if (rows.length === 0)
    faults.push("§6b carries no id registry — §0's two-way law has nothing to check");

  for (const { id, cluster, track, gate, home } of rows) {
    const what = cluster.replace(/\*/g, "").slice(0, 60);

    if (id === "—") {
      // A covering row carries no work of its own, so it must say which ids do.
      if (!/[A-Z]\.\d+/.test(home)) {
        faults.push(
          `'${what}' has no id and names no id it defers to — an item nobody is nurturing`,
        );
      }
      continue;
    }

    const shape = /^([A-Z])\.(\d+)$/.exec(id);
    if (!shape) {
      faults.push(
        `'${id}' is not <Track>.<seq> — §0's scheme is what lets a card name exactly one item`,
      );
      continue;
    }
    if (seen.has(id)) {
      faults.push(
        `'${id}' is used twice ('${seen.get(id)}' and '${what}') — a card pointing at it names neither`,
      );
    }
    seen.set(id, what);

    if (shape[1] !== track) {
      faults.push(`'${id}' sits in track '${track}' — the id's own letter says '${shape[1]}'`);
    }
    if (!tracks.has(track)) {
      faults.push(`'${id}' cites track '${track}', which §1b does not define`);
    }
    if (gate !== "—" && !gates.has(gate)) {
      faults.push(`'${id}' cites gate '${gate}', which §1b does not define`);
    }
    for (const [cited] of home.matchAll(/\bM\d\b/g)) {
      if (!milestones.has(cited)) {
        faults.push(`'${id}' is housed in '${cited}', which §4 does not define`);
      }
    }
  }
  return faults;
}

/** Reads the roadmap and reports. Returns a process exit code. */
export function checkRoadmapIds({ log = console.log } = {}) {
  const faults = findIdFaults(readFileSync(ROADMAP, "utf8"));
  for (const fault of faults) log(`${ROADMAP}: ${fault}`);
  return faults.length === 0 ? 0 : 1;
}
