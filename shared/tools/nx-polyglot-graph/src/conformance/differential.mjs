/**
 * Putting the two verdicts side by side, and naming the direction of every
 * disagreement.
 *
 * Three outcomes per reported violation, and they are not symmetric:
 *
 * - **agree** — both engines report the same `messageId` at the same site.
 * - **this-tool-stricter** — this engine reports where ESLint is silent. A
 *   DECISION, legitimate only when the case declares it and says why; never
 *   tolerated silently.
 * - **this-tool-weaker** — ESLint reports where this engine is silent. A
 *   DEFECT, always. It is the false negative the whole tool exists to remove:
 *   a green light nobody can trust is worse than the silence this replaces,
 *   because silence about Go, Rust and Python is at least known.
 *
 * ## What "the same site" means
 *
 * ESLint reports the whole statement — `import { a } from "@x/y";` starts at
 * column 1 — while this engine reports the SPECIFIER, because an editor
 * diagnostic should underline the string that is wrong. Comparing columns for
 * equality would therefore mark every single pair as a disagreement about
 * nothing. Instead a pair matches when this engine's position falls INSIDE the
 * range ESLint reported, which is the strongest statement that survives the
 * difference: same file, same statement, same rule. A violation this engine
 * reports at a different statement stays unmatched, and so surfaces as one
 * stricter plus one weaker rather than being quietly absorbed.
 */

/** Is `(line, column)` inside the `[start, end)` range of an ESLint message? */
function withinRange(message, line, column) {
  const endLine = message.endLine ?? message.line;
  const endColumn = message.endColumn ?? message.column + 1;
  const afterStart = line > message.line || (line === message.line && column >= message.column);
  const beforeEnd = line < endLine || (line === endLine && column < endColumn);
  return afterStart && beforeEnd;
}

/** A short, stable description of where a violation sits, for a report line. */
const siteOf = (file, line, column) => `${file}:${line}:${column}`;

/**
 * Pairs one file's two verdicts.
 *
 * @param {string} file Workspace-relative.
 * @param {{readable: boolean, messages: object[], notes: string[]}} upstream
 * @param {object[]} tool Violations from `evaluate`, already filtered to `file`.
 * @returns {{agree: object[], stricter: object[], weaker: object[]}}
 */
export function compareFile(file, upstream, tool) {
  const remaining = [...tool];
  const agree = [];
  const weaker = [];

  for (const message of upstream.messages) {
    const index = remaining.findIndex(
      (violation) =>
        violation.messageId === message.messageId &&
        withinRange(message, violation.line, violation.column),
    );
    if (index === -1) {
      weaker.push({
        messageId: message.messageId,
        site: siteOf(file, message.line, message.column),
        detail: message.message,
      });
      continue;
    }
    const [violation] = remaining.splice(index, 1);
    agree.push({
      messageId: message.messageId,
      site: siteOf(file, violation.line, violation.column),
      sameText: violation.message === message.message,
    });
  }

  const stricter = remaining.map((violation) => ({
    messageId: violation.messageId,
    site: siteOf(file, violation.line, violation.column),
    upstreamReadable: upstream.readable,
    detail: violation.message,
  }));
  return { agree, stricter, weaker };
}

/**
 * Compares a whole case and checks it against what it CLAIMED, which is the
 * half that keeps the suite honest.
 *
 * A differential where both engines stay silent "agrees" and proves nothing —
 * it is what a fixture that stopped triggering its rule looks like. So every
 * probe declares the message ids upstream must report (`upstream`) and, when
 * the two are meant to differ, the ids this engine must report (`tool`) plus
 * the reason. A claim that no longer matches reality is a failure of the same
 * weight as a disagreement.
 *
 * @returns {{rows: object[], breaches: string[]}} `breaches` is empty when the
 *   case behaved as declared; each entry names exactly what did not.
 */
export function compareCase(materialized, upstreamByFile, toolViolations) {
  const { spec } = materialized;
  const rows = [];
  const breaches = [];

  for (const probe of spec.probes) {
    const file = `${spec.id}/${probe.file}`;
    const upstream = upstreamByFile.get(file) ?? { readable: false, messages: [], notes: [] };
    const tool = toolViolations.filter((violation) => violation.sourceFile === file);
    const comparison = compareFile(file, upstream, tool);

    const actualUpstream = upstream.messages.map((message) => message.messageId).sort();
    const actualTool = tool.map((violation) => violation.messageId).sort();
    const claimedUpstream = [...(probe.upstream ?? [])].sort();
    const claimedTool = [...(probe.tool ?? probe.upstream ?? [])].sort();

    if (upstream.notes.length > 0) {
      breaches.push(
        `${spec.id} / ${probe.file}: ESLint reported something other than the boundary rule — ` +
          `${upstream.notes.join("; ")}. The fixture does not parse, so its verdict means nothing.`,
      );
    }
    if (JSON.stringify(actualUpstream) !== JSON.stringify(claimedUpstream)) {
      breaches.push(
        `${spec.id} / ${probe.file}: ESLint reported [${actualUpstream.join(", ") || "nothing"}], ` +
          `the case claims [${claimedUpstream.join(", ") || "nothing"}]. The fixture no longer ` +
          `triggers what it was built to trigger, so any agreement it shows is vacuous.`,
      );
    }
    if (JSON.stringify(actualTool) !== JSON.stringify(claimedTool)) {
      breaches.push(
        `${spec.id} / ${probe.file}: this engine reported [${actualTool.join(", ") || "nothing"}], ` +
          `the case claims [${claimedTool.join(", ") || "nothing"}].`,
      );
    }
    if (probe.tool && !probe.divergence) {
      breaches.push(
        `${spec.id} / ${probe.file}: declares a verdict of its own without a 'divergence' reason. ` +
          `A deliberate difference from ESLint is a decision and must be stated, never assumed.`,
      );
    }
    // A false negative is never a decision, so it is never simply "declared and
    // fine". A case may only RECORD one it has found, and then the suite holds
    // the record to the observed reality from both sides: a new one that is not
    // in the ledger fails here, and one the ledger names that has since been
    // fixed fails the ledger check. Neither direction can rot quietly.
    const ledgered = probe.divergence?.direction === "weaker";
    for (const weak of comparison.weaker) {
      if (ledgered) continue;
      breaches.push(
        `${spec.id} / ${probe.file}: FALSE NEGATIVE — ESLint reports ` +
          `${weak.messageId} at ${weak.site} and this engine does not.`,
      );
    }
    if (ledgered && comparison.weaker.length === 0) {
      breaches.push(
        `${spec.id} / ${probe.file}: records a false negative that no longer happens. ` +
          `Delete the ledger entry — a ledger of defects that are fixed is a ledger nobody rereads.`,
      );
    }

    rows.push({
      caseId: spec.id,
      file,
      intent: spec.intent,
      divergence: probe.divergence ?? null,
      probeUpstream: probe.upstream ?? [],
      upstreamReadable: upstream.readable,
      ...comparison,
    });
  }
  return { rows, breaches };
}

/** Every outcome for one messageId, across every case that produced it. */
function tallyFor(rows, messageId) {
  const tally = { agree: 0, stricter: 0, weaker: 0, cases: new Set(), notes: new Set() };
  for (const row of rows) {
    for (const hit of row.agree) {
      if (hit.messageId !== messageId) continue;
      tally.agree++;
      tally.cases.add(row.caseId);
    }
    for (const hit of row.stricter) {
      if (hit.messageId !== messageId) continue;
      tally.stricter++;
      tally.cases.add(row.caseId);
      tally.notes.add(
        hit.upstreamReadable
          ? (row.divergence?.reason ?? "undeclared")
          : "upstream cannot parse the language",
      );
    }
    for (const hit of row.weaker) {
      if (hit.messageId !== messageId) continue;
      tally.weaker++;
      tally.cases.add(row.caseId);
    }
  }
  return tally;
}

/**
 * The per-message differential table, as data.
 *
 * Driven by the id list read off the INSTALLED rule, so a message this engine
 * has never heard of appears as a row rather than being absent from a table
 * that then looks complete (Rule 11).
 *
 * @param {object[]} rows From `compareCase`.
 * @param {string[]} upstreamMessageIds Every id upstream defines.
 * @param {string[]} toolMessageIds Every id this engine can produce.
 */
export function summarize(rows, upstreamMessageIds, toolMessageIds) {
  const implemented = new Set(toolMessageIds);
  return upstreamMessageIds.map((messageId) => {
    const tally = tallyFor(rows, messageId);
    return {
      messageId,
      implemented: implemented.has(messageId),
      agree: tally.agree,
      stricter: tally.stricter,
      weaker: tally.weaker,
      exercised: tally.agree + tally.stricter + tally.weaker > 0,
      cases: [...tally.cases].sort(),
      notes: [...tally.notes].sort(),
    };
  });
}

/** The summary as a fixed-width table, for a terminal and for a report. */
export function renderTable(summary) {
  const header = ["messageId", "agree", "stricter", "weaker", "verdict"];
  const body = summary.map((row) => [
    row.messageId,
    String(row.agree),
    String(row.stricter),
    String(row.weaker),
    verdictOf(row),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...body.map((row) => row[column].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join(
    "\n",
  );
}

/**
 * Every disagreement, one line each, with its direction and its reason — the
 * raw material `README.md`'s ledger is written from, emitted by the run rather
 * than maintained beside it.
 */
export function renderDivergences(rows) {
  const lines = [];
  for (const row of rows) {
    for (const hit of row.weaker) {
      lines.push(
        `weaker    ${hit.messageId}  ${row.file}\n            ${row.divergence?.reason ?? "UNDECLARED"}`,
      );
    }
    for (const hit of row.stricter) {
      const reason = row.upstreamReadable
        ? (row.divergence?.reason ?? "UNDECLARED")
        : "ESLint has no parser for this language";
      lines.push(`stricter  ${hit.messageId}  ${hit.site}\n            ${reason}`);
    }
  }
  return lines.join("\n");
}

/** Pairs whose rendered message text differs, which is a report-quality note rather than a verdict. */
export function renderTextDifferences(rows) {
  return rows
    .flatMap((row) =>
      row.agree.filter((hit) => !hit.sameText).map((hit) => `${hit.messageId}  ${hit.site}`),
    )
    .join("\n");
}

/** One word for a row, so a reader does not have to do the arithmetic. */
export function verdictOf(row) {
  if (!row.implemented) return "UNIMPLEMENTED";
  if (!row.exercised) return "NOT EXERCISED";
  if (row.weaker > 0) return "WEAKER — DEFECT";
  if (row.stricter > 0 && row.agree > 0) return "agree + stricter";
  if (row.stricter > 0) return "stricter only";
  return "agree";
}
