# Push Notification (control plane)

`push-notification` là Cloudflare Worker làm **control plane** của hệ thống Push Notification. Thành phần này nhận notification intent từ business service, thực hiện `Push Routing`, tạo `Push Delivery`, rồi publish `Delivery Command` vào Cloudflare Queue để delivery plane (`web-push-notification-job`) thực hiện bất đồng bộ.

## Component type

Control plane (API service) — không public hostname; internal API qua Service Binding.

## Responsibility và boundary

- Quản lý `Device`, `Push Subscription`, `Push Provider`, `Push Notification`, `Push Delivery`, `Push Routing Policy` (domain state do `push-notification` bounded context sở hữu).
- `Push Routing` chỉ thực hiện ở control plane; delivery worker không routing lại.
- Outbox implementation: `Push Notification`, `Push Delivery`, `Outbox Entry` ghi trong cùng `db.batch()` của D1 `push`; `Outbox Publisher` publish `Delivery Command` vào Queue `ecoma-push-delivery` sau khi transaction commit.
- HTTP interfaces: internal application API (`POST /v1/devices`, `POST /v1/subscriptions`, `POST /v1/notifications`, ...), `Admin API` cho `Backoffice` (`/admin/v1/...`), private delivery runtime API cho delivery worker (`/internal/deliveries/:delivery_id/claim|release|outcome`, `/internal/subscriptions/:subscription_id/invalidate`).
- Runtime enforcement: `app` lấy từ authenticated principal (không từ body), credential chỉ trả khi claim thành công, provider credential không xuất hiện trong Queue/API response/log.
- Provider adapters (VAPID credential cho `web-push`), encryption at rest, root key rotation multi-key `K1 → K2`.

## Domain contexts tham gia

- `push-notification` — context này được control plane này host và hiện thực.

## Tài liệu bên trong

| Document                                     | Nội dung                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`01-architecture.md`](./01-architecture.md) | Kiến trúc thành phần: runtime boundary, flow, API surface, integration, persistence, runtime security, execution/failure model, invariants |
| [`02-requirements.md`](./02-requirements.md) | Yêu cầu kỹ thuật của application: giao thức, interface, runtime constraint, performance, availability/recovery, non-goals                  |
| [`03-operations.md`](./03-operations.md)     | Triển khai, cấu hình/secrets, migration D1, monitoring/alerting, failure handling, recovery, runbook                                       |

Domain model business knowledge nằm tại [`docs/domains/push-notification/domain-model.md`](../../domains/push-notification/domain-model.md) — thành phần này chỉ tham chiếu, không lặp business rule.

## Delivery plane (cùng context, component riêng)

`web-push-notification-job` là delivery plane của cùng bounded context `push-notification`, deploy unit độc lập, không truy cập D1 `push`. Xem [`applications/web-push-notification-job/`](../web-push-notification-job/README.md).
