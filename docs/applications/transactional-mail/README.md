# Transactional Mail (control plane)

`transactional-mail` là Cloudflare Worker làm **control plane** của hệ thống Transactional Mail. Thành phần này nhận yêu cầu gửi mail từ consumer (`account`, `auth`, `payment`), render template, lưu domain state vào D1 `mail` và đưa việc giao vào Cloudflare Queue thông qua **transactional outbox**.

## Component type

Control plane (API service) — không public hostname; internal API qua Service Binding.

## Responsibility và boundary

- Quản lý `Mail Template` (versioned: tên + locale + version, mỗi version có `variables_schema_json`), `Mail Message` (đồng điệp đã render), `Mail Outbox` (hàng đợi xuất bản giao).
- Nhận yêu cầu gửi mail qua `POST /v1/messages`, render nội dung từ template, lưu domain state vào D1 `mail`, publish Mail Command vào Queue `ecoma-mail-delivery` qua Outbox Publisher.
- Cung cấp private delivery interface cho delivery worker `transactional-mailer-job` (`GET /internal/deliveries/:delivery_id`, `POST /internal/deliveries/:delivery_id/outcome`, `POST /internal/deliveries/:delivery_id/redrive`) — chỉ runtime data, không provider credential.
- Rate limit theo authenticated principal và system-wide sending limit; content retention/deletion.
- HTTP interfaces: `POST /v1/messages` (application API), `GET /internal/deliveries/:delivery_id` + `POST .../outcome` + `POST .../redrive` (private delivery interface), `POST /internal/outbox/publish` (internal backup trigger — thiết kế, chưa implement).
- Runtime enforcement: `app` và `principal_id` lấy từ authenticated principal (không từ body), `UNIQUE (principal_id, idempotency_key)`, `request_fingerprint` là HMAC-SHA-256 có khoá, provider credential là Worker Secret của `transactional-mailer-job` (không phải của control plane).

## Domain contexts tham gia

- `transactional-mail` — context này được control plane này host và hiện thực.

## Tài liệu bên trong

| Document                                     | Nội dung                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md) | Kiến trúc thành phần: runtime boundary, flow, API surface, persistence, outbox, private interface, invariants             |
| [`02-requirements.md`](./02-requirements.md) | Yêu cầu kỹ thuật của application: giao thức, interface, runtime constraint, performance, availability/recovery, non-goals |
| [`03-operations.md`](./03-operations.md)     | Triển khai, cấu hình/secrets, migration D1, monitoring/alerting, failure handling, recovery, runbook                      |

Domain model business knowledge nằm tại [`docs/domains/transactional-mail/domain-model.md`](../../domains/transactional-mail/domain-model.md) — thành phần này chỉ tham chiếu, không lặp business rule.

## Delivery plane (cùng context, component riêng)

`transactional-mailer-job` là delivery plane của cùng bounded context `transactional-mail`, deploy unit độc lập, không truy cập D1 `mail`. Xem [`applications/transactional-mailer-job/`](../transactional-mailer-job/README.md).
