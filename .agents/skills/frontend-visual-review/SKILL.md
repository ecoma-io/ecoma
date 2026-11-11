---
name: frontend-visual-review
description: Manually review frontend UI against an isolated development server running the app's configured serve/data mode (UI preview), using Playwright CLI. Inspect screenshots, responsive layouts, interactions, browser console and network behavior. Not for authoring automated Playwright Test suites or real-stack system E2E.
---

# Frontend Visual Review

A manual browser-based UI review procedure for a frontend application, run
with the repo-local Playwright CLI (`pnpm exec playwright-cli`) against an
isolated development instance of one app in its configured serve/data mode,
in a uniquely named
Playwright CLI session owned by this review alone. The reviewer (human or
agent) drives the browser, inspects screenshots, responsive layouts,
interactions, browser console output and network behavior, then writes a
report.

This skill defines ONLY the review procedure. It introduces no test category,
no Nx target, and no test suite. Manual visual review is a serve-mode
UI-preview activity — not automated regression — per
[`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md)
§10 and [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md)
§1 (the runner does not decide the test category). Command syntax belongs to
the `playwright-cli` skill; this skill references it by name and never
duplicates its command reference.

Canonical documents outrank this skill. Where they disagree, the document wins.

## Canonical references

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) §3/§4 — what is and is not a test category;
  canonical Nx targets `test`, `test-integration`, `system-test`.
- [`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md) §5 — serve modes and data policy
  (mock data / contract mocking / real; the `isPreview` UI banner; fail-closed artifacts).
- [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md) §10 — manual UI preview is not a test.
- [`AGENTS.md`](../../../AGENTS.md) — Local Development Preview stack operations,
  including the URL/port discipline.
- The app's own documentation under `docs/applications/<name>/`, where present,
  plus the app's source for everything the docs do not state.
- `playwright-cli` skill — owner of `playwright-cli` command syntax and
  browser-operation details.

## Objective and exclusions

Three review kinds, never mixed:

1. **Manual visual review (this skill).** A human/agent drives a browser
   against one app served in its configured development serve/data mode;
   evidence is
   screenshots, accessibility snapshots, console and network output, captured
   into a text report. Nothing is committed except the report text.
2. **App-owned browser regression.** Automated Playwright suites owned by one
   app under `apps/<app>/tests/browser/`; integration layer (`06-testing.md`
   §2); wired to the `test-integration` target. The `e2e` target name is
   plugin-derived, not a taxonomy layer (`06-testing.md` §4).
3. **System E2E.** Cross-deploy-unit journeys against the real running stack;
   `system-tests/e2e/`, target `system-test` (`06-testing.md` §3).

Exclusions:

- Never author an automated Playwright Test suite during a manual review.
- Never create an Nx target or test target.
- Never start Docker/Pulumi/the local platform stack unless the app genuinely
  requires real dependencies and the task explicitly authorizes it
  (`AGENTS.md` Local Development Preview governs that path).
- Never fake or reshape API traffic through browser network interception
  during a review (§No network interception in the default workflow).
- Findings observed in mock data prove presentation only — they do not prove
  real-mode behavior ("no fake success," `05-code-architecture.md` §5).

## Preconditions

Complete every item before opening a browser session. A review started on the
wrong serve mode, wrong data mode or a stale server produces a report about
something the task did not ask about.

1. Identify the application, the exact worktree/revision under review, and the
   app's dev server command — read the app's Nx project targets and
   configuration (for example a `serve` target running `nuxt dev`), never from
   assumption.
2. Verify the app actually supports the requested serve/data mode BEFORE
   starting anything: read the app's data-mode resolver and adapter
   implementation. Mode names are per-app; never assume `mock`, `real` or
   `preview` are universal names. Examples in this repository, verified in
   source at the time of writing:
   - `backoffice` — `NITRO_PUBLIC_BACKOFFICE_DATA_MODE` → `prototype`
     (in-app fixtures), `realtime` (real adapter), `disabled` (default);
     any other value fails closed to `unavailable`
     (`apps/backoffice/app/backoffice-data/data-mode.ts`).
   - `account` — `NITRO_PUBLIC_ACCOUNT_DATA_MODE` → `mock` exists ONLY under
     `nuxt dev` (`import.meta.dev`); a built artifact never serves mock, and
     an unconfigured value falls to `real`
     (`apps/account/app/account-data/data-mode.ts`).
3. Determine how fixture/mock data is provided: through the app's own
   data-mode mechanism (resolver plus its mock adapter/fixtures), never by
   inventing data and never by faking responses in the browser (§No network
   interception in the default workflow).
4. Determine how authentication works in the chosen mode. Auth flows are real
   in every data mode — mock data covers the data domain only
   (`05-code-architecture.md` §5) — so a successful preview screen is NOT
   evidence that authentication works. Know how a reviewer obtains a real
   session in this mode before reviewing authenticated routes.
5. Determine how to start the server and how to verify readiness: start it
   with the app's documented command, wait for readiness (boot log or the
   app's readiness endpoint), and take the base URL from the actual
   environment — read `.env` (for example `ROOT_HOST`) or the server output.
   Never guess a dynamic port and never construct a URL from assumptions
   (`AGENTS.md` Local Development Preview). A misconfigured data mode must
   fail the boot or readiness check (fail-closed, `05-code-architecture.md`
   §5) — treat that as a finding, never work around it.
6. Confirm the running server belongs to the intended app and revision —
   check a version marker or route freshness; never review a stale server.
7. Confirm browser session isolation: default in-memory profile; do not reuse
   persistent profiles (`--persistent`/`--profile`) unless explicitly
   required; run `delete-data` between scenarios when needed.
8. Identify the routes and core workflows from the app's actual routes/pages;
   prioritize routes changed by the current task.

## Playwright CLI invocation and named sessions

- Invoke the CLI through the repo-local install:
  `pnpm exec playwright-cli ...`. `@playwright/cli` is a repository
  devDependency; never assume a global `playwright-cli` binary exists, and
  never install one as a side effect of a review.
- Every reviewer and every worktree creates its own uniquely named browser
  session and targets that session on EVERY command with `-s=<unique-name>`.
  Session semantics are owned by the `playwright-cli` skill
  (`references/session-management.md`); the syntax is `-s=<name>` before the
  subcommand. Use a semantic name that cannot collide with another reviewer:

  ```bash
  pnpm exec playwright-cli -s=visual-review-<worktree-or-agent>-<app> open <base-url>
  pnpm exec playwright-cli -s=visual-review-<worktree-or-agent>-<app> snapshot
  ```

- The steps below abbreviate this to `<cmd>`; every real invocation is
  `pnpm exec playwright-cli -s=<your-session> <cmd>`.
- Never share a session across reviewers or subagents. Parallel reviews on
  one machine share one Playwright CLI daemon; two agents driving one session
  destroy each other's state.
- Never close another agent's session, and never run `close-all` or
  `kill-all` in the normal review workflow — they stop every session on the
  machine, including sessions other reviews are still using. Close only the
  session you created: `-s=<your-session> close`.
- Do not leak sessions: when the review ends, close your own session and
  confirm with `list` that only sessions you did not create remain. A headless
  session also shuts itself down after an hour without commands
  (`open --idle-timeout=<ms>` changes that timeout).

## No network interception in the default workflow

During a normal visual review, never fake or reshape API traffic in the
browser:

- Never use browser network interception — `route`, `unroute`, `run-code`
  used for interception, or any equivalent mechanism — to fake API responses.
- Never substitute Playwright network interception for the app-owned data
  adapter: fixture data comes from the app's data mode, or it does not exist.
- Never create HTTP handlers to dodge data integration.
- Never distort real-adapter behavior.

If a separate task genuinely tests interception itself, that is a separate,
explicitly-scoped experiment — not part of this skill's standard procedure.
Development-only mock authoring (in-app mock data adapters, deterministic
fixtures, data-mode and adapter-selection wiring) is owned by the
`frontend-data-mocking` skill and the
app's data-mode seam, not by the review procedure.

## Review procedure

1. Finish §Preconditions. Start the server, verify readiness, and take the
   base URL from the environment (never a guessed port).
2. Open YOUR uniquely named session against the app:
   `pnpm exec playwright-cli -s=<your-session> open <base-url>`. Note the
   data-mode indicator — e.g. a preview-data banner (`isPreview`,
   `05-code-architecture.md` §5) — if the app provides one.
3. Inspect initial state before navigating: run `console` and `requests` on
   your session; record any boot errors.
4. Visit each prioritized route with `goto <url>`.
5. Capture an accessibility snapshot (`snapshot`, `find`) for semantic
   structure and interactive elements.
6. Capture screenshots (`screenshot --filename=...`) into a suitable ignored
   local artifact location.
7. VIEW every screenshot and inspect the actual rendered layout. Never treat
   an accessibility snapshot as a visual screenshot: `find`/`snapshot` prove
   structure; `screenshot` proves appearance. A screenshot is mandatory
   evidence for every visual finding (§Finding classification).
8. Exercise key interactions: primary workflows, focus movement, error and
   empty states reachable from the UI. Handle a native dialog with
   `dialog-accept`/`dialog-dismiss` when one opens.
9. Inspect console (`console`) and network (`requests`, `request <n>`) after
   each route and each interaction; record output for runtime findings.
10. Check representative failure/empty states the app supports; do not invent
    data scenarios the app does not implement.
11. Repeat steps 4–10 for the second viewport (`resize <w> <h>` or
    `open --mobile`) when responsive behavior is in scope.
12. Close ONLY your own session (`-s=<your-session> close`) and write the
    report (§Required report).

## Coverage matrix

| Area          | What to inspect                                                    | Applies when               |
| ------------- | ------------------------------------------------------------------ | -------------------------- |
| Layout        | Grid/flex breaks, alignment, overflow at each viewport             | Any UI                     |
| Hierarchy     | Heading order, landmark structure, reading order                   | Any UI                     |
| Components    | Each component renders its intended controls and content           | Component library in scope |
| States        | Loading, empty, error, success, disabled states per route          | States the app supports    |
| Interactions  | Clicks, form submit, focus trapping, dialogs                       | Interactive flows exist    |
| Responsive    | Desktop plus narrow/mobile viewport (`resize` or `open --mobile`)  | Responsive UI              |
| Accessibility | Semantic structure, labels, visible focus indicators               | Any UI                     |
| Runtime       | Console errors, unhandled rejections                               | Any UI                     |
| Network       | Failed requests/assets; unexpected real backend calls in mock mode | Network activity in scope  |
| i18n          | Locale rendering, text overflow across locales                     | i18n app                   |

State honestly when a row does not apply to the app under review.

## Scenario and route selection

- Inspect actual routes from the application's routes/pages source, not guesses.
- Prioritize routes changed by the current task.
- Include core workflows and critical states (empty, error, success).
- Avoid arbitrary exhaustive crawling.
- Do not assume a route works because the homepage loads.
- Do not invent data scenarios the app does not support.

## Finding classification

Every finding carries: severity, finding type, route, viewport, scenario,
observable behavior, evidence matched to the type (table below), impact.

Severity (one-line criteria):

- `critical`: blocks a core workflow on any viewport.
- `major`: breaks a state, interaction, or required element the user needs.
- `moderate`: visible defect that degrades but does not break the flow.
- `minor`: cosmetic or edge-case issue with no functional impact.

Confidence classes:

- `CONFIRMED`: reproduced or directly observable (screenshot/snapshot +
  console/network output as evidence).
- `PLAUSIBLE`: suggested by inspection but not reproduced — state why not
  confirmed.

### Required evidence by finding type

There is no blanket screenshot mandate: match the evidence to the finding
type.

| Finding type       | Required evidence                   |
| ------------------ | ----------------------------------- |
| Visual defect      | Screenshot + viewport               |
| Runtime error      | Console/error output                |
| Network failure    | Request/response evidence           |
| Interaction defect | Reproduction steps + actual result  |
| Responsive defect  | Viewport + corresponding screenshot |

Two rules hold across every type:

- A visual finding's screenshot is mandatory — no textual description
  substitutes for it.
- An accessibility snapshot is not a screenshot: it proves structure, not
  appearance.

## Required report

The report is returned through the channel the task specifies (Issue or PR
comment, task output). Never commit it to the repository unless the task
explicitly requests a committed report. Use this shape:

```text
## Review Scope
- Application:
- Revision:
- Base URL:
- Data mode: (the app's exact resolved mode — e.g. `prototype`, `mock`, `real`)
- Routes:
- Scenarios:
- Viewports:

## Preconditions and server state
- Dev server command:
- Readiness verification:
- Auth reality in this mode:
- Server state during review:

## Operations performed
- (each route/scenario exercised, in order, per viewport)

## Evidence
- Screenshots:
- Browser snapshots:
- Console:
- Network:

## Findings

### CONFIRMED
- [Severity] [Type] [Route] [Viewport] [Scenario]
  - Observation:
  - Evidence: (matched to the finding type)
  - Impact:

### PLAUSIBLE
- [Severity] [Type] [Route] [Viewport] [Scenario]
  - Observation:
  - Why not confirmed:

## Not verified
- Routes/scenarios not exercised:
- What could not be verified, and why:

## Environment limitations
- (review environment constraints: serve-mode limits, unavailable
  dependencies, port/auth constraints)

## Verdict
- Acceptable / Not acceptable / Inconclusive
- Reason:
```

`Acceptable` means every route listed under Operations performed was actually
exercised, carries the evidence its finding types require, and has no
unremediated critical/major finding; `Not acceptable` means a critical or
major finding stands; `Inconclusive` means coverage is insufficient to judge.

Never state that a route passed when it was not exercised or lacks evidence:
an unexercised route is a Not verified item, never a pass.

## Runtime permissions realism

- The Agent Skills spec supports an optional `allowed-tools` frontmatter
  field, but support differs by runtime. Do not treat it as a portable
  permission mechanism.
- OpenCode recognizes only a specific set of frontmatter fields; a field it
  does not know carries no meaning there. Do not treat unknown frontmatter
  fields as permission enforcement.
- Claude Code applies `allowed-tools` as tool pre-approval when a skill is
  invoked — not as an absolute cap over every tool the session has.
- Actual execution rights are always decided by runtime-level permission
  configuration, not by skill frontmatter.
- Do not describe `allowed-tools` as a sandbox or a uniform security
  boundary, and do not propose editing the vendored `playwright-cli` skill
  for cross-runtime uniformity — it is vendored to stay byte-identical with
  the official skill.

## Review constraints

- The reviewer never edits application code; never silently repairs issues.
- Never create automated test suites during a manual review.
- Never claim coverage for unvisited routes.
- Never fake or reshape API traffic with browser network interception during
  a review (§No network interception in the default workflow).
- Store screenshots only in a suitable ignored local artifact location when
  persistence is necessary; never commit screenshots, browser profiles,
  traces, or session state (`docs/AGENTS.md` §9 artifact lifecycle).
- Session hygiene: create only your own named session, close only your own
  session, and never run `close-all`/`kill-all` in the normal workflow.
- The report is delivered through the task's output channel; never commit it
  unless the task explicitly requests it.
