# Remote Cache — Applications

Self-hosted remote cache cho Nx: tái sử dụng kết quả task để rút ngắn build/CI. Đây là **disposable build state** — mất cache thì task chạy lại được, không mất correctness.

**Bounded context:** nghiệp vụ multi-tenant của service này thuộc bounded context `remote-cache` — xác lập bằng [ADR-0015](../../domains/remote-cache/adr/0015-remote-cache-bounded-context.md) (storage `db-remote-cache`, ranh giới tenant với `pact-broker`, entitlement Staff Access deferred). Thư mục này giữ **thiết kế của deploy unit** (boundary kỹ thuật, protocol, streaming, storage partitioning, requirements, runbook); ranh giới nghiệp vụ và quyết định ownership → [`docs/domains/remote-cache/`](../../domains/remote-cache/README.md).

- Phục vụ đúng Nx remote cache protocol (`GET`/`PUT /v1/cache/{hash}`) với Bearer API key project-scoped.
- Stream immutable cache artifact tới object storage durable (S3-compatible; MVP: Backblaze B2).
- **Hai composition**: API composition (`apps/remote-cache-api`) và portal composition (`apps/remote-cache-app` — Internal Developer Portal cho developer Ecoma, quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177): Nuxt non-SSR SPA + BFF, xác thực qua Ecoma Account, truy cập control plane qua private service binding theo R10/R22; thiết kế ở [01-architecture.md](./01-architecture.md) §12, hiện thực qua [#202](https://github.com/ecoma-io/ecoma/issues/202) + [#180](https://github.com/ecoma-io/ecoma/issues/180)).
- Không phải source of truth, không phải serving dependency của application nào (A18, invariant 22 — [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md)).

## Documents

- [01-architecture.md](./01-architecture.md) — boundary, request flow, storage partitioning, invariants.
- [02-requirements.md](./02-requirements.md) — FR/NFR, non-goals, acceptance criteria.
- [03-operations.md](./03-operations.md) — configuration, CI, verification, runbook.
- Bounded context `remote-cache` (ownership, tenant boundary, ADR) → [`docs/domains/remote-cache/`](../../domains/remote-cache/README.md).
