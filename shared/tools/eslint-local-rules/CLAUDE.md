# Local ESLint rules (`shared/tools/eslint-local-rules`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`;
what the rules enforce lives in `shared/CLAUDE.md` (Tooling) and the root
Working Principles. Nx project name `eslint-local-rules` (tags `type:lib`,
`scope:shared`). Flat-config rule modules consumed by the root
`eslint.config.mjs` under the `local/` plugin namespace; no `src/` — rules sit
at the project root.

- **Adding a rule touches three places in one pass:** the rule module
  (`<name>.mjs`), its test (`<name>.test.mjs`), and the root
  `eslint.config.mjs` (import + `local` plugin `rules` map + a config block
  enabling it). The `test` target still hands Node's runner the bare
  `*.test.mjs` glob, which auto-discovers every `*.test.mjs` in this directory,
  so a new test file needs no target edit — only `*.test.mjs` counts, which is
  why the shared `test-call-chain.mjs` helper is named without that suffix.
- Tests are plain `node` scripts (each a single implicit test case under
  Node's built-in test runner), not Vitest — keep them dependency-free. They
  are reached through
  `node ../../../shared/tools/dev-cli/src/main.mjs run-node-tests`, the same
  road the `lint` target already takes to `check-journey-markers`: that command
  adds `--experimental-test-coverage` plus the threshold flags it reads from
  the repo-root `coverage.config.json`, because an `nx:run-commands` string
  cannot read JSON and restating the numbers in `project.json` would fork the
  one floor the workspace holds (Rule 14). Dependency-free is untouched —
  nothing is installed for it, and no rule or test imports it.
- **The floor here is global, and one number short.** Like every vitest
  project's, the threshold is the aggregate over all rule modules, so a single
  file may sit below it (`test-call-chain.mjs` is at 70% branch today) while
  the project passes. Node's runner exposes no `statements` metric, so three of
  the shared floor's four numbers are enforced here rather than four;
  `run-node-tests` refuses to run rather than let the fourth quietly rise above
  what it can measure.
- **`dev-cli` is declared twice on purpose, and neither declaration does the
  other's job.** `implicitDependencies` is what makes `nx affected` see the
  edge; the `test` target's own `inputs` is what puts dev-cli's files in the
  task hash — measured, an implicit dependency alone replays a cached green
  after `run-node-tests` changes. That `inputs` list REPLACES `nx.json`'s
  `targetDefaults.test.inputs` rather than merging with it, which is why
  `default` and `coverageConfig` are restated there: drop `coverageConfig` and
  raising the shared floor replays a cached green too.
- `no-journey-markers` (prose: comments/test titles) and
  `no-journey-marker-names` (exported declaration names) read their patterns
  from `journey-markers.config.json` (repo root), the single source shared
  with dev-cli's `check-journey-markers` — see `shared/CLAUDE.md`; never
  inline a copy of a pattern in a rule. `namePattern` matches the
  kebab-normalized form of a name (contract documented in the config) — keep
  the tiny normalizer in `no-journey-marker-names.mjs` identical to the one in
  dev-cli's `check-journey-markers.mjs`.
