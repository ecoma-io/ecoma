---
name: create-issue
description: Open a GitHub issue for this repo that fits its templates and conventions - the right template chosen, duplicates searched first, environment facts read from commands instead of memory, security reports redirected off the public tracker. Use whenever asked to file, create, or draft an issue here.
---

# Create an issue (Ecoma)

The templates in `.github/ISSUE_TEMPLATE/` own the layout — mirror their sections, title prefix, and default label; never invent a parallel structure. This skill owns what the templates cannot: routing, dedup, fact honesty, and the prose.

## 1. Route first — not everything is an issue

- **Security vulnerability → never a public issue.** Report by email per `SECURITY.md`; stop here. When in doubt whether something is security-sensitive, treat it as if it is.
- **Half-formed idea** → the feature template itself says to consider a Discussion first; don't force it into an issue shape prematurely.
- **A defect you are fixing in the same session** → an issue is for tracking, not ceremony; create one only when the user wants the record (e.g. to reference from the PR as `Closes #N`).
- **A site your own fix left uncovered → not an issue, finish the fix.** If a change establishes an invariant ("this glyph declares its stroke", "a connector name is unique") and you find another place that invariant must hold, that belongs in the same PR — root `CLAUDE.md` → "A fix covers its invariant". The same applies when reviewing: an uncovered site is a **blocking** finding, not a follow-up to file. Filing it converts the author's incompleteness into someone else's backlog, and the issue tracker fills up with debt the fix should have absorbed. File only when covering it genuinely belongs elsewhere — a different leaf, a design decision the fix cannot settle, a behavior change needing its own migration answer — and then say in the issue why it was excluded rather than leaving that implicit.

## 2. Search for duplicates — before writing, not after

Search existing issues (open and closed) for the symptom and the component name. A match means comment/link on the existing issue instead of filing a twin; a near-match means the new issue must say explicitly how it differs.

## 3. Pick the template and keep its contract

- Broken behavior → `bug_report.md` (`[BUG] ` title prefix, `bug` label). New capability → `feature_request.md` (`[FEATURE] ` prefix, `enhancement` label).
- Title after the prefix names the problem or the end state, specific enough to find later — component in front where it helps ("core-ui: Toast stack loses order after rapid dismiss"). Rule 13 applies: no phase/plan/version-journey markers.

## 4. Facts come from commands, not memory (bug reports)

- Environment: `node --version`, `pnpm --version`, the OS actually observed, and the product version from the release tag (`git tag --list '<app>@*'`) or the app's `package.json` — never recalled or guessed.
- **Steps to Reproduce are steps you actually executed** (Rule 11): reproduce before filing; if you could not reproduce, the issue must say so plainly instead of presenting hypothetical steps as real ones.
- Paste real error output into the log section verbatim — trimmed, not paraphrased. Reference code as `path/to/file.ts:line` so it stays clickable.

## 5. The prose — one defect, observed vs expected

- One issue per defect/feature; a list of unrelated problems is several issues, not an umbrella.
- Bug description = what was observed vs what was expected, in terms of behavior, not suspicion about the cause; put root-cause hypotheses in Additional Context, marked as hypothesis.
- Feature description = the problem it solves before the solution shape (mirror the template's order); tie it to the leaf/boundary it belongs to so scoping is visible up front (root `CLAUDE.md` → Ecosystem Shape).

## 6. After creating

Link it where it earns its keep: `Closes #N` in the PR that fixes it, or a reference from the related issue/discussion. Don't assign, label beyond the template default, or set milestones unless asked.
