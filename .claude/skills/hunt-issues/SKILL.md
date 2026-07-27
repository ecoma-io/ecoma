---
name: hunt-issues
description: Hunt a project in the workspace for real, verified defects and turn the survivors into GitHub issues - fan out reviewers by lens, prove each finding on the real code path, filter through the issue-worthiness gates, then hand filing to the create-issue skill. Use whenever asked to hunt, sweep, audit, or find issues in a product, or when a scheduled Routine invokes issue-hunting.
---

# Hunt issues (Ecoma)

This skill owns the _hunting_ — scope, fan-out, verification, and the gates a finding clears before it becomes an issue. It does NOT own filing: the `create-issue` skill owns dedup, template choice, fact honesty, and security routing. Never re-implement those here; hand every survivor to it.

## 1. Scope one living area — never the whole repo at once

- Hunt one domain tree per run (e.g. `shared/`, or a product domain root once one exists), or the `affected` set of a diff. Rotate across runs; a single run that sweeps everything finds shallowly and floods.
- **Loud scaffold is not a defect — skip it.** A file whose exports `throw new Error("not implemented …")` and whose tests are `it.todo(...)` is honest, sanctioned incompleteness (root `CLAUDE.md` → Scaffold openly). An early-stage leaf may be mostly this while it's still being built out. Reporting a "missing implementation" there is noise. Any executing logic inside those trees is still in scope.

## 2. Fan out reviewers by lens

Spawn parallel subagents, one per lens, over the scoped tree — each reads that tree's `CLAUDE.md` files first for invariants and footguns:

- **correctness** — wrong logic, off-by-one, missing `await`, unhandled rejection, race, resource leak (unclosed process/handle/timer/stream), swallowed error.
- **security** — untrusted input → sink (shell/argv, path, deserialization), desktop-shell hardening, secret handling, unauth surface. Trace the full source→sink path.
- **test-gap (Rule 8)** — important, executing logic that can change without any test failing; a test that pins a fictional value or only asserts presence.

Route per root `CLAUDE.md` → Agent & Model Routing: bug hunting is reasoning work (`sonnet`+, `effort: high`), read-only search is `Explore`. Scale the pool to the ask — a few hunters for a quick pass; a larger pool plus an adversarial verify stage for "audit thoroughly".

## 3. Verify before you believe — evidence over assertion

- A subagent's finding is a _lead_, not a fact. Before it can pass, re-derive it: read the cited `file:line` yourself, trace the data/control flow, and confirm the vocabulary/types it depends on.
- **Run the real path.** Prove it with `pnpm nx affected -t typecheck test` (or the touched project's targets) — a failing check, a reproduced scenario, or a traced source→sink. A finding you cannot reproduce is reported as unconfirmed, never dressed as confirmed (Rule 11). Critical and security findings are re-verified by the main agent directly, never filed on a subagent's word alone.

## 4. The gates — a finding clears all of these or it is not an issue

1. **Evidence** — `file:line` plus a concrete failure scenario (inputs/state → wrong outcome) or a failing check. No "looks racy", no untraced suspicion.
2. **Severity floor** — critical / high / medium, or a Rule 8 test-gap on shipped logic. A style/naming nit does not get its own issue.
3. **Living scope** — in code that actually runs (gate 1 of §1). Skip loud scaffold.
4. **Not an already-acknowledged reserved gap** — if a `CLAUDE.md` or code comment openly documents the limitation as reserved (no identity system yet, redrive re-runs an irreversible step), filing "add the reserved thing" duplicates a known seam. The exception that _is_ fileable: the gap the docs do NOT acknowledge — e.g. an insecure default the deploy guidance never warns about. File the unacknowledged mismatch, not the acknowledged seam.
5. **Actionable + one defect** — you can state what "done" looks like, and each issue is a single defect (a list of unrelated problems is several issues, never one umbrella).

## 5. Hand off to `create-issue` — mode depends on how you were invoked

Every survivor is filed through the `create-issue` skill (it searches duplicates first, picks the template, keeps facts honest). Two modes:

- **Interactive** (a human ran `/hunt-issues`): present the verified findings ranked, then draft and **confirm before filing** — filing is outward-facing content creation.
- **Headless** (a Routine invoked this with no human present): auto-file each CONFIRMED finding that cleared every gate, so the run produces actionable issues by morning. Cap the count and rotate scope so a run never floods the tracker.
- **Security findings never go to the public tracker in either mode** — route per `SECURITY.md` (private report), per the `create-issue` skill's step 1. When unsure whether something is security-sensitive, treat it as if it is.

## 6. Report what you did

Close with a short ledger: area hunted, findings confirmed vs discarded (and why discarded — false positive, loud scaffold, acknowledged gate), and the issues filed or drafted. Silent truncation reads as "covered everything" when it didn't (Rule 11) — say what a run deliberately left for the next rotation.
