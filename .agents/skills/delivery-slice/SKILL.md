---
name: delivery-slice
description: Apply when an accepted outcome must be turned into a vertical slice and delivered — locking scope, opening a branch and draft PR, implementing the smallest change, choosing validation by change type, and reporting real results. USE WHEN the work is defined and code, tests, configuration or documentation must actually change, or when a slice's scope or validation is in question. NOT FOR deciding what to build or why (feature-modelling, architecture-evolution, domain-modelling), collecting evidence about an unknown (engineering-discovery), producing the verification verdict after delivery (verification), or reconciling a merged slice and closing the Issue (reconciliation).
---

# Delivery Slice

## Objective

Deliver one vertical slice: an observable outcome, verified at the right
layer, with every change inside a stated scope. This skill executes an
accepted decision; it does not make one, and it does not widen the unit to
absorb what it finds along the way.

Produce four things:

1. The outcome stated as observable behaviour, with what the slice does not
   cover.
2. A locked scope: the files, projects and behaviours the slice may change.
3. The smallest implementation that produces the outcome, plus the validation
   its change type requires.
4. Real command output — commands, exit status and results — in the PR body.

## Canonical references

These documents outrank this skill. Where this skill and a canonical document
disagree, the document wins.

- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §6.4 (Select & Plan), §6.5 (Deliver: smallest change, run the right
  test layer, record command and result), §6.8 (never implement an
  unaccepted decision; a blocked slice is not carried as half-done), §7
  (vertical slice conditions and **Prerequisite work**), §8 (limitation
  versus deviation).
- [`docs/engineering/contribution-workflow.md`](../../../docs/engineering/contribution-workflow.md)
  — §2.5 (branch and draft PR), §2.6 (scope lock), §2.7 (validation by
  change type), §2.8 (review findings), §2.9 (rebase and merge).
- [`docs/engineering/work-management.md`](../../../docs/engineering/work-management.md)
  — §5.1 (one PR = one logical change), §5.2 (`Closes #N` versus
  `Refs #N`), §5.3 (PR lifecycle).
- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md)
  — §3 (test category semantics), §4 (canonical targets `test`,
  `test-integration`, `system-test`), §6 (environment and isolation).
- [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md)
  — §3 (migration and contracts), §8 (rollback), §10 (test execution).
- [`AGENTS.md`](../../../AGENTS.md) — `Non-negotiable architecture`,
  `Change discipline`, `Workflow`, `Pull requests`, `Local Development
  Preview`.
- [`.agents/skills/commit-message/SKILL.md`](../commit-message/SKILL.md) —
  commit message format and signing rules.

## Required inputs

- The Issue that owns the outcome, with scope, constraints and verify
  criteria already written.
- The accepted decision or specification the slice implements. If the
  decision is open, the slice is blocked — stop here.
- The owning Nx project or projects of the behaviour, confirmed from the
  resolved configuration rather than from file paths.
- A configured commit signing key. Without one, stop and report.
- A known validation environment: whether Docker, PostgreSQL or the local
  stack are available, so a blocked suite is known before it is reported.

## Workflow

1. **Restate the outcome as observable behaviour.** Not "add a module" but
   "calling X returns Y". Name the portion of the target capability this
   slice covers and the portion it does not — the limit belongs in the PR,
   not in the reader's imagination.
2. **Check the slice is valid.** Per `evolution-process.md` §7 it must have
   an independently verifiable criterion at the right layer, must not create
   unobservable or irreversible state, and must state how it stays safe
   without unfinished dependencies (for example failing closed). If it is
   only one layer with no observable outcome, it is not a slice — go back to
   planning.
3. **Classify prerequisite work honestly.** Some work cannot stand alone as
   an observable outcome — a contract or domain model no application
   consumes yet. It is still legitimate, but it is `Implemented, not
   verified`, not a finished slice, and it must name the Issue whose slice
   it enables. If it names none, it has no destination.
4. **Lock the scope.** Write down the files, projects and behaviours inside
   it, and the ones explicitly outside. Anything discovered outside scope is
   recorded in the Issue or a new Issue, never absorbed into this PR.
5. **Create the branch and draft PR before editing.** Branch from the latest
   default branch; link the Issue with `Closes #N` only when the PR completes
   the whole Issue, otherwise `Refs #N`. Put the outcome, the limit and the
   planned validation in the PR body.
6. **Confirm the owning project and its targets** before running anything:

   ```bash
   pnpm nx show project <name> --json
   ```

   Do not assume a target exists because another project has it.

7. **Implement the smallest change that produces the outcome.** Preserve
   existing behaviour unless the Issue changes the contract. Respect the
   invariants in `AGENTS.md` `Non-negotiable architecture` — database
   ownership, contracts over shared access, expand → compatible rollout →
   contract for schema changes.
8. **Select validation by change type.** Do not run everything for every PR;
   run the row that matches, and add rows when the change spans them.

   | Change                                        | Minimum                                                                                                            |
   | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
   | Docs, templates, configuration                | `npx oxfmt --check .`; check links by hand (no link checker exists)                                                |
   | Code in one Nx project                        | `lint`, `typecheck`, `test` of that project — not every project has all three; check `pnpm nx show project <name>` |
   | Code touching a database or a real dependency | Add `test-integration` of the owning project                                                                       |
   | Change across deploy units                    | Add the relevant `system-test`; local stack per `AGENTS.md`                                                        |
   | Tooling under `tools/dx/`                     | `test` of Nx project `dx`, plus running the changed command                                                        |
   | Architecture tags, deployment map, graph      | `pnpm dx arch-check`                                                                                               |

   Run one project with `pnpm nx run <project>:<target>`. When the affected
   set is the subject, run `pnpm nx affected -t <target>` instead. The layer
   choice is this step's; `verification` produces and labels the result.
   `pnpm dx pr-check` runs only inside GitHub Actions — check a PR title
   locally with `pnpm exec commitlint`.

9. **Record what actually ran.** For each command: the exact invocation, exit
   status, pass/fail counts, and failing output verbatim. A suite that could
   not run because the environment lacked Docker or a service is reported as
   could not run — never as passed, and never skipped silently.
10. **Commit correctly.** Use the `commit-message` skill for the message.
    Every commit must be cryptographically signed. Never use `--no-verify`
    or any other means to bypass hooks. If signing is unavailable, stop and
    report rather than commit unsigned.
11. **Handle review without widening scope.** Fix every material finding
    inside the slice, re-running the affected validation each time. A finding
    outside scope becomes its own Issue or an Issue comment — the PR does not
    grow to cover it.
12. **Rebase before ready.** Rebase onto the latest default branch before
    marking ready for review and before the final push. Ready means CI is
    green on the final revision and every review conversation is resolved.
    Landing goes through squash merge and the merge queue; a green, approved,
    unblocked PR is queued immediately rather than left idle.
13. **Stop at verification.** Delivering the slice is not verifying it and
    not releasing it. Hand the evidence to `verification` and the
    post-merge comparison to `reconciliation`.

## Allowed changes

- Source, tests, configuration, migrations and documentation inside the
  locked scope of the Issue.
- Tests added in the owning project when the missing coverage is part of the
  slice's own deliverable.
- The PR body, including the limit of the slice and the command output.
- Issue comments recording out-of-scope discoveries, without absorbing them.

## Prohibited changes

- Implementing an unaccepted decision, or a decision still open in
  `01-architecture.md` §10 or `docs/domains/open-boundaries.md`.
- Widening scope to close review findings or to "finish" a discovery made
  mid-slice.
- Claiming a check passed that did not run, or reporting a remembered result
  as a current one.
- Declaring `Released` without a deployment record and a post-deploy
  environment check.
- Creating a Project, Milestone, label, assignee or project field.
- Bypassing hooks, pushing an unsigned commit, or working around unavailable
  signing.
- Changing test taxonomy or inventing target names; `test`, `test-integration`
  and `system-test` are the canonical targets.
- Editing an accepted ADR or a canonical decision so it matches the code.
- Introducing node-local state that breaks recovery, or logging prompt and
  response bodies.

## Evidence to collect

- The Issue number, and whether the PR uses `Closes #` or `Refs #`.
- The slice outcome in observable terms, and the part of the capability it
  does not cover.
- The projects and files changed, confirmed against `pnpm nx show project`.
- Each validation command, its exit status, its result, and the revision it
  ran on.
- Any validation that could not run, with the environmental blocker.
- Migration steps and their rollout order, when schema changed.
- Commits made, and confirmation that each carries a signature.
- The out-of-scope items found, with where each was recorded.

## Completion criteria

- The change is inside the scope stated before implementation began.
- Every validation the change type requires has a real command and result
  recorded, at the final revision.
- Nothing that could not run is reported as passing, and no claim exceeds its
  evidence.
- Every commit is signed and no hook was bypassed.
- The PR body states what was not done, and links the Issue correctly.
- The branch is rebased, CI is green and conversations are resolved before
  ready for review.
- No Project, Milestone, label or field was created as a side effect.

## Escalation

Stop and report when:

- The slice depends on a decision that is not accepted, or on an open item in
  a canonical document.
- The only way to finish is to exceed the Issue's scope. Say what the extra
  work is and let it become its own unit.
- The required validation cannot be run because an environment, credential or
  tool is unavailable. Report the blocker and the unverified remainder.
- Commit signing is not configured.
- A required migration would violate expand → compatible rollout → contract,
  or a change would break an invariant, a security boundary or backward
  compatibility.
- The implementation reveals the accepted decision cannot hold. That is a
  finding for `architecture-evolution` or `reconciliation`, not a silent
  redesign inside the PR.
