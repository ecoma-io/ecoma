---
name: frontend-data-mocking
description: Add or maintain a development-only in-app mock data adapter, its deterministic fixtures, or the data-mode and adapter-selection wiring behind UI preview under nuxt dev. The mechanism is substitution of the UI-facing data adapter behind the app's data-mode seam, not HTTP mocking. NOT FOR HTTP API mocking or network interception (MSW and similar), unit-test mocks, Pact mock providers or consumer contract testing, real-stack system E2E, or any production-serving path.
---

# Frontend data mocking

Development-only UI preview by substituting the UI-facing data adapter behind the app's data-mode seam: a mock adapter feeds deterministic fixtures instead of the real adapter's app-owned BFF or real services. This skill governs that in-app adapter substitution — adapters, fixtures, data-mode values, adapter-selection wiring under `nuxt dev`. The mechanism is adapter-based:

```
UI
 |
 v
UI-facing Data Adapter Contract
 |                    |
 v                    v
Mock Adapter       Real Adapter
 |                    |
 v                    v
Deterministic       App-owned BFF
Fixtures            / Real services
```

It is **not** HTTP request mocking, browser interception, or mock-serve bootstrap; those vocabularies belong to a different mechanism (section I).

## A. Objective and boundaries

This skill executes the accepted frontend UI-preview architecture: **in-app mock adapters behind a data-mode seam** ([`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md) §5). Use it when adding or changing a mock data adapter, its fixtures, or the data-mode and adapter-selection wiring for development-only UI preview under `nuxt dev`, and when deciding whether an existing adapter already satisfies the need.

Do not use it for:

- HTTP API mocking or network interception (MSW and similar);
- unit-test mocks (stubs/spies inside one test file);
- Pact mock providers generated from pact files (consumer/provider contract testing);
- integration or system E2E against a real backend;
- any production-serving path.

Boundary table — three mechanisms, never mixed:

| Mechanism                | Role                                                                   | Owned by this skill | Never use for                                           |
| ------------------------ | ---------------------------------------------------------------------- | ------------------- | ------------------------------------------------------- |
| In-app mock data adapter | Substitutes the UI-facing data adapter for UI preview under `nuxt dev` | Yes                 | Production serving; auth/credential flows               |
| Pact mock provider       | Mock provider generated from pact files                                | No                  | Substituting an in-app adapter or serving preview data  |
| Real adapter path        | App-owned BFF or real services; E2E and real-data verification         | No                  | Anything with a mock execution path in a built artifact |

## B. Adapter contract first

Before implementing anything:

1. Identify the owning app and confirm its Nx project and targets (`pnpm nx show project <name> --json`).
2. Read the app's instructions and contracts: `apps/AGENTS.md`, the app's own `AGENTS.md` if one exists, `docs/applications/<name>/`, API/BFF contracts.
3. Read the **adapter contract** (the TypeScript interface/types the UI consumes), then the existing mock adapter, real adapter, factory/composable and data-mode resolver — including their unit tests (`data-mode.spec.ts`, `mock-adapter.spec.ts`, `adapter.spec.ts` encode the seam's invariants).
4. Classify every data load as browser-originated or Nitro-server-originated; server-side loading in mock mode is an unsupported path (section I).
5. Decide reuse versus replacement against the accepted seam: extend an existing adapter where one exists; never invent a parallel mock mechanism. If the existing adapter already satisfies the need, add no new abstraction.
6. Derive response schemas and status semantics from the real API/BFF contracts (context only — section E); never guess endpoint names or response shapes.
7. Confirm mock mode resolves only under `nuxt dev` and that a built artifact can never contain a mock execution path (fail-closed — section H).

## Canonical references

Canonical documents outrank this skill; where they disagree, the document wins.

- [`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md) §5 — serve-mode data policy: mock data (UI preview) = "mock adapter in-app", only under `nuxt dev`; artifact build must not contain a mock path (fail-closed: mock ⇒ boot fail / readiness 503); auth flows always real; honesty banner via `isPreview`; mode naming `NITRO_PUBLIC_<APP>_DATA_MODE` / `runtimeConfig.public.<app>DataMode`, fail-closed to `unavailable`; never name a mode `preview`.
- [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md) §10 — serve-mode UI preview runs on a dev workstation only; not a CI gate, not a test.
- [`docs/domains/staff-access/adr/0011-authn-boundary-and-unauthenticated-response.md`](../../../docs/domains/staff-access/adr/0011-authn-boundary-and-unauthenticated-response.md) — `503` means retry with backoff, never fall back to sample data; invariant "UI does not simulate backend"; only the exact string `'prototype'` opens mock, everything else resolves to `unavailable`.
- [`docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md`](../../../docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md) — the prototype fixture is illustrative, not authoritative; prototype IDs are not seeded.
- [`docs/architecture/01-architecture.md`](../../../docs/architecture/01-architecture.md) A23 — authorization is deny-by-default enforced at the backend; UI visibility is not authorization.
- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — mock is not a test layer; the mock data adapter behind serve-mode UI preview is dev tooling, not `test` / `test-integration` / `system-test`.
- [`AGENTS.md`](../../../AGENTS.md) — language rules (SKILL.md is English), non-negotiable architecture, change discipline, pull requests.

## C. Target architecture versus current implementation

Canonical target (accepted):

- UI preview uses the mock adapter, only under `nuxt dev`.
- Built artifacts contain no mock execution path — fail-closed: an artifact configured for mock means boot fail / readiness 503, never serving fixtures.
- Auth flows are always real.
- Mixed real/mock state shows the honesty banner via `isPreview`; mode names are never `preview`.

Current implementation (observed in source; deviations are current behavior, not accepted design — do not treat them as licence or as a pattern to copy):

- Account app (`apps/account/`): `app/composables/use-account-adapter.ts` statically imports `createMockAccountAdapter`; the mock adapter implements credential methods (`verifyLoginCode`, consent handling); the real adapter factory spreads the mock adapter then overrides some methods, so credential paths can pass through mock implementations.
- Backoffice app (`apps/backoffice/`): data modes are `prototype` / `realtime` / `disabled`, fail-closed to `unavailable`; the prototype adapter is dynamic-imported via `import()` in the `'prototype'` branch only; the real adapter calls app-owned BFF endpoints.
- Mode strings are per-app (`mock` plus `nuxt dev` for the account data domain; `prototype` for backoffice; resolved fail-closed to `unavailable`): never normalize or rename an app's data-mode values, never assume a universal mode name, and never assume every app supports the same serve modes.

Do not "align" one app's resolver to the other; read each app's own resolver. Any change to the deviations above needs its own accepted decision.

## D. Fixture design

- Deterministic fixtures only: stable IDs, fixed ISO timestamps, no randomness, no uncontrolled `Date.now()`. Derive runtime-created IDs from a deterministic counter; keep one fixed clock constant for all timestamps so SSR and client render identically.
- ADR-0010: fixtures are illustrative, not authoritative; prototype IDs are not seeded; fixture data is not a seed, a catalog, or a data definition anyone may copy into migrations or contracts.
- Contract fidelity: honor the adapter's input/output types, Promise/Result semantics and existing error shapes; preserve unsupported behavior rather than inventing fake fallbacks; a mock result must mean what the real result means.
- Scenarios (default / empty / error / forbidden / unauthenticated / expired / validation-error / large) are examples when they materially improve reviewability — not mandatory per adapter method.
- No hidden business logic duplicated in the adapter — the mock mirrors the contract, it does not reimplement the backend.

## E. BFF/API contracts are context only

The real API/BFF contracts are read to understand semantics so fixture data is plausible and correctly shaped. They are not the place where HTTP mock handlers get implemented under this skill.

## F. State and lifecycle

- Init order: data-mode resolver first, adapter selection second, mock ready third; the app must not render data before the mock is ready, and never show partial mock state.
- Adapter selection happens at exactly one factory point in the app; do not add a second place that picks an implementation.
- Wait for readiness only when adapter creation is actually asynchronous (for example a dynamic `import()`); do not mandate async adapter initialization.
- Mutations are ephemeral and in-memory only; reload resets to the initial fixtures.
- Reset semantics must be explicit: what a reload discards, what persists (nothing in mock mode).
- Nothing in the mock may reach a real backend: no `fetch` or `useFetch` to real endpoints, no cookie, storage, or credential access.
- SSR safety: avoid module-global mutable state shared across SSR requests; create the adapter per SSR request (for example on `nuxtApp`) rather than at module scope.

## G. Authentication and security

- Mock never expands into authentication/credential flows: no synthetic auth, no fake JWTs, no fake cookies; auth flows (login challenge/verify/handoff, consent) stay on the real BFF path in every mode.
- A UI preview on mock data is never evidence of authentication, authorization, or security correctness (A23, ADR-0011); authorization is deny-by-default enforced at the backend; UI visibility is not authorization.
- Do not read `401` as permission denial or `403` as an auth error (ADR-0011): `401` redirects to login/re-auth, `403` means the authenticated caller lacks the resource right.
- A failing real adapter must never fall back to the mock adapter: `503` means retry with backoff, and the mock opens only via the exact configured string, never as an error fallback (ADR-0011).

## H. Production safety (artifact verification without prescribing technique)

- The mock path must be absent from built artifacts — fail-closed: selecting mock in an artifact means boot fail / readiness 503, not silent fallback.
- Do not mandate dynamic `import()`: its lazy chunk can still ship in the artifact, and it is not proof mock code is absent from production. Do not mandate async adapter initialization; wait for readiness only when the implementation is actually asynchronous.
- Require verification of actual results: inspect the **whole** production build output (not just the entry bundle), trace all reachable mock execution paths, determine whether mock modules are emitted in the artifact, and verify fail-closed behavior when an artifact is configured for mock.
- Mock initialization is dev-only (`nuxt dev`); nothing gates on query params, cookies, headers, localStorage, or hostname.
- The exact enabled string is per-app and must match byte-for-byte: only `'prototype'` opens backoffice mock; only `'mock'` plus `nuxt dev` opens the account data domain (ADR-0011). The fail-closed bottom differs per app today: backoffice resolves everything else to `unavailable`; the account data domain falls to `real` and a server-side gate returns 503 (`data_mode_mock_in_artifact`) when an artifact is configured `mock`. Read the app's own resolver; do not assume one rule fits both.
- Mixed mode (part real, part mock) requires the honesty banner via `isPreview`; the banner states status, it never hides it.
- PWA service-worker interplay (`@vite-pwa/nuxt` is an active module of the backoffice app) must be considered explicitly and reported, not assumed.

## I. Network interception (MSW) — not an accepted mechanism

Browser-level interception (for example MSW) has **no baseline status**: it is neither accepted nor proposed for this architecture, and this skill does not instruct agents to adopt it or to replace the accepted in-app mock adapters with it. Adopting it requires a separate, accepted ADR-level decision first; never present it as accepted, default, or equivalent to the in-app mock data adapter.

SSR fact: a browser Service Worker does not intercept requests executed directly by the Nitro server (server-side fetches). If an app loads data server-side in mock mode, the unsupported path must be reported, not papered over. Do not disable SSR to accommodate a browser interceptor, and do not introduce `msw/node` or any second server-side mechanism without an accepted decision.

## J. Required workflow

1. Inspect the baseline: existing adapter contract, mock adapter, real adapter, factory/composable, data-mode resolver, and their unit tests of the owning app.
2. Make the reuse-or-replace decision against the accepted seam; extend an existing adapter where one exists.
3. Identify the real API/BFF contracts each adapter method mirrors (context for shape and semantics only).
4. Classify browser-originated versus Nitro-server-originated data loads.
5. Design deterministic fixtures (fixed IDs and timestamps, no randomness).
6. Verify startup under `nuxt dev`: the app boots, the mock answers, and `isPreview` is set.
7. Verify fail-closed behavior: unhandled paths fail, no silent sample data, real adapter never falls back to mock on failure.
8. Verify production artifact safety per section H: build the artifact, inspect the whole build output, trace reachable mock execution paths, confirm whether mock modules are emitted, and confirm configuring mock there fails boot or readiness 503 rather than serving fixtures.
9. Report coverage and limitations.

**Output contract** (state in the PR or issue comment): app and data mode; adapter methods covered; fixtures included; browser/server request boundary; fail-closed behavior; production-safety evidence (fail-closed gate, whole-build artifact check); commands actually run with results; unsupported paths and remaining gaps.
