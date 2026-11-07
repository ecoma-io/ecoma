# Transactional Mail

`transactional-mail` là bounded context điều khiển việc gửi email giao dịch của Ecoma: tiếp nhận yêu cầu gửi mail từ consumer (`account`, `auth`, `payment`) qua contract, render template từ `Mail Template`, lưu domain state vào D1 `mail`, và đưa việc giao vào Cloudflare Queue thông qua **transactional outbox**.

## Nó sở hữu

- `Mail Template` (versioned: tên + locale + version, mỗi version có `variables_schema_json`), `Mail Message`, `Mail Outbox`.
- Message intent (template, recipient, variables, locale, correlation_id); `app` và `principal_id` lấy từ authenticated principal.
- Business delivery lifecycle: `accepted → queued → sent`, plus `failed` (terminal per-message) và `blocked` (non-terminal system-level).
- Semantic idempotency: scope `(principal_id, idempotency_key)`, fingerprint là HMAC-SHA-256 có khoá của canonical request.
- Rate limit theo authenticated principal và system-wide sending limit.
- Content retention/deletion semantics (recipient và nội dung render vs operational metadata).

## Nó không sở hữu

- Mail delivery thực sự (provider relay, Cloudflare Email Service, Resend adapter) — thuộc delivery plane (`transactional-mailer-job`).
- Provider credential — là Worker Secret của `transactional-mailer-job`; control plane không giữ, không decrypt, không truyền credential.
- `POST /v1/messages` không được gọi bởi `transactional-mailer-job` (`403`).

## Context liên quan cần biết

- `account`, `auth`, `payment` là consumer tạo message qua `POST /v1/messages`.
- `transactional-mailer-job` là delivery plane của cùng context này, consume Cloudflare Queue `ecoma-mail-delivery`, resolve runtime material qua private interface, không truy cập D1 `mail`.

## Tài liệu canonical trong thư mục

| Document                               | Nội dung                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, lifecycle, state transition, policy, invariant, actor/authority, domain event, semantic contract |

## Runtime / deploy unit (tham chiếu Architecture)

Xem [`applications/transactional-mail/`](../../applications/transactional-mail/README.md) (control plane) và [`applications/transactional-mailer-job/`](../../applications/transactional-mailer-job/README.md) (delivery plane) cho thiết kế thành phần, runtime và vận hành.
