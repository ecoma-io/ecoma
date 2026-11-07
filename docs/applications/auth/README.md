# Auth (ứng dụng)

`auth` là deploy unit của authorization server OAuth 2.0 / OpenID Connect: Cloudflare Worker API-only (Hono) phục vụ bounded context `auth`. Nó không có UI và không render login/consent — mọi tương tác với trình duyệt đi qua redirect, mọi tương tác với `account` đi qua back-channel có envelope HMAC.

```text
auth.ecoma.io  (Cloudflare Worker · API-only · Hono)
   ├── Hyperdrive → db-auth   (client · transaction · consent · grant · code · token · revocation · audit)
   └── Service Binding → account   (auth là CONSUMER: hỏi trạng thái account lúc phát hành — GET /internal/account/status)
```

Ranh giới context tại system level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2.1 · rule Nx theo scope của từng app → [`docs/architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md) §6.3 · mô hình miền → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md).

## Hiện trạng

Endpoint protocol và glue internal đã có trong code (`apps/auth`), 14 migration của `db-auth` nằm ở `apps/auth/migrations/` (`0001`…`0014`); **không database nào được provision** và Worker chưa khai environment staging/production. `oidc-provider` 9.12.2 chạy qua bridge `cloudflare:node` (`nodejs_compat` chỉ khai cho bridge, code ứng dụng giữ `runtime:edge`). Private key là Worker Secret `AUTH_SIGNING_KEY` (PKCS#8 PEM), **không** lưu trong `db-auth`; `db-auth` chỉ giữ metadata của key. `/authorize/complete` mới là route trong thiết kế — chưa mount (404 được ghim bằng test tại `apps/auth/src/main.spec.ts`).

## Documents

| Document                                     | Nội dung                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md) | Runtime, `db-auth` schema, giao thức login/consent (bốn contract back-channel, state machine, handle X/Y/Z), envelope nội bộ, token/revocation mechanics, observability, invariants |
| [`02-requirements.md`](./02-requirements.md) | Yêu cầu đặc thù ứng dụng: FR/NFR/SR/CR, threat model, acceptance matrix, privacy, non-goals, mục tiêu đề xuất                                                                       |
| [`03-operations.md`](./03-operations.md)     | Triển khai, role & migration, secret/key rotation, prune nonce, monitoring, alerting, failure modes, restore, runbook                                                               |

Mô hình miền, quyết định chính sách OAuth/OIDC và invariant nghiệp vụ → [`docs/domains/auth/`](../../domains/auth/README.md). Thiết kế của cron Worker dọn nonce → [`../auth-nonce-prune-job/`](../auth-nonce-prune-job/README.md).
