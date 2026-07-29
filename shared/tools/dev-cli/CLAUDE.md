# dev-cli (`shared/tools/dev-cli`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`;
what dev-cli is for lives in `shared/CLAUDE.md` (Tooling). Nx project name
`dev-cli` (tags `type:lib`, `scope:shared`). Plain-ESM `.mjs`, no
build/typecheck — invoked directly as
`node shared/tools/dev-cli/src/main.mjs <command>`.

- **Adding a subcommand touches three places in one pass:** the module
  (`src/<name>.mjs`, exports a function returning a process exit code), its
  test (`src/<name>.test.mjs`), and the `COMMANDS` registry in `src/main.mjs`.
- Tests run on Vitest (`vitest run` via the nx `test` target; config in
  `vitest.config.mjs` — `.mjs`, not `.ts`, because this project has no TS
  toolchain). Workspace taxonomy applies: `*.test.mjs` unit-tests the module's
  logic (node builtins mocked with `vi.mock` where determinism needs it);
  `*.integration.test.mjs` exercises real git/fs inside throwaway repos under
  the OS temp dir.
- **This suite needs `go` and `cargo` on PATH**: the scaffold-lib integration
  tests prove a scaffolded Go/Rust lib against the real toolchain (`go vet`,
  `cargo check --offline`), not just against our conventions checker — which
  is why CI sets both toolchains up unconditionally (`ci.yml`), before any Go
  or Rust project exists in the tree.
- **Never drive git from a test with a bare `execFileSync("git", …)`** — build
  the repo with `initFixtureRepo` and drive it with `fixtureGit`
  (`src/git-fixture.mjs`). Neither `cwd` nor `-C` contains git: `GIT_DIR` and
  friends outrank both, `verify` runs this suite from lefthook's `pre-push`,
  and a git hook exports `GIT_DIR` pointing at the repository being pushed — so
  an unqualified fixture write commits into the developer's own branch and
  deletes its tree. `git-fixture.mjs`'s header documents the three layers that
  close it (process-level scrub in `vitest.setup.mjs`, per-spawn scrub + `-C` +
  `cwd`, and a fail-loud guard); the guard aborts the run rather than let a
  fixture find a real repository.
- `pool: "forks"` is pinned for two reasons, both still live: the command
  modules that read the repository from the process working directory
  (`check-doc-links`, `check-claude-md`, `check-journey-markers`,
  `scaffold-lib`) are covered by tests that `process.chdir` into their fixture,
  which the threads pool forbids; and `setupFiles` mutates `process.env`, which
  needs a per-file process to stay isolated. `check-commit-scope` no longer
  needs either — `checkCommitScope`/`discoverProjects` take an explicit `cwd`,
  so its integration test names the repository instead of chdir-ing the runner.
- `src/main.mjs` is excluded from coverage: it `process.exit`s at import time,
  so `main.integration.test.mjs` drives it end-to-end in a spawned subprocess,
  which in-process V8 coverage cannot see.
- Argument parsing stays minimal by design (see `main.mjs` header); reach for
  a CLI framework only once several commands genuinely need one.
- `check-commit-scope` is tier 2 of the commit-message gates (rules in
  `CONTRIBUTING.md`): hook mode takes the commit-msg file and judges staged
  paths; `--commit <sha>` mode (CI) judges that commit against its own tree,
  so a commit scaffolding a project may already use the new scope. The repo
  root `commitlint.config.mjs` (tier 1) imports this module's
  project/subsystem discovery for `scope-enum` — single source of truth, don't
  restate the scope list anywhere. Both entry points take an options bag —
  `checkCommitScope(args, { readDeps, cwd })` — where `readDeps` injects the
  graph and `cwd` names the repository to judge; production callers pass
  neither, since the hook and CI both run at the repo root. The upstream-scope
  exception shells out to `pnpm nx graph`, so integration tests skip that path
  (unit tests inject the graph).
- `check-primitive-artifacts` runs from `core-ui`'s `lint` target rather than
  the CI doc-gate block, because the convention it enforces belongs to that one
  project. It scans the git **index**, so a new primitive's artifacts must be
  staged to count; `git ls-files` is cwd-relative, which is what lets the same
  scan work from the repo root and from inside `core-ui`.
- `check-journey-markers`' pattern source is `journey-markers.config.json`
  (repo root), shared with the `local/no-journey-markers` and
  `local/no-journey-marker-names` ESLint rules — see `shared/CLAUDE.md`;
  don't duplicate the patterns here. Besides file contents it scans file/
  directory names and Nx target names (`namePattern`, kebab-normalized per the
  config's contract — keep the normalizer identical to the ESLint rule's);
  the workspace entry point additionally scans project directory paths, which
  no per-project scan sees.
- `check-subsystem-readmes` gates the subsystem-root README contract: every
  top-level non-dot directory holding tracked files carries all 3 language
  variants (`README.md`, `README.vi.md`, `README.zh.md`), each opening with
  the canonical fixed-order frontmatter block (`name` = directory, `lang` =
  its own filename's language, one-line `description` in that language), the
  shared nav line, and an `# H1` naming the directory. `name` must be
  byte-identical across the 3 variants — a stale triad is a triage outage,
  not a doc nit, since `repo-care`'s `triage-issue` derives its area
  vocabulary and classifier prompt from the English variant's frontmatter —
  so the parsing regex is duplicated there on purpose; keep the two
  identical (a cross-project source import would be an edge the Nx graph
  cannot see). `check-subproject-readmes` mirrors `check-claude-md`'s
  project-walking pattern but audits this same 3-variant contract (plus the
  subproject-only `subsystem` field and the 5 fixed `<!-- readme:* -->` section
  markers) for every project's own `README.md` triad. Both gates share their
  audit logic — nav line, title, description bounds, section markers,
  technical-token parity — via `readme-schema.mjs`, so the two can never
  disagree on what a "variant" is.
- **`readme-schema.mjs` does not own the language triad** — it derives `LANGS`
  and the nav line's endonyms from `languages.config.json` at the repo root
  (see `shared/CLAUDE.md`), because `repo-care`'s `translate-thread` names the
  same three languages. Adding a language is one edit there, never here. It is
  loaded with `createRequire`, deliberately neither a static import attribute
  (the config sits outside this Nx project, so a relative path is an edge
  `@nx/enforce-module-boundaries` rejects) nor `node:fs` (several callers'
  unit tests mock `node:fs` wholesale to exercise path handling — reading the
  config that way would force those mocks to know about it).
- **`auditTokenParity` is the machine-decidable half of the 3-variant
  agreement rule, and it deliberately compares _rendered_ form.** Rule 12
  exempts technical tokens from translation, so every variant must name the
  same inline code spans as the English canonical — which makes the realistic
  failure (a fact lands in `README.md`, the translations are left behind) a
  red gate instead of a review note. `technicalTokens` applies CommonMark's
  own rule that a line ending inside a code span renders as a space: a
  hyphenated name wrapped across two source lines really does render as
  `eslint-local- rules`, so reporting it is the point, not a tokenizer
  artifact to forgive — while a wrap at an existing space is correctly read
  as the same token. It compares sets, not counts (how often a translation
  repeats a name is prose), and strips fenced blocks first (their content is
  a sample, and the inline scan would otherwise run across fence
  boundaries). Whether the prose around the tokens _means_ the same thing
  stays advisory with `repo-care`'s `readme-language-parity` card — this
  gate is why that card must not re-report a differing token.
- `check-doctrine-index` gates `doctrine-index.json` (repo root), whose cards
  point at the CLAUDE.md tier owning each rule. **The anchor is a verbatim
  `quote`, deliberately not a content hash:** doctrine churn here is
  overwhelmingly additive, so a section hash would fail on every unrelated
  addition inside the same section, and a gate that cries wolf is a gate that
  gets bypassed. The quote doubles as the locator — that is why a card carries
  no heading anchor (the tier's headings are section-level, far coarser than a
  rule). Matching is whitespace-normalized over a sliding window of consecutive
  lines, so re-wrapping prose never breaks a card; the window and the minimum
  quote length both exist to keep a short or stitched-together match from
  passing after the cited rule is gone. Scope globs are checked against
  `git ls-files` — one that matches nothing is dead routing. The `gate` field
  is a triage device, not documentation: a rule a deterministic gate fully
  holds must NOT get a card at all (the index's `$admission` names the three
  rules excluded on that ground). First consumer is `repo-care`'s `review-pr`
  rubric, which derives its always-on `CHECKS` from `diffCards` and
  path-activates each `pathCard` whose `scope` matches a changed file — both
  sides match scopes with `node:path`'s `matchesGlob`, so this gate and that
  activation can never disagree on glob semantics. Do not restate the card
  summaries in either place.
- `doctrine-sync` is the write side of `check-doctrine`'s staleness rule: it
  stamps each variant's `canonical-sha` with the fingerprint of the canonical
  beside it. Both sides scan `check-doctrine`'s exported `DOCTRINE_DOCS`
  pathspec, which reaches the documents inside the tree's families and
  **not** the project's own `README.md` triad at the root — those three are
  peers under the fixed-order frontmatter block `check-subproject-readmes`
  gates, where a `canonical-sha` key is a failure rather than a repair. Two
  things to know before running it: it reads the git **index**, so a newly
  written variant must be staged to be seen; and Prettier rewrites markdown in
  `pre-commit`, which changes the canonical's bytes and therefore its
  fingerprint, so the only order that terminates is **stage → format → sync →
  commit**. Stamping asserts nothing about the translation — re-stamping
  without re-reading is how a variant keeps authority it no longer earns, which
  is the failure the gate exists to catch.
- `ensure-commit-identity` keeps the commit identity attributed to the session
  operator (never the cloud-sandbox agent bot `noreply@anthropic.com`), and is
  the only place that identity lives — nothing hardcodes a person. Two modes:
  bare = **setter** (SessionStart hook, `.claude/hooks/session-start.mjs`),
  resolves the operator dynamically (GitHub `/user` for the display name via the
  sandbox auth proxy; `CLAUDE_CODE_USER_EMAIL` for the email of record) and
  writes repo-local identity + disables the bot's signing, but only when the
  ambient committer _is_ the bot, so a contributor machine is left untouched;
  `--check` = **guard** (`lefthook.yml` pre-commit). git resolves the identity
  before pre-commit, so the guard can't rewrite the current commit — it resets
  the config and fails loud, closing the session-timing gap SessionStart has.
  Uses `curl` (not Node fetch) because only proxy-aware clients get the
  sandbox's injected GitHub credential; this stays out of the emitted git hook,
  which is kept dependency-free.
