import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findMissingClaudeMd } from "./check-claude-md.mjs";
import { findConventionViolations } from "./check-project-conventions.mjs";
import { findProjectReadmeIssues } from "./check-subproject-readmes.mjs";
import { fixtureGit, initFixtureRepo } from "./git-fixture.mjs";
import { scaffoldLib } from "./scaffold-lib.mjs";

/**
 * Every CI doc/convention gate that judges a SUBPROJECT, run over the tracked
 * tree the way CI runs them. A scaffold is only "green from its first commit"
 * if all of them pass, so the oracle has to be all of them: scoping it to
 * `check-project-conventions` alone is exactly how a scaffold that emitted no
 * README variants passed this suite while failing CI. Repo-wide gates
 * (`check-doc-links`, `check-practice-index`, `check-subsystem-readmes`) are
 * deliberately excluded — they judge the workspace, not the scaffold, and the
 * fixture is not a workspace.
 */
const gateFailures = (repo) => {
  fixtureGit(repo, ["add", "-A"]);
  const tracked = fixtureGit(repo, ["ls-files"]).split("\n").filter(Boolean);
  const projectFiles = tracked.filter((p) => p.endsWith("project.json"));
  const read = (p) => readFileSync(p, "utf8");
  return [
    ...findConventionViolations(tracked, read),
    ...findMissingClaudeMd(projectFiles, existsSync),
    ...findProjectReadmeIssues(projectFiles, read, existsSync),
  ];
};

// `scaffoldLib` writes relative to the process working directory, so this suite
// still chdirs into its fixture; git itself never relies on that (see
// `git-fixture.mjs`).
describe("scaffold-lib against the real filesystem", () => {
  let repo;
  let cwd;

  beforeEach(() => {
    cwd = process.cwd();
    // A tracked placeholder under shared/ so deriveSubsystemRoots' real
    // `git ls-files` scan (scaffoldLib's default, exercised here unmocked)
    // recognizes "shared" as an existing subsystem.
    repo = initFixtureRepo("scaffold-lib", { "shared/README.md": "placeholder\n" });
    writeFileSync(
      join(repo, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { paths: {} } }),
    );
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  it("emits a lib that passes every subproject gate CI runs", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(scaffoldLib(["my-thing", "--subsystem", "shared", "--layer", "domain"])).toBe(0);

    expect(gateFailures(repo)).toEqual([]);

    expect(existsSync("shared/libs/my-thing/CLAUDE.md")).toBe(true);
    expect(existsSync("shared/libs/my-thing/src/index.ts")).toBe(true);
  });

  it("second run with the same name fails loudly instead of overwriting", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(scaffoldLib(["my-thing", "--subsystem", "shared"])).toBe(0);
    expect(scaffoldLib(["my-thing", "--subsystem", "shared"])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("never overwrites"));
  });

  // The toolchain-driving tests carry their own timeout: on a cold CI runner
  // (`setup-go` runs with `cache: false`) the first `go vet` compiles the
  // stdlib from an empty build cache and blows past Vitest's 5s default.
  const TOOLCHAIN_TIMEOUT_MS = 60_000;

  it(
    "a scaffolded Go lib is a real module: go vet accepts it via the emitted go.work",
    () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(scaffoldLib(["gadget", "--subsystem", "shared", "--lang", "go"])).toBe(0);

      expect(gateFailures(repo)).toEqual([]);
      expect(readFileSync("go.work", "utf8")).toContain("./shared/libs/gadget");

      // The emitted module must satisfy the real toolchain, not just our checks.
      execFileSync("go", ["vet", "./..."], { cwd: join(repo, "shared/libs/gadget") });
    },
    TOOLCHAIN_TIMEOUT_MS,
  );

  it(
    "a scaffolded Rust lib is a real crate: cargo check accepts it via the emitted workspace",
    () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(scaffoldLib(["widget", "--subsystem", "shared", "--lang", "rust"])).toBe(0);

      expect(gateFailures(repo)).toEqual([]);
      expect(readFileSync("Cargo.toml", "utf8")).toContain('"shared/libs/widget"');

      execFileSync("cargo", ["check", "--offline"], { cwd: join(repo, "shared/libs/widget") });
    },
    TOOLCHAIN_TIMEOUT_MS,
  );

  it("a scaffolded Python lib is wired into the uv workspace and passes every subproject gate", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(scaffoldLib(["pytool", "--subsystem", "shared", "--lang", "python"])).toBe(0);

    expect(gateFailures(repo)).toEqual([]);
    expect(readFileSync("pyproject.toml", "utf8")).toContain('"shared/libs/pytool"');
    expect(existsSync("shared/libs/pytool/src/pytool/__init__.py")).toBe(true);
  });
});
