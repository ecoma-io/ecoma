import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLA,
  CODEOWNERS,
  authorVerdict,
  automationClause,
  licensorHandles,
  projectAutomation,
} from "./check-contributor-record.mjs";
import { fixtureEnv, fixtureGit, initFixtureRepo } from "./git-fixture.mjs";

/**
 * The unit tests judge the rules against a fixture agreement. These judge them
 * against the live one, because every vocabulary this gate uses is read out of
 * documents that a maintainer edits for reasons of their own — and the failure
 * mode is a pull request that cannot be merged by anyone.
 *
 * It has happened: the gate landed with no automation exemption at all, and four
 * Renovate pull requests sat red asking a bot to sign a licence contract. What
 * pins that shut is not a mock — it is these files, as committed.
 */
describe("the gate against this repository's own documents", () => {
  // Paths in this module are repo-relative and the nx `test` target runs with
  // the project as cwd, so the root comes from this file's location, the same
  // way `check-roadmap-ids` reads the live roadmap.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const read = (path) => readFileSync(join(repoRoot, path), "utf8");
  const clause = automationClause(read(CLA));
  const automation = projectAutomation((path) => existsSync(join(repoRoot, path)));

  it("still finds the sentence in CLA.md that puts automated commits outside the agreement", () => {
    expect(clause).toMatch(/automated tooling/);
  });

  it("still finds the configuration that makes Renovate this project's own automation", () => {
    expect(automation).toEqual({ "renovate[bot]": ".github/renovate.json5" });
  });

  it("asks no contributor record of Renovate, which is what its pull requests need", () => {
    expect(
      authorVerdict("renovate[bot]", {
        type: "Bot",
        licensors: licensorHandles(read(CODEOWNERS)),
        clause,
        automation,
        hasRecord: false,
      }),
    ).toMatchObject({ ok: true });
  });

  /** The real CLI over the real tree, invoked the way `ci.yml` invokes it. */
  const runGate = (...args) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./main.mjs", import.meta.url)), "check-contributor-record", ...args],
      { cwd: repoRoot, encoding: "utf8" },
    );

  it("passes a Renovate pull request end to end, through the CLI as CI invokes it", () => {
    const cli = runGate("--author", "renovate[bot]", "--author-type", "Bot");
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
  });

  it("refuses a machine account this project does not run, agent or otherwise", () => {
    const cli = runGate("--author", "an-agent[bot]", "--author-type", "Bot");
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/does not run/);
  });

  it("refuses to guess when the caller passes an empty account type", () => {
    const cli = runGate("--author", "renovate[bot]", "--author-type", "");
    expect(cli.status).toBe(2);
    expect(cli.stderr).toMatch(/user\.type/);
  });
});

/**
 * The version-history half needs a repository whose CLA.md has actually moved,
 * which the live tree cannot stage — so these run the real CLI inside a
 * fixture repo, across a published version bump.
 */
describe("the gate across a CLA version bump, in a fixture repository", () => {
  const claAt = (version) => `# CLA

**Version ${version}, effective 2026-08-01.**

You agree that naming you in [\`CONTRIBUTORS.md\`](./CONTRIBUTORS.md) is
sufficient.

Commits made by automated tooling we run are not contributions under this
agreement.

Separately, sign off each commit.

## How you agree

\`\`\`
Full legal name:
GitHub:

I agree to the Ecoma Contributor License Agreement, version ${version}, at CLA.md,
for this and every future contribution I make to this project.
\`\`\`
`;

  const record = (version) => `Full legal name: A Person
GitHub: CasedUser

I agree to the Ecoma Contributor License Agreement, version ${version}, at CLA.md, for this and every future contribution I make to this project.
`;

  const roster = `# Contributors

| Name | GitHub | Since |
| ---- | ------ | ----- |
| A Person | [@CasedUser](https://github.com/CasedUser) | 2026-08 |
`;

  const fixtures = [];
  afterEach(() => {
    for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const buildFixture = () => {
    const dir = initFixtureRepo("cla-gate", {
      "CLA.md": claAt("1.0"),
      ".github/CODEOWNERS": "/CLA.md @owner\n",
      "CONTRIBUTORS.md": roster,
      "contributors/CasedUser.md": record("1.0"),
    });
    fixtures.push(dir);
    fixtureGit(dir, ["commit", "-q", "-m", "publish CLA 1.0"]);
    writeFileSync(join(dir, "CLA.md"), claAt("1.1"));
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, ["commit", "-q", "-m", "publish CLA 1.1"]);
    return dir;
  };

  const runGateIn = (dir, ...args) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./main.mjs", import.meta.url)), "check-contributor-record", ...args],
      { cwd: dir, encoding: "utf8", env: fixtureEnv() },
    );

  it("keeps a record valid under the version it agreed to after a newer one is published", () => {
    const dir = buildFixture();
    const cli = runGateIn(dir);
    expect(cli.stderr).toBe("");
    expect(cli.stdout).toMatch(/version 1\.0/);
    expect(cli.status).toBe(0);
  });

  it("matches an author to their record whatever the casing, as GitHub logins do", () => {
    const cli = runGateIn(buildFixture(), "--author", "caseduser", "--author-type", "User");
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
  });

  it("still refuses a record assenting to a version never published", () => {
    const dir = buildFixture();
    writeFileSync(join(dir, "contributors/CasedUser.md"), record("0.9"));
    const cli = runGateIn(dir);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/agreement sentence/);
  });

  it("holds the attribution promise: a record whose handle CONTRIBUTORS.md omits fails", () => {
    const dir = buildFixture();
    writeFileSync(join(dir, "CONTRIBUTORS.md"), "# Contributors\n\nnobody yet\n");
    const cli = runGateIn(dir);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/CONTRIBUTORS\.md/);
  });

  /** Adds two commits to a fixture: one signed off, one not. */
  const addSignedAndUnsigned = (dir) => {
    writeFileSync(join(dir, "signed.txt"), "one");
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, ["commit", "-q", "-s", "-m", "feat: signed work"]);
    writeFileSync(join(dir, "unsigned.txt"), "two");
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, ["commit", "-q", "-m", "feat: unsigned work"]);
    return "HEAD~2..HEAD";
  };

  it("names the commit missing the trailer the agreement asks for", () => {
    const dir = buildFixture();
    const range = addSignedAndUnsigned(dir);
    const cli = runGateIn(dir, "--commits", range);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/unsigned work/);
    expect(cli.stderr).not.toMatch(/feat: signed work/);
  });

  it("passes a range whose commits are all signed off", () => {
    const dir = buildFixture();
    writeFileSync(join(dir, "signed.txt"), "one");
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, ["commit", "-q", "-s", "-m", "feat: signed work"]);
    const cli = runGateIn(dir, "--commits", "HEAD~1..HEAD");
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
  });

  /** An unsigned commit authored by the machine account, inside the range. */
  const addUnsignedBotCommit = (dir) => {
    writeFileSync(join(dir, ".github/renovate.json5"), "{}\n");
    writeFileSync(join(dir, "bumped.txt"), "dep");
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, [
      "commit",
      "-q",
      "--author=renovate[bot] <bot@example.com>",
      "-m",
      "chore: bump a dependency",
    ]);
  };

  it("asks no trailer of the commits automation itself authored", () => {
    const dir = buildFixture();
    addUnsignedBotCommit(dir);
    const cli = runGateIn(
      dir,
      "--author",
      "renovate[bot]",
      "--author-type",
      "Bot",
      "--commits",
      "HEAD~1..HEAD",
    );
    expect(cli.stderr).toBe("");
    expect(cli.stdout).toMatch(/owe none/);
    expect(cli.status).toBe(0);
  });

  it("still holds a person's unsigned commit pushed onto a bot's branch", () => {
    const dir = buildFixture();
    addUnsignedBotCommit(dir);
    writeFileSync(join(dir, "human.txt"), "mine");
    fixtureGit(dir, ["add", "-A"]);
    fixtureGit(dir, ["commit", "-q", "-m", "feat: unsigned human work"]);
    const cli = runGateIn(
      dir,
      "--author",
      "renovate[bot]",
      "--author-type",
      "Bot",
      "--commits",
      "HEAD~2..HEAD",
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/unsigned human work/);
    expect(cli.stderr).not.toMatch(/bump a dependency/);
  });

  it("stops asking for a trailer once the agreement stops asking", () => {
    const dir = buildFixture();
    const range = addSignedAndUnsigned(dir);
    writeFileSync(
      join(dir, "CLA.md"),
      claAt("1.1").replace("Separately, sign off each commit.", ""),
    );
    const cli = runGateIn(dir, "--commits", range);
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
  });

  it("refuses a range it cannot read rather than reporting every commit signed", () => {
    const cli = runGateIn(buildFixture(), "--commits", "no-such-ref..HEAD");
    expect(cli.status).toBe(2);
    expect(cli.stderr).toMatch(/could not read the commits/);
  });

  it("faults CLA.md itself when its version line and assent sentence drift apart", () => {
    const dir = buildFixture();
    writeFileSync(join(dir, "CLA.md"), claAt("1.1").replace("**Version 1.1,", "**Version 1.2,"));
    const cli = runGateIn(dir);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/drifted apart/);
  });
});
