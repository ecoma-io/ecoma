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
decide whether an Issue should exist, find existing work, classify it, and
write the title and body. This skill introduces no competing process.

Sources of truth, in order of authority: `docs/engineering/work-management.md`
(policy), `docs/engineering/evolution-process.md` §4 (work kinds),
`AGENTS.md` (workflow, language), `docs/AGENTS.md` §2 (writing
quality), and the forms in `.github/ISSUE_TEMPLATE/` (structure). When they
conflict with this file, they win and this file should be corrected.

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
- Work kind is **not** a label. Do not create one; record it in the body or in
  the form field.

## Decide whether an Issue should exist

| Case                                                                      | Action                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The user explicitly asks for an Issue                                     | Create it, after the search below.                                                                                           |
| Independently trackable implementation work                               | One Issue per unit — see the criteria in `work-management.md` §2.1.                                                          |
| Exploratory work with unclear scope                                       | Investigate first; create the Issue once the work is defined.                                                                |
| Standalone explanation, advice, or review inside an existing PR           | No Issue; deliver the answer in place. Track follow-up work separately only when it becomes an independently trackable unit. |
| Work already tracked by an existing Issue or PR                           | Reuse or link it; never create a parallel one.                                                                               |
| The work is a ledger, precondition tracker, experiment record or decision | Create it as that record type, and say so — never as a work item (§2.2).                                                     |

Do not create Issues to appear thorough. If the requested outcome cannot be
established from the request and available evidence, ask one focused question
or record the unresolved decision; do not implement under an invented scope.

## Search before creating

Search by the outcome's domain and purpose — which service, which behavior —
not only by title words. Then:

1. Read the body of every plausible candidate; never decide from titles.
2. Classify each candidate using `work-management.md` §2.2: work item,
   coordination ledger, precondition tracker, experiment record, or decision
   Issue. Never turn a record into your work item, and never append new
   findings to an archived record.
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

## Classify the work kind

Pick exactly one of the five canonical kinds, applying the priority order in
`docs/engineering/evolution-process.md` §4.1 and stopping at the first match:
Remediation → Experiment → Modelling → Delivery → Discovery.

- Do not infer work kind from the label or the form used.
- A `bug` is usually Remediation, but a defect in behaviour that never existed
  is Delivery. A `documentation` issue is Modelling when the deliverable is
  the specification itself.
- If the kind is genuinely unclear, keep it out of the body and record the
  ambiguity as an open question. Do not guess to fill a field.

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

Additional content by work kind:

| Work kind       | Required extras                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| **Discovery**   | Question, evidence already available, where to look, what makes the answer sufficient                 |
| **Modelling**   | Which specification or ADR changes, which decisions are open, acceptance condition                    |
| **Experiment**  | Hypothesis, scope and environment, evaluation criteria fixed **before** running, how results are kept |
| **Delivery**    | Observable outcome, which part of the target capability is covered and which is not                   |
| **Remediation** | Which deviation or gap is being closed, its origin, closure condition                                 |

For ledgers, precondition trackers, experiment records and decision Issues,
use free structure. Every heading must carry information — no empty
placeholders.

## Ground every claim

Keep these categories distinguishable in the body:

- **Đã verify** — inspected behaviour; name the file, commit or command.
- **Yêu cầu của người dùng** — desired behaviour as stated.
- **Suy luận** — inference; say from what.
- **Giả thuyết chưa xác minh** — label it, especially for an unknown root
  cause. Never invent repro steps, `file:line` references or benchmark
  numbers; a number appears only when measured, with method and environment.

Acceptance criteria state observable outcomes. Quality words — `tối ưu`,
`hoàn thiện`, `mạnh mẽ`, `ổn định`, `đúng chuẩn`, `hoạt động tốt` — must not
stand alone as requirements.

Mark proposals as `đề xuất`; mark established decisions with their source
(ADR, Issue, user request). A proposal is never written as a decision.

## Create the Issue safely

```bash
gh issue create --repo ecoma-io/ecoma \
  --title "fix(dx): ..." \
  --body-file <path-to-body-file>
```

Write the body to a file so backticks, `$` and Vietnamese text survive intact.

- Set only verified, existing values. Prefer no label over an invented one.
  Never set a milestone, Project field or assignee that you have not confirmed
  exists — and never set one as a placeholder.
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
- Do not create Projects, Milestones, labels, custom fields or Issue templates
  as part of writing an Issue. Propose such changes as their own work unit.
- Never bulk-apply changes to existing Issues.

## Review before submitting

1. Can the reader get the main objective from the title alone?
2. Does the body state why the work matters and what result is required?
3. Can every completion criterion be verified without guessing?
4. Are verified facts, requirements, inferences and unknowns distinguishable?
5. Is the work kind stated, and does it match the body rather than the label?
6. Is this a work item — not accidentally a ledger, tracker or record?
7. Is the Issue genuinely new, properly linked, or correctly reused?
8. Does every heading add necessary information?
9. Are technical terms and identifiers accurate?
10. Does the content comply with repository policy and the task's
    authorization?

## Escalation

Stop and report instead of guessing when:

- A decision the Issue needs — scope, ownership, acceptance — is missing and
  no canonical document or accepted record supplies it.
- GitHub state needed to write the Issue cannot be read: token lacks
  `read:project`, the API fails, or search cannot cover closed Issues.
- Two canonical documents disagree about the work kind, the closure
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
- Work kind is stated using one canonical value, or its ambiguity is recorded.
- Search results and the reuse/link/create decision are accounted for.
- GitHub state used in the Issue was read from GitHub, not assumed.
- No GitHub state outside the task was changed.
