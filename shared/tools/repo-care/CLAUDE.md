# repo-care (`shared/tools/repo-care`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`.
Nx project name `repo-care` (tags `type:lib`, `scope:shared`). Plain-ESM
`.mjs`, no build/typecheck, no `package.json` (path-invoked, never imported) —
run as `node shared/tools/repo-care/src/main.mjs <command>`. Same anatomy as
`dev-cli`, but a different concern: dev-cli gates the _code_ locally/in CI;
repo-care automates care of the _repository surface_ (issue triage, PR
doctrine review, thread translation) from GitHub Actions.

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
  `doctrine-index.json`'s `diffCards` (repo root), the only place those
  summaries carry a pointer back to the CLAUDE.md rule each one restates.
  `dev-cli check-doctrine-index` fails when a cited rule is reworded or
  deleted, which is what keeps the rubric from drifting away from the doctrine
  it encodes. The index's `pathCards` extend that rubric per run:
  `activeChecks` offers a card only when a changed file falls inside its
  `scope` globs, matched with `node:path`'s `matchesGlob` — the same builtin
  `check-doctrine-index` validates scopes with, so the two can never disagree
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
- **README language parity is a separate review shape from everything else
  in `review-pr`**: `doctrine-index.json`'s `readme-language-parity` card
  carries `"shape": "parity"`, which `activeChecks` skips entirely — a
  parity finding names a relationship BETWEEN 2 files, not a judgment about
  one diff hunk, so it cannot fit the single-diff prompt/schema the rest of
  this rubric shares. `findReadmeGroups` matches changed paths against that
  card's own `scope` glob (never a hardcoded pattern, so routing here and
  `check-doctrine-index`'s dead-routing check can't disagree), groups them by
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
  - **`sanitizeTranslation` is load-bearing, not hygiene.** It is the only
    place model-chosen prose derived from untrusted thread text becomes a
    comment. HTML comments are stripped (else injected text forges a sibling's
    marker), `<details>`/`<summary>` are escaped (else the translation closes
    its own container early), @mentions are code-spanned (else every re-run
    re-pings people), and the result is length-capped. Every new rendering
    surface goes through it.
  - A target language that no model could translate is skipped loudly on
    stderr while the rest still post; all targets failing is exit 1, because
    silence would read as "already translated" on the next run.
- Invoked by `.github/workflows/issue-triage.yml` (issue opened/reopened +
  `workflow_dispatch` for backfill),
  `.github/workflows/pr-doctrine-review.yml` (non-draft PR
  opened/reopened/synchronize/ready_for_review), and
  `.github/workflows/thread-translate.yml` (issue and PR opened/edited +
  `workflow_dispatch` for backfill) with the ambient
  `GITHUB_TOKEN`; runs on bare `node` — keep this tool dependency-free so
  the workflows need no `pnpm install`. The PR-side jobs use
  `pull_request_target` because a fork PR's `pull_request` token is read-only
  and could never comment; that is safe only while nothing from the PR head is
  checked out or executed — head content reaches these commands as data, never
  as code.
- Tests follow the workspace taxonomy: `*.test.mjs` unit-test pure cores with
  injected `fetchImpl` (no real network anywhere in tests);
  `main.integration.test.mjs` drives the CLI in a subprocess because
  `main.mjs` exits at import time (also why coverage excludes it).
