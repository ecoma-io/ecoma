// Conventional Commits — enforced by lefthook's commit-msg hook and re-run per
// PR commit in CI. This is tier 1 (message shape + scope vocabulary); the
// scope ↔ path contract is tier 2, `dev-cli check-commit-scope`, which shares
// the project/subsystem discovery imported below — single source of truth.
// Rules and rationale: CONTRIBUTING.md.
import { allScopes, discoverProjects } from "./shared/tools/dev-cli/src/check-commit-scope.mjs";

// The same derivation `dev-cli list-scopes` prints — single source of truth.
const scopes = allScopes(discoverProjects());

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-empty": [2, "never"],
    "scope-enum": [2, "always", scopes],
  },
};
