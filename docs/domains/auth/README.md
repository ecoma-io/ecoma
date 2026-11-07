# Auth

`auth` là bounded context giữ **authorization server** OAuth 2.0 / OpenID Connect của Ecoma, API-only, issuer `https://auth.ecoma.io`. Context này sở hữu giao thức cấp quyền: client registration, authorization transaction, consent, grant, vòng đời authorization code và token, revocation, và signing key. Nó **không** sở hữu UI, credential, browser session, role nghiệp vụ hay permission ứng dụng.

```text
auth.ecoma.io  (Cloudflare Worker · API-only · Hono)
   ├── Hyperdrive binding → db-auth   (query cache OFF)
   └── Service Binding  → account     (auth là CONSUMER của contract auth → account,
                                       dùng để hỏi trạng thái account lúc phát hành)

     account ── push kết quả xác thực ──► auth
     auth    ── hỏi trạng thái account ──► account
```

Hai mũi tên trên là **hai contract khác hướng**, không phải một. `auth` không đọc `db-account` và không tự trả lời được "phiên này có thật không" — `account` đẩy kết quả sang; còn trạng thái account thì `auth` hỏi ngược lại.

Ranh giới context tại system level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2.1 · rule Nx theo scope của từng app → [`docs/architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md) §6.3 · bounded context lân cận → [`domains/account/`](../account/README.md).

## Hiện trạng

Endpoint protocol và glue internal đã có trong code (`apps/auth`), 14 migration của `db-auth` nằm ở `apps/auth/migrations/` (`0001`…`0014`); **không database nào được provision** và Worker chưa khai environment staging/production. `auth` **không** lưu private key trong `db-auth` — private key là Worker Secret `AUTH_SIGNING_KEY`; database chỉ giữ metadata của key.

## Documents

| Document                                                       | Nội dung                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`domain-model.md`](./domain-model.md)                         | Ranh giới, ngôn ngữ chung, quyết định chính sách OAuth/OIDC, consent ≠ grant, handle X/Y/Z, token/thu hồi, vòng đời account, invariant nghiệp vụ |
| [`docs/applications/auth/`](../../applications/auth/README.md) | Thiết kế deploy unit: runtime, schema, giao thức login/consent, envelope nội bộ, requirements, vận hành                                          |
