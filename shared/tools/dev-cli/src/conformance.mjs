/**
 * The executor rule #6 of the roadmap (§1b) demands: **a gate is a frozen text
 * plus a conformance suite that runs independently** — "a gate with no suite is
 * a paper gate". Until this command existed, both halves were prose. Nothing
 * could freeze a document, nothing could run a suite, and the ledger saying so
 * was hand-maintained, which is the same class of second-source-of-truth this
 * workspace removes everywhere else.
 *
 * It answers one question per gate and answers it from the tree:
 *
 * - **Frozen?** A doctrine document declares `status: frozen` and `gate: G<n>`
 *   in its frontmatter. Freezing is an act with consequences — after it, a
 *   change to that interface is breaking and travels a major — so this command
 *   never performs one. It only reports, and refuses the states that are lies.
 * - **Has a suite?** An Nx project declares a `conformance` target and a
 *   `gate:G<n>` tag. That is deliberately Nx's own vocabulary rather than a new
 *   registry file: a suite has to be runnable in CI, and CI already runs Nx
 *   targets (Rule 2 — stop at the first rung that works).
 *
 * **The gate vocabulary is the roadmap's, imported rather than restated**
 * (Rule 14 rung 1) — the same `gateVocabulary` `check-roadmap-ids` reads, off
 * the same table. Renaming or adding a gate is one edit, in the document that
 * owns gates.
 *
 * **What it fails on is the point, and it is narrow.** A gate with neither a
 * freeze nor a suite is not an error: nothing has been promised yet, and
 * reporting an unstarted gate as broken would make the command noise. What is
 * an error is a **frozen gate with no suite** — that is precisely the paper
 * gate rule #6 names, and it can only arise after someone freezes a text, which
 * is when the rule is supposed to bite. A suite or a freeze citing a gate the
 * roadmap does not define is an error too, for the same reason
 * `check-roadmap-ids` rejects an undefined track.
 *
 * `--run` additionally executes the suites through Nx. Without it the command
 * is a pure read of the tree, which is what lets it run on every commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ROADMAP, gateVocabulary } from "./check-roadmap-ids.mjs";
import { DOCTRINE_DOCS } from "./check-doctrine.mjs";
import { listTrackedFiles } from "./tracked-files.mjs";

export const CONFORMANCE_TARGET = "conformance";
export const FROZEN_STATUS = "frozen";

/** The `gate:G<n>` tag axis, shared by a suite's project and a frozen document. */
const GATE_TAG_RE = /^gate:(G\d)$/;

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z-]+):\s*(.+?)\s*$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return fields;
}

/**
 * Frozen documents, as `[{ file, gate }]`. A document declaring `status: frozen`
 * with no `gate:` is itself a fault — freezing is only meaningful against the
 * gate it closes — so it is returned with `gate: null` for the caller to report.
 */
export function findFrozenDocuments(files, read = readFileSync) {
  const frozen = [];
  for (const file of files) {
    let fields;
    try {
      fields = frontmatter(read(file, "utf8"));
    } catch {
      continue;
    }
    if (fields.status !== FROZEN_STATUS) continue;
    const gate = /^G\d$/.test(fields.gate ?? "") ? `◆${fields.gate}` : null;
    frozen.push({ file, gate });
  }
  return frozen;
}

/**
 * Suites, as `[{ project, gate }]` — an Nx project declaring a `conformance`
 * target. A project with the target and no `gate:` tag returns `gate: null`,
 * the same way an ungated freeze does: a suite that names no gate arbitrates
 * nothing.
 */
export function findSuites(files, read = readFileSync) {
  const suites = [];
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(read(file, "utf8"));
    } catch {
      continue; // an unparsable project.json is lint's problem, not this command's
    }
    if (!json.targets?.[CONFORMANCE_TARGET]) continue;
    const tag = (Array.isArray(json.tags) ? json.tags : []).find((t) => GATE_TAG_RE.test(t));
    suites.push({
      project: json.name ?? dirname(file),
      gate: tag ? `◆${tag.match(GATE_TAG_RE)[1]}` : null,
    });
  }
  return suites;
}

/**
 * The ledger rule #6 describes, one row per gate the roadmap defines, plus the
 * faults. Pure, so the whole judgment is testable without a tree.
 */
export function buildLedger(gates, frozen, suites) {
  const rows = [...gates].sort().map((gate) => ({
    gate,
    frozen: frozen.filter((f) => f.gate === gate).map((f) => f.file),
    suites: suites.filter((s) => s.gate === gate).map((s) => s.project),
  }));

  const faults = [];
  for (const { file } of frozen.filter((f) => !f.gate)) {
    faults.push(
      `${file}: declares status: ${FROZEN_STATUS} without a gate: — a freeze closes a gate or closes nothing`,
    );
  }
  for (const { project } of suites.filter((s) => !s.gate)) {
    faults.push(
      `${project}: has a '${CONFORMANCE_TARGET}' target without a gate:G<n> tag — a suite arbitrates a named gate or nothing`,
    );
  }
  for (const { gate, frozen: docs, suites: runners } of rows) {
    if (docs.length && !runners.length) {
      faults.push(
        `${gate}: frozen (${docs.join(", ")}) with no conformance suite — rule #6: a gate with no suite is a paper gate`,
      );
    }
  }
  return { rows, faults };
}

function unknownGateFaults(gates, frozen, suites) {
  const faults = [];
  for (const { file, gate } of frozen) {
    if (gate && !gates.has(gate))
      faults.push(`${file}: freezes ${gate}, which ${ROADMAP} does not define`);
  }
  for (const { project, gate } of suites) {
    if (gate && !gates.has(gate))
      faults.push(`${project}: serves ${gate}, which ${ROADMAP} does not define`);
  }
  return faults;
}

/** Reports the gate ledger, and with `--run` executes the suites. Returns an exit code. */
export function conformance(args = [], read = readFileSync, list = listTrackedFiles) {
  const gates = gateVocabulary(read(ROADMAP, "utf8"));
  if (!gates.size) {
    console.error(`${ROADMAP}: no gate table found — the vocabulary this command reads is empty`);
    return 1;
  }

  const frozen = findFrozenDocuments(list([DOCTRINE_DOCS]), read);
  const suites = findSuites(list(["**/project.json"]), read);
  const { rows, faults } = buildLedger(gates, frozen, suites);
  faults.push(...unknownGateFaults(gates, frozen, suites));

  for (const { gate, frozen: docs, suites: runners } of rows) {
    const state =
      !docs.length && !runners.length
        ? "not started"
        : `${docs.length} frozen, ${runners.length} suite(s)`;
    console.log(`${gate}  ${state}${runners.length ? ` — ${runners.join(", ")}` : ""}`);
  }

  for (const fault of faults) console.error(fault);
  if (faults.length) return 1;

  const runners = rows.flatMap((r) => r.suites);
  if (args.includes("--run") && runners.length) {
    try {
      execFileSync("pnpm", ["nx", "run-many", "-t", CONFORMANCE_TARGET, "-p", runners.join(",")], {
        stdio: "inherit",
      });
    } catch {
      return 1;
    }
  }
  return 0;
}
