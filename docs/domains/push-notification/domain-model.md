# Domain Model — Push Notification

## 1. Mục đích và phạm vi

`push-notification` là bounded context điều khiển việc gửi thông báo đẩy (push notification) từ Ecoma tới thiết bị của người dùng cuối. Context này chịu trách nhiệm:

- Quản lý vòng đời `Device` (thiết bị logic của một `User`), `Push Subscription` (đăng ký nhận notification của thiết bị), `Push Provider` (nhà cung cấp dịch vụ đẩy), `Push Notification` (ý định gửi notification), `Push Delivery` (một lần gửi thực sự) và `Push Routing Policy` (chính sách định tuyến).
- Nhận notification intent từ business service, thực hiện `Push Routing`, tạo `Push Delivery`, rồi đưa `Delivery Command` vào hàng đợi để delivery plane thực hiện bất đồng bộ.

Context này **không** thực hiện transport delivery (Web Push, APNs, FCM) — đó là trách nhiệm của delivery plane (`web-push-notification-job`). Context cũng **không** quyết định khi nào cần gửi notification — business service là nguồn ý định, `push-notification` chỉ nhận intent và điều phối routing.

Phiên bản đầu hỗ trợ `Transport = web` / `Provider = web-push`; kiến trúc cho phép mở rộng `Transport = app` / `Provider = fcm`/`apns` mà không đổi contract gọi của business service.

## 2. Ngôn ngữ dùng chung (ubiquitous language)

| Thuật ngữ             | Nghĩa trong Ecoma                                                                                                                            | Ghi chú                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Device`              | Thiết bị logic mà một `User` nhận push notification; có nhiều `Push Subscription` thuộc các `Transport` khác nhau                            | `device_id` là logical identity, **không** suy diễn từ IP/User-Agent/metadata không ổn định                                                              |
| `Push Subscription`   | Một endpoint cụ thể mà notification có thể gửi tới, gắn `user_id`, `device_id`, `app`, `transport`, provider tham chiếu, status              | Với `Web Push`: lưu `endpoint`, `p256dh`, `auth`                                                                                                         |
| `Push Provider`       | Nhà cung cấp dịch vụ đẩy (`web-push`, `fcm`, `apns` tương lai) do service quản lý: `type`, `name`, `status`, app scope, credential reference | Credential nhạy cảm không trả về qua API đọc configuration                                                                                               |
| `Push Notification`   | Ý định gửi notification tới một hoặc nhiều `User`; không gắn trực tiếp với `Push Subscription`                                               | Có `notification_id`, `expires_at`; có zero, one hoặc nhiều `Push Delivery`                                                                              |
| `Push Delivery`       | Một lần gửi thực sự tới một `Push Subscription` cụ thể                                                                                       | Có `delivery_id` duy nhất; state machine business                                                                                                        |
| `Push Routing Policy` | Quy tắc định tuyến: resolve users → devices → subscriptions → filter → transport → provider → tạo delivery                                   | Chỉ thực hiện ở control plane                                                                                                                            |
| `Transport`           | Kênh thiết bị nhận notification (`web`, `app`)                                                                                               | Độc lập với `Provider`                                                                                                                                   |
| `Provider`            | Hệ thống bên ngoài thực hiện delivery (`web-push`, `fcms`, `apns`)                                                                           | `web-push` là provider type, **không** phải giá trị `transport`                                                                                          |
| `Delivery Command`    | Lệnh delivery được materialize tại control plane và chuyển cho delivery plane thực thi                                                       | Hình dạng envelope và cơ chế vận chuyển → [`applications/push-notification/02-requirements.md`](../../applications/push-notification/02-requirements.md) |
| `Idempotency-Key`     | Khóa do caller cấp để deduplicate request tạo notification                                                                                   | Scope `(app, principal_id, idempotency_key)`                                                                                                             |
| `delivery_id`         | Định danh logical của một lần delivery                                                                                                       | **Không** phải API idempotency key                                                                                                                       |

## 3. Khái niệm và quan hệ

- Mỗi `Push Subscription` thuộc về đúng một `App`; `App` không suy luận từ `Provider` — một `App` dùng được nhiều `Provider` và ngược lại.
- Mỗi `Device` có nhiều `Push Subscription` thuộc các `Transport` khác nhau — cơ sở của `Transport Priority`.
- Mỗi `Push Notification` có zero, one hoặc nhiều `Push Delivery` độc lập.
- Mỗi `Push Delivery` luôn tham chiếu một `Push Subscription`; mỗi delivery có `delivery_id` duy nhất.
- `Transport` và `Provider` là hai abstraction độc lập. `Chrome`/`Firefox`/`Edge` là `Browser Push Service` nằm dưới `web-push` protocol — không phải `Provider` abstraction của domain.

## 4. Entity, aggregate và value object

- **`Device`** — aggregate root: quản lý danh sách `Push Subscription` của thiết bị; `device_id` là định danh opaque; association subscription → device **không bao giờ** suy diễn gián tiếp từ IP, User-Agent, browser name, network hoặc metadata không ổn định.
- **`Push Subscription`** — entity trong aggregate `Device`: lưu `endpoint`, `p256dh`, `auth` (dành cho Web Push), `app`, `transport`, `vapid_key_id`, provider tham chiếu, status.
- **`Push Provider`** — entity: cấu hình delivery provider (`type`, `name`, `status`, app scope, credential reference, configuration).
- **`Push Notification`** — aggregate root: ý định gửi; `notification_id` là định danh; có `expires_at` (hạn nghiệp vụ, phân biệt với Web Push transport TTL).
- **`Push Delivery`** — entity: một lần gửi thực sự; `delivery_id` định danh logical; trạng thái theo state machine dưới đây.

## 5. Lifecycle và state transition

### 5.1 Push Subscription lifecycle

```text
active ──> disabled      (unregister · admin disable · worker xác định không hợp lệ)
active ──> expired
```

- Chỉ `active` đủ điều kiện tạo `Push Delivery`.
- Subscription không còn hợp lệ (`disabled`/`expired`) không tiếp tục nhận delivery mới.
- Điều kiện disable: user unregister, administrator disable, hoặc delivery worker xác định subscription không còn hợp lệ (provider chứng minh endpoint đã chết). Cách worker phân loại lỗi provider → [`applications/push-notification/01-architecture.md`](../../applications/push-notification/01-architecture.md).

### 5.2 Push Delivery business lifecycle

```text
pending ──> queued ──> processing ──> delivered
 (outbox      ^         ├──> failed ──> queued   (administrative retry — ngoại lệ duy nhất rời terminal)
  publisher)   └──────────┤
            release (nhả quyền xử lý — retry transient, không phải kết cục delivery)
(expired từ mọi state non-terminal pending/queued/processing · processing→queued khi nhả quyền xử lý ·
 cancelled: khai báo, KHÔNG có actor trong v1)
```

| State        | Nghĩa (điều kiện phân biệt được, không suy diễn)                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`    | Chưa có lần bàn giao nào thành công; chưa có bằng chứng một delivery command đã được chuyển đi                                                |
| `queued`     | Lần bàn giao đã thành công → một delivery command đã tồn tại (hoặc đã từng tồn tại)                                                           |
| `processing` | Đang có một execution sở hữu quyền xử lý cho generation hiện tại; quyền đó chưa hết hạn                                                       |
| `delivered`  | Terminal — provider đã chấp nhận việc gửi                                                                                                     |
| `failed`     | Terminal — lỗi per-message (provider trả lỗi vĩnh viễn, subscription không hợp lệ, vượt ngưỡng retry, payload không hợp lệ tại delivery time) |
| `expired`    | Terminal — vượt `expires_at`; không gửi                                                                                                       |
| `cancelled`  | Khai báo nhưng **KHÔNG có actor trong v1** — delivery v1 kết thúc ở `delivered`, `failed` hoặc `expired`                                      |

- `delivered`, `failed`, `expired`, `cancelled` là terminal state — không transition ngược/ra theo đường bình thường.
- Ngoại lệ duy nhất rời terminal state: administrative retry `failed → queued` (có authorization, audit, precondition rõ ràng).
- `pending → queued` là transition duy nhất do outbox publisher thực hiện, sau khi lần bàn giao delivery command thành công.
- `processing → queued` qua release (nhả quyền xử lý) — không phải kết cục delivery, không ghi `failed`, delivery vẫn phải được gửi lại.
- `pending|queued|processing → expired` khi vượt `expires_at`; thực hiện bởi control plane qua logical delivery reconciliation.

## 6. Business policy, rule và invariant

### 6.1 Routing

- Routing hoàn tất trước khi enqueue delivery (resolve → filter → policy → transport → provider → tạo → enqueue). Delivery worker không thực hiện lại routing.
- Mọi delivery trong hàng đợi phải trỏ tới một subscription cụ thể và mang đủ `transport`, `provider_id`, `subscription_id` để delivery plane xử lý mà không cần routing lại.
- Transport Priority mặc định `app > web`: `Device` có cả subscription hợp lệ thì chỉ tạo delivery cho `App Push`; nếu `App Push` không tồn tại/không eligible thì dùng `Web Push`. Priority chỉ áp dụng giữa các subscription thuộc cùng một logical `Device`, **không** giữa hai `Device` khác nhau của cùng `User`.
- Mỗi tổ hợp `App` + `Transport` có đúng một active primary provider trong v1. Nhiều provider cùng `App`+`Transport` mà không xác định được primary: routing fail safely — không chọn random, không chọn theo thứ tự database.

### 6.2 Provider

- `Provider disabled` chỉ dừng routing delivery mới; delivery đã materialize giữ nguyên `provider_id`, tiếp tục được xử lý. Chỉ emergency hold/revoke mới làm delivery không eligible.
- Reroute delivery đã materialize sang provider khác là administrative recovery operation riêng, có audit — không xảy ra tự động.
- Provider credential theo `App`; thay đổi/rotate/migrate độc lập từng `App`, giới hạn blast radius.

### 6.3 Credential (ba loại, vòng đời tách biệt)

1. **Provider credential** (VAPID private key của `web-push`; `fcm`/`apns` key tương lai) — provider credential theo `App`, mã hoá at rest, có `credential_encryption_version`.
2. **Subscription delivery secret** (`auth`, `p256dh`) — dữ liệu protocol của một subscription, không phải provider credential; không xuất hiện dạng thô ngoài payload tối thiểu cần cho delivery.
3. **Root encryption key** — khoá hạ tầng dùng để mã hoá provider credential at rest; không bao giờ nằm trong dữ liệu nghiệp vụ, Git hay cấu hình public. Cơ chế lưu trữ → [`applications/push-notification/03-operations.md`](../../applications/push-notification/03-operations.md).

- VAPID key pair gắn định danh `vapid_key_id`, xoay theo key version. `Push Subscription` lưu `vapid_key_id` dùng lúc tạo; worker ký bằng key theo `vapid_key_id` của subscription, không phải key hiện tại của `App`.
- Root key rotation multi-key `K1 → K2`: không ngừng `K1` khi còn record `credential_encryption_version = K1`.
- VAPID rotation không phải root-key rotation; xoay root key reencrypt credential at rest nhưng không đổi key pair VAPID.

### 6.4 Payload và budget

- Payload chỉ chứa nội dung hiển thị của ứng dụng (`title`, `body`, `url`, `data`); `data` là opaque với worker.
- Ngân sách payload: request vượt ngân sách bị từ chối tại API, không cắt payload âm thầm, không persist rồi mới fail ở delivery time. Giá trị ngân sách, cách tính overhead mã hoá và giới hạn của provider → [`applications/push-notification/02-requirements.md`](../../applications/push-notification/02-requirements.md).
- Payload không chứa credential, token hay PII ngoài phạm vi hiển thị.
- `expires_at` là hạn nghiệp vụ của Ecoma, phân biệt với Web Push transport TTL (thời gian push service giữ message hộ).

### 6.5 Idempotency

- Tạo notification yêu cầu `Idempotency-Key` bắt buộc; thiếu hoặc không hợp lệ → từ chối là request không hợp lệ. Giới hạn độ dài và HTTP surface → [`applications/push-notification/02-requirements.md`](../../applications/push-notification/02-requirements.md).
- Scope idempotency là `(app, principal_id, idempotency_key)` — `app` + authenticated principal + key; `principal_id` là định danh ổn định của caller đã xác thực, không phải giá trị header tự khai.
- Replay cùng key + cùng canonical request hash → trả cùng `notification_id`, không tạo `Push Notification`/`Push Delivery` mới. Cùng key + request hash khác → từ chối là xung đột idempotency.
- `delivery_id` đảm bảo logical delivery idempotency, **không** đảm bảo exactly-once external provider side effect. `delivery_id` không phải API idempotency key.

### 6.6 Invariants (kinh doanh)

1. `push-notification` là nơi duy nhất thực hiện `Push Routing`; delivery worker không routing lại.
2. `App` là first-class boundary; `Transport` và `Provider` là hai abstraction độc lập.
3. `Push Delivery` luôn tham chiếu một `Push Subscription`; mỗi delivery một `delivery_id` duy nhất.
4. `app` ưu tiên hơn `web` khi hai subscription thuộc cùng một `Device`.
5. `app` trong notification request lấy từ authenticated principal, không phải arbitrary body value.
6. Provider credential không xuất hiện trong delivery command, API response hay log.
7. Provider/`App` failure cô lập; `Provider disabled` dừng routing mới, không implicit reroute delivery đã materialize.
8. Business service không quản lý trực tiếp subscription/delivery; `push-notification` không thực hiện transport delivery.
9. Việc bổ sung `App Push` không yêu cầu đổi notification contract cơ bản.
10. Mỗi `App` + `Transport` đúng một active primary provider trong v1; không có primary → routing fail safely.
11. Việc ghi `Push Notification`, `Push Delivery` và outbox intent là một thao tác bền vững duy nhất; chuyển giao delivery sang delivery plane **không** atomic với thao tác đó, nên một delivery có thể được chuyển đi nhiều lần và mỗi lần lặp phải được chấp nhận. Cơ chế ghi và chuyển giao → [`applications/push-notification/01-architecture.md`](../../applications/push-notification/01-architecture.md).
12. `delivery_id` đảm bảo logical idempotency, không đảm bảo exactly-once external provider side effect.
13. Mọi delivery non-terminal có đường recovery xác định hoặc failure mode được phát hiện + alert trong SLA — `expires_at` là chặn trên; không có delivery `pending` treo vô thời hạn không alert.

## 7. Actor, authority và business permission

- `app` identity phải đến từ authenticated principal; đối chiếu với body; không khớp → từ chối. Application chỉ được quản lý subscription thuộc scope mình và gửi notification trong scope được cấp quyền.
- Chỉ execution đang sở hữu quyền xử lý hiện tại của một delivery mới được ghi outcome cho delivery đó; ghi từ execution đã mất quyền → bị từ chối là stale write. Cơ chế lease và generation → [`applications/push-notification/01-architecture.md`](../../applications/push-notification/01-architecture.md).
- Chỉ control plane decrypt provider credential; credential chỉ được trả tới execution đang sở hữu quyền xử lý hợp lệ; delivery worker không lưu credential bất kỳ đâu.
- Administrative retry (`failed → queued`) yêu cầu administrative authorization + `reason` + `actor` + audit `delivery_retried`.

## 8. Domain events và semantic contracts

- `Push Notification created` — tạo `Push Notification` cùng các `Push Delivery` của nó; phân biệt tạo mới với replay idempotent (replay trả cùng `notification_id`, không tạo gì mới). HTTP surface, status code và shape response → [`applications/push-notification/02-requirements.md`](../../applications/push-notification/02-requirements.md).
- `Delivery Command` — tín hiệu uỷ thác một logical delivery cho delivery plane; envelope và nội dung vận chuyển → [`applications/push-notification/02-requirements.md`](../../applications/push-notification/02-requirements.md) FR-013.
- `delivery_id` là logical delivery idempotency key: consumer nhận lại cùng `Delivery Command` không tạo thêm logical delivery mới.

## 9. Business exceptions, correction và compensation

- **Administrative retry** (`failed → queued`): yêu cầu authorization, audit; precondition: delivery `failed`, subscription `active`, provider không emergency hold, notification chưa quá `expires_at`. Có thể tạo external duplicate nếu lần thử trước đã tới provider nhưng outcome không được ghi lại — operator chấp nhận rủi ro một cách có ý thức.
- **Re-publish** (`pending → pending`, không đổi state): operator recovery cho delivery non-terminal kẹt ở `pending` khi đường tự động đã cạn; tạo đúng một outbox intent mới cho cùng `delivery_id`, không tạo `notification_id`/`delivery_id` mới.
- **Expired**: không có đường `expired → queued`; muốn gửi lại thì tạo notification mới.

## 10. Điểm nghiệp vụ chưa chốt

- Cơ chế trigger cụ thể của Outbox Publisher — launch gate của PR implementation, chưa chốt; phương án kỹ thuật → [`applications/push-notification/01-architecture.md`](../../applications/push-notification/01-architecture.md).
- Thiết kế chi tiết cho `Transport = app`, `Provider = fcm`/`apns` — future extension, v1 không implement.
- Giá trị retention cụ thể của idempotency record — launch gate production; phải ≥ cả `caller_retry_window` và `max_notification_ttl + queue_retention + delivery_reconciliation_age`.
