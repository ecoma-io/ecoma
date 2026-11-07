# llm-console — 03 Operations

> Vận hành deploy unit `llm-console`. Business behavior của bounded context → canonical ở các `docs/domains/*/domain-model.md`. System-level operations → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md).

## Deployment

- Deploy unit: Cloudflare Worker (Nuxt 4 + Nitro `cloudflare_module`); deploy qua Nx/CI theo `02-delivery.md`.
- Non-SSR SPA: build static assets + Worker bundle; rollout Worker version độc lập (A16/A18).
- Rollback = rollback Worker version đã publish, không rollback database (không sở hữu DB).
- Preview/staging dưới `ecoma.io.vn` theo A13; production không qua Router.

## Configuration

| Binding/Secret/Vars                     | Loại            | Ghi chú                                                                                                                                            |
| --------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Downstream base URLs / Service Bindings | binding/var     | `llm-api` (gồm module `llm-consumer-tenant`, `llm-consumer-routing`), `llm-financial`, `payment`, `llm-usage`, `staff-access`, `push-notification` |
| OIDC issuer / client                    | var/secret      | `auth.ecoma.io` endpoint; client secret native Worker Secret                                                                                       |
| Session cookie domain/secret            | secret          | ký/verify session; native Worker Secret                                                                                                            |
| Shell preferences cookie                | cookie (client) | client-side, không authority                                                                                                                       |
| CSP nonce key                           | secret/var      | strict CSP                                                                                                                                         |

- Secrets không vào PR/CI file; dùng native Worker Secrets theo môi trường.
- Thiếu config → fail-closed 503 trên route cần config.

## Monitoring

- `GET /health` không chạm downstream (liveness).
- `GET /ready` kiểm config + downstream readiness.
- Theo dõi error rate per downstream, latency p95, session/auth failure.
- Observability không là serving-path dependency; không log prompt/response body hoặc sensitive payload.

## Failure handling

| Tình huống                     | Hành động                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Downstream unavailable         | BFF trả error chuẩn; UI hiển thị trạng thái unavailable; không retry không idempotent |
| Thiếu config/binding           | Fail-closed 503; provision rồi deploy lại                                             |
| Session/token hết hạn          | Redirect login; không retry ngầm                                                      |
| API key create fail giữa chừng | Idempotent retry với idempotency key; không partial state ở client                    |
| Top-up initiation fail         | Retry idempotent; không double-charge                                                 |
| XSS/CSP violation              | Block request; audit; không bypass CSP                                                |

## Recovery

- Worker version rollback qua pipeline (A16).
- Không rollback downstream data từ composition (không sở hữu DB).
- Session invalidation: revoke server-side session store; client re-login.
- Disaster recovery của downstream thuộc owner của nó (llm-api/llm-consumer-routing/...).

## Runbook tóm tắt

| Tình huống                   | Hành động                                                         |
| ---------------------------- | ----------------------------------------------------------------- |
| Deploy fail                  | Kiểm build/Nx target; rollback version; không sửa data downstream |
| Auth downstream down         | Fail-closed login; giữ session hiện có tới hết TTL; thông báo     |
| Downstream contract breaking | Dừng rollout; verify pact contract; forward-fix migration nếu cần |
| CSP blocking legit           | Điều chỉnh CSP whitelist qua config; không disable CSP            |
