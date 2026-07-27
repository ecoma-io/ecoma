import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allScopes,
  checkCommitScope,
  deriveSubsystems,
  discoverProjects,
  evaluateScopes,
  isIgnoredMessage,
  messageHeader,
  ownerOf,
  parseHeader,
  readProjectGraphDeps,
  transitiveDependsOn,
  WORKSPACE_SCOPE,
} from "./check-commit-scope.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const PROJECTS = [
  { name: "vider", root: "vider/apps/vider" },
  { name: "vider-ui", root: "vider/libs/vider-ui" },
  { name: "core-ui", root: "shared/libs/core-ui" },
  { name: "dev-cli", root: "shared/tools/dev-cli" },
  { name: "reacher", root: "reacher/apps/reacher" },
];
const SUBSYSTEMS = deriveSubsystems(PROJECTS);

/**
 * Routes the module's git calls to an in-memory repo: `tracked` maps path →
 * content (index and commit tree alike), `staged`/`commitFiles` are the
 * changed-path listings, `commitMessage` is what `git log` returns.
 */
function fakeGit({ tracked = {}, staged = [], commitFiles = [], commitMessage = "" }) {
  vi.mocked(execFileSync).mockImplementation((cmd, args) => {
    if (cmd !== "git") throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === "diff") return `${staged.join("\n")}\n`;
    if (args[0] === "log") return commitMessage;
    if (args[0] === "ls-files" || args[0] === "ls-tree")
      return `${Object.keys(tracked).join("\n")}\n`;
    if (args[0] === "show" && args.includes("--name-only")) return `${commitFiles.join("\n")}\n`;
    if (args[0] === "show") {
      const path = args.at(-1).replace(/^[^:]*:/, "");
      if (!(path in tracked)) throw new Error(`no such tracked file: ${path}`);
      return tracked[path];
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  });
}

const TRACKED_PROJECTS = Object.fromEntries(
  PROJECTS.map((p) => [`${p.root}/project.json`, JSON.stringify({ name: p.name })]),
);

function messageFile(content) {
  const path = join(mkdtempSync(join(tmpdir(), "commit-scope-msg-")), "COMMIT_EDITMSG");
  writeFileSync(path, content);
  return path;
}

afterEach(() => vi.restoreAllMocks());

describe("messageHeader", () => {
  it("returns the first real line, skipping comments, blanks, and the scissors block", () => {
    const msg = [
      "# comment from git",
      "",
      "feat(vider-ui): add thing",
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
    ].join("\n");
    expect(messageHeader(msg)).toBe("feat(vider-ui): add thing");
    expect(messageHeader("# only comments\n\n")).toBe("");
  });

  it("strips a trailing \\r on a CRLF-authored message, same as LF", () => {
    const msg = ["# comment from git", "", "feat(vider-ui): add thing", ""].join("\r\n");
    expect(messageHeader(msg)).toBe("feat(vider-ui): add thing");
  });
});

describe("isIgnoredMessage", () => {
  it.each([
    "Merge branch 'feature/x'",
    "Merge pull request #12 from a/b",
    'Revert "feat(vider-ui): add thing"',
    "fixup! feat(vider-ui): add thing",
    "squash! wip",
    "Merge remote-tracking branch 'origin/main'",
    "1.2.3",
    "v1.2.3-beta.1",
  ])("waves through commitlint's default-ignored message %j", (header) => {
    expect(isIgnoredMessage(header)).toBe(true);
  });

  it("does not ignore an ordinary Conventional header", () => {
    expect(isIgnoredMessage("feat(vider-ui): add thing")).toBe(false);
  });
});

describe("parseHeader", () => {
  it("extracts type and scope, including the breaking-change marker", () => {
    expect(parseHeader("feat(vider-ui): x")).toEqual({ type: "feat", scope: "vider-ui" });
    expect(parseHeader("fix(core-ui)!: y")).toEqual({ type: "fix", scope: "core-ui" });
    expect(parseHeader("chore: z")).toEqual({ type: "chore", scope: null });
  });

  it("returns null for a non-Conventional header", () => {
    expect(parseHeader("wip stuff")).toBeNull();
    expect(parseHeader("feat(vider-ui):")).toBeNull();
  });
});

describe("deriveSubsystems", () => {
  it("collects top-level directories that contain projects", () => {
    expect([...SUBSYSTEMS].sort()).toEqual(["reacher", "shared", "vider"]);
  });

  it("does not turn a top-level project root into a subsystem", () => {
    expect(deriveSubsystems([{ name: "tools", root: "tools" }]).size).toBe(0);
  });
});

describe("allScopes", () => {
  it("unions project names, subsystems, and workspace — deduped and sorted", () => {
    expect(allScopes(PROJECTS)).toEqual([
      "core-ui",
      "dev-cli",
      "reacher", // both the app project and its subsystem — one scope
      "shared",
      "vider",
      "vider-ui",
      "workspace",
    ]);
  });
});

describe("ownerOf", () => {
  it("assigns the deepest containing project", () => {
    expect(ownerOf("vider/libs/vider-ui/src/a.ts", PROJECTS, SUBSYSTEMS).name).toBe("vider-ui");
  });

  it("falls back to the subsystem for files no project owns", () => {
    expect(ownerOf("vider/CLAUDE.md", PROJECTS, SUBSYSTEMS)).toMatchObject({
      kind: "subsystem",
      name: "vider",
    });
  });

  it("falls back to workspace for root files", () => {
    expect(ownerOf("nx.json", PROJECTS, SUBSYSTEMS).name).toBe(WORKSPACE_SCOPE);
  });
});

describe("evaluateScopes", () => {
  const allowed = (paths) => [...evaluateScopes(paths, PROJECTS, SUBSYSTEMS).allowed].sort();

  it("requires the project scope when one project covers everything", () => {
    expect(allowed(["vider/libs/vider-ui/src/a.ts", "vider/libs/vider-ui/README.md"])).toEqual([
      "vider-ui",
    ]);
  });

  it("requires the subsystem scope for several owners inside one subsystem", () => {
    expect(allowed(["vider/apps/vider/src/m.ts", "vider/libs/vider-ui/src/a.ts"])).toEqual([
      "vider",
    ]);
    expect(allowed(["vider/CLAUDE.md", "vider/libs/vider-ui/src/a.ts"])).toEqual(["vider"]);
  });

  it("requires workspace across subsystems or for root files", () => {
    expect(allowed(["shared/libs/core-ui/src/b.ts", "vider/libs/vider-ui/src/a.ts"])).toEqual([
      WORKSPACE_SCOPE,
    ]);
    expect(allowed(["package.json"])).toEqual([WORKSPACE_SCOPE]);
  });

  it("marks a mix of root-owned and project/subsystem-owned paths as mustSplit, with no allowed scope", () => {
    const mixed = evaluateScopes(
      ["package.json", "vider/libs/vider-ui/src/a.ts"],
      PROJECTS,
      SUBSYSTEMS,
    );
    expect(mixed.mustSplit).toBe(true);
    expect(mixed.allowed.size).toBe(0);

    const mixedWithSubsystemFile = evaluateScopes(
      ["nx.json", "vider/CLAUDE.md"],
      PROJECTS,
      SUBSYSTEMS,
    );
    expect(mixedWithSubsystemFile.mustSplit).toBe(true);
  });

  it("marks cross-project commits as eligible for the upstream exception only when fully project-owned", () => {
    const cross = evaluateScopes(
      ["shared/libs/core-ui/src/b.ts", "vider/libs/vider-ui/src/a.ts"],
      PROJECTS,
      SUBSYSTEMS,
    );
    expect(cross.upstreamEligible).toBe(true);
    const withDoc = evaluateScopes(
      ["shared/libs/core-ui/src/b.ts", "vider/CLAUDE.md"],
      PROJECTS,
      SUBSYSTEMS,
    );
    expect(withDoc.upstreamEligible).toBe(false);
  });
});

describe("transitiveDependsOn", () => {
  const deps = new Map([
    ["vider-ui", ["core-ui"]],
    ["vider", ["vider-ui"]],
    ["core-ui", []],
  ]);

  it("finds direct and transitive dependencies", () => {
    expect(transitiveDependsOn("vider-ui", "core-ui", deps)).toBe(true);
    expect(transitiveDependsOn("vider", "core-ui", deps)).toBe(true);
  });

  it("rejects the reverse direction and survives cycles", () => {
    expect(transitiveDependsOn("core-ui", "vider-ui", deps)).toBe(false);
    const cyclic = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(transitiveDependsOn("a", "c", cyclic)).toBe(false);
  });
});

describe("discoverProjects", () => {
  it("reads tracked project.json files and skips a repo-root or unparsable one", () => {
    fakeGit({
      tracked: {
        "project.json": JSON.stringify({ name: "root" }),
        "vider/apps/vider/project.json": JSON.stringify({ name: "vider" }),
        "broken/project.json": "{not json",
        "unnamed/project.json": "{}",
        "vider/apps/vider/src/main.ts": "code",
      },
    });
    expect(discoverProjects()).toEqual([
      { name: "vider", root: "vider/apps/vider", tags: [] },
      { name: "unnamed", root: "unnamed", tags: [] },
    ]);
  });
});

describe("readProjectGraphDeps", () => {
  it("parses the nx graph file and drops npm dependencies", () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd !== "pnpm") throw new Error(`unexpected command: ${cmd}`);
      const out = args.find((a) => a.startsWith("--file=")).slice("--file=".length);
      writeFileSync(
        out,
        JSON.stringify({
          graph: {
            dependencies: {
              "vider-ui": [{ target: "core-ui" }, { target: "npm:vue" }],
              "core-ui": [],
            },
          },
        }),
      );
    });
    const deps = readProjectGraphDeps();
    expect(deps.get("vider-ui")).toEqual(["core-ui"]);
    expect(deps.get("core-ui")).toEqual([]);
  });

  it("shells out with shell: true so pnpm's Windows .cmd shim resolves", () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const out = args.find((a) => a.startsWith("--file=")).slice("--file=".length);
      writeFileSync(out, JSON.stringify({ graph: { dependencies: {} } }));
    });
    readProjectGraphDeps();
    expect(execFileSync).toHaveBeenCalledWith(
      "pnpm",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });
});

describe("checkCommitScope", () => {
  const errors = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("rejects missing arguments with usage", () => {
    const error = errors();
    expect(checkCommitScope([])).toBe(2);
    expect(checkCommitScope(["--commit"])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("usage:"));
  });

  it("passes when the scope is the single owning project", () => {
    fakeGit({ tracked: TRACKED_PROJECTS, staged: ["vider/libs/vider-ui/src/a.ts"] });
    expect(checkCommitScope([messageFile("feat(vider-ui): add thing\n")])).toBe(0);
  });

  it("fails a broader-than-necessary scope (tightness)", () => {
    fakeGit({ tracked: TRACKED_PROJECTS, staged: ["vider/libs/vider-ui/src/a.ts"] });
    const error = errors();
    expect(checkCommitScope([messageFile("feat(vider): add thing\n")])).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("allowed here: vider-ui");
    expect(reported).toContain("vider/libs/vider-ui/src/a.ts");
  });

  it("allows the upstream project's scope when all other touched projects depend on it", () => {
    fakeGit({
      tracked: TRACKED_PROJECTS,
      staged: ["shared/libs/core-ui/src/b.ts", "vider/libs/vider-ui/src/a.ts"],
    });
    const deps = new Map([["vider-ui", ["core-ui"]]]);
    expect(
      checkCommitScope([messageFile("fix(core-ui): api change\n")], { readDeps: () => deps }),
    ).toBe(0);
  });

  it("rejects a touched project's scope when another touched project does not depend on it", () => {
    fakeGit({
      tracked: TRACKED_PROJECTS,
      staged: ["shared/libs/core-ui/src/b.ts", "vider/libs/vider-ui/src/a.ts"],
    });
    errors();
    const deps = new Map();
    expect(
      checkCommitScope([messageFile("fix(vider-ui): change\n")], { readDeps: () => deps }),
    ).toBe(1);
  });

  it("skips ignored messages, scope-less headers, and exempt-only or empty commits", () => {
    fakeGit({ tracked: TRACKED_PROJECTS, staged: ["vider/libs/vider-ui/src/a.ts"] });
    expect(checkCommitScope([messageFile("Merge branch 'x'\n")])).toBe(0);
    expect(checkCommitScope([messageFile("feat: no scope here\n")])).toBe(0);
    expect(checkCommitScope([messageFile("not conventional at all\n")])).toBe(0);

    fakeGit({ tracked: TRACKED_PROJECTS, staged: ["pnpm-lock.yaml"] });
    expect(checkCommitScope([messageFile("chore(workspace): lockfile drift\n")])).toBe(0);
    fakeGit({ tracked: TRACKED_PROJECTS, staged: [] });
    expect(checkCommitScope([messageFile("chore(workspace): empty\n")])).toBe(0);
  });

  it("rejects a commit mixing a root-owned path with a project-owned path, regardless of claimed scope", () => {
    fakeGit({
      tracked: TRACKED_PROJECTS,
      staged: ["package.json", "vider/libs/vider-ui/src/a.ts"],
    });
    const error = errors();
    expect(checkCommitScope([messageFile("chore(workspace): add dep\n")])).toBe(1);
    expect(checkCommitScope([messageFile("feat(vider-ui): add dep\n")])).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("no single scope");
    expect(reported).toContain("package.json");
    expect(reported).toContain("vider/libs/vider-ui/src/a.ts");
  });

  it("rejects multi-scope headers", () => {
    fakeGit({ tracked: TRACKED_PROJECTS, staged: ["vider/libs/vider-ui/src/a.ts"] });
    const error = errors();
    expect(checkCommitScope([messageFile("feat(vider,core-ui): both\n")])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("one scope per commit"));
  });

  it("judges an existing commit in --commit mode from that commit's own tree", () => {
    fakeGit({
      tracked: TRACKED_PROJECTS,
      commitMessage: "feat(reacher): harden mode\n",
      commitFiles: ["reacher/apps/reacher/src/main.ts"],
    });
    expect(checkCommitScope(["--commit", "abc123"])).toBe(0);

    fakeGit({
      tracked: TRACKED_PROJECTS,
      commitMessage: "feat(workspace): mislabeled\n",
      commitFiles: ["reacher/apps/reacher/src/main.ts"],
    });
    errors();
    expect(checkCommitScope(["--commit", "abc123"])).toBe(1);
  });
});
