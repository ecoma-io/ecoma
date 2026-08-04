import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkCommitScope } from "./check-commit-scope.mjs";
import { fixtureGit, initFixtureRepo } from "./git-fixture.mjs";

/**
 * The upstream exception is exercised by the unit tests only — resolving it
 * spawns Nx's own CLI, which needs a real Nx workspace.
 *
 * Nothing here touches the process working directory: every git call goes
 * through `fixtureGit` (scrubbed env + `-C` + pinned cwd), every write is
 * joined onto the fixture path, and `checkCommitScope` is handed the
 * repository explicitly. `git-fixture.mjs` explains why `cwd` alone was never
 * enough.
 */
const scope = (repo, message) => checkCommitScope([messageFile(repo, message)], { cwd: repo });

function write(repo, rel, content) {
  writeFileSync(join(repo, rel), content);
}

function messageFile(repo, content) {
  const path = join(repo, ".git", "COMMIT_EDITMSG");
  writeFileSync(path, content);
  return path;
}

const WORKSPACE_FILES = {
  "package.json": '{ "name": "fixture" }\n',
  "vider/apps/vider/project.json": '{ "name": "vider" }\n',
  "vider/apps/vider/src/main.ts": "app\n",
  "vider/libs/vider-ui/project.json": '{ "name": "vider-ui" }\n',
  "vider/libs/vider-ui/src/a.ts": "lib\n",
  "vider/CLAUDE.md": "# vider\n",
  "shared/libs/core-ui/project.json": '{ "name": "core-ui" }\n',
  "shared/libs/core-ui/src/b.ts": "lib\n",
};

/** A fixture repo with `WORKSPACE_FILES` committed as its initial state. */
function initGitRepo() {
  const repo = initFixtureRepo("check-commit-scope", WORKSPACE_FILES);
  fixtureGit(repo, ["commit", "-qm", "chore(workspace): fixture"]);
  return repo;
}

describe("checkCommitScope against a real git repo", () => {
  let error;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enforces the narrowest covering scope over the staged paths", () => {
    const repo = initGitRepo();

    write(repo, "vider/libs/vider-ui/src/a.ts", "changed\n");
    fixtureGit(repo, ["add", "vider/libs/vider-ui/src/a.ts"]);
    expect(scope(repo, "feat(vider-ui): resize handles\n")).toBe(0);
    expect(scope(repo, "feat(vider): resize handles\n")).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("allowed here: vider-ui");

    write(repo, "vider/apps/vider/src/main.ts", "changed\n");
    fixtureGit(repo, ["add", "vider/apps/vider/src/main.ts"]);
    expect(scope(repo, "feat(vider): wire the handles\n")).toBe(0);

    write(repo, "package.json", '{ "name": "fixture", "private": true }\n');
    fixtureGit(repo, ["add", "package.json"]);
    expect(scope(repo, "chore(workspace): root config\n")).toBe(1);
    expect(scope(repo, "chore(vider): root config\n")).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("no single scope");
  });

  it("rejects a root-config change bundled with project code, and accepts it once split", () => {
    const repo = initGitRepo();

    write(repo, "package.json", '{ "name": "fixture", "private": true }\n');
    write(repo, "vider/libs/vider-ui/src/a.ts", "changed\n");
    fixtureGit(repo, ["add", "package.json", "vider/libs/vider-ui/src/a.ts"]);
    expect(scope(repo, "chore(workspace): add dep and use it\n")).toBe(1);

    fixtureGit(repo, ["reset", "vider/libs/vider-ui/src/a.ts"]);
    expect(scope(repo, "chore(workspace): add dep\n")).toBe(0);
    fixtureGit(repo, ["commit", "-qm", "chore(workspace): add dep"]);

    fixtureGit(repo, ["add", "vider/libs/vider-ui/src/a.ts"]);
    expect(scope(repo, "feat(vider-ui): use the new dep\n")).toBe(0);
  });

  it("lets a commit that scaffolds a new project already use the new scope", () => {
    const repo = initGitRepo();

    mkdirSync(join(repo, "reacher/apps/reacher/src"), { recursive: true });
    write(repo, "reacher/apps/reacher/project.json", '{ "name": "reacher" }\n');
    write(repo, "reacher/apps/reacher/src/main.ts", "app\n");
    fixtureGit(repo, ["add", "reacher"]);
    expect(scope(repo, "feat(reacher): scaffold the app\n")).toBe(0);
  });

  it("lets one commit move a project to another subsystem under that project's scope", () => {
    // The case the check reads a second tree to answer: after the move nothing
    // named `vider-ui` exists under `vider/` any more, so the deleted half has
    // an owner only in the parent commit. A real `git mv` and `--no-renames`
    // (what the check passes `git diff`) mean both sides really do arrive here
    // as separate paths, the way they will in a rename CI never sees as one.
    const repo = initGitRepo();

    fixtureGit(repo, ["mv", "vider/libs/vider-ui", "shared/libs/vider-ui"]);
    expect(scope(repo, "refactor(vider-ui): move under shared\n")).toBe(0);
    expect(scope(repo, "refactor(workspace): move under shared\n")).toBe(1);

    fixtureGit(repo, ["commit", "-qm", "refactor(vider-ui): move under shared"]);
    expect(checkCommitScope(["--commit", "HEAD"], { cwd: repo })).toBe(0);
  });

  it("never lends its old name to a project the commit deleted", () => {
    // The rule's boundary, and the reason it keys on the name surviving in the
    // current tree: a project that is gone is gone from commitlint's
    // `scope-enum` too, so requiring its name here would demand a scope tier 1
    // refuses — two gates that cannot both be satisfied. What is left is
    // whatever still owns the path, which differs between these two deletions
    // and is the point of testing both: `vider` outlives its lib and keeps
    // owning the space it stood in, while `shared` had only `core-ui` and
    // stops being a subsystem at all when it goes.
    const repo = initGitRepo();

    fixtureGit(repo, ["rm", "-rq", "vider/libs/vider-ui"]);
    expect(scope(repo, "chore(vider): retire the ui lib\n")).toBe(0);
    expect(scope(repo, "chore(vider-ui): retire the ui lib\n")).toBe(1);
    expect(scope(repo, "chore(workspace): retire the ui lib\n")).toBe(1);
    fixtureGit(repo, ["commit", "-qm", "chore(vider): retire the ui lib"]);

    fixtureGit(repo, ["rm", "-rq", "shared/libs/core-ui"]);
    expect(scope(repo, "chore(workspace): retire the shared lib\n")).toBe(0);
    expect(scope(repo, "chore(core-ui): retire the shared lib\n")).toBe(1);
  });

  it("judges an existing commit from that commit's own tree in --commit mode", () => {
    const repo = initGitRepo();

    write(repo, "shared/libs/core-ui/src/b.ts", "changed\n");
    fixtureGit(repo, ["add", "shared/libs/core-ui/src/b.ts"]);
    fixtureGit(repo, ["commit", "-qm", "fix(core-ui): keyboard step"]);
    expect(checkCommitScope(["--commit", "HEAD"], { cwd: repo })).toBe(0);

    write(repo, "shared/libs/core-ui/src/b.ts", "changed again\n");
    fixtureGit(repo, ["add", "shared/libs/core-ui/src/b.ts"]);
    fixtureGit(repo, ["commit", "-qm", "fix(shared): mislabeled"]);
    expect(checkCommitScope(["--commit", "HEAD"], { cwd: repo })).toBe(1);
  });

  it("skips git-generated messages and commits with nothing to judge", () => {
    const repo = initGitRepo();

    write(repo, "vider/libs/vider-ui/src/a.ts", "changed\n");
    fixtureGit(repo, ["add", "vider/libs/vider-ui/src/a.ts"]);
    expect(scope(repo, "Merge branch 'feature/x'\n")).toBe(0);
    expect(scope(repo, 'Revert "feat(vider-ui): resize"\n')).toBe(0);

    fixtureGit(repo, ["restore", "--staged", "."]);
    expect(scope(repo, "chore(workspace): empty commit\n")).toBe(0);
  });
});
