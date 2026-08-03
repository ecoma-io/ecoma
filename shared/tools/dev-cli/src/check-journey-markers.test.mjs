import { describe, expect, it } from "vitest";

import { scanName, scanText, workspaceLevelFiles } from "./check-journey-markers.mjs";

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
