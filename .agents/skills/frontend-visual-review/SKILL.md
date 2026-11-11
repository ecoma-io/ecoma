---
name: frontend-visual-review
description: Manually review frontend UI in an isolated development/mock-serve environment using Playwright CLI. Inspect screenshots, responsive layouts, interactions, browser console and network behavior. Not for authoring automated Playwright Test suites or real-stack system E2E.
---

# Frontend Visual Review

A manual browser-based UI review procedure for a frontend application,
run with Playwright CLI (`playwright-cli`) against an isolated
development/mock-serve instance of one app. The reviewer (human or agent)
drives the browser, inspects screenshots, responsive layouts, interactions,
browser console output and network behavior, then writes a report.

This skill defines ONLY the review procedure. It introduces no test category,
no Nx target, and no test suite. Manual visual review is a serve-mode UI-preview
activity — not automated regression — per [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md)
§10 and [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) §1 (the runner does not decide
the test category). Command syntax belongs to the `playwright-cli` skill;
this skill references it by name and never duplicates its command reference.

Canonical documents outrank this skill. Where they disagree, the document wins.

## Canonical references

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) §3/§4 — what is and is not a test category;
  canonical Nx targets `test`, `test-integration`, `system-test`.
- [`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md) §5 — serve modes and data policy
  (mock data / contract mocking / real; the `isPreview` UI banner; fail-closed artifacts).
- [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md) §10 — manual UI preview is not a test.
- [`AGENTS.md`](../../../AGENTS.md) — Local Development Preview stack operations.
- `playwright-cli` skill — owner of `playwright-cli` command syntax and browser-operation details.

## Objective and exclusions

Three review kinds, never mixed:

1. **Manual visual review (this skill).** A human/agent drives a browser
   against one app served in development or mock-serve mode; evidence is
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
- Findings observed in mock data prove presentation only — they do not prove
  real-mode behavior ("no fake success," `05-code-architecture.md` §5).

## Preconditions

1. Identify the application and the exact worktree/revision under review.
2. Confirm the serve mode is available, its base URL, and its data mode
   (mock / real). Read the app's deployment configuration before reviewing;
   mock data (UI preview) runs only under `nuxt dev` with the mock adapter
   in-app and real auth flows; real mode is the default for built artifacts
   (`05-code-architecture.md` §5).
3. Confirm the running server belongs to the intended app and revision —
   check a version marker or route freshness; never review a stale server.
4. Confirm browser session isolation: default in-memory profile; do not reuse
   persistent profiles (`--persistent`/`--profile`) unless explicitly
   required; run `playwright-cli delete-data` between scenarios when needed.
5. Identify the routes and core workflows from the app's actual routes/pages;
   prioritize routes changed by the current task.
6. Confirm the app actually supports the requested data mode — do not claim an
   app is mock-ready when its runtime does not support the mode (an artifact
   choosing mock must fail to boot, `05-code-architecture.md` §5).

## Review procedure

1. Open the app in an isolated browser session:
   `playwright-cli open <base-url>`. Note the data-mode indicator — e.g. a
   preview-data banner (`isPreview`, `05-code-architecture.md` §5) — if the
   app provides one.
2. Inspect initial state before navigating: run `playwright-cli console`
   and `playwright-cli requests`; record any boot errors.
3. Visit each prioritized route with `playwright-cli goto <url>`.
4. Capture an accessibility snapshot (`playwright-cli snapshot`, `find`) for
   semantic structure and interactive elements.
5. Capture screenshots (`playwright-cli screenshot --filename ...`, use
   `--full-page` for scroll-dependent layouts).
6. VIEW every screenshot and inspect the actual rendered layout. Never treat
   an accessibility snapshot as a visual screenshot: `find`/`snapshot` prove
   structure; `screenshot` proves appearance. Screenshots are mandatory
   evidence for every visual finding.
7. Exercise key interactions: primary workflows, focus movement, error and
   empty states reachable from the UI.
8. Inspect console (`playwright-cli console`) and network
   (`playwright-cli requests`, `playwright-cli request <n>`) after each route
   and each interaction; record output for runtime findings.
9. Check representative failure/empty states the app supports; do not invent
   data scenarios the app does not implement.
10. Repeat steps 3–9 for the second viewport (`playwright-cli resize <w> <h>`
    or `open --mobile`) when responsive behavior is in scope.
11. Close the session (`playwright-cli close`, or
    `playwright-cli close-all` if any sessions leaked) and write the report
    (§Required report).

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

Every finding carries: severity, route, viewport, scenario, observable
behavior, screenshot/evidence, impact.

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

## Required report

Use this exact shape:

```text
## Review Scope
- Application:
- Revision:
- Base URL:
- Data mode:
- Routes:
- Scenarios:
- Viewports:

## Evidence
- Screenshots:
- Browser snapshots:
- Console:
- Network:

## Findings

### CONFIRMED
- [Severity] [Route] [Viewport] [Scenario]
  - Observation:
  - Evidence:
  - Impact:

### PLAUSIBLE
- [Severity] [Route] [Viewport] [Scenario]
  - Observation:
  - Why not confirmed:

## Coverage Gaps
- Routes not inspected:
- Scenarios not inspected:
- Known limitations:

## Verdict
- Acceptable / Not acceptable / Inconclusive
- Reason:
```

`Acceptable` means every inspected route passed its scenario with no
unremediated critical/major finding; `Not acceptable` means a critical or
major finding stands; `Inconclusive` means coverage is insufficient to judge.

## Review constraints

- The reviewer never edits application code; never silently repairs issues.
- Never create automated test suites during a manual review.
- Never claim coverage for unvisited routes.
- Store screenshots only in a suitable ignored local artifact location when
  persistence is necessary; never commit screenshots, browser profiles,
  traces, or session state (`docs/AGENTS.md` §9 artifact lifecycle).
- No persistent Playwright CLI sessions unless the task requires them; always
  clean up browser sessions (`playwright-cli close` / `close-all`).
