---
name: repo-care
subsystem: shared
lang: en
description: Repository-surface automation — issue triage, advisory PR practice review, and thread translation via free LLMs.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# repo-care

<!-- readme:why -->

Three GitHub-facing chores need natural-language judgment a deterministic gate
can't provide: classifying a new issue's type/area, flagging judgment-
layer practice violations in a PR diff (weakened tests, disguised stubs, a
smuggled refactor) that no lint rule can see, and mirroring a thread written in
one project language into the other two so nobody is locked out of a
discussion. A large pull request is reviewed group by group — one group per
project or directory that owns the changed files — so the comment reads as a
checklist and no part of the diff goes unread. `repo-care` hands all three to LLMs,
but only the keyless free tier of opencode zen (`https://opencode.ai/zen/v1`)
— no API key, no secret to provision. Free models are individually weak and
operationally flaky (rate limits and provider outages arrive as HTTP 200 with
an `error` body, not a clean error status), so nothing here trusts a single
model's word: `zen.mjs` collects up to 3 schema-validated verdicts per
question and only acts once at least 2 agree (`tallyVerdicts`); fewer than 2
usable verdicts is a fail-loud exit, never a coin-flip mutation. The other
structural guard is the enum: a model only ever picks from a fixed vocabulary
(`TYPES`, `AREAS`, `LABEL_DEFS`, `CHECKS`), which caps the blast radius of a
flaky or prompt-injected response at "a wrong label from the list."

Translation is the one place free-form prose leaves a model, so it is the one
exception — a narrow, deliberate one. Detecting which language a thread is
written in is still an enum pick and still needs the quorum. The translated
text itself cannot be tallied, so it is contained instead: it lands as an
additive `TRANSLATE_MARKER` comment that never edits the author's own title or
body, and `sanitizeTranslation` neutralizes anything in it that could act
rather than read.

<!-- readme:consumers -->

Three GitHub Actions workflows invoke this tool directly, all using the
ambient `GITHUB_TOKEN` (no separate secret to provision):
`.github/workflows/issue-triage.yml` runs `main.mjs triage-issue` on issue
`opened`/`reopened` (plus a manual `workflow_dispatch` for backfilling an
older issue); `.github/workflows/pr-practice-review.yml` runs `main.mjs
review-pr` on non-draft PR `opened`/`reopened`/`synchronize`/
`ready_for_review`; `.github/workflows/translate-issue.yml` runs `main.mjs
translate-issue` on issue `opened`/`edited`;
`.github/workflows/translate-pr.yml` runs `main.mjs
translate-pr` on PR `opened`/`edited`. No workflow is wired into required/branch-protection
checks — see `readme:boundary`.

<!-- readme:ecosystem -->

`repo-care` is a peer to `dev-cli` and `eslint-local-rules` inside
`shared/tools`: `dev-cli` gates the code and repo conventions,
`eslint-local-rules` gates the AST, and `repo-care` automates the repository
surface (issues, PRs) around them. It authors none of its own vocabulary — the
issue-triage `AREAS` enum is derived at import time from every subsystem-root
`README.md`'s frontmatter (the contract `dev-cli check-subsystem-readmes` gates
in CI), the PR-review `CHECKS` rubric is derived from
`practice-index.json`'s `diffCards`/`pathCards` (gated by `dev-cli
check-practice-index`), and the translation languages come from
`languages.config.json` at the repo root — the same file `dev-cli` reads for
the README variant contract, so the two can never name different languages.
All three stay single sources of truth read at runtime,
never re-authored or copied into this project.

<!-- readme:boundary -->

`review-pr` is advisory by definition, never a required or blocking gate —
deterministic checks (lint/test/typecheck/build) stay the sole source of
truth for mergeability. Models here never execute anything and never invent
a label: every verdict field must come from a fixed enum, and a PR review's
own repository reads are validated, budget-capped, and read-only (this tool's
own source is read from the trusted base ref, PR diff/file content from the
head SHA, always framed as untrusted data). Translation is additive in the
same spirit: it only ever posts or edits its own `TRANSLATE_MARKER` comment —
the author's title and body are never rewritten, and a sibling job's comment
is off limits because every lookup here anchors its marker with `startsWith`.
`repo-care` also has no
`package.json` and is never imported — it runs on bare `node` so its
GitHub Actions jobs need no `pnpm install`.

<!-- readme:status -->

Active: all three workflows run this tool on every matching GitHub event, not a
draft or an unwired stub. Mechanics — the quorum/verdict-tallying rules, the
enum vocabularies, the multi-turn PR investigation, the translation quorum
exception, and known footguns — are
in [`./CLAUDE.md`](./CLAUDE.md).
