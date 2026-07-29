import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  activeChecks,
  buildDiff,
  buildParityReviewPrompt,
  buildReviewComment,
  buildReviewPrompt,
  CHECKS,
  findReadmeGroups,
  buildManifest,
  buildManifestPrompt,
  isSafeRepoPath,
  MANIFEST_CHECKS,
  withinBudget,
  parseParityVerdict,
  parseReviewVerdict,
  parseTurn,
  REVIEW_MARKER,
  reviewPr,
  runReviewTrajectory,
  tallyFindings,
} from "./review-pr.mjs";

const file = (over = {}) => ({
  filename: "src/a.mjs",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
  ...over,
});

describe("buildDiff", () => {
  it("assembles per-file patches and drops lockfile churn", () => {
    const diff = buildDiff([
      file(),
      file({ filename: "pnpm-lock.yaml" }),
      file({ filename: "img.png", patch: undefined }),
    ]);
    expect(diff.text).toContain("--- src/a.mjs (modified, +1/-1)");
    expect(diff.text).toContain("+new");
    expect(diff.text).not.toContain("pnpm-lock.yaml");
    expect(diff.text).toContain("img.png");
    expect(diff.text).toContain("(patch unavailable)");
    expect(diff.omitted).toBe(1);
    expect(diff.truncated).toBe(false);
  });

  it("caps one group's diff, so a group at the cap is a signal rather than a silent loss", () => {
    const diff = buildDiff([file({ patch: "x".repeat(80000) })]);
    expect(diff.truncated).toBe(true);
    expect(diff.text.length).toBeLessThan(61100);
    expect(diff.text).toContain("(diff truncated)");
  });
});

describe("buildReviewPrompt", () => {
  it("carries the rubric, the PR facts, and the untrusted-data framing", () => {
    const prompt = buildReviewPrompt(
      { title: "feat: x", body: "Adds x" },
      { text: "--- a\n+1", truncated: false },
    );
    for (const id of Object.keys(CHECKS)) expect(prompt).toContain(`- ${id}:`);
    expect(prompt).toContain("PR TITLE: feat: x");
    expect(prompt).toContain("Adds x");
    expect(prompt).toContain("UNTRUSTED DATA");
    expect(prompt).toContain("--- a");
  });

  it("marks a truncated diff and survives an empty body", () => {
    const prompt = buildReviewPrompt({ title: "t", body: null }, { text: "d", truncated: true });
    expect(prompt).toContain("DIFF (truncated)");
    expect(prompt).toContain("(empty)");
  });

  it("carries a journey-marker check so fuzzy Rule 13 comment/name violations get reviewed", () => {
    expect(CHECKS).toHaveProperty("journey-marker");
    expect(CHECKS["journey-marker"]).toMatch(/comment|name/i);
    const prompt = buildReviewPrompt({ title: "t", body: "" }, { text: "d", truncated: false });
    expect(prompt).toContain("- journey-marker:");
    expect(
      parseReviewVerdict({ findings: [{ check: "journey-marker", file: "src/a.mjs", note: "n" }] }),
    ).toEqual({
      findings: [{ check: "journey-marker", file: "src/a.mjs", note: "n" }],
      summary: "",
    });
  });

  it("reviews the test-intent and simplicity checks the deterministic gates cannot see", () => {
    const prompt = buildReviewPrompt({ title: "t", body: "" }, { text: "d", truncated: false });
    for (const check of ["thin-test-intent", "untested-behavior-change", "ladder-skip"]) {
      expect(CHECKS).toHaveProperty(check);
      expect(prompt).toContain(`- ${check}:`);
      expect(parseReviewVerdict({ findings: [{ check, file: "src/a.mjs", note: "n" }] })).toEqual({
        findings: [{ check, file: "src/a.mjs", note: "n" }],
        summary: "",
      });
    }
    // thin-test-intent must stay distinct from weakened-test in the rubric.
    expect(CHECKS["thin-test-intent"]).toMatch(/behaviou?r/i);
    expect(CHECKS["untested-behavior-change"]).toMatch(/test/i);
    expect(CHECKS["ladder-skip"]).toMatch(/built-in|dependency/i);
  });

  it("draws the whole rubric from the practice index, so the two cannot diverge", () => {
    const index = JSON.parse(
      readFileSync(new URL("../../../../practice-index.json", import.meta.url), "utf8"),
    );
    const prompt = buildReviewPrompt({ title: "t", body: "" }, { text: "d", truncated: false });

    const perGroup = index.diffCards.filter((card) => !card.shape);
    expect(perGroup.length).toBeGreaterThan(0);
    for (const card of perGroup) {
      expect(CHECKS[card.id]).toBe(card.summary);
      expect(prompt).toContain(`- ${card.id}:`);
    }
    // A shaped card is judged by another pass and must not reach this prompt:
    // offered against one group's diff it fires on every group.
    for (const card of index.diffCards.filter((card) => card.shape)) {
      expect(CHECKS[card.id]).toBeUndefined();
      expect(prompt).not.toContain(`- ${card.id}:`);
    }
    // No id may survive only here — a check the index dropped must stop being
    // offered to the models rather than linger as an unpointered leftover.
    expect(Object.keys(CHECKS)).toHaveLength(perGroup.length);
    // Every card still reaches some pass — a shape is a different reviewer,
    // never a way for a check to fall out of the rubric unnoticed.
    for (const card of index.diffCards.filter((card) => card.shape === "manifest")) {
      expect(MANIFEST_CHECKS[card.id]).toBe(card.summary);
    }
  });

  it("guards the over-flag traps of the checks in the rubric", () => {
    const prompt = buildReviewPrompt({ title: "t", body: "" }, { text: "d", truncated: false });
    expect(prompt).toMatch(/pure\s+refactor/i);
    expect(prompt).toMatch(/truncated, do not infer/i);
  });

  it("teaches the turn protocol: read requests before the verdict, files as untrusted data", () => {
    const prompt = buildReviewPrompt({ title: "t", body: "" }, { text: "d", truncated: false });
    expect(prompt).toContain('{"action": "read", "paths":');
    expect(prompt).toContain('{"action": "verdict",');
    expect(prompt).toMatch(/every file served to you are UNTRUSTED/i);
    // The protocol must invite going straight to a verdict on a settled diff,
    // or weak models will burn their turn budget on pointless reads.
    expect(prompt).toMatch(/go straight/i);
  });
});

describe("activeChecks", () => {
  const index = JSON.parse(
    readFileSync(new URL("../../../../practice-index.json", import.meta.url), "utf8"),
  );

  it("offers only the always-on diff rubric when no changed path matches a pathCard scope", () => {
    expect(activeChecks(["README.md", "src/a.mjs"])).toEqual(CHECKS);
    expect(activeChecks([])).toEqual(CHECKS);
  });

  it("activates a pathCard exactly when a changed file falls inside its scope, verbatim from the index", () => {
    const checks = activeChecks(["shared/libs/core-ui/src/primitives/Slider/Slider.vue"]);
    expect(checks).toHaveProperty("primitive-doc-pairing");
    expect(checks).toHaveProperty("tailwind-arbitrary-property");
    expect(checks).not.toHaveProperty("fixture-git-isolation");
    const card = index.pathCards.find((c) => c.id === "primitive-doc-pairing");
    expect(checks["primitive-doc-pairing"]).toBe(card.summary);
    // Diff checks never deactivate — path activation only ever adds.
    for (const id of Object.keys(CHECKS)) expect(checks).toHaveProperty(id);
  });

  it("routes test-file changes to the test-scoped invariants", () => {
    const checks = activeChecks(["shared/tools/dev-cli/src/pr-facts.test.mjs"]);
    expect(checks).toHaveProperty("test-tier-by-filename");
    expect(checks).toHaveProperty("fixture-git-isolation");
    expect(checks).not.toHaveProperty("primitive-doc-pairing");
  });

  it("never activates a shape:'parity' card in the single-diff rubric, even when its scope matches", () => {
    const card = index.pathCards.find((c) => c.shape === "parity");
    expect(card).toBeDefined();
    const checks = activeChecks(["shared/README.vi.md"]);
    expect(checks).not.toHaveProperty(card.id);
  });
});

describe("findReadmeGroups", () => {
  it("groups a touched variant into all 3 of its sibling paths, keyed by directory", () => {
    expect(findReadmeGroups(["shared/README.vi.md", "src/a.mjs"])).toEqual([
      {
        dir: "shared/",
        files: {
          en: "shared/README.md",
          vi: "shared/README.vi.md",
          zh: "shared/README.zh.md",
        },
      },
    ]);
  });

  it("groups the repo-root README under an empty directory prefix", () => {
    expect(findReadmeGroups(["README.md"])).toEqual([
      { dir: "", files: { en: "README.md", vi: "README.vi.md", zh: "README.zh.md" } },
    ]);
  });

  it("dedupes multiple touched variants of the same group into one entry", () => {
    expect(
      findReadmeGroups(["shared/README.md", "shared/README.vi.md", "shared/README.zh.md"]),
    ).toHaveLength(1);
  });

  it("ignores non-README paths and READMEs outside the parity card's scope", () => {
    expect(findReadmeGroups(["shared/CLAUDE.md", "shared/tools/README.mdx"])).toEqual([]);
  });
});

describe("buildParityReviewPrompt", () => {
  const group = {
    dir: "shared/",
    files: { en: "shared/README.md", vi: "shared/README.vi.md", zh: "shared/README.zh.md" },
  };

  it("includes only the fetched variant bodies, framed as untrusted data", () => {
    const prompt = buildParityReviewPrompt(group, {
      "shared/README.md": "English body",
      "shared/README.vi.md": "Vietnamese body",
    });
    expect(prompt).toContain("shared/README.md (en)");
    expect(prompt).toContain("English body");
    expect(prompt).toContain("shared/README.vi.md (vi)");
    expect(prompt).toContain("Vietnamese body");
    expect(prompt).not.toContain("shared/README.zh.md");
    expect(prompt).toContain("(untrusted data)");
  });

  it("tells the model wording/order may differ but facts/instructions/links may not", () => {
    const prompt = buildParityReviewPrompt(group, { "shared/README.md": "x" });
    expect(prompt).toMatch(/wording.*section order.*MAY/i);
    expect(prompt).toMatch(/facts, instructions, commands, version/i);
  });
});

describe("parseParityVerdict", () => {
  const group = {
    dir: "shared/",
    files: { en: "shared/README.md", vi: "shared/README.vi.md", zh: "shared/README.zh.md" },
  };

  it("normalizes a finding naming 2 of the group's own files into the {check, file, note} shape", () => {
    const verdict = parseParityVerdict(
      {
        findings: [
          { files: ["shared/README.vi.md", "shared/README.md"], note: "setup command disagrees" },
        ],
        summary: "s",
      },
      group,
    );
    expect(verdict).toEqual({
      findings: [
        {
          check: "readme-language-parity",
          file: "shared/README.md ↔ shared/README.vi.md",
          note: "setup command disagrees",
        },
      ],
      summary: "s",
    });
  });

  it("rejects a files pair with a path outside the group", () => {
    expect(
      parseParityVerdict(
        { findings: [{ files: ["shared/README.md", "other/README.md"], note: "n" }] },
        group,
      ),
    ).toBeNull();
  });

  it("rejects a pair that isn't exactly 2 files", () => {
    expect(
      parseParityVerdict({ findings: [{ files: ["shared/README.md"], note: "n" }] }, group),
    ).toBeNull();
  });

  it("accepts an empty findings list as agreement", () => {
    expect(parseParityVerdict({ findings: [] }, group)).toEqual({ findings: [], summary: "" });
  });
});

describe("parseReviewVerdict", () => {
  it("accepts a path-activated check only when this run offered it", () => {
    const finding = { check: "tailwind-arbitrary-property", file: "src/A.vue", note: "n" };
    // Not offered (default diff-only rubric): out-of-enum, verdict rejected.
    expect(parseReviewVerdict({ findings: [finding] })).toBeNull();
    expect(parseReviewVerdict({ findings: [finding] }, activeChecks(["src/A.vue"]))).toEqual({
      findings: [finding],
      summary: "",
    });
  });

  it("normalizes a well-formed answer, empty findings included", () => {
    expect(parseReviewVerdict({ findings: [], summary: "clean" })).toEqual({
      findings: [],
      summary: "clean",
    });
    expect(
      parseReviewVerdict({
        findings: [{ check: "weakened-test", file: "a.test.ts", note: "n" }],
      }),
    ).toEqual({
      findings: [{ check: "weakened-test", file: "a.test.ts", note: "n" }],
      summary: "",
    });
  });

  it("rejects unknown checks, missing files, and non-object shapes", () => {
    expect(parseReviewVerdict(null)).toBeNull();
    expect(parseReviewVerdict({ findings: "none" })).toBeNull();
    expect(
      parseReviewVerdict({ findings: [{ check: "style-nit", file: "a", note: "n" }] }),
    ).toBeNull();
    expect(
      parseReviewVerdict({ findings: [{ check: "fake-done", file: "", note: "n" }] }),
    ).toBeNull();
  });

  it("caps a flooding model at 8 findings instead of rejecting it", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      check: "fake-done",
      file: `f${i}`,
      note: "n",
    }));
    expect(parseReviewVerdict({ findings }).findings).toHaveLength(8);
  });
});

describe("isSafeRepoPath", () => {
  it("accepts only repo-relative paths with real segments", () => {
    expect(isSafeRepoPath("src/a.mjs")).toBe(true);
    expect(isSafeRepoPath("shared/tools/repo-care")).toBe(true);
    for (const bad of ["/etc/passwd", "../secret", "a/../b", "a//b", "a\\b", "", ".", "a/."]) {
      expect(isSafeRepoPath(bad)).toBe(false);
    }
  });
});

describe("parseTurn", () => {
  it("normalizes a read request, dropping junk paths and capping the batch", () => {
    expect(parseTurn({ action: "read", paths: ["a.mjs", 7, "", "b/c.ts"] })).toEqual({
      action: "read",
      paths: ["a.mjs", "b/c.ts"],
    });
    expect(parseTurn({ action: "read", paths: ["1", "2", "3", "4", "5", "6"] }).paths).toHaveLength(
      4,
    );
    expect(parseTurn({ action: "read", paths: [] })).toBeNull();
    expect(parseTurn({ action: "read" })).toBeNull();
  });

  it("accepts a verdict with or without the action wrapper — weak models drop it", () => {
    const findings = [{ check: "fake-done", file: "a.mjs", note: "n" }];
    expect(parseTurn({ action: "verdict", findings, summary: "s" })).toEqual({
      action: "verdict",
      verdict: { findings, summary: "s" },
    });
    expect(parseTurn({ findings, summary: "s" })).toEqual({
      action: "verdict",
      verdict: { findings, summary: "s" },
    });
  });

  it("rejects shapes that are neither a read nor a verdict", () => {
    expect(parseTurn(null)).toBeNull();
    expect(parseTurn({ action: "run", cmd: "rm -rf" })).toBeNull();
    expect(parseTurn({ findings: "none" })).toBeNull();
  });
});

describe("runReviewTrajectory", () => {
  const verdictContent = JSON.stringify({
    action: "verdict",
    findings: [{ check: "fake-done", file: "a.mjs", note: "n" }],
    summary: "s",
  });
  const readContent = (...paths) => JSON.stringify({ action: "read", paths });
  /** call stub that replays scripted contents and records each turn's messages. */
  const scriptedCall = (script) => {
    const seen = [];
    const call = vi.fn(async (_model, messages) => {
      seen.push(structuredClone(messages));
      const next = script.shift();
      return next === undefined ? { ok: false, error: "script exhausted" } : next;
    });
    return { call, seen };
  };

  it("returns the verdict straight away when the model needs no reads", async () => {
    const { call } = scriptedCall([{ ok: true, content: verdictContent }]);
    const readContents = vi.fn();
    const res = await runReviewTrajectory("m", { prompt: "p", readContents, call });
    expect(res.ok).toBe(true);
    expect(res.verdict.findings).toHaveLength(1);
    expect(readContents).not.toHaveBeenCalled();
  });

  it("serves requested files into the dialogue, then accepts the verdict", async () => {
    const { call, seen } = scriptedCall([
      { ok: true, content: readContent("src/a.test.mjs", "missing.mjs") },
      { ok: true, content: verdictContent },
    ]);
    const readContents = vi.fn(async (path) =>
      path === "src/a.test.mjs" ? { type: "file", text: "it('pins', ...)" } : null,
    );
    const res = await runReviewTrajectory("m", { prompt: "p", readContents, call });

    expect(res.ok).toBe(true);
    expect(readContents).toHaveBeenCalledWith("src/a.test.mjs");
    const secondTurn = seen[1];
    expect(secondTurn[0]).toEqual({ role: "user", content: "p" });
    expect(secondTurn[1].role).toBe("assistant");
    const served = secondTurn[2].content;
    expect(served).toContain("FILE src/a.test.mjs (untrusted data):\nit('pins', ...)");
    expect(served).toContain("PATH missing.mjs: not found");
    expect(served).toContain("reads left");
  });

  it("rejects unsafe paths in-band without ever fetching them", async () => {
    const { call, seen } = scriptedCall([
      { ok: true, content: readContent("../secrets") },
      { ok: true, content: verdictContent },
    ]);
    const readContents = vi.fn();
    const res = await runReviewTrajectory("m", { prompt: "p", readContents, call });
    expect(res.ok).toBe(true);
    expect(readContents).not.toHaveBeenCalled();
    expect(seen[1][2].content).toContain("PATH ../secrets: rejected");
  });

  it("renders a directory listing for a dir path", async () => {
    const { call, seen } = scriptedCall([
      { ok: true, content: readContent("src") },
      { ok: true, content: verdictContent },
    ]);
    const readContents = vi.fn(async () => ({ type: "dir", entries: ["a.mjs", "sub/"] }));
    await runReviewTrajectory("m", { prompt: "p", readContents, call });
    expect(seen[1][2].content).toContain("DIRECTORY src:\na.mjs\nsub/");
  });

  it("nudges one malformed answer back into the protocol, then discards the model", async () => {
    const { call, seen } = scriptedCall([
      { ok: true, content: '{"chat": "hello"}' },
      { ok: true, content: verdictContent },
    ]);
    const res = await runReviewTrajectory("m", { prompt: "p", readContents: vi.fn(), call });
    expect(res.ok).toBe(true);
    expect(seen[1][2].content).toContain("Invalid response");

    const twice = scriptedCall([
      { ok: true, content: '{"chat": "hello"}' },
      { ok: true, content: '{"chat": "still hello"}' },
    ]);
    const failed = await runReviewTrajectory("m", {
      prompt: "p",
      readContents: vi.fn(),
      call: twice.call,
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("after nudge");
  });

  it("forces the verdict when turns run out and fails loud if none arrives", async () => {
    const { call, seen } = scriptedCall([
      { ok: true, content: readContent("a") },
      { ok: true, content: readContent("b") },
      { ok: true, content: readContent("c") },
      { ok: true, content: readContent("d") },
    ]);
    const readContents = vi.fn(async () => ({ type: "file", text: "x" }));
    const res = await runReviewTrajectory("m", { prompt: "p", readContents, call });
    expect(res).toEqual({ ok: false, error: "no verdict within the turn budget" });
    expect(call).toHaveBeenCalledTimes(4);
    expect(seen[3].at(-1).content).toContain("No reads left");
  });

  it("stops granting reads past the total budget", async () => {
    const eightPaths = ["1", "2", "3", "4"];
    const { call, seen } = scriptedCall([
      { ok: true, content: readContent(...eightPaths) },
      { ok: true, content: readContent("5", "6", "7", "8", "9") },
      { ok: true, content: verdictContent },
    ]);
    const readContents = vi.fn(async () => ({ type: "file", text: "x" }));
    const res = await runReviewTrajectory("m", { prompt: "p", readContents, call });
    expect(res.ok).toBe(true);
    // 4 granted in turn one + 4 of the requested 5 in turn two (cap is 8).
    expect(readContents).toHaveBeenCalledTimes(8);
    expect(seen[2].at(-1).content).toContain("No reads left");
  });

  it("propagates a provider failure as a rotate-able error", async () => {
    const { call } = scriptedCall([{ ok: false, error: "provider: rate_limit" }]);
    const res = await runReviewTrajectory("m", { prompt: "p", readContents: vi.fn(), call });
    expect(res).toEqual({ ok: false, error: "provider: rate_limit" });
  });
});

describe("tallyFindings", () => {
  const v = (model, findings) => ({ model, verdict: { findings, summary: "" } });
  const f = (check, fileName, note = "n") => ({ check, file: fileName, note });

  it("confirms only (check, file) pairs named by ≥2 models, keeping both notes", () => {
    const confirmed = tallyFindings([
      v("m1", [f("weakened-test", "a.test.ts", "from m1"), f("fake-done", "b.mjs")]),
      v("m2", [f("weakened-test", "a.test.ts", "from m2")]),
      v("m3", [f("smuggled-refactor", "c.mjs")]),
    ]);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].check).toBe("weakened-test");
    expect(confirmed[0].notes).toEqual(["from m1", "from m2"]);
    expect(confirmed[0].models).toEqual(["m1", "m2"]);
  });

  it("never lets one model double-vote its own finding into a quorum", () => {
    const confirmed = tallyFindings([
      v("m1", [f("fake-done", "b.mjs", "one"), f("fake-done", "b.mjs", "two")]),
      v("m2", []),
    ]);
    expect(confirmed).toEqual([]);
  });
});

describe("withinBudget", () => {
  const g = (name, n = 1) => ({
    root: name,
    name,
    files: Array.from({ length: n }, (_, i) => `${name}/${i}`),
  });

  it("leaves a run that already fits untouched", () => {
    const groups = [g("a"), g("b")];
    expect(withinBudget(groups, 6)).toEqual(groups);
  });

  it("merges the tail instead of dropping it, because an unreviewed group reviews not at all", () => {
    const groups = [g("a"), g("b"), g("c"), g("d")];
    const kept = withinBudget(groups, 2);
    expect(kept).toHaveLength(2);
    expect(kept.flatMap((k) => k.files).sort()).toEqual(groups.flatMap((x) => x.files).sort());
  });

  it("names what it absorbed, so a reader can see those files were judged together", () => {
    const merged = withinBudget([g("a"), g("b"), g("c")], 2).at(-1);
    expect(merged.name).toContain("b");
    expect(merged.name).toContain("c");
    expect(merged.name).toContain("2 smaller groups");
  });
});

describe("buildManifest", () => {
  it("describes what changed without any of the content, which is all a manifest check needs", () => {
    const manifest = buildManifest([
      file({ filename: "a.ts", additions: 3, deletions: 1 }),
      file({ filename: "b.test.ts", status: "added", additions: 9, deletions: 0 }),
    ]);
    expect(manifest).toContain("2 files changed, 13 lines added or removed");
    expect(manifest).toContain("a.ts (modified, +3/-1)");
    expect(manifest).toContain("b.test.ts (added, +9/-0)");
    expect(manifest).not.toContain("@@");
  });
});

describe("buildManifestPrompt", () => {
  it("offers only the manifest checks and frames the description as untrusted", () => {
    const prompt = buildManifestPrompt({ title: "t", body: "adds tests" }, "1 file changed");
    for (const id of Object.keys(MANIFEST_CHECKS)) expect(prompt).toContain(`- ${id}:`);
    for (const id of Object.keys(CHECKS)) expect(prompt).not.toContain(`- ${id}:`);
    expect(prompt).toContain("UNTRUSTED DATA");
    expect(prompt).toContain("adds tests");
  });

  it("tells the model a shorter description is not a finding, the trap this shape exists to avoid", () => {
    const prompt = buildManifestPrompt({ title: "t", body: "" }, "m");
    expect(prompt).toMatch(/shorter or more general[\s\S]*not a\s*\n?finding/i);
    expect(prompt).toContain("not the diff");
  });
});

describe("buildReviewComment", () => {
  const group = (over = {}) => ({
    name: "dev-cli",
    quorum: true,
    truncated: false,
    confirmed: [],
    ...over,
  });

  it("heads each group with its own state, so a large pull request reads as a checklist", () => {
    const body = buildReviewComment(
      [
        group({
          confirmed: [
            { check: "weakened-test", file: "a.test.ts", notes: ["n1", "n2"], models: ["x", "y"] },
          ],
        }),
        group({ name: "core-ui" }),
      ],
      ["x", "y", "z"],
    );
    expect(body).toContain(REVIEW_MARKER);
    expect(body).toContain("#### dev-cli — 1 finding");
    expect(body).toContain("**weakened-test** — `a.test.ts`");
    expect(body).toContain("- n1");
    expect(body).toContain("#### core-ui — clean");
    expect(body).toContain("Advisory only");
  });

  it("says a group reached no quorum instead of leaving it out, because absence would read as clean", () => {
    const body = buildReviewComment([group({ name: "repo-care", quorum: false })], ["x"]);
    expect(body).toContain("#### repo-care — no quorum — not reviewed");
    expect(body).toContain("not the same as clean");
  });

  it("marks truncation against the group it happened in, not the whole review", () => {
    const body = buildReviewComment(
      [group({ truncated: true }), group({ name: "core-ui" })],
      ["x"],
    );
    const [devCli, coreUi] = body.split("#### core-ui");
    expect(devCli).toContain("truncated");
    expect(coreUi).not.toContain("truncated");
  });
});

describe("reviewPr", () => {
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "ecoma-io/ecoma" };
  const finding = { check: "weakened-test", file: "a.test.ts", note: "assertion removed" };

  const fakeFetch = (state, { pr = {}, zenFindings = [finding] } = {}) =>
    vi.fn(async (url, init = {}) => {
      const asJson = (payload) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      });
      if (url.endsWith("/chat/completions")) {
        const { messages } = JSON.parse(init.body);
        state.dialogues.push(messages);
        // First turn: optionally read; afterwards: the verdict. A bare
        // findings object (no action wrapper) must count as a verdict.
        const content =
          state.readFirst && messages.length === 1
            ? JSON.stringify({ action: "read", paths: state.readFirst })
            : JSON.stringify({ findings: zenFindings, summary: "s" });
        return asJson({
          choices: [{ finish_reason: "stop", message: { content } }],
        });
      }
      if (url.includes("/contents/")) {
        state.contentUrls.push(url);
        return asJson({
          type: "file",
          encoding: "base64",
          content: Buffer.from("full file body").toString("base64"),
        });
      }
      if (/\/pulls\/\d+$/.test(url)) {
        return asJson({
          number: 9,
          title: "t",
          body: "b",
          state: "open",
          draft: false,
          head: { sha: "headsha1" },
          ...pr,
        });
      }
      if (url.includes("/pulls/9/files")) return asJson(state.files);
      if (url.includes("/comments?per_page=100&page=")) {
        const page = Number(new URL(url).searchParams.get("page"));
        return asJson(state.comments.slice((page - 1) * 100, page * 100));
      }
      if (url.includes("/issues/9/comments")) {
        state.posted = JSON.parse(init.body).body;
        return asJson({});
      }
      if (url.includes("/issues/comments/")) {
        state.updated = { url, body: JSON.parse(init.body).body };
        return asJson({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

  const freshState = () => ({
    files: [file()],
    comments: [],
    dialogues: [],
    contentUrls: [],
    readFirst: null,
  });

  it("posts one comment carrying the quorum-confirmed findings", async () => {
    const state = freshState();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], { fetchImpl: fakeFetch(state), env });

    expect(code).toBe(0);
    expect(state.posted).toContain("**weakened-test** — `a.test.ts`");
    const summary = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(summary.findingCount).toBe(1);
    // One group, named for the unit owning the changed file, and it reached a
    // quorum — the three facts a reader needs to know the review happened.
    expect(summary.groups).toEqual([{ name: "src", quorum: true, truncated: false, findings: 1 }]);
    log.mockRestore();
  });

  it("path-activates scoped checks and lets a quorum confirm findings against them", async () => {
    const state = freshState();
    state.files = [file({ filename: "shared/libs/core-ui/src/primitives/Slider/Slider.vue" })];
    const vueFinding = {
      check: "tailwind-arbitrary-property",
      file: "shared/libs/core-ui/src/primitives/Slider/Slider.vue",
      note: "arbitrary property used",
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], {
      fetchImpl: fakeFetch(state, { zenFindings: [vueFinding] }),
      env,
    });

    expect(code).toBe(0);
    // The activated card reached the model's rubric; unrelated pathCards did not.
    const prompt = state.dialogues[0][0].content;
    expect(prompt).toContain("- tailwind-arbitrary-property:");
    expect(prompt).not.toContain("fixture-git-isolation");
    expect(state.posted).toContain("**tailwind-arbitrary-property**");
    const summary = JSON.parse(log.mock.calls.at(-1)[0]);
    // Named by the Nx project, the same vocabulary a commit scope uses.
    expect(summary.groups.map((g) => g.name)).toEqual(["core-ui"]);
    log.mockRestore();
  });

  it("reviews each owning unit as its own group, named the way a commit scope names it", async () => {
    const state = freshState();
    state.files = [
      file({ filename: "shared/tools/dev-cli/src/a.mjs" }),
      file({ filename: "shared/libs/core-ui/src/b.ts" }),
      file({ filename: "CLAUDE.md" }),
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], { fetchImpl: fakeFetch(state), env });

    expect(code).toBe(0);
    const summary = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(summary.groups.map((g) => g.name).sort()).toEqual([
      "core-ui",
      "dev-cli",
      "repository root",
    ]);
    // Each group was investigated on its own diff, not once on the whole PR.
    expect(state.posted).toContain("#### dev-cli");
    expect(state.posted).toContain("#### core-ui");
    log.mockRestore();
  });

  it("exits 1 when no group reached a quorum, rather than posting a comment that reads as clean", async () => {
    const state = freshState();
    const broken = fakeFetch(state);
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/chat/completions")) {
        return {
          ok: true,
          status: 200,
          text: async () => "{}",
          json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }),
        };
      }
      return broken(url, init);
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], { fetchImpl, env });

    expect(code).toBe(1);
    expect(state.posted).toBeUndefined();
    expect(err.mock.calls.flat().join(" ")).toContain("no group reached a quorum");
    vi.restoreAllMocks();
  });

  it("serves investigation reads from the PR head SHA before the verdict lands", async () => {
    const state = freshState();
    state.readFirst = ["src/a.test.mjs"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], { fetchImpl: fakeFetch(state), env });

    expect(code).toBe(0);
    expect(state.contentUrls).toHaveLength(3); // one read per model trajectory
    expect(state.contentUrls[0]).toContain("/contents/src/a.test.mjs?ref=headsha1");
    // The served file must reach the model's next turn as untrusted data.
    const verdictTurn = state.dialogues.find((m) => m.length === 3);
    expect(verdictTurn[2].content).toContain(
      "FILE src/a.test.mjs (untrusted data):\nfull file body",
    );
    expect(state.posted).toContain("**weakened-test** — `a.test.ts`");
    vi.restoreAllMocks();
  });

  it("stays silent on a clean first run, but updates an existing comment to all-clear", async () => {
    const clean = freshState();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      await reviewPr(["--pr", "9"], { fetchImpl: fakeFetch(clean, { zenFindings: [] }), env }),
    ).toBe(0);
    expect(clean.posted).toBeUndefined();

    const stale = freshState();
    stale.comments = [{ id: 5, body: `${REVIEW_MARKER}\nold findings` }];
    expect(
      await reviewPr(["--pr", "9"], { fetchImpl: fakeFetch(stale, { zenFindings: [] }), env }),
    ).toBe(0);
    expect(stale.updated.url).toContain("/issues/comments/5");
    expect(stale.updated.body).toContain("— clean");
    vi.restoreAllMocks();
  });

  it("finds the review marker past the first page of comments and edits it in place", async () => {
    const state = freshState();
    state.comments = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: i, body: `noise ${i}` })),
      { id: 55, body: `${REVIEW_MARKER}\nold findings` },
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], { fetchImpl: fakeFetch(state), env });

    expect(code).toBe(0);
    expect(state.posted).toBeUndefined();
    expect(state.updated.url).toContain("/issues/comments/55");
    vi.restoreAllMocks();
  });

  it("exits 1 with a structured error when GitHub fails, instead of crashing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    }));
    expect(await reviewPr(["--pr", "9"], { fetchImpl, env })).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toContain("review-pr: GitHub GET");
    err.mockRestore();
  });

  it("skips drafts and closed PRs without calling any model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const pr of [{ draft: true }, { state: "closed" }]) {
      const state = freshState();
      const fetchImpl = fakeFetch(state, { pr });
      expect(await reviewPr(["--pr", "9"], { fetchImpl, env })).toBe(0);
      const urls = fetchImpl.mock.calls.map(([u]) => u);
      expect(urls.some((u) => u.includes("chat/completions"))).toBe(false);
    }
    vi.restoreAllMocks();
  });

  it("fails loud when the quorum is unreachable", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = freshState();
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/chat/completions")) {
        return { ok: true, json: async () => ({ error: { code: "rate_limit" } }) };
      }
      return fakeFetch(state)(url, init);
    });
    expect(await reviewPr(["--pr", "9"], { fetchImpl, env })).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toContain("quorum");
    err.mockRestore();
  });

  it("rejects bad usage and missing environment as usage errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reviewPr([], { env })).toBe(2);
    expect(await reviewPr(["--pr", "9"], { env: {} })).toBe(2);
    err.mockRestore();
  });

  it("surfaces a README language-parity finding, additive to a clean diff review", async () => {
    const state = freshState();
    state.files = [file({ filename: "shared/README.vi.md" })];
    const bodies = {
      "shared/README.md": "The setup script is `setup.sh`.",
      "shared/README.vi.md": "Script cai dat la `install.sh`.",
      "shared/README.zh.md": "Setup script shi `setup.sh`.",
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const asJson = (payload) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      });
      if (url.endsWith("/chat/completions")) {
        const { messages } = JSON.parse(init.body);
        const isParity = messages[0].content.includes("semantic agreement");
        const content = isParity
          ? JSON.stringify({
              findings: [
                {
                  files: ["shared/README.md", "shared/README.vi.md"],
                  note: "setup script name disagrees",
                },
              ],
              summary: "s",
            })
          : JSON.stringify({ findings: [], summary: "s" });
        return asJson({ choices: [{ finish_reason: "stop", message: { content } }] });
      }
      if (url.includes("/contents/")) {
        const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1]);
        return asJson({
          type: "file",
          encoding: "base64",
          content: Buffer.from(bodies[path] ?? "").toString("base64"),
        });
      }
      if (/\/pulls\/\d+$/.test(url)) {
        return asJson({
          number: 9,
          title: "t",
          body: "b",
          state: "open",
          draft: false,
          head: { sha: "headsha1" },
        });
      }
      if (url.includes("/pulls/9/files")) return asJson(state.files);
      if (url.includes("/comments?per_page=100&page=")) return asJson([]);
      if (url.includes("/issues/9/comments")) {
        state.posted = JSON.parse(init.body).body;
        return asJson({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await reviewPr(["--pr", "9"], { fetchImpl, env });

    expect(code).toBe(0);
    expect(state.posted).toContain("**readme-language-parity**");
    expect(state.posted).toContain("shared/README.md ↔ shared/README.vi.md");
    const summary = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(summary.readmeGroupsChecked).toBe(1);
    log.mockRestore();
  });
});
