import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { scanName, scanText, workspaceLevelFiles } from "./check-journey-markers.mjs";

// The vocabulary side of the name space: words built from letters alone, so
// neither pattern can fire on them by accident — every journey token needs a
// digit or one of the four fixed words, and those four are excluded here.
const QUALIFIERS = ["new", "old", "temp"];
const word = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 2, maxLength: 8 })
  .map((chars) => chars.join(""))
  .filter((candidate) => candidate !== "wip" && !QUALIFIERS.includes(candidate));
const plainName = fc.array(word, { minLength: 1, maxLength: 4 }).map((words) => words.join("-"));

// Lines that carry no digit at all: every alternative of the prose pattern
// needs one, so these can never be a hit however they are shuffled together.
const proseLine = fc
  .array(fc.constantFrom(..."abcdefghij "), { maxLength: 24 })
  .map((chars) => chars.join(""));
const markerLine = fc.constantFrom(
  "/* ships at 0.2 */",
  "<!-- roadmap 0.1 backlog -->",
  "see PLAN-0.2.md",
  "REVIEW-UX-0.2 A3",
  "(0.2 surface)",
);

describe("scanText", () => {
  it("leaves behavior-describing prose alone, including bare version numbers", () => {
    expect(scanText("/* tokens come from the shared Aperture preset */")).toHaveLength(0);
    expect(scanText(".badge { padding: 0.2rem; } /* invariant I2 cross-ref */")).toHaveLength(0);
  });

  it("flags journey markers in comment styles the ESLint rule can't parse", () => {
    expect(scanText("/* ships at 0.2 */")).toHaveLength(1);
    expect(scanText("<!-- roadmap 0.1 backlog -->")).toHaveLength(1);
    expect(scanText("/* see PLAN-0.2.md */")[0].match).toBe("PLAN-0.2.md");
    expect(scanText("/* REVIEW-UX-0.2 A3 */")[0].match).toBe("REVIEW-UX-0.2 A3");
    expect(scanText("/* (0.2 surface) */")).toHaveLength(1);
  });

  it("reports the 1-based line of the offending marker", () => {
    const hits = scanText("clean line\n/* landed at 0.2 */\nanother clean line");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  // One example proves the arithmetic on one file shape; the report has to hold
  // for whatever interleaving of clean and offending lines a real file has,
  // because a line number that drifts sends the author to the wrong line and a
  // hit swallowed between two clean lines fails nothing.
  test.prop([fc.array(fc.tuple(fc.boolean(), proseLine, markerLine), { maxLength: 20 })])(
    "reports every marker line at its own 1-based number, and reports no clean line",
    (lines) => {
      const text = lines
        .map(([carriesMarker, prose, marker]) => (carriesMarker ? `${prose} ${marker}` : prose))
        .join("\n");
      const hits = scanText(text);

      expect(hits.map((hit) => hit.line)).toEqual(
        lines.flatMap(([carriesMarker], index) => (carriesMarker ? [index + 1] : [])),
      );
      for (const hit of hits) {
        expect(text.split("\n")[hit.line - 1]).toContain(hit.match);
      }
    },
  );
});

describe("scanName", () => {
  it("leaves end-state names alone — token substrings, leading qualifiers, domain vocabulary", () => {
    for (const name of [
      "step-executor.ts", // step without an ordinal is domain vocabulary
      "stepId",
      "ISSUE_TEMPLATE", // issue without an ordinal; temp inside a longer word
      "renewal.vue",
      "uuidv4.mjs", // v4 not on a word boundary
      "new-workflow-modal.vue", // leading new = creates a new workflow
      "temp-dir-helper.mjs", // leading temp = handles genuinely temporary files
      "es2022", // a year alone is not a date
      "templates",
      "conformance-g0", // gate codes are end-state vocabulary (conformance.mjs reads gate:G# tags)
      "playlist.m3u8", // m-digit-letter runs are domain names, not milestone codes
      "m2m-gateway.ts",
    ]) {
      expect(scanName(name), name).toBeNull();
    }
  });

  it("flags version, wip, and ordinal tokens as whole name segments", () => {
    expect(scanName("api-v2.ts")).toBe("v2");
    expect(scanName("wip-notes.md")).toBe("wip");
    expect(scanName("phase-2")).toBe("phase-2");
    expect(scanName("build-v3")).toBe("v3"); // an Nx target name
  });

  it("flags bare milestone codes but never gate codes", () => {
    expect(scanName("m0-engine")).toBe("m0");
    expect(scanName("m0-notes.md")).toBe("m0");
    expect(scanName("M1Wedge.ts")).toBe("m1");
  });

  it("flags trailing new/old/temp qualifiers without the extension masking them", () => {
    expect(scanName("utils-new.ts")).toBe("new");
    expect(scanName("config-old.json")).toBe("old");
    expect(scanName("parser-temp.mjs")).toBe("temp");
  });

  it("flags dates and plan/review-code names via the prose pattern", () => {
    expect(scanName("snapshot-2025-01-31.md")).toBe("2025-01-31");
    expect(scanName("PLAN-0.2.md")).toBe("PLAN-0.2.md");
  });

  // The examples above are the tokens someone thought of; the gate has to hold
  // over the whole token space, because the cost of a miss is a durable name
  // nobody can rename later and the cost of a false hit is a blocked commit.
  test.prop([plainName])("leaves a name built from ordinary words alone", (name) => {
    expect(scanName(name)).toBeNull();
  });

  test.prop([plainName, fc.nat({ max: 99 }), fc.constantFrom("", ".ts", ".mjs", ".vue", ".md")])(
    "flags a version segment whatever the name around it and whatever extension follows",
    (base, ordinal, extension) => {
      expect(scanName(`${base}-v${ordinal}${extension}`)).toBe(`v${ordinal}`);
    },
  );

  test.prop([
    plainName,
    fc.constantFrom("phase", "sprint", "milestone", "step", "issue", "ticket"),
    fc.constantFrom("", "-"),
    fc.nat({ max: 99 }),
  ])(
    "flags an ordinal segment whether or not a hyphen separates its number",
    (base, kind, separator, ordinal) => {
      expect(scanName(`${base}-${kind}${separator}${ordinal}`)).toBe(
        `${kind}${separator}${ordinal}`,
      );
    },
  );

  test.prop([
    plainName,
    fc.record({
      year: fc.integer({ min: 1900, max: 2099 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 31 }),
    }),
    fc.constantFrom("-", ""),
  ])(
    "flags a date stamp anywhere in the calendar, hyphenated or compact",
    (base, date, separator) => {
      const pad = (value) => String(value).padStart(2, "0");
      const stamp = `${date.year}${separator}${pad(date.month)}${separator}${pad(date.day)}`;
      expect(scanName(`${base}-${stamp}`)).toBe(stamp);
    },
  );

  // The word-boundary claim `journey-markers.config.json` makes, over every
  // word rather than the three it names: a qualifier is a journey marker only
  // as the trailing segment, so `renewal` and `NewWorkflowModal` stay legal.
  test.prop([word, fc.constantFrom(...QUALIFIERS)])(
    "flags a trailing new/old/temp segment, and only when it is a segment of its own",
    (base, qualifier) => {
      expect(scanName(`${base}-${qualifier}`)).toBe(qualifier);
      expect(scanName(`${qualifier}-${base}`)).toBeNull();
      expect(scanName(`${base}${qualifier}`)).toBeNull();
    },
  );
});

describe("workspaceLevelFiles", () => {
  it("keeps only files that no nx project owns", () => {
    // Files under any project dir belong to that project's own lint scan; only
    // files no project owns (root docs, .github, .claude) are kept.
    const manifests = ["vider/apps/vider/project.json", "shared/tools/dev-cli/project.json"];
    const files = [
      "CLAUDE.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "vider/apps/vider/README.md",
      "shared/tools/dev-cli/src/notes.css",
    ];
    expect(workspaceLevelFiles(files, manifests)).toEqual([
      "CLAUDE.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ]);
  });
});
