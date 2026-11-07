# Account

`account` là bounded context giữ bằng chứng đăng nhập và mọi UI liên quan tài khoản; deploy unit cùng tên phục vụ nó. Bổ sung `auth` (authorization server, API-only) — bounded context riêng, hai database riêng.

```text
account.ecoma.io  (Nuxt UI + BFF: account · login · consent)
   └──► db-account     users · profile · email · credential · MFA/passkey · session · preference · privacy

              ▲                    ▲
              └── back-channel xác minh session (account đẩy sang auth) ──┘
                                    ▼
                    db-auth      (grant · token — account đọc qua contract, không đọc DB)
```

Ranh giới context tại system level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2.1 · rule Nx theo scope của từng app → [`docs/architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md) §6.3.

## Hiện trạng

`account` đã có backend thật (`apps/account`): 10 migration `db-account` (`apps/account/db/migrations/` — trong đó `0004` đổi `authn_level` → `acr`, `0005` `email_addresses`, `0006` `otp_challenges`, `0007` role pruner cho cron Worker dọn nonce, `0008` profile/preferences, `0009` purpose `verify_email`, `0010` `privacy_requests`), các contract internal `GET /internal/account/status` (trạng thái cho `auth`) và `GET /internal/account/profiles` (displayName theo batch cho `backoffice`) — đều qua envelope HMAC — và luồng đăng nhập email-OTP qua các route `/api/auth/{challenge,verify,session,logout}` (`apps/account/server/api/auth/`) — anti-enumeration, OTP chỉ lưu digest HMAC, session cookie `__Host-account-session` chỉ lưu hash. **Đã có cả UI lẫn BFF thật**: `/login`, `/login/continue`, `/consent` (`apps/account/app/pages/`) nối qua adapter thật `apps/account/app/account-data/real-adapter.ts` (`POST /api/auth/{challenge,verify,handoff}`, `POST /api/consent/{context,decide}`; BFF còn phục vụ `GET /api/auth/session` và `POST /api/auth/logout`), BFF dữ liệu tài khoản (`profile`, `emails`, `notifications`, `preferences`, `privacy-requests`, `sessions`, `applications`), và back-channel đẩy `POST /internal/session/verified` + `POST /internal/consent/{context,decide}` sang `auth` qua Service Binding (`apps/account/server/api/auth/handoff.post.ts`). **Chưa có**: password/MFA/passkey, UI nhập mã xác minh email, fulfilment privacy request, prune `otp_challenges`. `account` **không** chạm `access_token`/`id_token` — nó không có đường lấy access token cho bên thứ ba, `auth` mới là bên cấp code. `db-account` vẫn **chưa provision**. Chi tiết kỹ thuật: [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §11.

## Documents

| Document                               | Nội dung                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Ranh giới, khái niệm nghiệp vụ, mô hình assurance, vòng đời account, retention/privacy, invariant nghiệp vụ, điểm mở |

Runtime, schema, contract, cookie/session, envelope HMAC và vận hành của component hiện thực context này → [`../../applications/account/`](../../applications/account/README.md).
