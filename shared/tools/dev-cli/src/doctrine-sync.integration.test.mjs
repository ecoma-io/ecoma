/**
 * `doctrine-sync` writes the fingerprints `check-doctrine` reads, so the
 * behaviour worth pinning is the agreement between them over a real index —
 * which is the interaction itself, not either side's logic. Two things only a
 * real `git ls-files` can decide:
 *
 *   - that the shared pathspec reaches the documents inside the tree's
 *     families, so syncing leaves the gate green;
 *   - that it does *not* reach the project's own `README.md` triad, whose three
 *     languages are peers under a fixed-order frontmatter block that a
 *     `canonical-sha` key would break.
 *
 * Both are properties of git's pathspec matching. Every unit test above injects
 * `list` and would stay green against a pathspec that swept the whole
 * directory.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkDoctrine } from "./check-doctrine.mjs";
import { doctrineSync } from "./doctrine-sync.mjs";
import { fixtureGit, initFixtureRepo } from "./git-fixture.mjs";
import { listTrackedFiles } from "./tracked-files.mjs";

const ROOT = "shared/libs/doctrine";

/** A README variant in its own contract's shape: fixed keys, no fingerprint. */
const readme = (lang) =>
  `---\nname: doctrine\nsubsystem: shared\nlang: ${lang}\ndescription: The published ceiling.\n---\n\n# doctrine\n`;

const CANONICAL = `---\ntitle: Role\n---\n\n# Role\n\nA Role is a unit of labour a Filler occupies.\n`;

/**
 * A fixture tree plus deps that resolve every path inside it — git through
 * `fixtureGit`, reads and writes through the fixture root.
 */
function fixture() {
  const dir = initFixtureRepo("doctrine-sync", {
    [`${ROOT}/README.md`]: readme("en"),
    [`${ROOT}/README.vi.md`]: readme("vi"),
    [`${ROOT}/README.zh.md`]: readme("zh"),
    [`${ROOT}/spec/role.md`]: CANONICAL,
    [`${ROOT}/spec/role.vi.md`]: `---\ntitle: Vai\ncanonical-sha: aaaaaaaaaaaa\n---\n\n# Vai\n`,
    [`${ROOT}/spec/role.zh.md`]: `---\ntitle: 角色\n---\n\n# 角色\n`,
  });

  const read = (path, encoding) => readFileSync(join(dir, path), encoding);
  const deps = {
    read,
    write: (path, text) => writeFileSync(join(dir, path), text),
    list: (pathspecs) => listTrackedFiles(pathspecs, (args) => fixtureGit(dir, args)),
    log: () => {},
    error: () => {},
  };
  return { dir, read, deps };
}

describe("doctrine-sync over a real index", () => {
  it("leaves the gate green on a tree it has just stamped, which is the whole point of sharing the pathspec", () => {
    const { deps, read } = fixture();

    expect(doctrineSync([], deps)).toBe(0);
    expect(checkDoctrine(read, deps.list)).toBe(0);
  });

  it("stamps a variant that recorded the wrong fingerprint", () => {
    const { deps, read } = fixture();
    doctrineSync([], deps);
    expect(read(`${ROOT}/spec/role.vi.md`, "utf8")).not.toContain("aaaaaaaaaaaa");
  });

  it("stamps a variant that recorded none at all", () => {
    const { deps, read } = fixture();
    doctrineSync([], deps);
    expect(read(`${ROOT}/spec/role.zh.md`, "utf8")).toMatch(/canonical-sha: [0-9a-f]{12}/);
  });

  it("never reaches the project's own README triad, whose frontmatter contract forbids the key", () => {
    const { deps, read } = fixture();
    doctrineSync([], deps);
    for (const lang of ["vi", "zh"]) {
      expect(read(`${ROOT}/README.${lang}.md`, "utf8")).toBe(readme(lang));
    }
  });

  it("ignores a document not yet staged, since the gate cannot see it either", () => {
    const { dir, deps } = fixture();
    writeFileSync(join(dir, `${ROOT}/spec/task.md`), CANONICAL);
    writeFileSync(join(dir, `${ROOT}/spec/task.vi.md`), `---\ntitle: Việc\n---\n\n# Việc\n`);

    expect(doctrineSync([], deps)).toBe(0);
    expect(readFileSync(join(dir, `${ROOT}/spec/task.vi.md`), "utf8")).not.toContain(
      "canonical-sha",
    );
  });

  it("sees that same document once it is staged, which is what makes stage-then-sync the working order", () => {
    const { dir, deps } = fixture();
    writeFileSync(join(dir, `${ROOT}/spec/task.md`), CANONICAL);
    writeFileSync(join(dir, `${ROOT}/spec/task.vi.md`), `---\ntitle: Việc\n---\n\n# Việc\n`);
    fixtureGit(dir, ["add", "-A"]);

    expect(doctrineSync([], deps)).toBe(0);
    expect(readFileSync(join(dir, `${ROOT}/spec/task.vi.md`), "utf8")).toMatch(
      /canonical-sha: [0-9a-f]{12}/,
    );
  });
});
