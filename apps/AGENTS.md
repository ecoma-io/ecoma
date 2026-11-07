# Application Instructions

- `apps/` holds only runtime, composition and deploy projects — each directory is an independent Nx deploy unit (web app, Worker service, infrastructure app). It is not a place for arbitrary project types; contract projects live with their bounded context (`libs/<bc>-contracts` — see `docs/architecture/05-code-architecture.md`).
- An app is a composition root: wire the libraries its bounded contexts need; keep business logic in `libs/`.
- Preserve the project's Nx `scope`, `type`, and `runtime` boundaries. Apps are `type:composition`: they compose `domain`/`application`/`infrastructure`/`contracts` libraries, never `type:tooling` ones. Do not bypass module-boundary rules to access another domain.
- A project must access another project's data only through its defined API, event contract, or other explicitly documented interface; never access another service's database directly.
- Keep deploy units independently buildable, testable, releasable, and deployable.
- Do not introduce shared mutable state or node-local state that violates the architecture's recovery/topology requirements.
- Runtime-specific code must respect its Nx `runtime` boundary; do not introduce Node-only dependencies into `runtime:edge` projects.
- Follow the project's local `AGENTS.md` when present; it overrides these rules for that subtree.
- Canonical reference: [`docs/architecture/05-code-architecture.md`](../docs/architecture/05-code-architecture.md) for code architecture and [`docs/architecture/06-testing.md`](../docs/architecture/06-testing.md) for testing architecture (test placement, categories, Nx test targets).
