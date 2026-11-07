# Web Push Notification Job Architecture

> **Phạm vi:** boundary, runtime resolution, state ownership, idempotency, lifecycle và architectural invariants của `web-push-notification-job`.
> Design của control plane (state machine, routing, idempotency model) → [`docs/applications/push-notification/01-architecture.md`](../push-notification/01-architecture.md) · error matrix canonical → [`docs/applications/push-notification/03-operations.md` §5](../push-notification/03-operations.md) · requirement → [`02-requirements.md`](./02-requirements.md) · vận hành → [`03-operations.md`](./03-operations.md).

## 1. Mục đích

`web-push-notification-job` là delivery worker thực hiện `Web Push` delivery cho các `Push Delivery` đã được `push-notification` tạo và enqueue. Worker là một phần của **delivery plane** — không quyết định notification gửi cho ai hay bằng transport nào.

```text
push-notification
       |
       | Delivery Command
       v
Cloudflare Queue
       |
       v
web-push-notification-job ──── D1 `push-job`
       |
       | Web Push Protocol
       v
Browser Push Service
```

## 2. Phạm vi

### 2.1. Trong phạm vi

- Consume `Delivery Command` từ Cloudflare Queue và validate schema.
- Resolve runtime delivery data qua private interface của `push-notification`.
- Kiểm tra delivery còn eligible, thực hiện `Web Push`, phân loại kết quả delivery.
- Retry lỗi transient; báo `Push Subscription` không còn hợp lệ khi provider chứng minh.
- Cập nhật `Push Delivery` state theo state machine do control plane định nghĩa.
- Ack/reject từng Queue message theo delivery outcome (per-message ACK/retry).
- Ghi và dùng job execution state trên D1 `push-job` (attempt record, processed marker, **envelope của lần consume đầu** đủ 7 trường theo §5, việc kẹt); chạy reconciliation cho job state của chính mình.

### 2.2. Ngoài phạm vi

- Tạo `Push Notification`, resolve recipient/`Device`, chọn `Transport`/`Provider`/tìm subscription thay thế, áp dụng `app > web`, thực hiện `FCM`/`APNs`.
- Quản lý `Push Provider` hay `Push Subscription` lifecycle ngoài việc báo trạng thái invalid.
- Truy cập D1 của service khác hay PostgreSQL (`docs/architecture/01-architecture.md` invariant 5; không có Hyperdrive binding — `docs/architecture/03-operations.md` §11.4).
- Quản lý business logic của application.
- **Backup/DR của D1 `push-job`** — D1 `push-job` nằm **ngoài** Backup/DR scope: không backup strategy, không restore runbook, không RPO/RTO (`docs/architecture/03-operations.md` §3.1). Mất D1 `push-job` là chấp nhận được; recovery **ở mức service** qua reconciliation (§11b, `03-operations.md` §17). Time Travel là platform capability destructive, **không** phải cam kết phục hồi (`docs/architecture/04-platform-facts.md` DB5).

## 3. Worker Boundary

Ranh giới của worker là một `Delivery Command` cụ thể. Queue message đã chứa decision của control plane; toàn bộ envelope `version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload` là **immutable** — worker không thay đổi chúng, không tìm một delivery khác, không materialize lại payload (§5).

```text
Push Notification → Push Routing → Push Delivery → Cloudflare Queue → Web Push Worker → External Web Push Provider
```

## 4. Supported Delivery

Phiên bản đầu chỉ hỗ trợ `transport = web` / `provider.type = web-push`. Message không thuộc scope (ví dụ `transport = app`) bị từ chối an toàn — không được chuyển sang provider hoặc transport khác.

**Schema chung ≠ scope thực thi — phải phân biệt rõ hai lớp này.** `@ecoma-io/push-notification-contracts` là contract **dùng chung** cho mọi transport/provider trong vocabulary hệ thống: `validateDeliveryCommand` (và các validator canonical khác) **chấp nhận** `transport = app` cùng `provider.type = fcm`/`apns`, vì đó là giá trị hợp lệ của vocabulary chứ không phải envelope hỏng — contract không tự biết plane nào đang gọi nó. Vì vậy **MUST** có một **execution-scope guard** ở ranh giới consumer, và guard đó **MUST** đọc chính hằng số scope của contract (`V1_EXECUTABLE_TRANSPORT = 'web'`, `V1_EXECUTABLE_PROVIDER_TYPE = 'web-push'`) chứ không hard-code lại:

- `validateV1ExecutionTransport(transport)` — dùng ở ranh giới envelope (khi chỉ có `transport`): `transport` ngoài scope → từ chối an toàn, **KHÔNG** ACK mù, **KHÔNG** chuyển sang provider/transport khác.
- `validateV1ExecutionMaterialScope({ transport, provider_type })` — dùng ở ranh giới runtime material (response `200` của `claim`, nơi có cả `provider.type`): kiểm `transport` trước, rồi `provider.type`; material của provider khác **MUST NOT** được coi là thực thi được bởi worker này.

Quy tắc bất biến: `validateDeliveryCommand(...).ok === true` **KHÔNG** đủ để worker thực thi message — worker **MUST** kiểm execution-scope guard trước khi claim/gọi provider. `app`/`fcm`/`apns` **MUST NOT** được tính là thực thi được bởi web-push worker, dù schema chung chấp nhận chúng. Lý do tách hai lớp: cùng một contract phải phục vụ cả `web-push-notification-job` hiện tại và `app-push-notification-job` tương lai (`§22`), nên scope là thuộc tính của **plane**, không phải của schema. `detail` của guard là **chuỗi hằng** (không nối giá trị caller gửi vào) — guard chạy trên dữ liệu chưa tin nên không được tạo log injection.

## 5. Delivery Command

Envelope của Queue message gồm đúng bảy trường `version` (bắt buộc để hỗ trợ evolution của Queue contract), `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload` — danh sách này là **contract** giữa hai plane, canonical ở `docs/applications/push-notification/02-requirements.md` FR-013.

- Toàn bộ envelope là **immutable** với worker: không đổi `transport`/`provider_id`/`subscription_id`, không thay recipient, không reroute (§3).
- `payload` được **materialize tại control plane** và là **source of truth** của nội dung gửi đi; worker **KHÔNG** đọc lại payload từ runtime API để thay thế nó (§6) — runtime API chỉ dùng để xác thực/đối chiếu, không phải nguồn payload mới.
- Worker không được tạo payload mới theo business logic riêng (§15).

Queue message **không được chứa**: VAPID private key, provider secret, access token, hay bất kỳ private credential nào.

## 6. Runtime Resolution

Queue chỉ tham chiếu `subscription_id`, `provider_id`, `delivery_id`. Worker resolve runtime configuration qua **private delivery interface** của `push-notification`:

```text
Queue → delivery_id → POST .../claim (private delivery runtime API) → Push Delivery · Push Subscription · Push Provider · Provider Credential → Worker
```

- **Runtime material được lấy qua `claim`, không qua một operation đọc riêng.** Private delivery runtime API **không** có `GET` (`docs/applications/push-notification/01-architecture.md` §8.1): delivery material cùng provider credential **CHỈ** có trong response `200` của `POST /internal/deliveries/:delivery_id/claim` — tức chỉ khi execution **đã thắng lease**. Mọi `409` (mọi `reason`) **MUST NOT** chứa material hay credential. Vì vậy "resolve runtime" và "claim" **là cùng một bước**: worker **MUST NOT** giả định có bước nào lấy được material mà chưa claim.
- Interface chỉ dành cho trusted delivery worker, không phải public API; **không** dùng interface để tìm subscription khác, đổi provider, reroute, thay đổi recipient hay transport.
- Interface là **delivery lookup theo `delivery_id`**, không phải routing API: không có tham số khám phá theo `app`/`user`/`transport`/`provider`.
- Interface **không** trả routing decision mới và **không** thay thế `payload` của Queue (§5) — payload materialize ở control plane là source of truth.
- `web-push-notification-job` **không truy cập D1 `push`** — mọi dữ liệu control plane đi qua private interface. Worker có D1 riêng `push-job` cho job execution state. Hai D1 là hai storage resource, mỗi thứ một owner (`docs/architecture/01-architecture.md` invariant 5).

### 6.1. Caller authorization

Cloudflare **không** cung cấp header phân biệt Service Binding với request từ Internet, và endpoint private vẫn reachable nếu Worker có hostname/route — Service Binding **không** phải ranh giới tin cậy tự thân. Vì vậy authenticator **bắt buộc ở tầng ứng dụng**, verify **trước** khi xử lý request:

- Caller khai báo principal header `X-ECOMA-PRINCIPAL` (giá trị `svc.web-push-notification-job`) và shared secret do `Cloudflare Worker Secret` của control plane cấp (qua `Authorization`). **Không** có `X-ECOMA-APP` trong cặp push này: claim/lookup theo `delivery_id`, và `app` là thuộc tính của delivery do control plane sở hữu — nên `X-ECOMA-APP` là thừa và **không** phải bằng chứng danh tính.
- Header principal tự khai **KHÔNG** phải bằng chứng danh tính: chỉ tin sau khi secret đã xác thực; nếu principal header có mặt và không khớp principal gắn với credential → `401`.
- Sai principal / sai secret hoặc thiếu credential → từ chối `401` **trước** lookup, **không** tiết lộ delivery có tồn tại hay không.
- **Service Binding KHÔNG phải authorization boundary** (`docs/architecture/01-architecture.md` §6). Auth của interface là trách nhiệm của control plane (canonical → `docs/applications/push-notification/01-architecture.md` §8.1); worker giữ phần của mình theo `02-requirements.md` SR-004.
- Quyền tối thiểu của worker (danh sách đóng): `claim` · `release` · ghi outcome · báo invalidate subscription · job state trên D1 `push-job`. **Worker CÓ THỂ** produce message tới Queue `ecoma-push-delivery` **chỉ** cho mục đích reconciliation re-deliver của **cùng** `delivery_id` (FR-022); **KHÔNG** được dùng để reroute, đổi provider, tạo delivery mới hay publish notification khác. **MUST NOT** gọi Admin API; **MUST NOT** truy cập D1 `push`. Danh sách này **không** có operation đọc delivery material: không `GET` (`docs/applications/push-notification/01-architecture.md` §8.1).

## 7. Delivery Runtime

Runtime delivery material phải đủ để worker thực hiện một Web Push request. **Material này CHỈ đến từ response `200` của `claim`** (§6) — không có `GET` để lấy material trước khi claim:

- `Delivery`: `delivery_id` · `notification_id` · `app` · `status` · `expires_at` · `payload_digest` _(optional — thuật toán digest là open item, `docs/applications/push-notification/03-operations.md` §11; worker đối chiếu khi có, MUST NOT từ chối response chỉ vì thiếu)_ · `dispatch_generation` · `lease_expires_at` · `transport` · `provider_id` · `subscription_id`
- `Subscription`: `endpoint` · `p256dh` · `auth` · `vapid_key_id`
- `Provider`: `type` · `configuration` · `credential`

Trong tập field đóng của response `200` (bảng canonical → `docs/applications/push-notification/01-architecture.md` §8.1) có **13** top-level field: `delivery_id` · `notification_id` · `app` · `status` · `expires_at` · `payload_digest` _(optional)_ · `dispatch_generation` · `lease_expires_at` · `transport` · `provider_id` · `subscription_id` · `subscription` · `provider`. Ba nhóm ở trên chính là phép **rã** của 13 field đó: `Delivery` liệt kê 11 scalar top-level; `Subscription` và `Provider` là **nội bộ** của hai object top-level `subscription` (4 field, đóng) và `provider` (3 field, đóng) — tức 11 + 4 + 3 = 18 giá trị lá. Một field ngoài tập 13 top-level kia trong `200` là **vi phạm contract** (worker không gọi provider); và `provider_id` là scalar **top-level**, **không** nằm trong object `provider` (object đó đóng đúng ba field `type` · `configuration` · `credential`). `transport` trong material là **giá trị của `Transport`** (`web` cho delivery v1) — **không** phải provider type; worker **MUST** kiểm tra nó khớp `transport` của envelope trước khi gửi, và một material trả `transport: "web-push"` là sai contract.

`payload` **KHÔNG** nằm trong runtime material — nguồn sự thật duy nhất của payload là envelope Queue (§5). `payload_digest` **chỉ để đối chiếu** (§15), không dùng để gửi. `app` lấy từ material cho metric/log — envelope **không** có field `app` (§5); envelope phân biệt delivery bằng `transport`/`provider_id`. `expires_at` phục vụ kiểm tra hạn **trước** khi gọi provider (§16). `vapid_key_id` buộc worker ký bằng key của **subscription**, không phải "key hiện tại của `App`" (§18). `credential` của provider phải đủ để ký Web Push **theo `vapid_key_id` của subscription**: control plane trả credential khớp `vapid_key_id` trong runtime material; trong thời gian rotation, control plane **MUST** vẫn trả được credential cho mọi `vapid_key_id` còn được subscription active tham chiếu (§18; rotation → `docs/applications/push-notification/03-operations.md` §7.2). `Provider Credential` chỉ được trả cho trusted worker qua private channel; không lưu credential trong Queue. `dispatch_generation` là fencing token worker gửi kèm khi ghi outcome/release (§11); `lease_expires_at` do control plane quản lý — worker chỉ đọc.

## 8. Delivery Lifecycle

```text
Claim (private API, §11) → Validate → Resolve Runtime → Check Delivery Eligibility → Send Web Push
   ├── claim rejected ─────→ no-op theo `reason` (ACK an toàn; `pending` → Queue retry)
   ├── success ────────────→ Mark Delivered
   ├── transient ──────────→ Release lease → Retry
   ├── permanent ──────────→ Mark Failed (credential/payload failure — KHÔNG tự invalidate subscription)
   └── invalid ────────────→ Mark Failed → Disable Subscription
```

Worker chỉ acknowledge message sau khi outcome đã được persist, hoặc delivery đã được chuyển vào retry/DLQ path, hoặc message đã kết thúc **no-op an toàn** — claim bị từ chối với `reason` không đòi retry (`terminal`/`expired`/`ineligible_*`/`lease_held`), hoặc delivery đã quá `expires_at` ngay trước lúc gửi (§9, §16). `reason = 'pending'` **không** thuộc nhóm no-op: để Queue retry theo backoff.

## 9. Delivery Eligibility

Trước khi gọi provider, worker xác định delivery còn eligible từ kết quả claim (§11). Không còn eligible khi: `delivery` đã terminal (`delivered`/`failed`/`expired`/`cancelled`), `subscription disabled/expired`, `notification` đã quá `expires_at`, hoặc provider đang **emergency hold** — tương ứng đúng các `reason` `terminal`, `ineligible_subscription`, `expired`, `ineligible_provider_hold` của claim. Trong mọi trường hợp đó worker **không** gọi provider, **không** ghi state (worker không sở hữu terminal state) và ACK an toàn; delivery tiếp tục được control plane xử lý.

`provider disabled` (dừng routing mới — `docs/applications/push-notification/01-architecture.md` §5.3) **KHÔNG** phải điều kiện ineligible: delivery đã materialize giữ `provider_id` và **tiếp tục được xử lý**. **Emergency hold/revoke** của provider thì **LÀ** điều kiện ineligible → claim trả `409 ineligible_provider_hold`, worker **không** gọi provider và **không** tự reroute. Hai operation này phân biệt ở control plane (canonical → `docs/applications/push-notification/01-architecture.md` §5.3, `docs/applications/push-notification/03-operations.md` §6.3); worker chỉ đọc kết quả `claim` (§11).

## 10. Idempotency

`delivery_id` là idempotency key, đảm bảo **logical delivery idempotency**. Cloudflare Queue at-least-once, crash window (provider accept → worker crash trước khi persist → Queue retry → duplicate external notification) và ranh giới logical-vs-external **đã canonical ở `docs/applications/push-notification/01-architecture.md` §7** — worker tuân thủ model đó:

- không tạo logical delivery mới khi cùng message được deliver lại; logical state transition không bị lặp sai;
- duplicate external notification trong crash window là khả năng đã chấp nhận;
- race giữa hai executions của cùng `delivery_id` xử lý bằng persistent state transition kèm **`dispatch_generation`** (fencing token do control plane cấp); `dispatch_generation` không khớp → **stale write bị từ chối**, worker coi là duplicate/conflict và ACK an toàn — **không** gửi lại provider.

## 11. Delivery State Ownership

`push-notification` là owner của `Push Delivery` state. Worker request transition theo state machine của control plane (`queued → processing → delivered/failed`, và `processing → queued` qua `release`); không tạo state mới và không chuyển delivery từ `delivered/failed/expired/cancelled` về trạng thái chưa xử lý.

**Lease và fencing.** Control plane cấp lease (`lease_expires_at`) + `dispatch_generation` (fencing token) bằng **atomic claim** — `POST /internal/deliveries/:delivery_id/claim` (canonical → `docs/applications/push-notification/01-architecture.md` §5.6, §8.1; không định nghĩa lại). Claim là **guarded conditional write** ở control plane: predicate nằm trong chính statement ghi và thắng/thua xác định bằng số dòng **thực sự** bị thay đổi (`docs/architecture/04-platform-facts.md` DB3) — worker **MUST NOT** giả định có row-level locking hay isolation level nào, vì D1 **không** tài liệu hoá hai thứ đó (DB11). Worker ghi outcome/release chỉ khi `dispatch_generation` khớp; không khớp → `409 stale_write`, delivery đã terminal → `409 terminal`; stale write bị từ chối, worker coi là duplicate/conflict, ACK an toàn, **không** gửi lại provider. **Worker KHÔNG** tự gia hạn lease, **không** có reaper phía worker. Lease expiry **không** tự chuyển state: nó chỉ làm delivery claimable lại; việc đánh dấu `expired` do control plane làm, qua reconciliation (`docs/applications/push-notification/03-operations.md` §4.2 (c)). Nếu `expires_at` trôi qua **trong khi** worker đang giữ lease, worker vẫn ghi outcome (`delivered`/`failed`) bình thường — expiry chặn **claim mới**, không huỷ lần gửi đã bắt đầu.

Kết quả claim worker phải xử lý (canonical → `docs/applications/push-notification/01-architecture.md` §8.1 — bao gồm cả hành vi Queue cho mỗi kết quả; bảng dưới tham chiếu, không định nghĩa lại):

| Kết quả claim                                  | Worker làm gì                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `200 claimed`                                  | gọi provider bằng `dispatch_generation` nhận được                                      |
| `409 lease_held`                               | **không** gọi provider, ACK an toàn                                                    |
| `409 terminal`                                 | **không** gọi provider, ACK an toàn                                                    |
| `409 expired`                                  | **không** gọi provider, ACK an toàn                                                    |
| `409 pending`                                  | **không** gọi provider, **KHÔNG** ACK; để Queue retry/backoff (theo backoff của Queue) |
| `409 ineligible_subscription`                  | **không** gọi provider, ACK an toàn                                                    |
| `409 ineligible_provider_hold`                 | **không** gọi provider, ACK an toàn                                                    |
| lỗi contract hoặc không gọi được control plane | **không** gọi provider; **KHÔNG** ACK mù — để Queue retry bounded (rồi DLQ)            |

Tập `reason` này là **đóng** và canonical ở control plane (`docs/applications/push-notification/01-architecture.md` §8.1) — worker **MUST** xử lý đủ mọi giá trị; `reason` không nhận biết được là **lỗi contract**: không gọi provider, không ACK mù (để Queue retry dẫn tới DLQ).

Fencing token ngăn: hai execution cùng ghi outcome; execution cũ ghi đè kết quả generation mới; hai execution chạy **đồng thời** cho cùng một generation. Fencing **KHÔNG** loại bỏ duplicate phía provider khi request đã tới provider rồi worker crash trước khi persist — crash window **đã chấp nhận** (§10; canonical → `docs/applications/push-notification/01-architecture.md` §7).

### 11b. Job State trên D1 `push-job`

| Tầng                 | Owner                       | Lưu ở đâu                     | Vai trò                                                                                      |
| -------------------- | --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| **Logical delivery** | `push-notification`         | D1 `push` (qua private API)   | Trạng thái đúng của delivery: `pending/queued/processing/delivered/failed/cancelled/expired` |
| **Job execution**    | `web-push-notification-job` | D1 `push-job` (binding riêng) | Việc đã làm: attempt, ack, delivery nào đã xử lý, việc kẹt                                   |

Job execution state tối thiểu trong D1 `push-job`: attempt record (idempotent theo `delivery_id` + `attempt`), processed marker (duplicate Queue message skip ngay), **envelope của lần consume đầu** (đủ bảy trường — §5; cần để job reconciliation re-deliver đúng message mà **không** phải hỏi lại control plane), reconciliation data (việc kẹt — đã nhận nhưng quá ngưỡng chưa kết thúc, hoặc đã persist nhưng chưa ack). D1 `push-job` **ngoài** Backup/DR scope (`docs/architecture/03-operations.md` §3.1).

Envelope lưu ở D1 `push-job` **không** được chứa thêm gì ngoài bảy trường §5: không provider credential, không subscription secret. Mất D1 `push-job` làm mất khả năng re-deliver **của worker** cho việc đã nhận; phần message **chưa từng** được consume vẫn do control plane (c) phủ (`03-operations.md` §14.10).

- D1 `push-job` là **authoritative cho job state** của service này (`docs/architecture/01-architecture.md` A19, invariant 6) — không dùng KV, bộ nhớ Worker hay `/tmp` làm nơi duy nhất.
- D1 `push-job` **không** chứa logical delivery state; ghi đè nó không thay đổi trạng thái delivery của control plane.
- Queue **không** là source of truth: mất message sau retention, việc **đã có job record** được tìm lại bằng **job reconciliation** đọc D1 `push-job`; message **chưa từng được consume** không có job record nên do control plane phát hiện (cơ chế (c) — `03-operations.md` §14.10).

## 12. Retry Model

Retry điều khiển bởi **provider error classification** — error matrix canonical ở `docs/applications/push-notification/03-operations.md` §5 (dùng chung control/delivery plane). Ba nhóm outcome, xử lý thống nhất:

**(i) Determinate terminal** — `2xx` → `delivered`; `404`/`410` → `failed` + invalidate subscription; `401`/`403` → `failed` (provider-level); `413` → `failed`; **mọi `3xx`** → `failed` (redirect **không** được đi theo — không gọi tiếp sang host khác, **không** invalidate subscription, alert). Ghi outcome kèm `dispatch_generation`, rồi **ACK**. `401/403` **không** hard-code thành invalid subscription và **không** invalidate subscription.

**(ii) Determinate retryable — provider đã trả lời hoặc lỗi xảy ra TRƯỚC khi gọi provider** — `429`, `5xx`, và lỗi validate/kết nối/runtime-resolve xảy ra **trước khi** request tới provider. Kết quả **xác định** (biết chắc provider **chưa** accept message) nên retry không tạo duplicate. **Release lease** (operation riêng `POST /internal/deliveries/:delivery_id/release`, kèm `dispatch_generation`) rồi `retry()`.

**(iii) Indeterminate — request CÓ THỂ đã tới provider** — timeout sau khi đã gửi, connection reset giữa response, runtime API fail **sau** khi gọi provider. Kết quả **không xác định**: provider **có thể** đã accept. Cũng **release lease** rồi `retry()`; đây là nguồn duplicate tiềm năng (alert policy → `03-operations.md` §12).

Quy tắc bắt buộc:

- **Worker MUST release lease trước khi trả `retry()`.** Không release → delivery vẫn `processing` với lease còn hiệu lực → message redelivery gặp `409 lease_held` và bị ACK/skip → **retry của Queue không thực sự retry provider**. Đây là lỗi correctness trung tâm. Quy tắc này chỉ áp dụng cho nhánh **(ii)/(iii)** — khi claim **đã** thắng (worker đang giữ lease). Claim bị từ chối `409 pending` thì **không có lease để release**: worker chỉ `retry()` (§11).
- `release` kèm `dispatch_generation`; generation không khớp → `409 stale_write`, state không đổi, coi là stale/duplicate, ACK an toàn, **không** gọi provider.
- Phân biệt nhóm (ii) và (iii) phải quan sát được trong **job state + log + metric** vì (iii) là nguồn duplicate tiềm năng.
- Retry **bounded**: trần `max_retries` của Queue + attempt budget trong job state. Không retry vô hạn.
- **MUST NOT ACK** delivery vẫn còn cần xử lý.
- **External retry authority:** retry external thuộc delivery worker + Cloudflare Queue; worker **không** retry publish; control plane **không** retry delivery. Retry publish thuộc outbox của control plane (canonical → `docs/applications/push-notification/03-operations.md` §4). `POST /admin/v1/deliveries/:id/retry` là administrative recovery — tạo outbox entry mới cho delivery đã terminal `failed`, giữ nguyên `delivery_id` (canonical → `docs/applications/push-notification/03-operations.md` §4, §5).
- **VAPID:** key pair là provider credential theo `App` (`Web Push`), không phải secret hạ tầng dùng chung; worker nhận qua runtime resolution, **không** ghi vào Queue/log/error message (§18).
- Không tự động reroute sang provider khác khi provider fail — `provider_id` do control plane materialize.

### 12.1. Per-message Processing

Worker xử lý từng Queue message độc lập: failure của message A không ảnh hưởng ACK/retry của message B, C trong cùng batch.

## 13. Subscription Invalidation

Nếu provider xác nhận subscription không còn hợp lệ, worker báo `push-notification` chuyển `active → disabled/expired`; delivery mới tới subscription này không được tạo. Worker chỉ báo invalid khi **provider response chứng minh** (`404` hoặc `410`); worker không tự xóa subscription khỏi database.

## 14. Provider Handling

Worker dùng `provider_id` đã được routing, không fallback sang provider khác khi provider fail. Worker không suy luận provider từ browser/`User-Agent`/IP/endpoint hostname — provider identity là `provider_id` do control plane quyết định. `provider disabled` dừng routing mới nhưng **không** loại delivery đã materialize; provider **emergency hold** là điều kiện ineligible (`409 ineligible_provider_hold`) → worker **không** gọi provider, **không** reroute (§9).

## 15. Web Push Payload

Worker nhận payload đã tạo ở control plane; có thể thực hiện transformation bắt buộc bởi Web Push Protocol nhưng không thay đổi business semantics: không tạo title mới, đổi notification type, deep link, template hay thêm business data.

Payload **chỉ** chứa nội dung hiển thị (`title`, `body`, `url`, `data`); `data` là opaque với worker. Payload **MUST NOT** chứa `auth`, `p256dh`, VAPID private key, provider secret hay authorization header (nhắc lại ở DLQ — `03-operations.md` §6).

Worker **MAY** đối chiếu `payload_digest` (§7) với payload của envelope. Digest không khớp → **contract violation**: **không** gọi provider, đánh dấu attempt failure an toàn, alert.

**Trần kích thước (canonical → `docs/applications/push-notification/02-requirements.md` FR-008, FR-013).** Payload đã materialize **MUST** nằm trong ngân sách do control plane enforce (serialized plaintext ≤ 3993 octets → body mã hoá ≤ 4096 octets, fact → `docs/architecture/04-platform-facts.md` §2.15 WP5). Worker **MUST NOT** thêm byte làm body vượt trần; nếu transformation bắt buộc bởi protocol khiến body vượt trần, worker **MUST** kết luận **permanent payload failure** (`413`-tương đương, không retry, không invalidate subscription) — **MUST NOT** cắt payload âm thầm và **MUST NOT** gửi body vượt trần. Worker **KHÔNG** thêm padding để "đệm" thêm dữ liệu; padding chỉ phục vụ length-hiding theo protocol.

## 16. Timeout

External provider request có timeout hữu hạn; worker không giữ Queue message ở trạng thái processing vô hạn. Timeout phân loại transient, trừ khi provider adapter xác định permanent. Timeout **sau khi** đã gửi request là **indeterminate** (§12 nhóm iii) — release lease rồi retry, có thể tạo duplicate phía provider.

**Hai khái niệm hạn tách biệt — không đánh đồng:**

- **Notification `expires_at`** — hạn nghiệp vụ của ecoma, lấy từ runtime material (§7). Worker **MUST** kiểm tra `expires_at` **một lần, ngay trước** khi gọi provider. Đã hết hạn → **KHÔNG** gọi provider, **KHÔNG** ghi outcome, **KHÔNG** ghi `expired` (worker không sở hữu terminal state — `docs/applications/push-notification/01-architecture.md` §5.6), **KHÔNG** invalidate subscription: đánh dấu attempt kết thúc an toàn trong D1 `push-job` rồi `ack()` message, **không** release lease (lease tự hết hạn). Delivery vẫn non-terminal và được **control plane** chuyển `expired` bằng logical delivery reconciliation (`docs/applications/push-notification/03-operations.md` §4.2 (c)). Kiểm tra này chỉ chặn **lần gửi chưa bắt đầu**: một request đã gửi đi thì được hoàn tất và ghi outcome bình thường (`delivered`/`failed`) kể cả khi `expires_at` trôi qua trong lúc đó (cùng quy tắc với lease — `docs/applications/push-notification/03-operations.md` §5.1).
- **Web Push transport `TTL`** — khoảng push service giữ message hộ (fact → `docs/architecture/04-platform-facts.md` §2.15). Worker **MUST** đặt `TTL` **không vượt** thời gian còn lại tới `expires_at` (không gửi message sống lâu hơn hạn nghiệp vụ).

## 17. Concurrency và backpressure

Worker có thể process nhiều Queue messages đồng thời; mỗi execution độc lập theo `delivery_id`. Concurrency là **bounded** (`max_concurrency`), không phải "tăng tới khi hết backlog".

- Provider throttling (`429`) → **giảm** effective concurrency, không tăng. Tôn trọng `Retry-After`.
- Chỉ tăng concurrency khi bottleneck **không** phải provider.
- Tìm bottleneck trước: provider rate limit / provider latency / database latency / network / Worker CPU.
- Trần concurrency theo platform limit (`docs/architecture/04-platform-facts.md` QU6). Cùng một trần với canonical: `docs/applications/push-notification/03-operations.md` §16; policy capacity của worker → `03-operations.md` §18.
- Concurrency không phá idempotency; không yêu cầu global ordering. Cùng `delivery_id` xử lý đồng thời → chỉ một execution được thực hiện delivery thành công, execution còn lại xử lý như duplicate/conflict.

## 18. Security Boundary

Worker là trusted delivery component:

- **Có quyền:** đọc delivery runtime data, dùng provider credential, cập nhật delivery outcome, invalidate subscription.
- **Không có quyền:** tạo notification, reroute, modify provider configuration, modify subscriptions khác, access admin configuration API.

Provider credential phải: mã hóa khi lưu trữ, chỉ giải mã trong trusted execution, không xuất hiện trong logs/Queue/error message.

**Với `Web Push`, VAPID key pair là provider credential theo `App`** — không phải secret hạ tầng dùng chung, và worker **không** sở hữu nó. Worker nhận nó qua **runtime resolution** (§6) tại delivery time và **không bao giờ** ghi nó vào Queue message, log, error message, hay DLQ payload. Vòng đời credential (encrypt/storage/rotation, không revoke bản cũ trước khi bản mới validate) thuộc control plane → `docs/applications/push-notification/03-operations.md` §7.

**Ký theo `vapid_key_id` của subscription.** Worker **MUST** ký request bằng key khớp `vapid_key_id` của **subscription** (lấy từ runtime material — §7), **không phải** "key hiện tại của `App`". Push service từ chối message ký bằng key khác key dùng lúc tạo subscription (fact → `docs/architecture/04-platform-facts.md` §2.15 WP1, WP2), nên dùng key hiện tại của `App` sẽ làm hỏng mọi subscription cũ. Key không resolve được cho `vapid_key_id` đã ghi → **permanent failure** của attempt (không retry, không invalidate subscription, alert) — remediation → `03-operations.md` §7.2.

**VAPID JWT.** Worker **MUST** ký JWT với claim `aud` chứa origin của push resource URL (không phải hostname của application server) và `exp` **không** quá **24 giờ** kể từ thời điểm request (fact → `docs/architecture/04-platform-facts.md` §2.15 WP3). Header `Authorization` dùng scheme `vapid` với `t` (JWT) và `k` (public key) — WP6. JWT này **KHÔNG** được log; thời hạn ngắn để giảm blast radius nếu lộ.

## 19. Observability

Metric/dashboard/alert inventory → [`03-operations.md`](./03-operations.md) §11–§12. Bảo đảm danh sách redaction: `auth`, `p256dh`, VAPID private key, provider secret, authorization header; không dùng `user_id`, `notification_id`, `delivery_id`, `endpoint` làm high-cardinality label; chỉ dùng `provider_id`, `app`, `transport`. Correlation chain giữ nguyên `request_id → notification_id → delivery_id → subscription_id → provider_id`. Observability **không** là serving-path dependency.

## 20. Failure Isolation

- Failure của một delivery không fail toàn bộ batch (per-message ACK/retry độc lập).
- Provider failure không làm mất những delivery khác.
- `push-notification` runtime API transient failure retry theo policy nhưng không khiến worker tự tìm alternate route.

## 21. Scaling

Worker scale độc lập với `push-notification` API. Scale driver: Queue backlog, delivery latency, provider throughput. Không cần tăng capacity theo request rate của control plane nếu notification chưa được enqueue.

## 22. Future Compatibility

Kiến trúc cho phép thêm `app-push-notification-job` cho `transport = app` mà không thay đổi worker contract: cùng Queue, rẽ theo transport. Worker không cần biết implementation của job worker khác.

## 23. Architectural Invariants

1. Worker chỉ xử lý `transport = web` — thực thi bằng execution-scope guard của `@ecoma-io/push-notification-contracts` (`validateV1ExecutionTransport`/`validateV1ExecutionMaterialScope`, §4), **không** phải bằng schema validator vốn chấp nhận cả vocabulary chung.
2. Worker không thực hiện `Push Routing`, không tìm subscription thay thế, không chọn provider khác.
3. `delivery_id` là idempotency key ở **logical state**; external provider exactly-once không được guarantee (`push-notification/01-architecture.md` §7).
4. Queue message không chứa provider credential.
5. Worker không truy cập D1 của service khác — chỉ dùng D1 `push-job` cho job state của chính mình.
6. Runtime data resolve từ private delivery interface; interface là delivery lookup theo `delivery_id`, không phải routing API, và **không** có operation đọc material ngoài `claim` — delivery material + credential **CHỈ** trong response `200` của `POST .../claim`. Caller authorization bắt buộc (principal header + shared secret), verify trước khi xử lý — sai → `401`, không tiết lộ delivery tồn tại hay không.
7. Worker không thay đổi business semantics của payload (payload materialize tại control plane, worker không đọc lại để thay thế). Queue envelope immutable: `version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload`.
8. Chỉ invalidate subscription khi provider response chứng minh; `401/403` là provider-level failure, không bulk-disable. VAPID key pair là provider credential theo `App` (`Web Push`), không ghi vào Queue/log/error.
9. Duplicate Queue message không tạo duplicate logical delivery; delivery đã hoàn thành không gửi lại. Stale write (`dispatch_generation` không khớp) bị từ chối, ACK an toàn.
10. Provider failure không làm thay đổi routing decision. `provider disabled` (dừng routing mới) **không** phải điều kiện ineligible cho delivery đã materialize — delivery vẫn được xử lý; provider **emergency hold** thì **là** ineligible (không gọi provider). Worker không reroute.
11. Worker chỉ cập nhật delivery outcome theo state machine hợp lệ (kèm `dispatch_generation`).
12. External request có timeout hữu hạn; secret không xuất hiện trong log (bao gồm `auth`, `p256dh`, VAPID private key, provider secret, authorization header).
13. Per-message ACK/retry — một message fail không force retry các message khác trong batch. Lease/fencing: `dispatch_generation` + `lease_expires_at`; worker không tự gia hạn lease, không background reaper (canonical → `docs/applications/push-notification/01-architecture.md` §5.6).
14. D1 `push-job` ngoài Backup/DR scope; recovery ở mức service qua reconciliation (`docs/architecture/03-operations.md` §3.1, `04-platform-facts.md` DB5).
15. Worker **release lease** (`POST /internal/deliveries/:delivery_id/release`, kèm `dispatch_generation`) trước khi trả `retry()` cho Queue (§12). Fencing **không** loại bỏ duplicate phía provider (request đã tới provider rồi worker crash trước khi persist) — crash window đã chấp nhận.
16. Worker **không** ghi logical delivery state (thuộc control plane); worker chỉ claim/release/ghi outcome/invalidate subscription/job state trên D1 `push-job`, **không** gọi Admin API, **không** truy cập D1 `push`.
