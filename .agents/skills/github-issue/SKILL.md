---
name: github-issue
description: Apply when creating, drafting, revising, or reviewing GitHub
  Issues, when searching existing Issues and PRs before starting work, or
  when defining independently trackable implementation work that needs an
  Issue. USE WHEN asked to open an issue, file a bug, track a unit of work,
  or check whether work already exists. NOT for PR titles or PR bodies
  (commitlint and pr-check govern those; `docs/AGENTS.md` §2 governs prose).
---

# GitHub Issues

Operationalize `docs/engineering/work-management.md` for the Issue step:
decide whether an Issue should exist, find existing work, set its Issue Type,
and write the title and body. This skill introduces no competing process.

Sources of truth, in order of authority: `docs/engineering/work-management.md`
(policy — §2.2 record kinds and their Issue Types, §2.3 how the Issue Type is
recorded, §3 Project membership, §4 Milestones and horizons),
`docs/engineering/evolution-process.md` §4.1 (the five Issue Type values and
the priority order), `AGENTS.md` (workflow, language), `docs/AGENTS.md` §2
(writing quality), and the forms in `.github/ISSUE_TEMPLATE/` (structure).
When they conflict with this file, they win and this file should be
corrected.

## Read GitHub state before relying on it

Nothing in this skill is a snapshot of the repository's GitHub configuration.
Read the live state first, and treat an unreadable value as unknown rather
than a default:

```bash
gh label list --repo ecoma-io/ecoma --limit 100
gh api repos/ecoma-io/ecoma/milestones
gh issue list --repo ecoma-io/ecoma --state all --search "<keywords>" --limit 20
gh pr list --repo ecoma-io/ecoma --state all --search "<keywords>" --limit 20
```

Project fields need the `read:project` token scope. If `gh project` fails,
report the limitation — do not assume a Project exists, does not exist, or
has particular field values.

Repository conventions that are not machine-enforced (re-verify before
asserting):

- **Nothing validates Issue rules.** `pnpm dx pr-check` and commitlint check
  PR titles and commits only. The ASCII-only commit rule never sees an Issue.
- The **title is written in English** by convention; the **body is written in
  Vietnamese** per `AGENTS.md` `Language`. Keep paths, commands, error codes,
  identifiers, product and API names unchanged.
- Titles conventionally carry a Conventional-Commit-style prefix
  `type(scope): summary`. The scope is free-form; the one-Nx-project scope
  restriction and PR rules do not apply to Issues.
- The **Issue Type is native metadata**, not a label, not a Project field,
  not a form field value — see the next section. Do not create any of those
  as a parallel channel.
- The Project's `Work kind` single-select predates the current policy and
  is **frozen**: set no new value in it (`work-management.md` §2.3, §3.4).
  The form's `Loại công việc` dropdown is the form-side surface of the
  interim `## Loại công việc` body channel — it writes that body line and
  stays usable until transition step 3 removes it (`work-management.md`
  §2.3).
- `project:track` **is** a label — the only label this skill applies on its
  own authority, and during the transition only on a **root issue** per
  `work-management.md` §3.2–§3.3. Every other label, Project field, Milestone
  and assignee follows the verified-value rule below.

## Decide whether an Issue should exist

| Case                                                                      | Action                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The user explicitly asks for an Issue                                     | Create it, after the search below.                                                                                           |
| Independently trackable implementation work                               | One Issue per unit — see the criteria in `work-management.md` §2.1.                                                          |
| Exploratory work with unclear scope                                       | Investigate first; create the Issue once the work is defined.                                                                |
| Standalone explanation, advice, or review inside an existing PR           | No Issue; deliver the answer in place. Track follow-up work separately only when it becomes an independently trackable unit. |
| Work already tracked by an existing Issue or PR                           | Reuse or link it; never create a parallel one.                                                                               |
| The work is a ledger, precondition tracker, experiment record or decision | Create it as that record kind, and say so — never as a work item (§2.2).                                                     |

Frame the work against Change Specifications before writing the body: does
it follow an existing spec, need a new one — only when the change meets the
spec gate in `docs/changes/README.md` §1 — or go straight to Delivery or
Modelling with the canonical documents updated in the same logical change?
State the answer in the body: the spec path when one applies, or the
canonical documents the Issue updates.

Do not create Issues to appear thorough. If the requested outcome cannot be
established from the request and available evidence, ask one focused question
or record the unresolved decision; do not implement under an invented scope.

## Search before creating

Search by the outcome's domain and purpose — which service, which behavior —
not only by title words. Then:

1. Read the body of every plausible candidate; never decide from titles.
2. Classify each candidate using `work-management.md` §2.2 — work item,
   coordination ledger, precondition tracker, experiment record, or decision
   Issue — and read the Issue Type it carries: an Experiment record is typed
   Experiment, a decision Issue is typed Modelling, while ledgers and
   precondition trackers are legitimate untyped root issues. Never turn a
   record into your work item, and never append new findings to an archived
   record.
3. State one of three outcomes:
   - **Reuse** — an open Issue already tracks the same outcome.
   - **Link** — same topic, materially different outcome. Reference the
     related Issue and explain the distinction in one sentence.
   - **Create** — the outcome is genuinely uncovered. Say in one sentence how
     it differs from the closest candidate.
4. Treat closed Issues as sources of binding decisions: cite the finding or
   constraint instead of re-deriving it.

If search is unavailable or incomplete, state the limitation. Never claim
duplicate detection was comprehensive when it was not.

## Set the Issue Type

Pick exactly one of the five canonical values — Discovery, Modelling,
Experiment, Delivery, Remediation — applying the priority order in
`docs/engineering/evolution-process.md` §4.1 and stopping at the first match:
Remediation → Experiment → Modelling → Delivery → Discovery.

- Today the five Issue Types are **not yet org-configured**, so
  classification is recorded through the interim channel: the
  `## Loại công việc` line in the Issue body, which the form's
  `Loại công việc` dropdown writes — when the dropdown is used, the body
  line must match it. Match the line by section name, whatever the heading
  level or the form's `(kênh tạm thời)` suffix — not by literal string
  (`work-management.md` §2.3). Where another place records a divergent
  value, fix it to match this line; it is never a parallel custom field,
  label or form value.
- Native metadata at creation — the UI, or `gh issue create --type <name>` —
  is the target-state mechanism once the org configures the five types. The
  authority runs in three windows (`work-management.md` §2.3): the body line
  before that configuration; native Issue Type after it, with form-created
  Issues still recording via the body line and native winning any
  divergence; native-only once the cleanup step retires the body channel —
  from then on an Issue never carries classification on two channels.
  Issue Forms cannot set the native type. In no window are GitHub's default
  Task/Bug/Feature types substitutes for the five canonical values
  (`work-management.md` §2.3).
- **Missing type (work items):** report a blocker only when a work item
  needs a classification or native GitHub capability that has no documented
  channel — a value outside the five Issue Types, or a capability with no
  interim path (`work-management.md` §2.3). While that interim channel
  exists (org not configured yet), use it instead of blocking; do not
  invent a substitute classification.
- Do not infer the Issue Type from the issue category — a `bug` is usually
  Remediation, but a defect in behaviour that never existed is Delivery; a
  `documentation` issue is Modelling when the deliverable is the
  specification itself.
- If the value is genuinely unclear, record the ambiguity as an open question
  in the body. Do not guess to fill a field.
- A later type change is recorded with its reason in a comment, never applied
  silently (`work-management.md` §2.5).

## Choose the body structure

Use the matching form's fields as `##` headings when one form applies —
`bug_report.yml`, `feature_request.yml`, `documentation.yml`, or
`engineering_work.yml` for Discovery / Modelling / Experiment and any
engineering work that is not a bug, feature or docs task. Mirror the fields,
minus the form widgets.

Minimum content for a work item, per `work-management.md` §2.4:

- **Outcome** — observable result, not a task list.
- **Phạm vi** — what may change, and the non-goals.
- **Ràng buộc** — invariants, contracts, accepted decisions, with links.
- **Dependency** — work or decisions that must land first.
- **Điều kiện hoàn thành** — how to verify.

Additional content by Issue Type:

| Issue Type      | Required extras                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| **Discovery**   | Question, evidence already available, where to look, what makes the answer sufficient                 |
| **Modelling**   | Which specification or ADR changes, which decisions are open, acceptance condition                    |
| **Experiment**  | Hypothesis, scope and environment, evaluation criteria fixed **before** running, how results are kept |
| **Delivery**    | Observable outcome, which part of the target capability is covered and which is not                   |
| **Remediation** | Which deviation or gap is being closed, its origin, closure condition                                 |

For ledgers, precondition trackers, experiment records and decision Issues,
use free structure. Every heading must carry information — no empty
placeholders.

## Root issue, sub-issue and Project membership

Native parent/child is the only source of the hierarchy — no label, field or
Milestone carries it (`work-management.md` §2.1, §3.2).

- **Root issues own outcomes and belong to the Project.** A root issue that
  needs decomposition takes sub-issues; one that does not acts as its own
  unit. It closes when its outcome is met and reconciled
  (`work-management.md` §2.6).
- **Sub-issues own work units and never join the Project.** They are visible
  through the root issue's native sub-issues progress. A sub-issue never
  inherits Project membership from its parent, and never carries
  `project:track`.
- **Transition:** the native auto-add workflow is not root-aware yet, so the
  `project:track` label — root issues only — remains the admission signal
  read by that workflow (`work-management.md` §3.2). Admission is the
  creating agent's duty: apply the label to a root issue **at creation**,
  per the root-issue rule — that is the admission act, not a drift fix
  (`work-management.md` §3.3).
- Membership lifecycle belongs to the Project coordinator. When reviewing,
  report drift — a sub-issue inside the Project, a labeled Issue with no
  item, an item with no label — only after re-reading the Project state to
  rule out a workflow race, and never archive, remove or add a Project item
  yourself (`work-management.md` §3.3).
- **A root issue that owns a Change Specification references the spec by its
  path in the body** (the `change-spec` form input writes it); sub-issues
  may reference a spec but never co-own it. Exactly one open root issue may
  own a spec — zero is the "no reachable owner" escalation and more than
  one is drift to report, never a choice (`docs/changes/README.md` §4).

## Ground every claim

Keep these categories distinguishable in the body:

- **Verified** — inspected behaviour; name the file, commit or command.
- **User requirement** — desired behaviour as stated by the requester.
- **Inference** — say what it is inferred from.
- **Unverified hypothesis** — label it, especially for an unknown root cause.
  Never invent repro steps, `file:line` references or benchmark numbers; a
  number appears only when measured, with method and environment.

Acceptance criteria state observable outcomes. Quality words must not stand
alone as requirements — each must be qualified by the measurable condition
the requester actually supplied.

Mark proposals as proposals; mark established decisions with their source
(ADR, Issue, user request). A proposal is never written as a decision.

## Create the Issue safely

Write the body to a file so backticks, `$` and Vietnamese text survive intact.
Two clearly separated cases — never mix them (`work-management.md` §2.3):

**Current stage — before transition step 2 (the five Issue Types are not
org-configured yet).** Classification is carried by the `## Loại công việc`
body line (the form dropdown writes it; the two must match) — never in a
label or Project field. Do **not** pass `--type` here: the only values it
could carry are GitHub's default Task/Bug/Feature types, which are not the
five canonical values and must not substitute for them. This command is the
executable one today:

```bash
gh issue create --repo ecoma-io/ecoma \
  --title "fix(dx): ..." \
  --body-file <path-to-body-file>   # body carries ## Loại công việc
```

**After transition step 2 (the org has configured the five types).** Set the
native type explicitly with `--type`; an Issue created with a native type
carries no body line. Form-created issues still record through the body
line until the cleanup step retires it, with native winning any divergence
(`work-management.md` §2.3). Do not run this command in the current stage:

```bash
gh issue create --repo ecoma-io/ecoma \
  --title "fix(dx): ..." \
  --body-file <path-to-body-file> \
  --type <Discovery|Modelling|Experiment|Delivery|Remediation>
```

- Set only verified, existing values. Prefer no label over an invented one.
  Never set a milestone, Project field or assignee that you have not confirmed
  exists — and never set one as a placeholder. `project:track` is applied only
  under the root-issue rule above.
- Include verified references to related Issues, PRs, documents and evidence
  as exact links (`#N`, paths).
- If the user asks only for a draft, return the title and body without
  creating.
- Report the URL only after creation succeeds, read from the command output.
  If it fails, report the blocker together with the prepared title and body.
- Security-sensitive work: check `SECURITY.md` before publishing details.
  Secret values, tokens, cookie contents, prompt/response bodies and customer
  data never enter an Issue.

## Do not change GitHub state outside the task

- Do not reopen, edit, close, relabel or reclassify an Issue you did not
  create without explicit authorization. Add a comment instead of editing.
- Do not close another unit's Issue; closure conditions belong to that unit
  (`work-management.md` §2.6).
- Do not create Projects, Milestones, labels, custom fields, Issue types or
  Issue templates as part of writing an Issue. Propose such changes as their
  own work unit.
- Never bulk-apply changes to existing Issues.

## Review before submitting

1. Can the reader get the main objective from the title alone?
2. Does the body state why the work matters and what result is required?
3. Can every completion criterion be verified without guessing?
4. Are verified facts, requirements, inferences and unknowns distinguishable?
5. Is the Issue Type set in native metadata — or, during the transition, in
   the `## Loại công việc` body line, matching the dropdown when one was
   used, with no duplicate channel once native types exist — and does it
   match the body rather than the issue category?
6. Does Project membership follow the root-issue rule, with `project:track`
   applied only to a root issue during the transition?
7. Is this a work item — not accidentally a ledger, tracker or record? And if
   it is a record, does it carry the Issue Type §2.2 assigns it — or none,
   for a legitimate untyped root issue?
8. Is the Issue genuinely new, properly linked, or correctly reused?
9. Is a sub-issue placed under the right root issue, and never marked for
   Project membership?
10. Does every heading add necessary information?
11. Are technical terms and identifiers accurate?
12. Does the content comply with repository policy and the task's
    authorization?

## Escalation

Stop and report instead of guessing when:

- A work item needs a classification or native GitHub capability that has
  no documented channel — a value outside the five Issue Types, or a
  capability with no interim path. Report the blocker naming the gap; do
  not substitute a classification (`work-management.md` §2.3).
- A decision the Issue needs — scope, ownership, acceptance — is missing and
  no canonical document or accepted record supplies it.
- GitHub state needed to write the Issue cannot be read: token lacks
  `read:project`, the API fails, or search cannot cover closed Issues.
- Two canonical documents disagree about the Issue Type, the closure
  condition or the Issue's owner, and no authoritative source resolves it.
- The requested Issue would exceed the unit you were asked to handle, or
  would duplicate work already tracked.
- The task would require changing GitHub state — closing, relabelling,
  retagging, creating a Project or Milestone — that the request did not
  authorize.

State what is blocked, what was verified, and what decision is needed. Do not
substitute an invented value.

## Completion Criteria

- The Issue exists (or the draft is returned), with a title that states the
  outcome and a body grounded in inspected evidence.
- The Issue Type is set in native metadata, or carried by the interim
  `## Loại công việc` body line when the type is not configurable yet — never
  in a label or Project field; the body line matches the dropdown, and after
  native types exist the Issue carries no duplicate body line.
- Search results and the reuse/link/create decision are accounted for.
- Project membership follows the root-issue rule; a sub-issue was never
  marked for membership.
- GitHub state used in the Issue was read from GitHub, not assumed.
- No GitHub state outside the task was changed.
