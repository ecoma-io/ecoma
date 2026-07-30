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
  enabling it). The `test` target's `node --test *.test.mjs` auto-discovers
  every `*.test.mjs` in this directory, so a new test file needs no target
  edit — only `*.test.mjs` counts, which is why the shared `test-call-chain.mjs`
  helper is named without that suffix.
- Tests are plain `node` scripts (each a single implicit test case under
  Node's built-in test runner), not Vitest — keep them dependency-free.
- `no-journey-markers` (prose: comments/test titles) and
  `no-journey-marker-names` (exported declaration names) read their patterns
  from `journey-markers.config.json` (repo root), the single source shared
  with dev-cli's `check-journey-markers` — see `shared/CLAUDE.md`; never
  inline a copy of a pattern in a rule. `namePattern` matches the
  kebab-normalized form of a name (contract documented in the config) — keep
  the tiny normalizer in `no-journey-marker-names.mjs` identical to the one in
  dev-cli's `check-journey-markers.mjs`.
