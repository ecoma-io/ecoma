/**
 * Prints the commit-scope vocabulary (CONTRIBUTING.md; `.claude/skills/commit-msg`)
 * — derived live from the tracked `project.json` files via the same module
 * commitlint's `scope-enum` uses, never hand-maintained. Default output is one
 * scope per line; `--json` emits a JSON array for tooling.
 */
import { allScopes, discoverProjects } from "./check-commit-scope.mjs";

/** CLI entry. Returns a process exit code; `discover` is injectable for tests. */
export function listScopes(args = [], discover = discoverProjects) {
  const scopes = allScopes(discover());
  console.log(args.includes("--json") ? JSON.stringify(scopes) : scopes.join("\n"));
  return 0;
}
