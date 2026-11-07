---
name: commit-message
description: Apply whenever creating, drafting, revising, correcting,
  reviewing, or validating a Git commit message, choosing a Conventional
  Commit type or scope, or fixing a commitlint failure for a commit. Derive
  the message from the actual change, validate the exact final message with
  the repository tooling, and surface policy conflicts instead of guessing.
  Not for PR titles, PR bodies, or issue bodies, which follow separate rules.
---

# Commit Message Authoring

## Objective

Produce a commit message that accurately describes the intended commit,
passes the repository's real validation, and stays inside the message-policy
boundaries — without performing Git operations the task did not authorize.

## Boundaries

- This skill governs message content only. It grants no permission to run
  `git commit`, `git commit --amend`, `git rebase`, `git reset`, or
  `git push` (see Git Operation Boundaries).
- A commit message is not a PR title or PR body. PR-only rules are listed
  under Policy Boundaries; do not apply them to individual commits, and do
  not apply commit rules to PR titles.
- Sources of truth, in order of authority: `commitlint.config.mjs` and the
  presets it extends (machine-enforced commit rules), `lefthook.yml` (Git
  hooks), `tools/dx/src/pull-request/pr-check.ts` (PR-level checks),
  `AGENTS.md` (signing, language, workflow), and
  `docs/architecture/02-delivery.md` (delivery policy). Re-read them when
  observed behavior differs from this skill; this skill summarizes, it does
  not override.

## Understand the Actual Change

Never compose a message from the task description alone.

1. Run `git status` and distinguish staged from unstaged changes.
2. When the commit is the staged set, inspect `git diff --cached`; do not
   assume every working-tree change belongs to the commit.
3. Read the diff hunks, not only the file list, and combine them with the
   user's task description to identify the principal behavior change — the
   purpose of the change, not the file operations.
4. If the intended commit contents are ambiguous (mixed concerns, unclear
   commit boundary), resolve the ambiguity with the user before writing a
   message.
5. Never invent a root cause, feature, test result, or issue reference that
   the evidence does not support.

## Compose the Message

### Format

Conventional Commits as configured in `commitlint.config.mjs`:

```
<type>(<scope>): <subject>

<body>

<footer>
```

Header at most 100 characters; each body and footer line at most 100
characters (`header-max-length`, `body-max-line-length`,
`footer-max-line-length` — all machine-enforced).

### Type

Pick one of the enforced set: `build`, `chore`, `ci`, `docs`, `feat`, `fix`,
`perf`, `refactor`, `revert`, `style`, `test`. `feat` adds a user-visible
capability, `fix` repairs a defect; the others follow their names. Choose
the type that matches the principal behavior change, and never downgrade a
breaking change to a safer-looking type (see Breaking Changes).

### Scope

- Valid scopes are the current Nx project names, resolved
  live from the Nx graph (`scope-enum` in `commitlint.config.mjs`). Never
  keep a local copy of the list; resolve it instead with
  `pnpm nx show projects --json` (strip the `@ecoma-io/` prefix), by
  reading the `scope-enum` list from a commitlint error, or by reading
  `commitlint.config.mjs`.
- Repository guidance (`AGENTS.md`, `docs/architecture/02-delivery.md`) expects
  a scope on `feat` and `fix` commits, but the validator accepts a missing
  scope — a documented-vs-enforced gap. Include a valid scope when one
  applies, and never assume a missing scope will fail validation.
- A scope names one lane. Composite scopes such as `dx,home` pass
  commitlint but are rejected on PR titles by `pr-check`; use one scope.

### Subject

- Start lower-case, no trailing `.` (`subject-case`, `subject-full-stop`).
- Describe the behavior or purpose — `send OTP mail with a per-attempt
  Idempotency-Key` — not the file operation (`update files`).

### Body and footers

Body and footer are optional. Add a body when the subject alone cannot
carry the reason, constraint, or behavior change; explain why and what, not
a file listing. Keep the blank line between header and body. Footers use
`Token: value` form (`Refs: #123`). Add footers only when the task and
repository conventions justify them.

### Examples

Validated against this repository's configuration:

```
fix(account): send OTP mail with a per-attempt Idempotency-Key

Mail providers treat repeated Idempotency-Key values as replays and
drop the follow-up attempts, so each attempt derives its own key.
```

Rejected by commitlint — know why before validating:

- `feat(dx): thêm tính năng` — non-ASCII in the header
  (`ascii-only-message`).
- `chore(dx)!: migrate config store` — breaking change outside `feat`/`fix`
  (`breaking-change-allowed-types`).
- `feat(nonexistent-scope): x` — scope absent from the Nx graph
  (`scope-enum`).
- `feat(dx): Add Cache Layer` — banned subject case (`subject-case`).

## Hard Rules vs Guidance

Machine-enforced by commitlint on every local commit, through the
`commit-msg` hook in `lefthook.yml`:

| Rule                                             | Value                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `type-enum`                                      | the 11 types listed above                                    |
| `scope-enum`                                     | `release` plus live Nx project names                         |
| `breaking-change-allowed-types`                  | breaking changes only via `feat`/`fix`                       |
| `ascii-only-message`                             | every character at or below 0x7F in header, body, and footer |
| `header-max-length`                              | 100                                                          |
| `body-max-line-length`, `footer-max-line-length` | 100                                                          |
| `subject-case`, `subject-full-stop`, `type-case` | config-conventional defaults                                 |

Machine-enforced at PR level by `pr-check` (not per-commit):

- The PR title is linted with full commitlint and must carry at most one
  scope.
- Development commits are parsed to confirm they are Conventional Commits.
  There is **no** type-count invariant: any number of `feat`, `fix` or other
  types is allowed. Re-verify against `tools/dx/src/pull-request/pr-check.ts`
  before asserting otherwise.

Guidance, not enforced per-commit: English language (`ascii-only-message`
blocks non-ASCII characters; it cannot detect language), scope presence on
`feat`/`fix`, and body quality. `AGENTS.md` requires commit messages in
English — follow it even though the machine cannot fully check it.

## Policy Boundaries and Known Conflicts

- `ascii-only-message` is not an English test. Vietnamese without
  diacritics passes the validator and still violates the English policy.
  Never work around the rule by stripping diacritics; write English.
- PR bodies are written in Vietnamese per the language policy. Squash merge
  is configured (a GitHub repository setting) to use the PR title and the
  branch's commit messages — not the PR body — so the PR body does not
  become a commit body. Do not paste PR or issue body text into a commit
  message.
- Breaking changes must be declared with `!` or the exact footer
  `BREAKING CHANGE:`, on a `feat` or `fix` commit. If the actual change is
  breaking and the type is not `feat`/`fix`, that is a policy conflict:
  disclose it and let the user decide. Do not reclassify the change, do not
  use variant spellings to slip past the validator, and do not hide the
  breaking note.
- If any rule conflicts with the task, or you cannot verify which rule
  applies, state the conflict and the authoritative source. Do not silently
  redefine policy to obtain a green check.

## Validate the Exact Final Message

1. Validate the exact final message — header, body, and footer — from the
   repository root:

   ```
   pnpm exec commitlint <<'MSG'
   fix(account): send OTP mail with a per-attempt Idempotency-Key

   Mail providers treat repeated Idempotency-Key values as replays and
   drop the follow-up attempts, so each attempt derives its own key.
   MSG
   ```

2. Read the actual output and fix the reported violations in the message;
   do not change the message's meaning to silence a rule.
3. Revalidate after every material edit — a message that passed before an
   edit is not verified after it.
4. If commitlint cannot run (missing dependencies, broken environment),
   fail closed: report the blocker and do not claim the message is
   validated. The `commit-msg` hook runs commitlint again at commit time,
   but a hook result is not a substitute for validating the intended
   message beforehand.

Commitlint validates structure, charset, and lengths. It does not prove
the message is grammatically correct English.

## Git Operation Boundaries

- This skill never authorizes `git commit`, `git commit --amend`,
  `git rebase`, `git reset`, or `git push`. Perform those only when the
  task explicitly authorizes them and the repository workflow is satisfied
  (issue, branch, PR — see `AGENTS.md`).
- Never use `--no-verify` or any other means to bypass repository hooks. A
  hook failure means the message or the change must be fixed, not bypassed.
- Every commit must be cryptographically signed (`AGENTS.md`; enforced by
  the signing checks in `lefthook.yml`). If signing is unavailable, stop
  and report the blocker instead of committing unsigned.

## Completion Criteria

The skill's work is complete when all of the following hold:

- The message accurately represents the intended commit, derived from the
  inspected change.
- Every hard rule above has been checked against its source.
- The exact final message passes `pnpm exec commitlint` when the tool can
  run, and any PR-level constraints the commit participates in are
  accounted for.
- Any unresolved policy conflict or validation blocker is disclosed.
- No Git operation outside the task's authorization has occurred.
