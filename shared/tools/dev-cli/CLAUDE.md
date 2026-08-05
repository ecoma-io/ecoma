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
- **Neither `cwd` nor `-C` contains git — `GIT_DIR` and friends outrank both — so
  every git spawn here names the environment it runs in, in production as well as
  in tests.** The ambient variable arrives from a git hook run in a **linked
  worktree**, which exports an absolute `GIT_DIR` (measured on git 2.43.0:
  `pre-commit` and `pre-push` both export it there, and a plain checkout exports
  only a relative `GIT_INDEX_FILE`, which still resolves correctly from a
  subdirectory).
  - **Never drive git from a test with a bare `execFileSync("git", …)`** — build
    the repo with `initFixtureRepo` and drive it with `fixtureGit`
    (`src/git-fixture.mjs`).
    `verify` runs this suite from lefthook's `pre-push`, so an unqualified fixture
    write commits into the developer's own branch and deletes its tree.
    `git-fixture.mjs`'s header documents the three layers that close it
    (process-level scrub in `vitest.setup.mjs`, per-spawn scrub + `-C` + `cwd`, and
    a fail-loud guard); the guard aborts the run rather than let a fixture find a
    real repository.
  - **Production: pass `env: cwdGitEnv()` (`src/git-env.mjs`) on every
    `execFileSync("git", …)`.** `pre-commit` runs `pnpm nx affected -t lint` and
    every lint target runs with `cwd: {projectRoot}`, so a command that lets the
    environment pick the repository is told the project directory is the entire
    work tree. Both consequences were observed here, and they are not
    symmetrical: `check-e2e-story-coverage` died on a pathspec suddenly "outside
    repository", while `check-journey-markers` opened no file and reported the
    project clean — green having checked nothing, on every commit. The production
    list deliberately keeps `GIT_INDEX_FILE`, which is the one name it does not
    share with the fixture: `git commit -- <paths>` hands the hook a temporary
    index naming exactly the paths being committed, and a gate that ignored it
    would judge a change nobody is making. `src/git-env.mjs` owns the shared
    names; `git-fixture.mjs` builds its own stricter list on top.
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
- **`license-scope.mjs` is the one place that answers "which terms govern this
  path?"** — the root `LICENSE`'s SCOPE section as code. **The tree answers
  first and the path only refines it**: `licenseForPath` takes the slug
  `rootLicenseSlug` reads off the tree's own LICENSE, because a carve-out is a
  promise a tree makes about part of itself, and a tree that grants nothing has
  nothing to carve out of — in a proprietary tree every path is proprietary,
  `packages` directory or not. Never reintroduce a directory name as the
  first question: this module is consumed by the private control-plane
  workspace too, and recognising a tree by an area name means its next rename
  silently reclassifies it. It has two consumers
  that must never disagree: `check-project-conventions` judges the `license:*`
  tag and `license` manifest field a project already declares, and
  `scaffold-lib` decides what a new project is born declaring. Were those two
  derivations separate, every scaffolded project would arrive failing the gate
  that scaffolded it. It is a module of its own rather than a section of either
  consumer only because `check-project-conventions` already imports from
  `scaffold-lib`; putting it in the gate would close that edge into a cycle.
  The licence _vocabulary_ is mirrored in `require-project-tags.mjs` and in
  `eslint.config.mjs`'s `depConstraints` — a new value belongs in all three in
  one pass, the same contract the `scope:` axis already carries.
  `check-project-conventions` also judges **presence** of every required tag —
  `type:*`, `scope:*`, and `license:*` alike, not just the licence axis' value:
  `require-project-tags` only fires from a project's own opted-in `lint`
  target, while this gate walks every tracked `project.json` unconditionally,
  so it is the one path that cannot be silently skipped by a hand-written
  project with no `lint` target wired to it. Where a value is derivable from
  the path (`scope:*`, `license:*`) the gate checks that too; `type:*` has no
  path-derived expected value, so only its presence is judged. The two rules
  still do not duplicate each other — `require-project-tags` is the fast
  in-editor signal (and the only one judging tag _vocabulary_), this gate is
  the unconditional backstop.
- **`MANIFEST_LICENSE` deliberately avoids npm's `SEE LICENSE IN <file>`.** npm
  resolves that string against the file at the _package_ root, and this tree has
  a package whose root licence covers its documents rather than its code
  (`shared/libs/doctrine/LICENSE.docs` is CC BY-SA; the modules beside it are
  not). The string therefore declared TypeScript source to be under a ShareAlike
  copyleft, and four other packages carried it with no such file at all. Every
  value is now a valid SPDX expression, so it names terms directly instead of
  pointing at a file that may be the wrong one or missing. Do not "simplify" it
  back to a file pointer.
- **The carve-out gate reads content, not just a filename.** Requiring only that
  `<carve-out>/LICENSE` exists let a zero-byte file pass — and let the SUL text
  itself sit in a `packages` directory whose whole purpose is to not be under
  those terms. `CARVE_OUT_LICENSE_MARKER` is the phrase each must contain. It is
  evidence, not proof: no string match verifies a licence, and the residue stays
  on review.
- `check-primitive-artifacts` runs from `core-ui`'s `lint` target rather than
  the CI doc-gate block, because the convention it enforces belongs to that one
  project. It scans the git **index**, so a new primitive's artifacts must be
  staged to count; `git ls-files` is cwd-relative, which is what lets the same
  scan work from the repo root and from inside `core-ui` — cwd-relative only while
  nothing in the environment outranks cwd, hence the `cwdGitEnv` above. It is also
  the one project gate an inherited `GIT_DIR` left working, because it passes no
  pathspec and `PRIMITIVE_FILE_RE` reads a repo-relative listing as happily as a
  project-relative one; that is a property of this gate, not a reason to trust the
  ambient environment anywhere else.
- **`run-node-tests` exists because an `nx:run-commands` string cannot read
  JSON.** Every vitest project reads the coverage floor from
  `coverage.config.json` inside its own config; a project on Node's built-in
  runner takes its thresholds as CLI flags, so without this command the only
  way to hold that floor is to restate the numbers in `project.json` — the
  duplication the single source exists to prevent (Rule 14). It spawns
  `process.execPath` with an argv array, never a shell string, so nothing
  depends on POSIX word-splitting or globbing (Node expands the positional test
  patterns itself, on Windows too). Node's runner has **no `statements`
  threshold**: three of the shared floor's four numbers are enforced, and the
  command refuses to run rather than let the fourth rise above the `lines`
  floor it does measure. `check-project-conventions` requires a project with
  tests and no vitest config to name this command in its `test` target, so the
  gate imports `RUN_NODE_TESTS_COMMAND` and `main.mjs` keys `COMMANDS` off it —
  one spelling, three consumers, and no gate scans that registry for a drifted
  literal.
- `check-journey-markers`' pattern source is `journey-markers.config.json`
  (repo root), shared with the `local/no-journey-markers` and
  `local/no-journey-marker-names` ESLint rules — see `shared/CLAUDE.md`;
  don't duplicate the patterns here. Besides file contents it scans file/
  directory names and Nx target names (`namePattern`, kebab-normalized per the
  config's contract — keep the normalizer identical to the ESLint rule's);
  the workspace entry point additionally scans project directory paths, which
  no per-project scan sees.
- **`check-command-refs` derives its valid-name list from `COMMANDS` itself,
  never a restated copy (Rule 14 rung 1).** `main.mjs` calls `process.exit` at
  import time, so it cannot be imported for its keys — the same reason
  `main.integration.test.mjs` drives it as a subprocess rather than importing
  it. This gate does the same: it spawns the real CLI with no command and
  parses its own "unknown command '…'. Available: …" listing off stderr.
  It flags only the unambiguous invocation form,
  `node shared/tools/dev-cli/src/main.mjs <name>`, never a bare inline-code
  mention — the same word can be ordinary prose, can belong to a different
  `main.mjs` (`repo-care` has its own registry), or can be a seam the doctrine
  corpus deliberately reserves before it exists. None of those write the full
  invocation form, so anchoring there keeps false positives at zero without a
  denylist. It scans every tracked `*.md`/`*.mdx` file, which is what reaches
  `.claude/skills/**/SKILL.md` and every `CLAUDE.md`/`README*.md` without a
  second file-walk — the same `listTrackedFiles` call `check-doc-links` makes.
  It stays a command of its own rather than folding into `check-doc-links`:
  that gate's name and docstring commit it to relative Markdown _links_, and a
  command citation is a shell invocation, not a link — conflating the two
  would make the gate's name stop describing what it checks.
- **`check-contributor-record` is the enforcement half of `CLA.md`'s acceptance
  rule**: a contributor agrees by posting the agreement sentence as a pull
  request comment, and nothing is granted until that signature exists. **What
  records the signature is the CLA action, not this gate** —
  `contributor-assistant/github-action` (`.github/workflows/cla.yml`) turns the
  comment into a line in a signatures file and commits it here, so the writing
  the agreement needs lives in the tree rather than in a service's database.
  This gate is what keeps the required check honest: the action publishes its
  own commit status, branch protection watches exactly one check (`ci-gate`),
  so the verdict has to be re-derivable inside CI or it is not covered by the
  thing that blocks a merge. Every vocabulary is read out of `CLA.md` or the
  workflow — the assent sentence from the fenced block under "How you agree",
  the version from the effective-version line, the signatures path from the
  `path-to-signatures:` input that writes it — so amending the agreement or
  moving the file moves the gate rather than leaving a second contract behind
  (Rule 14 rung 1). **The dependency runs both ways**: `--sign-comment` and
  `--allowlist` print what the workflow needs as inputs, so the action derives
  them from here instead of holding a second copy of the sentence and a second
  answer to who is exempt. The licensor exemption is derived the same way: the
  CLA runs _to_ whoever can make the grant, and `CODEOWNERS`' owners of
  `/CLA.md` are already that set, protected there for exactly this reason. Bare
  mode audits the signatures file's shape and runs offline; `--author <login>`
  additionally judges that login, and only CI can know who opened a pull
  request — which is why that mode lives in `ci.yml` rather than in a hook. It
  judges the signature, never the person: whether the private details are real
  stays with the maintainer who asks for them before merge.
  - **A signature is bound to a version by the file it lands in.** `CLA.md`'s
    change rule says a version binds a contributor only once they agree to it,
    and the action's versioning is the mechanism: publishing a version moves
    `path-to-signatures` to the next generation, everyone signs again, and the
    previous generation's file stays in the tree as the writing for everything
    already merged under it. The join key is therefore a path, not a search
    through `CLA.md`'s git history — which is what that history read used to
    answer, and why nothing here needs `fetch-depth: 0` any more. The gate does
    still cross-check the `**Version …**` line against the version inside the
    fenced assent sentence (`templateVersionFault`) — the two spots must move
    in one edit. `auditSignatures` judges the shape of the file itself, because
    it is a third party's write and the only writing behind every grant the
    project holds; and while `CLA.md` promises naming in `CONTRIBUTORS.md`
    (`attributionClause`, clause 3), every signatory must be listed there — the
    moral-rights naming consent is the one legally load-bearing promise no
    other gate watches. `licensorHandles` takes the **last** matching CODEOWNERS
    entry, GitHub's own precedence.
  - **`sync-contributors` is the other side of that promise**, and it is a
    separate command because it WRITES where the gate only judges: given the
    signatures file, it appends a `CONTRIBUTORS.md` row for every signatory the
    roster does not name, and `cla.yml` commits the result. Clause 3.2 makes
    that file how the project credits an author, so the row is what the project
    owes rather than a step to hand a first-time contributor. **Additive,
    never regenerating**: an existing row is left exactly as it is, because the
    name column is how a person chose to be credited and a rewrite would
    repeatedly replace that with a handle. That also makes it idempotent. It
    re-pads the table on write because Prettier owns this file's formatting,
    and a signatory whose signature carries no usable date is skipped rather
    than credited with an invented month.
  - **The automation exemption is deliberately not a "is it a bot" test**, and
    the difference is the whole design. `--author-type` carries GitHub's
    `user.type` from the pull request payload — the only authority on which
    accounts are machines, never a `[bot]` suffix — but that answers only
    whether the account is a person. What earns the exemption is being
    automation _this project runs_: `PROJECT_AUTOMATION` pairs each login with
    the configuration that runs it (`renovate[bot]` ↔ `.github/renovate.json5`),
    and only a pair whose file is still committed is exempt, so retiring a tool
    retires its exemption with no edit here. A coding agent's machine account
    therefore fails, and that is the point — the person who directed it authored
    the work and owes the signature, so exempting every bot would leave anyone
    who has not agreed one move from merging. Both halves are also conditional on
    `CLA.md` still carrying the sentence that puts automated commits outside the
    agreement, read at run time like every other vocabulary here.
  - **`--commits <range>` holds the DCO half**, which two documents asked for
    and nothing checked: every non-merge commit in the range must carry the
    `Signed-off-by` trailer. It lives in this command rather than in a gate of
    its own because the exemption it needs is already here — automation this
    project runs certifies nothing, so a second gate would have to re-derive
    `PROJECT_AUTOMATION` and could disagree with it. Clause-anchored like the
    rest (`signOffClause`): delete the sentence from `CLA.md` and the check
    stops in the same edit. **The exemption is per commit, not per pull
    request**, and that distinction is the whole of it: exempting the range
    because a bot opened it lets a person push onto a bot's branch and skip the
    trailer entirely. GitHub is still the only authority on whether an
    _account_ is a machine (`--author-type`), but which commits that account
    authored is answered from `%an`, which git supplies offline — compared
    against the **git author name `PROJECT_AUTOMATION` declares beside the
    login**, never the login itself. Those are different namespaces that
    coincide for Renovate and do not in general (the Actions bot commits as
    "GitHub Actions" under `github-actions[bot]`), so comparing the login would
    work by accident where it worked at all, and would otherwise turn the gate
    red on a bot's own commits — reading as the bot owing a certification it
    cannot give. `commitsOwedSignOff` is a pure function so both directions of
    that mismatch are pinned without a fixture repository. **That is
    unverified metadata, and the exemption is worth exactly what it is worth**:
    a commit claiming the exempt account's name is exempted with nothing
    checking the claim, so do not read this path as fail-closed. What bounds it
    is reach rather than verification — the exemption opens only on a pull
    request GitHub says a machine opened, and a spoofed commit has to land on
    that account's branch, which needs push access to this repository; anyone
    holding that can merge past the gate anyway. The verified answer (GitHub
    resolving each commit to an account) is a network call this command
    deliberately does not make, so wanting it is a reason to move the check,
    never to add a fetch here. CI passes
    `origin/$BASE_REF..HEAD`, which is why that job needs `fetch-depth: 0`.
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
- `check-practice-index` gates `practice-index.json` (repo root), whose cards
  point at the CLAUDE.md tier owning each rule. **The anchor is a verbatim
  `quote`, deliberately not a content hash:** rule churn here is
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
- **`check-roadmap-ids` derives every vocabulary it checks from the roadmap
  itself** — tracks from §1b's track table, gates from its gate table,
  milestones from §4's headings — so renaming any of them needs no edit here
  (Rule 14). It reads one document rather than the tree, which is why it sits
  outside `nx affected` beside `check-doctrine`. Two limits are deliberate and
  stated in its header rather than left to be discovered: it cannot see an id
  **reused** after a cancellation (one snapshot shows the same id either way —
  only the subject changed), and the other half of §0's law, a board _card_
  tracing to no id, is `repo-care audit-roadmap-labels` — a separate command in a
  separate tool, so this one keeps running offline on every commit while that one
  reaches the tracker.
- **`conformance` is the executor roadmap rule #7 demands**, and it is a read of
  the tree rather than a registry: a freeze is a doctrine document declaring
  `status: frozen` plus `gate: G<n>`, a suite is an Nx project declaring a
  `conformance` target plus a `gate:G<n>` tag. Nx's own vocabulary rather than a
  new file format, because a suite has to run in CI and CI already runs targets.
  The gate vocabulary is imported from `check-roadmap-ids`, off the roadmap's own
  gate table — one edit renames a gate everywhere. **What it fails on is
  deliberately narrow**: a gate nobody has started is not an error (nothing has
  been promised), an ungated freeze or ungated suite is, and a **frozen gate with
  no suite** is — that last one is the paper gate the rule names, and it can only
  arise after someone freezes, which is when the rule is meant to bite. It never
  performs a freeze: after one, a change to that interface is breaking and travels
  a major, so it stays a human act. `--run` executes the suites through Nx;
  without it the command is pure and runs on every commit.
- **`check-doctrine` takes the root it judges**, defaulting to
  `shared/libs/doctrine`. The corpus has two tiers and only one lives here, so
  a downstream workspace runs the same command against its withheld tier
  rather than growing a second implementation of the same rules. Which rules
  apply is **derived from the root, never passed**: `withheldTier` reads the
  tree's own LICENSE through `rootLicenseSlug`, because a caller free to state
  the tier is free to state it wrongly, and "published tree judged as withheld"
  is precisely the mistake nobody would notice. It derives from a legal fact
  rather than a directory name, which is what lets the withheld tier's
  workspace rename its areas without changing tier. Three rules are publication-scoped — bet identifiers
  (the ledger defining them lives in the withheld tier), corpus-map routing,
  and orphan families (an owner published across the boundary is not missing);
  episode markers and variant staleness are properties of doctrine prose and
  run in both. **Documents are selected by what a file is, not by how deep it
  sits**: `doctrineDocPaths` lists every `.md` under the root and drops the
  README variants and `CLAUDE.md` by name. A depth-based pathspec excluded
  those four only by accident of this tree's layout, and matched **nothing** in
  a tier whose documents sit directly at its root — the gate then reported
  clean having opened no file, which is the failure mode that reads as success.
- `doctrine-sync` is the write side of `check-doctrine`'s staleness rule: it
  stamps each variant's `canonical-sha` with the fingerprint of the canonical
  beside it. Both sides select documents through the same `doctrineDocPaths`
  and take the same root argument, so the reader and the writer of one
  fingerprint cannot be pointed at different trees. That selection reaches the
  tree's documents and **not** the project's own README variants — those are
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
