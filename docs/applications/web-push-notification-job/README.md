# Web Push Notification Job

`web-push-notification-job` là delivery worker thực hiện `Web Push` delivery cho các `Push Delivery` mà `push-notification` đã tạo và enqueue. Worker thuộc **delivery plane** — không routing, không reroute, không chọn provider — chỉ thực thi quyết định đã được control plane materialize.

## Runtime

```text
web-push-notification-job
├── Cloudflare Worker
└── Cloudflare Queue consumer
```

- Chỉ xử lý `transport = web` / `provider.type = web-push`; message ngoài scope bị từ chối an toàn.
- Sở hữu D1 riêng `push-job` cho job execution state; dữ liệu control plane resolve qua private delivery interface của `push-notification`.
- Không có API public; credential không bao giờ đi vào Queue/log.

## Documents

| Document                                     | Nội dung                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md) | Boundary, idempotency, runtime resolution, state ownership, invariants |
| [`02-requirements.md`](./02-requirements.md) | Functional/non-functional requirements và non-goals                    |
| [`03-operations.md`](./03-operations.md)     | Queue config, retry, DLQ, provider failure, troubleshooting, runbook   |

## Delivery plane (cùng context, component riêng)

`web-push-notification-job` là delivery plane của bounded context `push-notification`, deploy unit độc lập, không truy cập D1 `push`. Xem [`applications/push-notification/README.md`](../../applications/push-notification/README.md) (control plane).

Domain model business knowledge nằm tại [`docs/domains/push-notification/domain-model.md`](../../domains/push-notification/domain-model.md) — thành phần này chỉ tham chiếu, không lặp business rule.

Runtime design và tương tác với control plane: [`docs/applications/push-notification/01-architecture.md`](../push-notification/01-architecture.md).
