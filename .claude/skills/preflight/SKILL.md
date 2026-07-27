---
name: preflight
description: Judgment-layer review of pending work against this repo's doctrine, run AFTER the deterministic gates (hooks, `pnpm nx affected -t lint test typecheck build e2e`) are green and before push/PR. Catches what no lint can — fake-done, intent-less tests, smuggled refactors, simplicity-ladder skips, seam/boundary erosion, boilerplate CLAUDE.md — and only that; it never re-runs the deterministic gates and it is not a generic bug hunt (use /code-review for that).
---

# Preflight — the judgment pass (Ecoma)

Deterministic checks live below this skill: hooks and CI own formatting, lint, types, tests, commit gates, journey markers, doc links. **Do not re-run or restate them here.** This pass reviews the one layer no gate can judge — whether the change honors the repo's doctrine. Every check below cites the rule it serves (root `CLAUDE.md`, always in context); this file adds only the _review questions_, never a copy of the rules.

## 1. Scope the diff

Review the work that will ship, not the working tree noise:

```bash
git diff --stat main...HEAD   # what a PR would carry (merge-base)
git diff main...HEAD          # the full diff to judge
```

For uncommitted work, use `--cached` / plain `git diff` instead. Read every hunk you are about to judge (Rule 7) — never review from the stat line alone.

## 2. The checklist

Work through each lens against the diff. A finding names `file:line`, the rule it violates, and _why it matters here_ — not just that it pattern-matches.

- **Honest completion (Rule 11, "never fake done").** Does any code path return a fabricated value to satisfy a check? Is anything reported "done" whose real user-facing path was never exercised? Was every mode/branch the change touches actually run — or is one mode verified and the others assumed? Unfinished seams must be _loud_ (`throw`, `TODO`, `.todo` test), never disguised.
- **Tests pin intent (Rule 8).** For each behavior this change adds or alters: could the important logic be broken without any test failing? Do test titles state the behavior they pin (not the task that produced them)? Is a weakened assertion hiding in a "fixed" test?
- **Surgical scope (Rule 3).** Does the diff contain refactors, polish, or dead-code removal unrelated to the stated goal? Report them as findings to split out — do not silently keep or revert them.
- **Simplicity ladder (Rule 2).** For each new bespoke piece: was there a lower rung — config, existing repo code, stdlib, an installed dep? Name the rung that was skipped.
- **End-state naming (Rule 13, semantic tier).** The regex gates catch known marker shapes; judge what they cannot: names, test titles, or docs that describe the _journey_ (a phase, a fix-round, "new"/"old" relatives) rather than what the thing _is_.
- **Seam & boundary discipline (Ecosystem Shape).** Does the change harden a reserved seam without a real second consumer? Bake a forbidden assumption into a leaf (single-human principal, UI-coupled core, display-only artifact, blocking HITL, uncounted work)? Couple leaves at build time where a runtime protocol is the seam? Put workspace/marketplace concerns inside a leaf?
- **Docs stay true (one source of truth).** Do the claims in the touched `CLAUDE.md`s / `CONTRIBUTING.md` still hold after this diff? Did the change duplicate a rule that already has an owning tier instead of pointing to it? Is a new/edited subproject `CLAUDE.md` real content (invariants, footguns) or padding?

## 3. Report

Output findings ranked by severity, each with `file:line` + rule + consequence; state plainly when a lens found nothing. "No findings" is a legitimate result — an invented nitpick is itself a Rule 11 violation. If a finding requires re-running something real to confirm (a mode never exercised), say so explicitly rather than guessing either way.
