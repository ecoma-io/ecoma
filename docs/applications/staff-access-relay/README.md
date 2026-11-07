# Staff Access Relay (application)

`staff-access-relay` là background job (Worker cron) thực thi **relay outbox entitlement** của bounded context `staff-access`: claim event chưa publish trong bảng outbox, publish vào Cloudflare Queues, đánh dấu đã publish.

- **Loại component:** background job (Worker cron), chạy độc lập khỏi `staff-access` (lifecycle riêng).
- **Responsibility:** claim sự kiện chưa publish trong `staff_access.entitlement_outbox_events` bằng `FOR UPDATE SKIP LOCKED`, publish vào Cloudflare Queues với idempotency key = `event_id`, consumer Queue cho settlement receipt.
- **Bounded contexts tham gia:** `staff-access` (nguồn sự kiện entitlement outbox, business semantics trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)).
- **Tài liệu bên trong:** `README.md`, `01-architecture.md`.
