---
name: verification
description: Apply when the task is to produce evidence that a change or claim
  holds — choosing the verification layer for a change, running the matching
  target, recording each run as passed, failed or could not run, and stating
  which capability state the evidence supports before or after merge. USE WHEN
  asked to verify a change, pick a test layer or target, run validation, or
  justify a capability state. NOT for deciding what to build or writing the
  implementation, and NOT for comparing target with reality, classifying a gap
  or closing the work item after merge (that is `reconciliation`). NOT for
  commit messages, PR titles or PR bodies, and NOT for selecting which
  validation a change needs before it is implemented (that is `delivery-slice`
  step 8).
---

# Verification

## Objective

Turn a claim about a capability into an evidence-backed statement: select the
verification layer that can actually support the claim, run it on the revision
being claimed, and report exactly what happened. This skill operationalizes
policy that already exists. It adds no gate, no evidence artifact, no evidence
store, and no status vocabulary.

## Canonical references

- `docs/engineering/evolution-process.md` §5.1 (capability states and the
  minimum evidence each requires), §5.2 (what must not be equated), §5.3
  (evidence sources and their limits), §6.6 (Verify & Release).
- `docs/architecture/06-testing.md` §3 (test category semantics), §4
  (canonical Nx targets), §7 (minimum test by responsibility and risk), §8
  (which targets CI runs is delivery policy, not a test-architecture fact).
- `docs/engineering/contribution-workflow.md` §2.7 (validation by change type)
  and §2.8 (re-run after every material fix).
- `docs/architecture/02-delivery.md` §12 (no deployment record store and no
  staging/production pipeline exist yet).
- `AGENTS.md` (`Workflow`, `Local Development Preview`); `docs/AGENTS.md` §9
  (artifact lifecycle).
- Writing quality: `docs/AGENTS.md` §2. Language of Issue and PR
  text: `AGENTS.md` `Language`.

## Required inputs

1. The claim, in one sentence, naming the capability and the state being
   claimed. Only `Specified`, `Implemented`, `Verified`, `Released` are valid
   states; anything else is not a state claim.
2. The scope of the claim: which behaviour, which deploy unit, which
   environment the capability is designed to serve.
3. The revision the claim applies to (branch head or commit SHA).
4. The verification criteria written in the Issue or PR. If none exist, stop
   and escalate; do not invent criteria after running.
5. What the local environment can run (Docker, PostgreSQL, the local stack),
   so a blocked suite is known before it is reported.
6. Evidence already collected, if any, and the revision it belongs to.

## Workflow

1. Restate the claim and mark which single state it asserts. A claim of
   `Implemented` needs source, schema, contract or configuration evidence; a
   claim of `Verified` needs a test result at the right layer; a claim of
   `Released` needs deployment evidence. One state never implies another.
2. Locate the owning Nx project or projects of the behaviour under test. The
   owner, not the nearest test file, decides where evidence comes from.
3. Choose the layer by verification scope, using `06-testing.md` §3 and §4:
   unit/component logic of one project → `test`; app-owned suites under
   `apps/<app>/tests/` → `test-integration`; a flow across deploy units →
   `system-test`. The runner or tool does not determine the layer.
4. Check the minimum bar in `06-testing.md` §7 for the responsibility being
   changed. If a required category is missing, record that as a coverage gap;
   do not lower the claim to match the missing test.
5. Run the command that produces evidence for that layer, on the revision the
   claim applies to. Use `pnpm nx run <project>:<target>` for one project,
   `pnpm nx affected -t <target>` when the affected set is the subject. A
   cross-deploy-unit run uses `pnpm nx affected -t system-test -c local` and
   the local stack per `AGENTS.md` `Local Development Preview`; confirm the
   stack with `pnpm nx run platform-deploy:local-smoke -c local`.
6. Capture the exact command, its exit status, the pass/fail counts, and the
   failing output verbatim. Never paraphrase a failure into a summary that
   loses the error.
7. Classify each run into exactly one of three outcomes: **ran and passed**,
   **ran and failed**, or **could not run**. A skipped, blocked or
   environment-missing suite is "could not run"; a red suite is "ran and
   failed". Do not collapse either into a pass.
8. Match the evidence to the claim:
   - `Implemented` — cite the file, contract or configuration that contains
     the behaviour, with path and line where possible. State that correctness
     is not proven by this evidence.
   - `Verified` — cite the passing result of the correct layer and name the
     scope the run covered and did not cover.
   - `Released` — require a deployment record plus a post-deploy environment
     check. When the capability's intended environment is production-facing,
     refuse this state: no deployment record store exists
     (`02-delivery.md` §12), so the state stays at `Verified`. A local deploy
     supports `Released` only when local is the environment the capability is
     designed to serve (`evolution-process.md` §5.1).
9. Report the evidence where the work is tracked — PR body for a pre-merge
   run, Issue comment for a post-merge settlement — using clear prose per
   `docs/AGENTS.md` §2. Include the unverified remainder explicitly.
10. After any material fix or rebase, re-run the affected validation. A result
    from an earlier revision does not cover the new head.

## Allowed changes

- Run any command needed to produce evidence, including local stack commands
  listed in `AGENTS.md`.
- Add or adjust tests inside the owning project when the missing coverage is
  part of the unit's own deliverable.
- Write commands, outcomes, and limitations into the PR body or Issue comment.
- Report a failed check and hand the fix back to the change's owner when the
  fix is outside the current scope.

## Prohibited changes

- Claiming a check passed without running it, or reporting a remembered result
  as a current one.
- Upgrading `Verified` to `Released` from merged source, green CI, or a
  successful deploy command; CI is not a deployment record.
- Treating "CI green" or "deploy succeeded" as a business outcome.
- Inventing target names, a new test layer, a new evidence format, a report
  file, or an evidence store.
- Adding or changing CI gates, `.github/workflows/`, or `pnpm dx pr-check`.
- Converting a skipped or blocked suite into a pass, or reporting a partial
  run as complete.
- Putting secrets, customer data, or prompt/response bodies into reported
  evidence.

## Evidence to collect

- Exact command line, including flags, `-c` configuration and project names.
- Revision: branch head or commit SHA the run applied to.
- Outcome class: ran and passed / ran and failed / could not run.
- For a failure: failing test names and the error output verbatim.
- Pass/fail/skip counts as the tool reports them, not as estimated.
- Scope covered by the run, and the behaviours left unverified.
- Environment limitations that prevented a run, stated as a blocker.
- For `Released`: the deployment record locator, the environment, and the
  post-deploy check command and result.
- Repository-level checks for the change's type, per
  `contribution-workflow.md` §2.7 — for docs, templates and configuration
  `npx oxfmt --check .`; for project tags, the deployment map or the Nx graph
  `pnpm dx arch-check`. Project lint runs through the Nx `lint` target, not a
  separate command. `pnpm dx pr-check` runs only inside a GitHub Actions
  `pull_request` event; it fails closed locally, so check a PR title with
  `pnpm exec commitlint` instead.
- The validation selection itself comes from `delivery-slice` step 8 or from
  `06-testing.md` §7; this skill produces the result for a layer already
  chosen, and escalates when the selection is missing rather than inventing
  one.

## Completion criteria

- Every state claimed has its own evidence; none is inferred from another.
- Each run is labelled with one of the three outcomes, and the label matches
  the recorded output.
- The unverified portion of the scope is named.
- The evidence is reproducible from what was written down: command, revision,
  environment.
- No claim exceeds what the evidence supports, and no new artifact or gate was
  introduced to support it.

## Escalation

Stop and report when:

- the required layer cannot run (no Docker, no PostgreSQL, no credentials, the
  local stack failed to come up) — report the blocking step and its error;
- the verification criteria in the Issue are missing or ambiguous;
- the claim is `Released` for a production-facing capability, or otherwise
  needs a deployment record the repository cannot produce;
- no test layer owns the behaviour, or the required category does not exist;
- a failing check needs a fix outside the current scope;
- canonical sources disagree on the required evidence — do not pick a side.
