# Remote Cache — Applications

Self-hosted remote cache cho Nx: tái sử dụng kết quả task để rút ngắn build/CI. Đây là **disposable build state** — mất cache thì task chạy lại được, không mất correctness.

**Bounded context:** nghiệp vụ multi-tenant của service này thuộc bounded context `remote-cache` — xác lập bằng [ADR-0015](../../domains/remote-cache/adr/0015-remote-cache-bounded-context.md) (storage `db-remote-cache`, ranh giới tenant với `pact-broker`, entitlement Staff Access deferred). Thư mục này giữ **thiết kế của deploy unit** (boundary kỹ thuật, protocol, streaming, storage partitioning, requirements, runbook); ranh giới nghiệp vụ và quyết định ownership → [`docs/domains/remote-cache/`](../../domains/remote-cache/README.md).

- Phục vụ đúng Nx remote cache protocol (`GET`/`PUT /v1/cache/{hash}`) với Bearer API key project-scoped.
- Stream immutable cache artifact tới object storage durable (S3-compatible; MVP: Backblaze B2).
- **Hai composition**: API composition (`apps/remote-cache-api`) và admin UI composition (`apps/remote-cache-app` — Nuxt non-SSR SPA shell, truy cập control plane qua private service binding theo R10; giai đoạn scaffold chỉ có app shell, chưa có dashboard/authentication/BFF).
- Không phải source of truth, không phải serving dependency của application nào (A18, invariant 22 — [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md)).

## Documents

- [01-architecture.md](./01-architecture.md) — boundary, request flow, storage partitioning, invariants.
- [02-requirements.md](./02-requirements.md) — FR/NFR, non-goals, acceptance criteria.
- [03-operations.md](./03-operations.md) — configuration, CI, verification, runbook.
- Bounded context `remote-cache` (ownership, tenant boundary, ADR) → [`docs/domains/remote-cache/`](../../domains/remote-cache/README.md).
