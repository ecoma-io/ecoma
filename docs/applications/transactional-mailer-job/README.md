# Transactional Mailer Job

`transactional-mailer-job` là delivery worker thực hiện mail delivery cho các `Mail Message` mà `transactional-mail` đã render và enqueue. Worker thuộc **delivery plane** — không render template, không quyết định recipient, không chọn/reroute provider — chỉ thực thi quyết định đã được control plane materialize.

## Runtime

```text
transactional-mailer-job
├── Cloudflare Worker (module worker, KHÔNG có HTTP route)
├── Cloudflare Queue consumer `ecoma-mail-delivery`
├── Cloudflare Queue consumer `ecoma-mail-lifecycle-events` (lifecycle ingest — CHƯA provision)
└── Cloudflare D1 `mail-job` (job execution state của chính service này)
```

- Consume Mail Command từ Cloudflare Queue `ecoma-mail-delivery` (bounded retry + DLQ).
- Consumer thứ hai `ecoma-mail-lifecycle-events` cho lifecycle event ingest-only của provider — Event Subscriptions chưa được provision (`01-architecture.md` §11.3).
- Sở hữu D1 riêng `mail-job` cho job execution state; dữ liệu control plane resolve qua private delivery interface của `transactional-mail`.
- Không có API public; credential không bao giờ đi vào Queue/log/DLQ.
- Không truy cập D1 `mail` của control plane.
- External provider: v1 là Cloudflare Email Service qua binding `send_email` (cùng account, không credential HTTP); adapter Resend giữ lại làm adapter phụ — endpoint + credential là Worker Secret của chính worker này, không đến từ control plane.

## Documents

| Document                                     | Nội dung                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md) | Boundary, lifecycle, state ownership, idempotency, retry model, invariants |
| [`02-requirements.md`](./02-requirements.md) | Functional/non-functional requirements và non-goals                        |
| [`03-operations.md`](./03-operations.md)     | Queue config, retry, DLQ, provider failure, troubleshooting, runbook       |

## Delivery plane (cùng context, component riêng)

`transactional-mailer-job` là delivery plane của bounded context `transactional-mail`, deploy unit độc lập, không truy cập D1 `mail`. Xem [`applications/transactional-mail/`](../../applications/transactional-mail/README.md) (control plane).

Domain model business knowledge nằm tại [`docs/domains/transactional-mail/domain-model.md`](../../domains/transactional-mail/domain-model.md) — thành phần này chỉ tham chiếu, không lặp business rule.

Runtime design của chính component này: [`01-architecture.md`](./01-architecture.md). Tương tác với control plane — Mail Command contract, private delivery interface, generation authority: [`docs/applications/transactional-mail/01-architecture.md`](../transactional-mail/01-architecture.md) §5/§7.
