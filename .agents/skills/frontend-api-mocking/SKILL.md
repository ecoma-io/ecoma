---
name: frontend-api-mocking
description: Add or maintain development-only frontend API mocking, browser interception handlers, deterministic fixtures, mock scenarios, or mock-serve bootstrap. Use only for the accepted frontend UI-preview architecture; not for unit-test mocks, Pact contract tests, or real-stack system E2E.
---

# Frontend API mocking

Dev-only UI preview only: in-app mock adapters behind the data-mode seam, deterministic fixtures, mock
scenarios, mock-serve bootstrap under `nuxt dev`. Not for unit-test mocks, Pact mock providers, or
real-stack tests.

## A. Objective and boundaries

This skill executes the **accepted** frontend UI-preview architecture: **in-app mock adapters behind a
data-mode seam** (`docs/architecture/05-code-architecture.md` §5). Use it when adding or changing a mock
adapter, its fixtures, scenario flags, or the bootstrap that selects the adapter under `nuxt dev`.

Do not use it for:

- unit-test mocks (stubs/spies inside a test file);
- Pact mock providers for consumer contract tests;
- integration or system E2E against a real backend;
- any production-serving path.

Exclusions, distinguished:

| Mechanism              | What it is                                                     | Owned by this skill | Never use for                             |
| ---------------------- | -------------------------------------------------------------- | ------------------- | ----------------------------------------- |
| Development mock-serve | In-app mock adapter behind the data-mode seam, `nuxt dev` only | Yes                 | Production serving                        |
| Unit-test mock         | Stub/spy inside one test file                                  | No                  | UI-preview architecture                   |
| Pact mock provider     | Mock provider generated from pact files                        | No                  | Hand-stubbing each call                   |
| Real backend           | Integration/system E2E                                         | No                  | Anything with a mock path in the artifact |

Inspect first, before any handler is written:

1. App identity (which Nx deploy unit owns the UI).
2. `apps/AGENTS.md`, plus the app's own `AGENTS.md` if one exists, and `docs/applications/<name>/`.
3. The app's data-mode and adapter files (for example `apps/backoffice/app/backoffice-data/data-mode.ts`,
   `adapter.ts`, `mock-adapter.ts`; `apps/account/app/account-data/` equivalents), including their unit
   tests — `data-mode.spec.ts`, `mock-adapter.spec.ts`, `adapter.spec.ts` encode the seam's invariants.
4. The real API/BFF contracts the mock must mirror.
5. Whether each data load originates in the browser or in the Nitro server — server-side loading in mock
   mode is an unsupported path (see section G).
6. The app's own fail-closed bottom state; the two apps differ today (see section F).

## Canonical references

Canonical documents outrank this skill; where they disagree, the document wins.

- [`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md) §5 —
  serve-mode data policy: mock data (UI preview) = "mock adapter in-app", only under `nuxt dev`; artifact
  build must not contain a mock path (fail-closed: mock ⇒ boot fail / readiness 503); auth flows always
  real; honesty banner via `isPreview`; mode naming `NITRO_PUBLIC_<APP>_DATA_MODE` /
  `runtimeConfig.public.<app>DataMode`, fail-closed to `unavailable`; never name a mode `preview`.
- [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md) §10 — serve-mode UI
  preview runs on a dev workstation only; not a CI gate, not a test.
- [`docs/domains/staff-access/adr/0011-authn-boundary-and-unauthenticated-response.md`](../../../docs/domains/staff-access/adr/0011-authn-boundary-and-unauthenticated-response.md)
  — `503` means retry with backoff, never fall back to sample data; invariant "UI does not simulate
  backend"; only the exact string `'prototype'` opens mock, everything else resolves to `unavailable`.
- [`docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md`](../../../docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md)
  — the prototype fixture is illustrative, not authoritative; prototype IDs are not seeded.
- [`docs/architecture/01-architecture.md`](../../../docs/architecture/01-architecture.md) A23 —
  authorization is deny-by-default enforced at the backend; UI visibility is not authorization.
- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — mock is not a test
  layer; mock-serve is dev tooling, not `test` / `test-integration` / `system-test`.
- [`AGENTS.md`](../../../AGENTS.md) — language rules (this skill is English), non-negotiable architecture,
  change discipline, pull requests.

## B. Required preflight

1. Identify the owning app and confirm its Nx project and targets (`pnpm nx show project <name> --json`).
2. Read the app's instructions and contracts: `apps/AGENTS.md`, app `AGENTS.md` if present,
   `docs/applications/<name>/`, API/BFF contracts.
3. Read the existing data-mode implementation and adapter selection (mock adapter, real adapter,
   unavailable adapter).
4. Make the reuse-or-replace decision against the accepted seam: extend an existing adapter where one
   exists; do not invent a parallel mock mechanism. Fixtures live as siblings of the adapter in the app's
   data directory.
5. Never create handlers or fixtures by guessing endpoint names or response schemas — derive both from the
   app's real API/BFF contracts.
6. Classify every data load as browser-originated or Nitro-server-originated.
7. Confirm mock mode resolves only under `nuxt dev` and that a built artifact can never contain a mock path
   (fail-closed).

## C. Handler and fixture design

- Match method and URL exactly to the real contract; never loosen matching to "help" the UI.
- Validate requests consistently with the real API (required fields, enum values, id formats).
- Keep response schemas and status semantics consistent with the contract; a mock `200` must mean what the
  real `200` means, and error scenarios must use the statuses the real contract emits, not invented ones.
- Handle query and pagination explicitly where the contract has them; do not return the whole collection
  when the contract pages.
- Deterministic fixtures only: stable IDs, fixed ISO timestamps, no random business data, no uncontrolled
  `Date.now()`.
- Derive runtime-created IDs from a deterministic counter, not `crypto.randomUUID()`; keep one fixed clock
  constant for all timestamps so SSR and client render identically.
- No hidden business logic duplicated in handlers — the mock mirrors the contract, it does not reimplement
  the backend.
- Scenarios (default / empty / error / forbidden / unauthenticated / expired / validation-error / large)
  are examples when they materially improve reviewability — not mandatory per endpoint.
- ADR-0010: fixtures are illustrative, not authoritative, and prototype IDs are not seeded; fixture data is
  not a seed, a catalog, or a data definition anyone may copy into migrations or contracts.

## D. State and lifecycle

- Init order: data-mode resolver first, adapter selection second, mock ready third; the app must not render
  data before the mock is ready, and never show partial mock state.
- Adapter selection happens at exactly one factory point in the app; do not add a second place that picks an
  implementation.
- Make the app wait for mock readiness explicitly: keep one pending load for the mock module and resolve it
  before the first read — reloading the module per read would create fresh adapter instances and
  non-deterministic state.
- Mutations are ephemeral and in-memory only; reload resets to the initial fixtures.
- Reset semantics must be explicit: what a reload discards, what persists (nothing in mock mode).
- Nothing in the mock may reach a real backend: no `fetch` or `useFetch` to real endpoints, no cookie,
  storage, or credential access.

## E. Authentication and security

- Auth flows are always real ("auth flows luôn thật"): no synthetic auth, no fake JWTs, no fake cookies.
- The data-mode flag's scope is the data domain only: auth operations (login challenge/verify/handoff/
  consent, login and consent UI) stay on the real BFF path in every mode.
- Do not read `401` as permission denial or `403` as an auth error (ADR-0011); `401` redirects to login/
  re-auth, `403` means the authenticated caller lacks the resource right.
- A UI preview success is not evidence of authentication, authorization, or security correctness (A23):
  authorization is deny-by-default enforced at the backend; UI visibility is not authorization.
- A failing real adapter must never fall back to the mock adapter: `503` means retry with backoff, and the
  mock opens only via the exact configured string, never as an error fallback (ADR-0011).

## F. Production safety (accepted architecture)

- The mock path must be absent from built artifacts — fail-closed: selecting mock in an artifact means boot
  fail / readiness 503, not silent fallback.
- Mock initialization is dev-only (`nuxt dev`); nothing gates on query params, cookies, headers,
  localStorage, or hostname.
- Load the mock adapter with dynamic `import()` from the single adapter-selection point so the fixture stays
  out of every other environment's bundle — this is the mechanism the backoffice adapter uses today.
- The exact enabled string is per-app and must match byte-for-byte: only `'prototype'` opens backoffice
  mock; only `'mock'` plus `nuxt dev` opens the account data domain (ADR-0011).
- The fail-closed bottom differs per app today: backoffice resolves everything else to `unavailable`; the
  account data domain falls to `real` and a server-side gate returns 503 (`data_mode_mock_in_artifact`) when
  an artifact is configured `mock`. Read the app's own resolver; do not assume one rule fits both, and do
  not "align" one app's resolver to the other.
- Mixed mode (part real, part mock) requires the honesty banner via `isPreview`; the banner states status,
  it never hides it.
- PWA service-worker interplay (`@vite-pwa/nuxt` is an active module of the backoffice app) must be
  considered explicitly and reported, not assumed.

## G. Browser interception (MSW) — conditional, not accepted

Browser-level interception (for example MSW) has **no baseline status**: grep across all of `docs/` finds
zero mentions of MSW / Mock Service Worker / mock-serve, so it is neither accepted nor proposed. This skill
does **not** instruct agents to adopt MSW or to replace the accepted in-app mock adapters with it.

Adopting browser interception requires a separate, accepted ADR-level decision first. Until then, this
section is requirements-ready only:

- It may intercept only frontend-originated requests to the app-owned API/BFF boundary — never DB traffic
  or service bindings.
- Fail-closed unhandled-request policy for business APIs: an unhandled business request must fail, never
  silently return sample data; static assets, HMR, and WebSocket traffic are explicitly classified and
  excluded from interception.
- No blanket bypass; production-asset exclusion so the interceptor ships only in dev.
- Research the current official MSW API (`https://mswjs.io/api/setup-worker/start`) rather than relying on
  remembered option names, if it is ever implemented.

SSR fact: a browser Service Worker does not intercept requests executed directly by the Nitro server
(server-side fetches). If an app loads data server-side in mock mode, the unsupported path must be reported,
not papered over. Do not disable SSR to accommodate a browser interceptor, and do not introduce `msw/node`
or any second server-side mechanism without an accepted decision.

## H. Required workflow

1. Inspect the baseline: existing data-mode, adapters, fixtures, and contracts of the owning app.
2. Identify the real API/BFF contracts each handler will mirror.
3. Classify browser-originated versus Nitro-server-originated requests.
4. Design handler coverage: endpoints, methods, statuses, query/pagination handling.
5. Create deterministic fixtures (fixed IDs and timestamps, no randomness).
6. Verify startup and interception: the app boots in `nuxt dev`, the mock answers, and `isPreview` is set.
7. Verify unhandled business requests fail closed (no silent sample data).
8. Verify no unexpected request reaches a real backend from mock mode.
9. Verify production artifact safety: build the artifact and confirm the fixture is not embedded in the
   entry bundle, and that configuring mock there fails boot or readiness 503 rather than serving fixtures.
10. Report coverage and limitations.

**Output contract** (state in the PR or issue comment): app and data mode; endpoints/methods covered;
scenarios included; browser/server request boundary; unhandled-request behavior; production-safety evidence
(fail-closed gate, artifact check); commands actually run with results; unsupported paths and remaining gaps.
