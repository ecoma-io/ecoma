# Account (ứng dụng)

`account` là ứng dụng Nuxt UI + BFF phục vụ bounded context `account`: trang đăng nhập, consent, và BFF quản lý tài khoản. Nó chạy trên Cloudflare Worker (Nuxt 4 + Nitro), nói với `db-account` qua Hyperdrive, và gọi `auth` qua Service Binding để xác minh session và consent.

- **Component type:** UI/BFF (Nuxt UI + server routes, cùng một deploy unit).
- **Bounded context tham gia:** `account` — sở hữu toàn bộ phần thực thi. Không host context khác.
- **Ranh giới:** sở hữu account UI, BFF, login UI, consent UI, browser session, credential, MFA/passkey, profile, preference, privacy request. **Không** sở hữu endpoint protocol OAuth 2.0/OIDC, client registration, grant, token hay signing key — những thứ đó thuộc [`applications/auth`](../auth/README.md). Ngữ nghĩa nghiệp vụ của ranh giới này → [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §1.

```text
account.ecoma.io  (Nuxt UI + BFF: account · login · consent)
   ├── Hyperdrive → db-account   (users · profile · email · credential · MFA/passkey · session · preference · privacy)
   └── Service Binding → auth    (POST /internal/session/verified, POST /internal/consent/{context,decide})
```

Ranh giới ở system level → [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §2.1 · rule Nx theo scope → [`../../architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md) §6.3.

## Documents

| Document                                     | Nội dung                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md) | Runtime, `db-account` schema & migration, cookie/session, envelope HMAC & kho nonce, Service Binding, contract surfaces, observability |
| [`02-requirements.md`](./02-requirements.md) | Yêu cầu kỹ thuật: protocol/interface, NFR, security requirement, threat model, acceptance matrix, non-goal kỹ thuật                    |
| [`03-operations.md`](./03-operations.md)     | Triển khai, role & migration, dọn dữ liệu hết hạn, cô lập môi trường, Hyperdrive, giám sát, alerting, restore, runbook                 |

Quy tắc nghiệp vụ (danh tính, vòng đời account, retention, privacy) không nằm trong bộ tài liệu này — canonical tại [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md).

## Hiện trạng

Backend thật đã có (`apps/account`): migration `db-account` `0001`–`0010`, hai contract internal `GET /internal/account/status` và `GET /internal/account/profiles` sau envelope HMAC, luồng đăng nhập email-OTP qua `/api/auth/{challenge,verify,session,logout}`, UI `/login`, `/login/continue`, `/consent`, BFF dữ liệu tài khoản (`profile`, `emails`, `notifications`, `preferences`, `privacy-requests`, `sessions`, `applications`) và back-channel `POST /internal/session/verified` + `POST /internal/consent/{context,decide}` sang `auth`. Chưa có: password/MFA/passkey, UI nhập mã xác minh email, fulfilment privacy request, prune `otp_challenges`. `db-account` chưa provision. Chi tiết từng phần → [`01-architecture.md`](./01-architecture.md) §11.
