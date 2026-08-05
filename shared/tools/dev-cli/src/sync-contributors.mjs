/**
 * Adds a row to `CONTRIBUTORS.md` for every account in the CLA signatures file
 * that it does not already name.
 *
 * `CLA.md` clause 3.2 makes that file how the project names an author, and the
 * contributor consents to modification of their work on the strength of it. So
 * the row is part of what the project owes, not a courtesy — which is exactly
 * why it stopped being a step the contributor performs. Asking a first-time
 * contributor to edit a roster is asking them to do the project's own side of
 * the bargain, and it is the step most likely to be forgotten, conflict, or be
 * done wrong; `check-contributor-record` then fails their pull request for it.
 *
 * **Additive, never rewriting.** An existing row is left exactly as it is,
 * including a `Name` cell someone improved by hand — the roster's name column is
 * how a person chooses to be credited, and regenerating the file would
 * repeatedly overwrite that with a GitHub handle. New rows are appended in the
 * order the signatures were made. That also makes the command idempotent: run
 * it twice and the second run writes nothing.
 *
 * The table is re-padded on write because Prettier owns this file's formatting
 * and pads GFM cells to the widest in each column. Emitting an unpadded row
 * would leave the tree one `nx format:write` away from a diff nobody asked for.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  CONTRIBUTORS_FILE,
  auditSignatures,
  listedInContributors,
} from "./check-contributor-record.mjs";

/**
 * The month a signature was made, as `YYYY-MM` — the granularity the roster's
 * `Since` column carries. An unparseable timestamp yields `null` rather than a
 * guess; `auditSignatures` is what reports it as a fault.
 */
export function signedMonth(createdAt) {
  const m = /^(\d{4})-(\d{2})/.exec(String(createdAt ?? ""));
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * Splits `text` into `{ before, header, separator, rows, after }` around the
 * first GFM table, or `null` when it carries none. The table is found by its
 * separator line rather than by position, so prose may move around it.
 */
export function parseTable(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes("-"));
  if (at < 1) return null;
  let end = at + 1;
  while (end < lines.length && lines[end].trim().startsWith("|")) end += 1;
  return {
    before: lines.slice(0, at - 1),
    header: splitRow(lines[at - 1]),
    separator: splitRow(lines[at]),
    rows: lines.slice(at + 1, end).map(splitRow),
    after: lines.slice(end),
  };
}

/** The cells of one `| a | b |` line, trimmed. */
function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * The table rendered the way Prettier renders one: every cell padded to the
 * widest in its column, the separator filled with dashes to the same width.
 * Width is counted in code points after NFC normalization, so a Vietnamese name
 * written with combining marks is not padded as if it were twice as long.
 */
export function renderTable({ header, separator, rows }) {
  const width = (s) => [...(s ?? "").normalize("NFC")].length;
  const pad = (s, w) => (s ?? "") + " ".repeat(Math.max(0, w - width(s)));

  const columns = header.map((_, i) => Math.max(3, ...[header, ...rows].map((r) => width(r[i]))));
  const line = (cells) => `| ${columns.map((w, i) => pad(cells[i], w)).join(" | ")} |`;
  // A separator cell keeps whichever alignment colons it already carried and
  // is filled out with dashes; Prettier writes the same shape.
  const rule = (cell, w) => {
    const left = cell?.startsWith(":") ? ":" : "";
    const right = cell?.endsWith(":") ? ":" : "";
    return left + "-".repeat(Math.max(3, w - left.length - right.length)) + right;
  };
  return [
    line(header),
    `| ${columns.map((w, i) => rule(separator[i], w)).join(" | ")} |`,
    ...rows.map(line),
  ];
}

/**
 * `CONTRIBUTORS.md` with a row appended for every signatory it does not name,
 * as `{ text, added }`. Pure, so the roster logic is testable without a tree.
 * A signatory whose signature carries no usable date is skipped rather than
 * given an invented month — `check-contributor-record` already fails that
 * signature, and a wrong date in an attribution table is worse than an absent
 * row that a red gate is naming.
 */
export function rosterWithSignatories(text, entries) {
  const table = parseTable(text);
  if (!table) {
    throw new Error(`${CONTRIBUTORS_FILE}: carries no contributor table to add a row to`);
  }
  const added = [];
  for (const { name, created_at: createdAt } of entries) {
    if (!name || listedInContributors(name, text)) continue;
    const month = signedMonth(createdAt);
    if (!month) continue;
    // The GitHub cell is what `check-contributor-record` matches on; the name
    // cell starts as the handle because nothing offline knows the person's
    // chosen display name, and a human may replace it afterwards.
    table.rows.push([name, `[@${name}](https://github.com/${name})`, month]);
    added.push(name);
  }
  if (added.length === 0) return { text, added };
  return {
    text: [...table.before, ...renderTable(table), ...table.after].join("\n"),
    added,
  };
}

/**
 * Reads the signatures file named by `path` and writes any missing rows into
 * `CONTRIBUTORS.md`. Returns a process exit code. `--check` reports what would
 * be added without writing, for a caller that wants the answer and not the
 * edit.
 */
export function syncContributors(args = [], io = { readFileSync, writeFileSync }) {
  const at = args.indexOf("--signatures");
  const path = at === -1 ? undefined : args[at + 1];
  if (!path) {
    console.error(
      "sync-contributors: --signatures <path> is required — the CLA workflow's " +
        "`path-to-signatures` names it, and guessing it would be a second answer",
    );
    return 2;
  }

  let signatures;
  try {
    signatures = io.readFileSync(path, "utf8");
  } catch {
    console.log(`${path}: does not exist yet — no signature to credit, nothing to add.`);
    return 0;
  }
  const { faults } = auditSignatures(signatures, path);
  if (faults.length > 0) {
    for (const fault of faults) console.error(fault);
    console.error(
      "sync-contributors: refusing to write a roster from a signatures file that does not audit",
    );
    return 1;
  }
  const entries = JSON.parse(signatures).signedContributors;

  const before = io.readFileSync(CONTRIBUTORS_FILE, "utf8");
  let result;
  try {
    result = rosterWithSignatories(before, entries);
  } catch (error) {
    console.error(`sync-contributors: ${error.message}`);
    return 1;
  }
  if (result.added.length === 0) {
    console.log(`${CONTRIBUTORS_FILE}: already names every signatory — nothing to add.`);
    return 0;
  }
  if (args.includes("--check")) {
    console.error(
      `${CONTRIBUTORS_FILE}: does not name ${result.added.join(", ")} — run 'dev-cli ` +
        `sync-contributors --signatures ${path}'`,
    );
    return 1;
  }
  io.writeFileSync(CONTRIBUTORS_FILE, result.text);
  console.log(`${CONTRIBUTORS_FILE}: added ${result.added.join(", ")}`);
  return 0;
}
