---
name: create-pr
description: Open a pull request that meets THIS repo's standard - definition-of-done proven green first, every checkbox computed from `dev-cli pr-facts` instead of guessed, the model writing only the Description and Test Steps prose. Use whenever asked to create, open, or prepare a PR here; refuse to open one on a red definition-of-done.
---

# Create a PR (Ecoma)

The repo's gates already own commit hygiene (every branch commit passed commitlint + scope↔path, and CI re-checks per commit because PRs are rebase-merged). This skill owns the last mile: proving the work green, filling the template from facts, and writing only the prose a model is actually for. Facts come from commands, never from memory or re-derivation.

## 1. Prove the definition of done

```bash
pnpm nx affected -t lint test typecheck build e2e
```

Red → **stop and report the failure; do not open the PR** (Rule 11). A just-completed green run of the same targets on the same tree counts — don't re-run for ceremony. If the work deserves a judgment pass and hasn't had one, run `/preflight` first and resolve or surface its findings.

## 2. Compute the facts

```bash
node shared/tools/dev-cli/src/main.mjs pr-facts        # add --base <ref> if not origin/main
```

Everything checkable comes from this JSON — commits (type/scope/breaking), touched projects, `typeOfChange` labels, `testsChanged`, `viewLayerTouched`. Do not tick a box the facts don't justify, and do not re-classify by reading the diff "one more time".

## 3. Fill the template

Use `.github/PULL_REQUEST_TEMPLATE.md` as the layout:

- **Type of Change** — tick exactly the boxes in `typeOfChange`.
- **How Has This Been Tested?** — "Unit tests added/updated" from `testsChanged`; "Tests pass locally" only because §1 was green; UI/accessibility boxes only for view-layer work you actually exercised.
- **AI-Assisted Development** — tick it whenever an agent drafted or substantially wrote the change, and name the tool and model tier in the comment beside it. This is the one box no fact command can derive: `pr-facts` reports what the diff contains, never who wrote it, so an unticked box here is a false statement rather than a missing one (Rule 11).
- **Checklist** — each box only if true; an unticked box with a one-line reason beats a false tick (Rule 11).
- **Description** and **Test Steps** — the model's part, and the only part. Explain what problem the change solves and how a reviewer verifies it, grounded in the commits and diff. Rule 13 applies to this prose: the PR body lives outside the repo's journey-marker gates, so keep phases, plan codes, and version markers out of it yourself.
- **For a fix, the Description states the invariant and its coverage.** Name the rule the change establishes, then account for every place it must hold — covered here, or excluded with a reason (root `CLAUDE.md` → "A fix covers its invariant"). This is the one claim §1's green run cannot make for you: a definition-of-done gate proves the code you wrote works, never that you wrote enough of it. A fix that covers six of seven call sites passes every target in the repo. If enumerating the sites reveals one you have not covered, go back to §1 — do not open the PR listing it as future work.
- Reference the issue if one exists; state breaking changes plainly.
- **The body carries no agent attribution and no session link.** No "Generated with Claude Code" byline, no `Co-Authored-By: Claude` or `Claude-Session:` trailer, no `https://claude.ai/code/session_…` URL — the session link points into a private transcript, and a PR body is public. The harness already omits all of it (`.claude/settings.json` → `attribution`); do not type it back in by hand. `.claude/hooks/block-agent-attribution.mjs` denies a publishing `gh` command whose body — inline or via `--body-file` — still contains any of them, so a denial there means the body needs the line removed, not a workaround.

## 4. Open it, don't merge it

- Title: imperative summary of the end state; a single-project PR may reuse its dominant commit header.
- Base `main`, head the current branch (push with `-u` first if unpushed).
- Never merge, enable auto-merge, or approve — review belongs to humans.
- After creating, offer to watch the PR (CI + review comments) if watching tooling is available in the session.
