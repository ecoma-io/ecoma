# repo-care (`shared/tools/repo-care`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`.
Nx project name `repo-care` (tags `type:lib`, `scope:shared`). Plain-ESM
`.mjs`, no build/typecheck, no `package.json` (path-invoked, never imported) —
run as `node shared/tools/repo-care/src/main.mjs <command>`. Same anatomy as
`dev-cli`, but a different concern: dev-cli gates the _code_ locally/in CI;
repo-care automates care of the _repository surface_ (issue triage, PR
practice review, thread translation) from GitHub Actions.

- **LLM calls go through the keyless free tier of opencode zen**
  (`https://opencode.ai/zen/v1`, models suffixed `-free`) — no API key, no
  secret to provision. Free models are individually weak and operationally
  flaky, which forces the two structural rules of this tool:
  - **Nothing lands on a single model's word.** `zen.mjs` collects up to 3
    schema-validated verdicts (primaries in parallel, fallbacks one at a
    time); a field takes effect only when ≥2 verdicts agree
    (`tallyVerdicts`). No quorum → no action; <2 usable verdicts → exit 1
    (fail loud, never a coin-flip mutation). `translate-thread` is the sole
    documented exception, and only for the half of its work that is prose —
    see its bullet below.
  - **Models only ever pick from fixed enums** (`TYPES`, `AREAS`,
    `LABEL_DEFS`, `CHECKS`, and review-pr's two turn actions); issue/PR text
    is prompt-framed as untrusted data. Blast radius of a prompt-injected or
    hallucinating model is capped at "a wrong label from the vocabulary" —
    plus, in review-pr, read-only fetches of repository files.
- Provider failures arrive as **HTTP 200 + `error` body** (rate limits,
  provider down) — never judge a zen response by status code alone.
  `response_format: json_object` is the pool's common denominator
  (`json_schema` is rejected by `deepseek-v4-flash-free`); schema validation
  therefore stays on our side, in code.
- Triage **adds, never overwrites**: a type label set by an issue template or
  a human wins; an existing `area:*` label is respected; the needs-info
  comment is edited in place via `TRIAGE_MARKER`, never stacked.
- **Three commands now comment on the same thread, so a marker must be exact,
  not merely present.** Every comment lookup matches
  `body.startsWith(MARKER)` — never `includes` — because a marker _quoted
  inside_ a sibling's comment (a translation of a body that mentions one, say)
  would otherwise make a job edit the wrong comment on a live thread. Each
  builder emits its marker as line 1, which is what makes the anchored match
  total. That the three markers stay pairwise distinct and non-nesting is a
  property of the modules together, so it is pinned in
  `translate-thread.integration.test.mjs` rather than in any one unit test —
  a collision fails no build, it silently overwrites another job's comment.
- **The `AREAS` vocabulary is derived, never authored here** (except
  `workspace`, the one area with no directory to declare it): triage discovers
  each top-level subsystem root's `README.md` frontmatter (`name`/`description`,
  canonical fixed-order block) at import time and builds both the enum and the
  classifier prompt's area map from it. The contract is gated in CI by
  `dev-cli check-subsystem-readmes`; the parsing regex is duplicated between the
  two modules on purpose — keep them identical (a cross-project source import
  would be an edge the Nx graph cannot see). A README present but malformed
  throws (fail loud); a README-less directory is skipped (local build output).
- **The `CHECKS` rubric is derived, never authored here** — it comes from
  `practice-index.json`'s `diffCards` (repo root), the only place those
  summaries carry a pointer back to the CLAUDE.md rule each one restates.
  `dev-cli check-practice-index` fails when a cited rule is reworded or
  deleted, which is what keeps the rubric from drifting away from the practice
  it encodes. The index's `pathCards` extend that rubric per run:
  `activeChecks` offers a card only when a changed file falls inside its
  `scope` globs, matched with `node:path`'s `matchesGlob` — the same builtin
  `check-practice-index` validates scopes with, so the two can never disagree
  on glob semantics. The schema gate is per-run too: a verdict naming a check
  that was not offered this run is rejected whole. Add or edit a check in the
  index, never in this module; read it with `node:fs` (not an import
  attribute) so this tool stays dependency-free.
- `review-pr` is **advisory by definition, never a gate**: it reviews only
  the judgment layer the deterministic gates cannot see (`CHECKS` — weakened
  tests, disguised stubs, smuggled refactors, boilerplate docs, description↔
  diff mismatch, the fuzzy Rule 13 journey markers in comments/names that the
  `no-journey-markers` regex deliberately can't match, and the intent/simplicity
  calls no lint can make: thin-intent tests and unpinned behaviour changes
  (Rule 8), simplicity-ladder skips (Rule 2)); a finding needs ≥2 models naming
  the same (check, file). The rubric carries its own over-flag guards (a pure
  refactor, an in-diff covering test, a truncated diff are not findings) —
  weak free models over-report without them.
  Deterministic gates stay the source of truth — do not wire this workflow
  into required checks. Commenting is frugal: a clean first run posts
  nothing; a run supersedes earlier findings by editing the `REVIEW_MARKER`
  comment. Review calls need `maxTokens` ≥ 6000 — live runs showed long
  diff prompts exhausting reasoning models into empty content at 3000.
- **review-pr reviews as a bounded investigation, not a single shot**
  (`runReviewTrajectory`): each model may spend a few turns requesting
  repository reads before its verdict — `{"action":"read","paths":[...]}`
  answered with file/dir content, or the final `{"action":"verdict",...}`
  (a bare findings object counts too; weak models drop the wrapper). All
  control flow stays in code (Rule 5): paths are validated
  (`isSafeRepoPath`), budgets capped (`MAX_TURNS`/`MAX_READS`/
  `MAX_FILE_CHARS`), one format nudge per trajectory, verdict forced when
  the budget runs out. Reads resolve at the **PR head SHA via the contents
  API** — never the Actions checkout, which is deliberately the trusted
  base ref (the job holds a write token; head code must stay data, never
  executed). Served file content is framed as untrusted data like the diff.
- **A pull request is partitioned before any of it is reviewed**
  (`group-files.mjs`). The key is the one the repository already decides a
  commit's scope by — deepest owning project, else subsystem, else top-level
  directory, else the root — so a group is exactly the work one commit could
  have carried, and the comment reads as a checklist per unit. Project roots
  come from the **git index**, never a directory walk (a built Storybook ships
  its own `project.json`, and no prune list stays ahead of what a build emits),
  and they are resolved from this module's own location rather than the working
  directory, because `git ls-files` answers relative to where it is run and a
  wrong cwd silently degrades every project group to its subsystem. That
  anchoring only holds once the repo-selecting git variables are out of the spawn
  environment: `GIT_DIR` outranks both `cwd` and `-C`, and the degradation it
  causes is the silent kind — git errors, `discoverProjectRoots` swallows it, and
  every group falls back to a directory. `cwdGitEnv` here is a deliberate twin of
  `dev-cli`'s `git-env.mjs`, for the reasons this file's other duplications
  already carry (a cross-project source import would be an edge the Nx graph
  cannot see, and this tool stays dependency-free); the names are git's own
  vocabulary rather than a workspace decision, so neither copy can drift alone.
  Group labels
  are the Nx project names; `group-files.integration.test.mjs` pins them against
  `dev-cli list-scopes`, because a drift there fails no build and would leave
  reviews grouped along a boundary the commit gate does not recognise. **That
  spawn is why this project declares `implicitDependencies: ["dev-cli"]`** — it
  is the only thing that makes a `dev-cli` change re-run the guard. The workspace
  covers every project's _lint_ against `dev-cli` through `nx.json`'s
  `targetDefaults.lint.inputs`; nothing there reaches a _test_ target, so
  without the edge this guard would be re-run only by coincidence and would go
  quiet the day that unrelated line changed — the exact silent drift it exists
  to catch. Why it is
  worth the extra calls, measured on a 46-file pull request: the whole diff was
  128k characters against the budget, every `pathCard` was offered against every
  file (one stylesheet comment put the design card in front of models reviewing
  workflows), and the single whole-diff run reached **no quorum at all** — two
  of three models failed and the third returned nothing — while the same models
  on one group of that same diff each returned a finding.
- **Three review shapes now, and a card's `shape` picks which one judges it.**
  Un-shaped `diffCards` are the per-group investigation. `shape: "manifest"`
  (today `desc-mismatch`) is judged **once per pull request over the file
  manifest** — filenames, statuses and line counts, never a diff — because a
  description of the whole change always claims more than any one group contains,
  so offered per group it fires on every group; the grouped probe returned
  exactly that, from both models that answered, both spurious.
  `shape: "parity"` keeps its own README pass, unchanged. A card with a shape
  must not reach `CHECKS`, and the rubric test pins that every card still
  reaches some pass — a shape is a different reviewer, never a way for a check
  to fall out of the rubric.
- **Budgets bound the prompt per group and the run on the wall clock, and
  nothing is dropped silently.** `MAX_DIFF_CHARS`
  bounds one group, not the pull request; probing the pool at 50k/95k/129k
  characters produced no context error from any primary, so a group at the cap
  is a signal to look at what landed in it rather than a diff to grow. Groups
  past `MAX_GROUPS` are **merged into one final group, never dropped**, and that
  group names what it absorbed. `MAX_GROUPS` is a bound on how many passes and
  comment sections one review produces — **not** a time budget: it once stood in
  for one (job ceiling ÷ worst-case group) and that arithmetic is now measured
  instead of divided out in advance. A group that reaches no quorum is reported
  as "not reviewed" in the comment, which is why an otherwise clean run still
  posts one: silence there would read as a passed review. Only a run where
  **no** attempted group reached a quorum exits 1.
  - **The wall clock is the budget that had no report, and that was the whole
    defect.** GitHub kills the job at its `timeout-minutes`, and it killed it
    _before_ the comment was posted, so a review that reviewed nothing looked
    exactly like a review that found nothing. `createBudget` admits a pass only
    while the time left covers it plus `BUDGET_RESERVE_MS`, which is held back
    for the two whole-pull-request single-shot passes and the comment post — the
    point is that the comment gets posted, so nothing may start that would eat
    the posting. Whatever the clock leaves unstarted is named in that comment in
    the same voice as a quorum miss, and the run still exits **0**: this tool is
    advisory by definition and must never gate a merge, so its loud channel is
    the comment, not the exit code.
  - **The ceiling is derived, never authored here**: `parseJobCeilingMs` reads
    `timeout-minutes` out of `.github/workflows/pr-practice-review.yml`, the
    workflow that imposes it, so the number lives in exactly one place — keep
    exactly one such key in that file, since a second makes the read fail loud
    rather than budget against the wrong one. Rungs below were available and
    rejected: an env var would write the number twice in the same workflow
    (the `env` context is not available to a job's `timeout-minutes`), a GitHub
    repository variable would move the source of truth out of the tree where an
    unset value silently becomes the 6-hour default, and no run-metadata API
    reports a job's configured timeout.
  - **The next pass is projected from this run's own measurements, not from a
    constant.** Per-pass durations on a live grouped run went 62s → 103s → 161s:
    superlinear, because the groups share one rate-limited pool and `zen.mjs`
    rotates fallbacks one at a time, so a later pass queues behind the earlier
    ones and inherits their retries. `projectPassMs` therefore carries the
    measured growth forward instead of assuming the next pass is no worse than
    the worst so far. The summary line logs `passDurationsMs` and
    `budgetRemainingMs` for the same reason: nothing outside the process can see
    them, and they are the data any recalibration of these budgets needs.
- **README language parity is a separate review shape from everything else
  in `review-pr`**: `practice-index.json`'s `readme-language-parity` card
  carries `"shape": "parity"`, which `activeChecks` skips entirely — a
  parity finding names a relationship BETWEEN 2 files, not a judgment about
  one diff hunk, so it cannot fit the single-diff prompt/schema the rest of
  this rubric shares. `findReadmeGroups` matches changed paths against that
  card's own `scope` glob (never a hardcoded pattern, so routing here and
  `check-practice-index`'s dead-routing check can't disagree), groups them by
  directory, and fetches every variant that still exists at the PR head SHA
  (a missing sibling is skipped silently — existence is `dev-cli`'s gate, not
  this one's). Each group gets its own single-shot quorum
  (`buildParityReviewPrompt`/`parseParityVerdict`, via `zen.mjs`'s
  `collectVerdicts` — no multi-turn investigation needed, since every body is
  already supplied) asking only about fact/instruction/link contradictions,
  never wording. `parseParityVerdict` normalizes a finding into the same
  `{check, file, note}` shape `tallyFindings`/`buildReviewComment` already
  handle (`file` is the pair, sorted and joined by `↔`), so a parity
  finding rides the existing quorum/comment machinery unmodified. A parity
  group with fewer than 2 fetchable variants, or a quorum miss on one group,
  is silently additive — it can never trip the main diff-review's own
  `verdicts.length < 2` fail-loud exit, which stays scoped to that
  investigation alone.
- **`sanitizeTranslation` is load-bearing, not hygiene, and it is shared.** It
  lives in `translate-thread.mjs` but governs every surface where text this
  tool did not author becomes a comment: HTML comments are stripped (else
  injected text forges a sibling's marker), `<details>`/`<summary>` are escaped
  (else the text closes its own container early), @mentions are code-spanned
  (else every re-run re-pings people), and the result is length-capped. **Every
  rendering surface goes through it** — `review-pr` imports it rather than
  growing a second set of rules free to drift.
  - **Going through it is not the same as calling it, because the surfaces
    render differently.** A translation is a whole Markdown body, so newlines
    are its structure; a review renders each value inside ONE heading, list
    item, or code span, where a newline puts the remainder at column 0 and a
    backtick closes the span it was meant to stay inside. So
    `buildReviewComment` wraps the shared rules: `renderText` folds newlines,
    and `renderPath` additionally strips backticks (which also unwraps the
    code spans the @mention rule adds — inside a code span a mention cannot
    ping, so one wrapper is both the safe and the only rendering one).
  - **What is contained there, and what is contained better.** Through
    `renderText`/`renderPath`: a finding's `note` and its `file` (free strings
    the verdict schema only type-checks), and a group's `name`, which is a
    trusted Nx project name only when a project owns the files and otherwise a
    directory the pull request itself introduced. NOT a finding's `check` — it
    is gated against the run's own rubric enum in `parseReviewVerdict` before
    it can reach the comment, which is the stronger containment. The markers
    and the fixed prose are this tool's own text and must survive verbatim;
    `REVIEW_MARKER` in particular is what the next run's `startsWith` lookup
    anchors on.
- **`translate-thread` backs both `translate-issue` and `translate-pr`** —
  one implementation, because GitHub models a PR as an issue (same
  `GET /issues/{n}`, same comments endpoint) and the only difference is which
  kind of thread each accepts; the wrong kind is skipped with exit 0, not an
  error. Its target languages come from `languages.config.json` at the repo
  root, shared with `dev-cli`'s README variant contract (see
  `shared/CLAUDE.md`) — adding a language is one edit there.
  - **Why it is the quorum exception.** Detection of the source language _is_
    an enum pick, so it keeps the full ≥2-of-3 quorum; no quorum → no comment,
    exit 1. The translated prose cannot be tallied at all, so the rule is
    replaced by structural containment rather than weakened: the output is
    ADDITIVE (a labelled `TRANSLATE_MARKER` comment that never touches the
    human's own title or body), from one model with the pool rotated on
    failure only. Worst case is a clumsy translation beside an untouched
    original. Do not "fix" this by voting on prose — the containment is the
    guarantee, not the model count.
  - A target language that no model could translate is skipped loudly on
    stderr while the rest still post; all targets failing is exit 1, because
    silence would read as "already translated" on the next run.
- Invoked by `.github/workflows/issue-triage.yml` (issue opened/reopened +
  `workflow_dispatch` for backfill),
  `.github/workflows/pr-practice-review.yml` (non-draft PR
  opened/reopened/synchronize/ready_for_review),
  `.github/workflows/translate-issue.yml` (issue opened/edited +
  `workflow_dispatch` for backfill), and
  `.github/workflows/translate-pr.yml` (PR opened/edited +
  `workflow_dispatch` for backfill) with the ambient
  `GITHUB_TOKEN`; runs on bare `node` — keep this tool dependency-free so
  the workflows need no `pnpm install`. Both PR-side jobs use
  `pull_request_target` because a fork PR's `pull_request` token is read-only
  and could never comment — under `pull_request` a fork PR spends the whole
  model budget and then goes red on the post, its last step; that is safe only
  while nothing from the PR head is checked out or executed — head content
  reaches these commands as data, never as code. Neither names a `ref:` on its
  checkout: `pull_request_target` already defaults to the base branch, and
  spelling that default out makes Scorecard's dangerous-workflow check read it
  as an untrusted checkout. That reasoning is written in each workflow's own
  header, because this file does not load for someone editing
  `.github/workflows`.
- Tests follow the workspace taxonomy: `*.test.mjs` unit-test pure cores with
  injected `fetchImpl` (no real network anywhere in tests);
  `main.integration.test.mjs` drives the CLI in a subprocess because
  `main.mjs` exits at import time (also why coverage excludes it).
