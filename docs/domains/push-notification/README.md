# Push Notification

`push-notification` là bounded context điều khiển việc gửi thông báo đẩy (push notification) từ Ecoma tới thiết bị của người dùng cuối: quản lý vòng đời `Device`, `Push Subscription`, `Push Provider`, `Push Notification`, `Push Delivery` và `Push Routing Policy`; nhận notification intent từ business service, thực hiện `Push Routing`, tạo `Push Delivery`, rồi đưa `Delivery Command` vào Cloudflare Queue để delivery plane thực hiện bất đồng bộ.

## Nó sở hữu

- `Device`, `Push Subscription`, `Push Provider`, `Push Notification`, `Push Delivery`, `Push Routing Policy` — business state và lifecycle của chúng.
- Quy tắc định tuyến (routing), `Transport Priority`, provider scope theo `App`, credential isolation (provider credential, subscription delivery secret, root encryption key).
- `delivery_id` làm logical delivery idempotency key; `Idempotency-Key` scope `(app, principal_id, idempotency_key)`.
- Payload budget và `expires_at` (hạn nghiệp vụ, phân biệt với Web Push transport TTL).

## Nó không sở hữu

- Transport delivery thực sự (Web Push, APNs, FCM) — thuộc delivery plane (`web-push-notification-job`).
- Quyết định khi nào cần notification — business service là nguồn ý định.
- Provider credential làm runtime secret của delivery worker; control plane không giữ, không decrypt, không truyền credential.

## Context liên quan cần biết

- `account`, `auth`, `payment`, `llm-api` là producer của notification intent (gửi intent qua contract/event).
- `web-push-notification-job` là delivery plane của cùng context này, consume Cloudflare Queue `ecoma-push-delivery`, resolve runtime material qua private delivery interface, không truy cập D1 `push`.

## Tài liệu canonical trong thư mục

| Document                               | Nội dung                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, lifecycle, state transition, policy, invariant, actor/authority, domain event, semantic contract |

## Runtime / deploy unit (tham chiếu Architecture)

Xem [`applications/push-notification/`](../../applications/push-notification/README.md) (control plane) và [`applications/web-push-notification-job/`](../../applications/web-push-notification-job/README.md) (delivery plane) cho thiết kế thành phần, runtime và vận hành.
