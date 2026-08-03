import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectPrFacts, prFacts, typeOfChange } from "./pr-facts.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const PROJECT_FILES = {
  "vider/libs/vider-ui/project.json": JSON.stringify({
    name: "vider-ui",
    tags: ["type:lib", "scope:vider", "layer:view"],
  }),
  "shared/tools/dev-cli/project.json": JSON.stringify({
    name: "dev-cli",
    tags: ["type:lib", "scope:shared"],
  }),
};

/** Routes git calls to an in-memory branch: shas → messages, plus a diff. */
function fakeGit({ commits = {}, changed = [] }) {
  vi.mocked(execFileSync).mockImplementation((cmd, args) => {
    if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === "rev-list") return `${Object.keys(commits).join("\n")}\n`;
    if (args[0] === "log") return commits[args.at(-1)];
    if (args[0] === "diff") return `${changed.join("\n")}\n`;
    if (args[0] === "ls-files") return `${Object.keys(PROJECT_FILES).join("\n")}\n`;
    if (args[0] === "show") return PROJECT_FILES[args.at(-1).replace(/^:/, "")];
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("typeOfChange", () => {
  it("maps commit types onto the PR template's labels", () => {
    const labels = typeOfChange(
      [
        { type: "feat", breaking: false },
        { type: "fix", breaking: false },
      ],
      false,
    );
    expect(labels).toEqual([
      "Bug fix (non-breaking change fixing an issue)",
      "New feature (non-breaking change adding functionality)",
    ]);
  });

  it("flags breaking changes and view-layer work", () => {
    const labels = typeOfChange([{ type: "feat", breaking: true }], true);
    expect(labels).toContain(
      "Breaking change (fix or feature causing existing functionality to change)",
    );
    expect(labels).toContain("Design system / component update");
  });
});

describe("collectPrFacts", () => {
  it("parses branch commits and attributes changed paths to their owners", () => {
    fakeGit({
      commits: {
        abc1: "feat(vider-ui): add drag handles\n\nbody\n",
        abc2: "fix(dev-cli): correct exit code\n",
      },
      changed: [
        "vider/libs/vider-ui/src/Canvas.vue",
        "vider/libs/vider-ui/src/Canvas.test.ts",
        "shared/tools/dev-cli/src/main.mjs",
        "nx.json",
      ],
    });

    const facts = collectPrFacts("origin/main");
    expect(facts.commits).toEqual([
      // `header` is the whole `type(scope): subject` line — not the bare subject, not the body.
      expect.objectContaining({
        sha: "abc1",
        type: "feat",
        scope: "vider-ui",
        header: "feat(vider-ui): add drag handles",
        breaking: false,
      }),
      expect.objectContaining({ sha: "abc2", type: "fix", scope: "dev-cli" }),
    ]);
    expect(facts.touchedProjects).toEqual(["dev-cli", "vider-ui"]);
    expect(facts.workspaceTouched).toBe(true);
    expect(facts.testsChanged).toBe(true);
    expect(facts.viewLayerTouched).toBe(true);
  });

  it("counts every language's test-file convention as testsChanged", () => {
    for (const path of [
      "platform/libs/conformance-g0/lease_test.go",
      "platform/libs/conformance-g0/lease_integration_test.go",
      "shared/tools/repo-care/src/triage_test.py",
      "platform/libs/engine-domain/tests/contract.rs",
    ]) {
      fakeGit({ commits: { abc1: "test(dev-cli): pin behavior\n" }, changed: [path] });
      expect(collectPrFacts("origin/main").testsChanged, path).toBe(true);
    }
    // A non-test Go file does not count.
    fakeGit({
      commits: { abc1: "feat(dev-cli): x\n" },
      changed: ["platform/libs/engine-domain/doc.go"],
    });
    expect(collectPrFacts("origin/main").testsChanged).toBe(false);
  });

  it("detects a breaking change from the ! header marker", () => {
    fakeGit({
      commits: { abc1: "feat(vider-ui)!: rename prop\n" },
      changed: ["vider/libs/vider-ui/src/index.ts"],
    });
    expect(collectPrFacts("origin/main").commits[0].breaking).toBe(true);
  });

  it("skips messages commitlint ignores (merges, reverts)", () => {
    fakeGit({
      commits: { abc1: "Merge branch 'x'\n", abc2: "docs(vider-ui): clarify\n" },
      changed: ["vider/libs/vider-ui/CLAUDE.md"],
    });
    const facts = collectPrFacts("origin/main");
    expect(facts.commits).toHaveLength(1);
    expect(facts.commits[0].type).toBe("docs");
    expect(facts.testsChanged).toBe(false);
  });
});

describe("prFacts", () => {
  it("prints JSON honoring --base", () => {
    fakeGit({ commits: {}, changed: [] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(prFacts(["--base", "origin/develop"])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).base).toBe("origin/develop");
  });
});
