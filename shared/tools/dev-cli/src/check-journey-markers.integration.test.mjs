import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkJourneyMarkers, checkWorkspaceDocs } from "./check-journey-markers.mjs";
import { initFixtureRepo } from "./git-fixture.mjs";

/**
 * Creates a throwaway git repo holding `files` and returns its path. The
 * fixture helper owns the git isolation (scrubbed env + `-C` + a guard) — see
 * `git-fixture.mjs` for why a bare `cwd` is not enough.
 */
function initGitRepo(files) {
  return initFixtureRepo("journey-markers", files);
}

describe("checkJourneyMarkers against a real git repo", () => {
  const originalCwd = process.cwd();
  let error;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("reports markers in tracked non-JS files, skipping what ESLint already covers", () => {
    process.chdir(
      initGitRepo({
        "docs/style.css": "/* ships at 0.2 */\n",
        "README.md": "Describes behavior only.\n",
        "covered.ts": "// ships at 0.2 — the ESLint rule owns this file\n",
      }),
    );

    expect(checkJourneyMarkers(".")).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("docs/style.css:1");
    expect(reported).not.toContain("covered.ts");
  });

  it("reports journey markers in file and directory names, even of ESLint-covered files", () => {
    process.chdir(
      initGitRepo({
        "src/api-v2.ts": "export const api = 1;\n", // content is ESLint's; the NAME is ours
        "docs/utils-new.md": "Describes behavior only.\n",
        "phase-2/notes.md": "Describes behavior only.\n",
      }),
    );

    expect(checkJourneyMarkers(".")).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("src/api-v2.ts: journey marker 'v2'");
    expect(reported).toContain("docs/utils-new.md: journey marker 'new'");
    expect(reported).toContain("phase-2: journey marker 'phase-2'");
  });

  it("reports journey markers in Nx target names", () => {
    process.chdir(
      initGitRepo({
        "project.json": JSON.stringify({ targets: { "build-v2": {}, lint: {} } }),
      }),
    );

    expect(checkJourneyMarkers(".")).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("project.json: journey marker 'v2' in target name 'build-v2'");
    expect(reported).not.toContain("'lint'");
  });

  it("passes on a clean repo, including end-state names the pattern must not flag", () => {
    process.chdir(
      initGitRepo({
        "README.md": "Describes behavior only.\n",
        "src/step-executor.ts": "export const stepId = 1;\n",
        ".github/ISSUE_TEMPLATE/bug.md": "Report the observed behavior.\n",
        "project.json": JSON.stringify({ targets: { lint: {}, test: {} } }),
      }),
    );
    expect(checkJourneyMarkers(".")).toBe(0);
  });

  it("skips a target path outside the repository working tree", () => {
    process.chdir(initGitRepo({ "README.md": "clean\n" }));
    expect(checkJourneyMarkers("/")).toBe(0);
  });
});

describe("checkWorkspaceDocs against a real git repo", () => {
  const originalCwd = process.cwd();
  let error;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("scans only files no nx project owns — the per-project lint's blind spot", () => {
    process.chdir(
      initGitRepo({
        "TOPDOC.md": "roadmap 0.1 backlog\n", // workspace-level → reported
        "sub/project.json": "{}\n",
        "sub/notes.css": "/* ships at 0.2 */\n", // owned by sub → its own lint's job
        "main.ts": "// ships at 0.2\n", // ESLint-covered → skipped
      }),
    );

    expect(checkWorkspaceDocs()).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("TOPDOC.md:1");
    expect(reported).not.toContain("sub/notes.css");
    expect(reported).not.toContain("main.ts");
  });

  it("reports a project directory whose own name is a journey marker — the per-project scan never sees it", () => {
    process.chdir(
      initGitRepo({
        "libs/utils-new/project.json": JSON.stringify({ targets: { lint: {} } }),
        "libs/utils-new/index.md": "Describes behavior only.\n", // owned → content/name are its own lint's job
      }),
    );

    expect(checkWorkspaceDocs()).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("libs/utils-new: journey marker 'new'");
    expect(reported).not.toContain("index.md");
  });
});
