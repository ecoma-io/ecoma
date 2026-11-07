# Kiến trúc thành phần — Push Notification (control plane)

> **Phạm vi:** runtime/process boundary, application flow, API/protocol surfaces, outbox và persistence implementation, security/observability boundary, data ownership và application-level invariants của control plane `push-notification`.
> Business semantics (khái niệm, quy tắc nghiệp vụ, lifecycle, invariant nghiệp vụ, domain event) thuộc [`docs/domains/push-notification/domain-model.md`](../../domains/push-notification/domain-model.md) — tài liệu này không định nghĩa lại.
> Requirement → [`02-requirements.md`](./02-requirements.md) · vận hành/runbook → [`03-operations.md`](./03-operations.md) · delivery plane → [`docs/applications/web-push-notification-job/`](../web-push-notification-job/README.md) · system-wide policy → `docs/architecture/`.

---

## 1. Mục đích

`push-notification` là **control plane** thống nhất cho hệ thống Push Notification: quản lý vòng đời của `Device`, `Push Subscription`, `Push Provider`, `Push Notification`, `Push Delivery` và `Push Routing Policy`. Thành phần này:

- Nhận notification intent từ business service qua internal API (Service Binding, không public hostname).
- Thực hiện `Push Routing` (resolve users → devices → subscriptions → filter ineligible → routing policy → chọn transport → chọn provider → tạo `Push Delivery`).
- Tạo `Push Delivery` và `Outbox Entry` trong cùng một `db.batch()` của D1 `push`; publish `Delivery Command` vào Cloudflare Queue `ecoma-push-delivery` qua `Outbox Publisher` sau khi transaction commit.
- Cung cấp `Admin API` cho `Backoffice` (quản lý provider, credential, app-provider mapping, subscription, device, delivery).
- Cung cấp private delivery runtime API cho delivery worker `web-push-notification-job` (`claim`/`release`/`outcome`/`invalidate`, không có `GET`).

Thành phần này **không** thực hiện transport delivery (`Web Push`, `APNs`, `FCM`) — đó là trách nhiệm của delivery plane `web-push-notification-job` (component riêng). Giai đoạn đầu hỗ trợ `Web Push`; kiến trúc cho phép mở rộng `App Push` mà không đổi contract của caller (§13).

---

## 2. Phạm vi

**Trong phạm vi:** quản lý `Device`/`Push Subscription` · `Push Provider` + credential theo `App` · tiếp nhận notification intent · `Push Routing` theo policy · tạo và quản lý logical state của `Push Delivery` · đưa `Delivery Command` vào Queue (qua outbox — §6) · internal API cho application và `Admin API` cho `Backoffice`.

**Ngoài phạm vi** — thuộc delivery worker ([`docs/applications/web-push-notification-job/`](../web-push-notification-job/README.md)): thực hiện `Web Push`/`APNs`/`FCM` delivery · quản lý `Browser Push Service` · retry network delivery, xử lý DLQ. Thuộc business service: logic quyết định **khi nào** cần notification.

---

## 3. Kiến trúc tổng thể

```text
Ecoma Applications (backoffice · llm-seller · llm-console)
                    │  notification intent (internal API)
                    ▼
         ┌─────────────────────────┐
         │   push-notification     │  Cloudflare Worker (control plane)
         │   Device / Subscription │  D1 `push`
         │   Provider / Routing    │  Queue producer + Outbox Publisher
         │   Delivery / Admin API  │
         └───────────┬─────────────┘
                     │ Delivery Command
                     ▼
             Cloudflare Queue ──► web-push-notification-job (delivery plane)
                                       │
                                       ▼
                               Browser Push Service (Web Push)
```

- `push-notification` là **control plane**: Cloudflare Worker + D1 `push` + Queue producer; internal API, không public hostname — Service Binding theo `docs/architecture/01-architecture.md` §2.
- `*-push-notification-job` là **delivery plane**: Worker + Queue consumer + D1 riêng cho job state. Ranh giới giữa hai plane là Cloudflare Queue.
- `web-push-notification-job` **không truy cập D1 `push`** — dữ liệu control plane đi qua private delivery interface (§8.1).
- Mỗi environment (`development`, `staging`, `production`) dùng D1, Queue, provider configuration và secrets độc lập.

**Runtime / process boundary.**

- Cloudflare Worker (control plane), internal API qua Service Binding; không public hostname (`workers_dev: false`).
- D1 `push` — storage owner của control plane; mỗi environment một D1 riêng.
- Queue producer: `ecoma-push-delivery` (+ DLQ `ecoma-push-delivery-dlq`).
- Private delivery runtime API dùng `PUSH_NOTIFICATION_SERVICE` Service Binding; caller là `web-push-notification-job` qua `X-ECOMA-PRINCIPAL: svc.web-push-notification-job` + shared secret (`Cloudflare Worker Secret`).
- `Outbox Publisher` là component của control plane, nằm trong (hoặc cùng deployment với) Worker — **không** thuộc delivery plane, không thực hiện delivery (§6.2).

**Luồng end-to-end (orchestration).**

1. Business service gửi notification intent (`POST /v1/notifications`) với `Idempotency-Key`.
2. Control plane authenticate, resolve `app` từ authenticated principal, validate shape, authorize theo template/operation, rate limit.
3. Routing hoàn tất trước khi enqueue: resolve users → devices → subscriptions → filter ineligible → áp routing policy → chọn transport → chọn provider → tạo `Push Delivery` (`status = 'pending'`).
4. `Push Notification`, `Push Delivery`, `Outbox Entry` (và idempotency record — FR-008) ghi trong cùng một `db.batch()`.
5. `Outbox Publisher` claim outbox record `pending`, publish `Delivery Command` vào Queue `ecoma-push-delivery`, trong cùng thao tác ghi chuyển delivery `pending → queued` và outbox `publishing → published`.
6. Delivery worker `web-push-notification-job` consume Queue, claim delivery qua private delivery runtime API, thực thi delivery, báo outcome (`delivered`/`failed`).

D1 commit và Queue publish **không** atomic — hai hệ thống khác nhau; Queue publish là asynchronous boundary sau transaction. Duplicate publish phải được chấp nhận (§6, §7).

---

## 4. Architectural principles

### 4.1. Routing chỉ được thực hiện tại `push-notification`

Service là nơi duy nhất quyết định: gửi cho `Device` nào, dùng `Transport`/`Provider` nào, có gửi hay không, có loại bỏ subscription khỏi delivery hay không. Delivery worker chỉ nhận `Delivery Command` đã materialize (`transport`, `provider_id`, `subscription_id`) và thực thi. Quy tắc routing và `Transport Priority` canonical ở [`domain-model.md`](../../domains/push-notification/domain-model.md) §6.1; thứ tự thực hiện ở §5.5 dưới đây.

### 4.2. `Transport` và `Provider` là hai abstraction khác nhau

- `Transport` (`web`, `app`) — phương thức `Device` nhận notification.
- `Provider` (`web-push`, `fcm`, `apns`) — hệ thống bên ngoài thực hiện delivery.

`Chrome`, `Firefox`, `Edge` là `Browser Push Service` nằm dưới `web-push` protocol — **không** phải `Provider` abstraction của domain. Với `Web Push`, `Push Subscription` chứa `endpoint` do `Browser Push Service` cấp; service dùng `Web Push` protocol và credential tương ứng để delivery.

### 4.3. `App` là first-class concept

Mỗi `Push Subscription` thuộc về đúng một `App`; `App` không suy luận từ `Provider` — một `App` dùng được nhiều `Provider` và ngược lại. Namespace các `App` cô lập với nhau (§8.2).

---

## 5. Domain model — góc nhìn application

Khái niệm, quan hệ, lifecycle nghiệp vụ và policy canonical ở [`domain-model.md`](../../domains/push-notification/domain-model.md) §3–§6. Mục này chỉ ghi những gì là **cơ chế runtime/persistence** của control plane, và các ràng buộc kỹ thuật mà implementation phải giữ.

### 5.1. Device — identity và association

`Device` là logical identity của một thiết bị mà một `User` nhận `Push Notification`; một `Device` có nhiều `Push Subscription` thuộc các `Transport` khác nhau — cơ sở của `Transport Priority` (§5.5). **Device Identity** (logical `device_id` đã lưu) và **Device Association** (cơ chế gắn subscription vào đúng `device_id`) là hai khái niệm riêng:

- Web client v1: client tạo `device_id` ngẫu nhiên (UUID) khi lần đầu đăng ký, lưu tại client; mọi request đăng ký/ghi subscription gửi kèm `device_id`; không có `device_id` hợp lệ thì không tạo subscription; `device_id` được gán cho `User` của phiên đăng nhập khi đăng ký.
- Native app tương lai: link installation vào logical `Device` phải dùng explicit authenticated mechanism do application protocol định nghĩa riêng — không thiết kế chi tiết ở đây.
- Association **không bao giờ** suy luận gián tiếp: không dùng IP, User-Agent, browser name, network hay metadata không ổn định để nhận diện hai subscription là cùng một physical device (FR-011).

### 5.2. Push Subscription

Entity trong aggregate `Device` (→ [`domain-model.md`](../../domains/push-notification/domain-model.md) §4): một endpoint cụ thể mà notification có thể gửi tới, gắn `user_id`, `device_id`, `app`, `transport`, provider tham chiếu, status, timestamps. Với `Web Push`, tối thiểu lưu dữ liệu cần cho protocol: `endpoint`, `p256dh`, `auth`, và `vapid_key_id` dùng lúc tạo.

Subscription không còn hợp lệ (`disabled`/`expired`) **không** tiếp tục nhận delivery mới (lifecycle → [`domain-model.md`](../../domains/push-notification/domain-model.md) §5.1). `invalidate` chỉ đổi `active → disabled` qua private delivery runtime API (§8.1); transition `expired` theo vòng đời subscription không do operation này set ở v1.

### 5.3. Push Provider

Cấu hình delivery provider do service quản lý (`type`, `name`, `status`, app scope, credential reference, configuration); credential nhạy cảm không trả về qua API đọc configuration (§9).

**Provider disable semantics** (áp dụng thống nhất — `03-operations.md` §6.3):

```text
provider disabled ──> không tạo NEW delivery
```

- Chỉ có nghĩa **dừng routing cho delivery mới**; delivery đã materialize với `provider_id` giữ nguyên quyết định đó — queued delivery tiếp tục xử lý, **không** implicit cancel.
- Reroute delivery đã materialize sang provider khác là **administrative recovery operation riêng**, chủ đích, có audit — không xảy ra tự động.
- `Provider disabled` **KHÔNG** làm một delivery trở thành `ineligible`. Điều kiện `ineligible_provider_hold` chỉ áp dụng cho **emergency hold/revoke** (`03-operations.md` §6.5).
- **Provider scope theo `App`:** credential tách theo `App`, thay đổi/rotate/migrate độc lập từng `App`, giới hạn blast radius.

**Provider selection (v1):** mỗi tổ hợp `App` + `Transport` có đúng một active primary provider. Nhiều provider cùng `App`+`Transport` mà không xác định được primary: routing **fail safely** — không chọn random, không chọn theo thứ tự database. `priority`, `fallback`, `weighted routing` là future extension, v1 không implement.

### 5.4. Push Notification

Ý định gửi notification tới một hoặc nhiều `User`; **không** gắn trực tiếp với `Push Subscription` (→ [`domain-model.md`](../../domains/push-notification/domain-model.md) §3):

```text
Push Notification ──> Push Routing ──> Push Delivery[]
```

Một notification có zero, one hoặc nhiều delivery độc lập.

- `notification_id` là identity của notification; **API idempotency** yêu cầu `Idempotency-Key` **bắt buộc** do caller cấp (scope `(app, principal_id, idempotency_key)`) — semantics đầy đủ ở `02-requirements.md` FR-008. `delivery_id` **không** phải API idempotency key — nó là logical delivery identity ở tầng Queue (§7).
- Mỗi notification có `expires_at`; delivery `pending`/`queued`/`processing` vượt `expires_at` chuyển `expired` và **không** gửi (§5.6 · `02-requirements.md` FR-015).

### 5.5. Push Routing và Transport Priority

Thứ tự routing: resolve users → devices → subscriptions → filter ineligible → apply routing policy → select transport → select provider → create `Push Delivery`. Routing **hoàn tất trước khi** message vào Queue (§6).

`Transport Priority` mặc định `app > web`: `Device` có cả hai subscription hợp lệ cho cùng `App` thì chỉ tạo delivery cho `App Push`; `App Push` không tồn tại/không eligible thì dùng `Web Push`. Priority **chỉ** áp dụng khi hai subscription được chứng minh thuộc cùng một `Device` — không collapse delivery giữa hai `Device` khác nhau của cùng `User` (FR-010, FR-011).

### 5.6. Push Delivery và state

Resource độc lập, luôn tham chiếu một `Push Subscription`; mỗi delivery có `delivery_id` duy nhất. State machine business và nghĩa từng state canonical ở [`domain-model.md`](../../domains/push-notification/domain-model.md) §5.2 (`pending` · `queued` · `processing` · `delivered` · `failed` · `expired` · `cancelled`); transition table đầy đủ ở `02-requirements.md` FR-015 — mục này **không** định nghĩa lại.

`delivered`, `failed`, `expired`, `cancelled` là **terminal state**. Ngoại lệ duy nhất rời terminal state là administrative retry `failed → queued` (§5.6.1) — có authorization, audit, và precondition rõ ràng. Control plane tạo và quản lý logical state; delivery worker cập nhật kết quả delivery, **không** thay đổi routing decision đã tạo.

**Execution lease và fencing.** Lease (`lease_expires_at`) và fencing token (`dispatch_generation`) **chỉ** được cấp bởi **atomic claim** — `POST /internal/deliveries/:delivery_id/claim`, operation **duy nhất** cấp quyền thực thi delivery. Operation set **không** có thao tác đọc nào trả delivery material: **không có `GET`** (§8.1).

**Guarded conditional write (pattern canonical — đây là điểm quyết định thắng/thua).** Claim thắng khi và chỉ khi **một** statement `UPDATE` khớp predicate và D1 báo **đúng một dòng** thay đổi:

```sql
UPDATE push_deliveries
   SET status              = 'processing',
       dispatch_generation = dispatch_generation + 1,
       lease_expires_at    = :now + :lease_duration
 WHERE delivery_id = :delivery_id
   AND expires_at > :now
   AND ( status = 'queued'
      OR ( status = 'processing' AND lease_expires_at <= :now ) );
```

- **Thắng/thua nằm ở chính statement, không ở application.** Xác định claim thắng bằng số dòng **thực sự** bị thay đổi mà D1 trả về: `meta.changes == 1` → thắng (`docs/architecture/04-platform-facts.md` DB3). `meta.changes == 0` → predicate không khớp → **thua claim** → đọc lại điều kiện đã đổi để trả `409 <reason>` (§8.1).
- **Cấm read-then-write.** **MUST NOT** đọc state → quyết định ở application → ghi theo kết quả đọc cũ. Predicate nằm trong `WHERE` chính là thứ loại bỏ race đó; `db.batch()` tự nó **không** phải bằng chứng atomicity của một read-then-write.
- **`dispatch_generation` tăng đơn điệu** vì được tính từ giá trị hiện tại của hàng **trong cùng statement**. **MUST NOT** đọc generation ở application rồi ghi lại giá trị đã đọc (giá trị đó đã cũ nếu có execution khác xen vào).
- Lease, generation và delivery material **CHỈ** được trả khi claim thắng (`meta.changes == 1`), trong chính response `200` — §8.1.
- Nếu claim cần ghi kèm bảng khác, các statement đó nằm trong **cùng** `db.batch()` (`docs/architecture/04-platform-facts.md` DB2: chạy tuần tự, lỗi ở statement nào rollback cả dãy); statement quyết định thắng/thua **vẫn là** guarded `UPDATE` ở trên.
- **`now`** là một giá trị do **control plane** xác định duy nhất cho mỗi lần claim (một timestamp lấy một lần cho cả predicate lẫn `lease_expires_at`) — **không** dùng `now` khác nhau giữa nhánh kiểm tra và nhánh ghi. `lease_duration` là tham số cấu hình (§8.1); `lease_expires_at` do control plane quản lý, worker chỉ đọc.

**Giới hạn phải nêu rõ (MUST NOT overclaim).** D1 **không** tài liệu hoá isolation level hay row-level locking (`docs/architecture/04-platform-facts.md` DB11). Vì vậy tính đúng đắn **chỉ** dựa trên: (i) predicate nằm trong chính statement ghi, và (ii) mỗi DB xử lý query **một lần một cái**, ghi đi về primary (DB4, DB10). **MUST NOT** giả định có khoá hàng, `SELECT ... FOR UPDATE`, hay isolation `SERIALIZABLE`. Nếu một implementation cần nhiều hơn một statement để quyết định thắng/thua, đó là **thiết kế sai** — phải gộp điều kiện vào một statement có guard.

**Verification còn là launch gate (tách khỏi thiết kế đã chốt ở trên).** Correctness của pattern này dưới tải đồng thời **MUST** được chứng minh bằng integration/concurrency test trước production: N execution claim **cùng** một `delivery_id` đồng thời → **đúng một** nhận `200`, phần còn lại nhận `409 lease_held`; N execution ghi outcome với generation cũ → **tất cả** `409 stale_write`, state không đổi. Kết quả test này là **launch gate**; **không** được suy ra từ `db.batch()` hay từ tài liệu này.

**Chỉ ghi kết quả khi còn giữ generation hiện hành.** Worker **MUST** gửi `dispatch_generation` của lease đang giữ trong **mọi** write (`outcome`, `release`); fencing token được đối chiếu trong **cùng statement ghi** (guard `AND dispatch_generation = :generation` — §8.1), không bằng một lần đọc rồi quyết định ở application. Vì vậy:

- generation không khớp → write bị từ chối như **stale write**; outcome không được áp dụng, delivery state không đổi.
- lease hết hạn (`now > lease_expires_at`) → delivery trở lại **claimable** để Queue redelivery claim bằng một lease mới (generation mới); **không** có reaper tự chuyển state **vì lease hết hạn** — lease expiry chỉ làm delivery claimable lại, và chỉ execution giữ generation hiện hành mới ghi được outcome. (Việc đánh dấu `expired` là transition riêng, do reconciliation — xem dưới.)
- lease/fencing **không** thêm state mới: state machine và terminal states giữ nguyên FR-015.

**Ai thực hiện `queued|processing → expired`.** Transition này thuộc **control plane** — delivery plane **không** ghi terminal state, nó chỉ nhận `409 expired` từ claim và ACK an toàn. Control plane đánh dấu `expired` qua **logical delivery reconciliation** (`03-operations.md` §4.2 (c)) khi phát hiện delivery non-terminal (`pending`/`queued`/`processing` hết lease) đã vượt `expires_at`; không có cơ chế nào khác làm việc này. Vì vậy:

- Claim **KHÔNG** ghi state khi từ chối: `409 expired` là **no-op** với state (delivery vẫn non-terminal cho tới lượt quét của (c)) nhưng **không** claimable, và **MUST NOT** bị coi là lỗi transient.
- Execution **đang giữ lease** khi `expires_at` trôi qua vẫn ghi được `delivered`/`failed` — expiry chặn claim **mới**, **không** huỷ một lần gửi đã bắt đầu (`03-operations.md` §5.1).
- `expired` **MUST NOT** requeue: không có đường `expired → queued` (kể cả administrative retry, §5.6.1).

**Giới hạn của fencing (MUST NOT overclaim).** Fencing bảo vệ **logical state** phía control plane. Nó **KHÔNG** ngăn được external duplicate: một execution cũ đã gọi provider thành công nhưng chưa ghi outcome, rồi mất lease, vẫn đã tạo side effect ở provider — lease mới có thể gửi lại và provider tạo notification thứ hai. External duplicate nằm trong crash window đã chấp nhận (§7); **không** tài liệu nào được khẳng định fencing loại bỏ mọi duplicate phía provider.

**Administrative recovery transition.** Ngoài luồng claim, control plane có **một** transition vận hành được phép: terminal `failed → queued` (§5.6.1) cho administrative retry có authorization + audit. Đây là **ngoại lệ được kiểm soát**, không phải luồng thường.

Interface để worker claim lease và ghi outcome → §8.1; concurrency control phía delivery plane → [`docs/applications/web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §17.

### 5.6.1. Terminal failure và administrative retry

`failed` là terminal: **một** semantic duy nhất cho mọi delivery thất bại vĩnh viễn — không phân nhánh "failed nhưng retryable" ở tầng state (delivery plane retry transient **trước khi** kết luận, §5.6.2). Delivery vào `failed` khi: provider trả lỗi vĩnh viễn · subscription không hợp lệ · vượt ngưỡng retry · payload không hợp lệ tại delivery time.

Administrative retry là transition **duy nhất** rời khỏi terminal state:

```text
failed ──> queued        (administrative retry — authorization + audit bắt buộc)
```

- **Precondition canonical → `02-requirements.md` FR-015** (delivery `failed`; subscription `active`; provider không đang **emergency hold**; notification chưa quá `expires_at`); không thoả → **từ chối kèm lý do**, không requeue một phần.
- Loại trừ rõ: `delivered` **không** retry được qua đường này; delivery đã `expired` hoặc `cancelled` **không** requeue được — muốn gửi lại thì tạo notification mới. Delivery **non-terminal** (`pending`/`queued`/`processing`) cũng **không** đi qua operation này — chúng không ở terminal state nên không có gì để "hồi sinh"; đường phục hồi của chúng là (§5.6.3).
- Khi requeue: `dispatch_generation` tăng (không tái dùng generation cũ) và một outbox intent mới được ghi trong cùng transaction để message được publish lại (§6). Không tạo `notification_id`/`delivery_id` mới.
- ⚠️ Retry **có thể tạo external duplicate** nếu lần thử trước thực ra đã tới provider nhưng outcome không được ghi lại (§7 crash window). Operator phải chấp nhận rủi ro này một cách có ý thức; audit record ghi `actor`, `delivery_id`, `reason`.

### 5.6.2. Retry transient

Delivery plane phân loại kết quả provider và quy định thứ tự **release lease trước `retry()`** — **canonical ở [`docs/applications/web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §12**; error matrix HTTP canonical ở `03-operations.md` §5. Hệ quả phía control plane (vì control plane sở hữu claim predicate) → `03-operations.md` §5.1: worker **MUST** release lease (operation riêng trên private delivery runtime API, §8.1) **trước** khi trả `retry()`, nếu không message redelivery sẽ gặp `409 lease_held` và retry của Queue không thực sự retry provider.

### 5.6.3. Phục hồi delivery **non-terminal** bị mắc kẹt

Hai transition vận hành rời khỏi luồng thường, **phân biệt theo state của delivery** — không dùng lẫn:

```text
failed  ──> queued     administrative retry — delivery ĐÃ terminal (§5.6.1)
pending ──> pending    re-publish (không đổi state) — delivery CHƯA terminal, outbox không còn khả năng xử lý
```

- **Không phải đường tự động.** Chỉ dùng khi đường tự động đã cạn: outbox record `failed` (vượt `max publish attempts`) hoặc **không** còn outbox record nào cho `delivery_id`. Reconciler **MUST NOT** tự tạo intent trong hai trường hợp này (`03-operations.md` §4.2 (c)).
- **Operation:** `POST /admin/v1/deliveries/:id/republish` (`02-requirements.md` FR-017) — tạo **đúng một** outbox intent mới cho **cùng** `delivery_id`; **không** tạo `notification_id`/`delivery_id` mới; **không** đổi delivery state (publisher mới là actor của `pending → queued`, §6.2).
- **Precondition** (không thoả → từ chối kèm lý do): delivery **non-terminal**; chưa quá `expires_at`; subscription `active`; provider không **emergency hold**; **không** có outbox record `pending`/`publishing` nào cho `delivery_id` (chống dồn intent).
- **Không thể tạo external duplicate:** một delivery còn `pending` **chưa** từng được claim, nên chưa có request nào tới provider; re-publish chỉ có thể đưa nó sang `queued` để claim.
- Audit `delivery_republished` + `reason` + `actor` (`02-requirements.md` FR-020) và administrative authorization (FR-017/SR-004).
- **Bị chặn trên bởi `expires_at`:** quá `expires_at` thì đường phục hồi duy nhất còn lại là `expired` (terminal, không gửi) do reconciliation (c) đánh dấu — xem decision table `03-operations.md` §4.2. Muốn gửi lại sau đó thì tạo notification mới.

---

## 6. Transaction và outbox boundary

Sau khi routing hoàn tất, `Push Notification`, `Push Delivery` và `Outbox Entry` được ghi trong cùng một transaction của D1 `push`; `Outbox Publisher` publish `Delivery Command` vào Queue **sau** khi transaction đã commit.

- **"D1 transaction" trong tài liệu service = một `db.batch()`** (`docs/architecture/04-platform-facts.md` DB2 — D1 auto-commit, `db.batch()` gộp write atomically). Không dựa vào `BEGIN`/`COMMIT`/isolation level — hành vi transaction tương tác chưa xác minh (`docs/architecture/01-architecture.md` §10).
- **Không được giả định D1 commit và Queue publish là atomic** — hai hệ thống khác nhau; Queue publish là asynchronous boundary **sau** transaction.
- **D1 `push` — persistence implementation.** Schema và migration theo expand → compatible rollout → contract; không down-migrate. Không dùng transaction tương tác (`BEGIN`/`COMMIT`) — chỉ `db.batch()` (transaction tương tác D1 chưa xác minh). Inventory bảng/schema → `03-operations.md` §8.
- **Idempotency record.** `notification_idempotency` với `UNIQUE (app, principal_id, idempotency_key)`; retention tham số `idempotency_retention` (launch gate production, fail closed nếu chưa cấu hình — `02-requirements.md` FR-008). Idempotency record **MUST** được ghi trong **cùng** `db.batch()` với `Push Notification`/`Push Delivery`/outbox — không có cửa sổ tạo notification mà thiếu record idempotency.

### 6.1. Push Outbox Model

Record durable ghi lại một `Delivery Command` cần publish vào Queue:

```text
id · delivery_id · status · attempts · available_at
claimed_at · claimed_by · published_at · last_error · timestamps

pending ──> publishing ──> published    (Queue.send() thành công — terminal)
                  └──────> failed       (vượt ngưỡng attempts — recoverable, không xóa tự động)
```

- `pending` đã ghi trong transaction, chờ claim; `available_at` cho backoff. `publishing` đang giữ lease. `failed` vượt ngưỡng attempts nhưng vẫn recoverable để operator xử lý. `delivery_id` là tham chiếu duy nhất từ outbox record tới logical delivery.

**Claim predicate của outbox record** (đối xứng với claim predicate của delivery — §5.6):

```text
status = 'pending' AND available_at <= now
OR (status = 'publishing' AND lease_expires_at <= now)
```

`published` là terminal của record; `failed` **không** claimable — chỉ operator mới đưa nó trở lại đường publish (`03-operations.md` §4.1, §4.3). Publisher claim bằng **guarded conditional write** (cùng pattern §5.6: predicate nằm trong chính statement, thắng/thua xác định bằng `meta.changes == 1`; `docs/architecture/04-platform-facts.md` DB3), nên hai publisher chạy đồng thời **không thể** cùng giữ một record — publisher thua nhận `meta.changes == 0` và bỏ qua. Mọi thao tác ghi của publisher mang `claimed_by`/`claimed_at` của lần claim hiện tại; **MUST NOT** ghi khi không còn giữ claim (lease đã hết hạn) — record khi đó đã claimable cho publisher khác.

**Ràng buộc chống dồn intent (bắt buộc ở tầng database).** Với mỗi `delivery_id`, **tối đa một** outbox record ở trạng thái "đang chờ publish" (`pending` hoặc `publishing`) được tồn tại. Ràng buộc này **MUST** được enforce ở D1 (partial unique index trên `delivery_id` với điều kiện `status IN ('pending','publishing')` — `03-operations.md` §8), **không** chỉ bằng một kiểm tra đọc-rồi-ghi ở application: hai reconciler chạy đồng thời có thể cùng đọc "không có record nào đang chờ" rồi cùng tạo intent. Record `published`/`failed` **không** nằm trong ràng buộc (một intent mới hợp lệ được phép tồn tại cạnh chúng — §5.6.3, `03-operations.md` §4.2).

### 6.2. Outbox Publisher

Component của control plane, nằm trong (hoặc cùng deployment với) Worker — **không** thuộc delivery plane, không thực hiện delivery. Design rules:

- Claim record `pending` sau khi transaction commit, giữ lease hạn định; publisher crash → lease hết hạn → claim lại.
- **Publish thành công chuyển delivery `pending → queued` trong CÙNG một thao tác ghi** với `Outbox Entry` `publishing → published`: sau khi `Queue.send()` trả về thành công, publisher ghi `outbox.status := 'published'` **và** `delivery.status := 'queued'` trong một `db.batch()`, chỉ cho record đang giữ claim lease. Vì vậy:
  - `queued` nghĩa là **một Queue message đã tồn tại** (hoặc đã từng tồn tại) cho delivery đó; `pending` nghĩa là **chưa có lần publish nào thành công** — khớp đúng `reason = 'pending'` của claim (§8.1).
  - **Actor duy nhất** của `pending → queued` là `Outbox Publisher`. Delivery plane **MUST NOT** chuyển state này, và **không** có operation nào khác (claim/release/outcome) tạo ra `queued` từ `pending`.
  - **Guard của thao tác ghi (bắt buộc).** Write `delivery.status := 'queued'` **CHỈ** được áp dụng khi delivery **vẫn** đang `pending` — guard này nằm trong cùng `db.batch()` với `outbox.status := 'published'`. Nếu delivery đã rời `pending` trong lúc publish (bị (c) đánh dấu `expired`, bị mark `failed`, đã `queued` do một lần publish trước, hoặc đang `processing` vì consumer đã claim), publisher **MUST NOT** ghi `delivery.status`: chỉ ghi `outbox.status := 'published'` — publish **đã** thực sự xảy ra nên record không được retry vô hạn — và **MUST NOT** hồi sinh một terminal state. Message vừa publish trong trường hợp đó bị worker từ chối an toàn ngay theo contract claim (`409 terminal` / `409 expired` → ACK, không gọi provider — §8.1; [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §11), nên **không** cần cơ chế mới. Delivery đã terminal **KHÔNG** quay lại `queued` ngoài administrative recovery (§5.6.1, FR-015).
  - Crash **sau** `Queue.send()` nhưng **trước** thao tác ghi đó: delivery còn `pending`, outbox record còn `publishing` → consumer nhận message có thể claim và nhận `409 pending` (retry/backoff, ACK/retry theo bảng §8.1) trong khi publisher claim lại record và publish lại; hệ thống ưu tiên duplicate thay vì mất message.
  - `Queue.send()` **thất bại** → delivery **giữ** `pending`; record tăng `attempts`/`available_at` theo backoff. Record `failed` (vượt attempts) → delivery kẹt ở `pending` **chờ operator** (§6.1, `03-operations.md` §4.1–§4.2) — control plane **MUST NOT** tự chuyển delivery sang `queued` khi chưa publish được.
- **Không** thực hiện network call tới Queue hay external provider bên trong D1 transaction.
- **Cơ chế trigger của publisher (open launch gate — không được suy diễn).** Publisher **MUST** chạy định kỳ để claim record `pending`/`publishing` đến hạn; **cơ chế trigger cụ thể chưa chốt** và **MUST NOT** được giả định là đã tồn tại (điểm chung với `transactional-mail` chỉ là **chưa cấu hình và chưa implement**, **không** phải cơ chế chưa chốt: với `transactional-mail`, cơ chế trigger **đã được chốt** ở thiết kế — scheduled handler của chính Worker đó (`docs/applications/transactional-mail/01-architecture.md` §6.3); với `transactional-mailer-job`, thiết kế cũng quy định Worker có scheduled handler riêng (`docs/applications/transactional-mailer-job/01-architecture.md` §7); `docs/architecture/03-operations.md` §10 tóm tắt cả hai khẳng định này. Các scheduled handler đó đều **chưa** được implement, cấu hình hay xác minh runtime; `apps/push-notification/wrangler.jsonc` hiện **không** khai báo cron trigger). Entry point của publish là **`POST /internal/outbox/publish`** — route nội bộ **của control plane**, **không** thuộc private delivery runtime API (§8.1: API đó chỉ dành cho delivery worker), không trả material, không public. **Hai thuộc tính PHẢI TÁCH RÕ** (không được gộp thành một câu cam kết):

  - **(i) Không publish/network operation khi không có gì để publish.** Bất kể cơ chế trigger nào, khi không có record `pending`/`publishing` đến hạn, entry point **MUST** là no-op thuần: **không** `Queue.send()`, **không** ghi outbox record, **không** network call. Đây là thuộc tính của **handler**, kiểm chứng được bằng test.
  - **(ii) Không Worker invocation được tính phí khi không có gì để publish** — thuộc tính **RIÊNG**, mạnh hơn (i), và **CHƯA** được chứng minh cho bất kỳ cơ chế trigger nào. Một Cron/scheduled trigger **vẫn sinh invocation định kỳ** kể cả khi handler no-op, và tài liệu này **không** có bằng chứng platform nào (verify từ `04-platform-facts.md` + billing docs trước production) rằng invocation đó không được tính phí. **MUST NOT** kết luận "chọn cron trigger → satisfy (ii)". Nếu (ii) là yêu cầu kinh doanh, đó là **launch gate** của PR implementation, phải verify số liệu billing thật trước khi chốt.

  Thuộc tính (i) **bắt buộc** bất kể cơ chế trigger nào; (ii) là **open**. Riêng `outbox_recovery_sla` — mỗi record đến hạn **MUST** được claim trong vòng ngưỡng đó (giá trị cấu hình → `03-operations.md` §11) kể cả khi không có traffic API. Cơ chế gọi route này (Cloudflare Cron Trigger · relay ngoài · cơ chế khác) là **launch gate** cho PR implementation; tài liệu này **không** giả định một trigger đã tồn tại và **không** bịa cron.

- Record `published` xóa theo retention; record `failed` không xóa tự động. Tham số vận hành (poll interval, batch, lease timeout, backoff, monitoring) → `03-operations.md` §4.

### 6.3. Delivery Command — payload source of truth

Envelope của `Delivery Command` (Queue `ecoma-push-delivery`, field list canonical → `02-requirements.md` FR-013). Envelope chứa đúng **7 field**: `version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload`.

- `version` là số nguyên, hiện tại `1` (`DELIVERY_COMMAND_VERSION = 1`); `payload` chứa đúng **4 khoá** `title`, `body`, `url`, `data`; envelope là **closed schema** (reject field lạ).
- **Payload được materialize tại control plane** khi routing hoàn tất, ngay trong transaction đã commit (§6). Envelope chứa `transport`, `provider_id`, `subscription_id` cùng payload đã materialize — quyết định routing và nội dung payload là **immutable trong Queue**.
- Worker **MUST NOT** đọc lại payload từ private delivery runtime API để **thay thế** payload của message; runtime API chỉ dùng để **xác thực/đối chiếu** delivery material (§8.1).
- Private delivery runtime API **không** trả routing decision mới — không provider/subscription/transport thay thế (§8.1). Thay đổi routing sau khi materialize chỉ xảy ra qua administrative recovery operation riêng, có audit (§5.3).
- `app` **không** nằm trong envelope; nhiều `App` dùng chung queue `ecoma-push-delivery` và phân biệt bằng `transport` + `provider_id`. Worker lấy `app` từ runtime material (§8.1).
- Worker thực hiện delivery theo envelope; canonical contract → [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §5.

---

## 7. Delivery idempotency

> Đây là canonical location của logical-idempotency / crash-window model cho cả push pair; `web-push-notification-job` tham chiếu mục này.

Cloudflare Queue là **at-least-once** (`docs/architecture/04-platform-facts.md` QU1). Mỗi `Push Delivery` có một `delivery_id` duy nhất — **logical delivery idempotency key**: consumer nhận lại cùng `Delivery Command` không tạo thêm logical delivery mới; không dùng random identifier mới cho mỗi retry.

**Logical exactly-once khác external exactly-once:**

```text
logical exactly-once  !=  exactly-once external provider side effect
```

Crash window phải được chấp nhận: provider accept → worker crash trước khi persist `delivered` → Queue retry → **duplicate external notification có thể xảy ra**. Kết luận:

- hệ thống đảm bảo idempotent **logical state** (một `delivery_id` là một logical delivery, state transition không lặp sai);
- external duplicate notification nằm trong crash window đã chấp nhận; `delivery_id` **không** phải bằng chứng exactly-once ở external provider;
- client/service worker có thể dùng `notification_id` để deduplicate UX trong tương lai.

`delivery_id` là **logical delivery identity**, **không** phải API idempotency key — retry ở API `POST /v1/notifications` do caller điều khiển qua `Idempotency-Key` **bắt buộc** (`02-requirements.md` FR-008), không dùng `delivery_id`.

`Push Delivery` truy vết được theo chuỗi: `notification_id → delivery_id → subscription_id → provider_id`.

---

## 8. Interface boundary

### 8.1. Internal API, Admin API và private delivery runtime API

- **Internal API** cho các application `ecoma-io`: đăng ký device/subscription, tạo notification (capability → `02-requirements.md` §4). Service **không có public API** (`docs/architecture/01-architecture.md` §2).

  ```text
  POST   /v1/devices          GET/DELETE /v1/devices/:id
  POST   /v1/subscriptions    PATCH/DELETE /v1/subscriptions/:id
  POST   /v1/notifications
  ```

  `POST /v1/notifications` yêu cầu header `Idempotency-Key` bắt buộc (≤ 128 ký tự, thiếu → `400`) và áp rate limit theo `app` (`02-requirements.md` FR-008, FR-021).

- **Admin API** cho `Backoffice`: provider/credential/app-provider mapping/subscription/device/delivery (capability list → `02-requirements.md` FR-017).

  ```text
  GET/POST /admin/v1/providers            GET/PATCH/DELETE /admin/v1/providers/:id
  POST     /admin/v1/providers/:id/test
  POST     /admin/v1/providers/:id/rotate-credential
  POST     /admin/v1/providers/:id/hold   POST  /admin/v1/providers/:id/release
  GET      /admin/v1/devices
  GET      /admin/v1/subscriptions        PATCH /admin/v1/subscriptions/:id
  GET      /admin/v1/notifications
  GET      /admin/v1/deliveries           POST  /admin/v1/deliveries/:id/retry
                                          POST  /admin/v1/deliveries/:id/republish
  ```

  `hold`/`release` là emergency hold/revoke provider (không alias của `PATCH .../:id` với `status: disabled`); yêu cầu administrative authorization + audit `provider_held`/`provider_released`.
  `retry` là administrative recovery cho delivery terminal `failed` (tăng generation, outbox intent mới, audit `delivery_retried`).
  `republish` là operator recovery cho delivery non-terminal kẹt ở `pending` (không đổi state, không cấp generation, chỉ tạo outbox intent mới cho cùng `delivery_id`, audit `delivery_republished`) — §5.6.3.

- `Backoffice` **không** truy cập trực tiếp credential provider và **không** gọi trực tiếp `FCM`/`APNs`/`Browser Push Service`.

- **Private delivery runtime API** cho delivery worker — canonical location của interface này:

  ```text
  Queue → delivery_id → Private Delivery Runtime API → Push Delivery · Push Subscription · Push Provider · Provider Credential → Worker
  ```

  - **Lookup theo `delivery_id` duy nhất** — **MUST NOT** có tham số discovery theo `app`/`user`/`transport`/`provider`/`subscription`; **không** phải routing API, **không** trả routing decision mới (§6.3). Delivery material + credential được trả **trong response `200` của `claim`** cho execution vừa thắng lease, để worker thực thi đúng envelope; tham chiếu từ delivery plane → [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §6.
  - **Caller authorization bắt buộc ở tầng ứng dụng.** Cloudflare **không** phân biệt được Service Binding với internet, và endpoint private vẫn reachable từ Internet nếu Worker có hostname/route — nên `push-notification` **MUST NOT** dựa vào "chỉ Service Binding mới gọi được". Caller là `web-push-notification-job` qua Service Binding `PUSH_NOTIFICATION_SERVICE`; mọi request **MUST** mang principal header `X-ECOMA-PRINCIPAL` (giá trị `svc.web-push-notification-job`) + shared secret/`Authorization` cấp qua `Cloudflare Worker Secret` (`03-operations.md` §7.1). **KHÔNG** dùng header `X-ECOMA-APP` để định danh caller; self-declared header **không phải** proof của identity. Service Binding là **transport-level routing**, **không phải authorization boundary**.
  - **Verify trước khi xử lý**, kể cả trước khi lookup: principal/secret sai hoặc thiếu → `401`, response **MUST NOT** tiết lộ delivery có tồn tại hay không (không phân biệt "không có quyền" với "không tìm thấy").
  - Worker ghi outcome (`delivered`/`failed`) qua cùng interface này, kèm `dispatch_generation` khớp lease — semantics lease/fencing → §5.6. Authorization requirement của phía worker → [`web-push-notification-job/02-requirements.md`](../web-push-notification-job/02-requirements.md) SR-004.
  - **Operation set (đóng, least privilege).** Private delivery runtime API **CHỈ** expose:

    ```text
    POST /internal/deliveries/:delivery_id/claim      → 200 lease mới | 409 <reason>
    POST /internal/deliveries/:delivery_id/release    → 200 | 409 stale_write | 409 terminal
    POST /internal/deliveries/:delivery_id/outcome    → 200 | 409 stale_write | 409 terminal
    POST /internal/subscriptions/:subscription_id/invalidate   (chỉ khi provider chứng minh endpoint chết — `404`/`410`)
    ```

    **KHÔNG** có operation đọc delivery: operation set **không** có `GET`, vì `claim` đã trả đủ delivery material cho execution đang giữ lease và **không** có use case bắt buộc nào cần đọc delivery mà không claim (`POST .../claim` là **operation duy nhất** cấp quyền thực thi và là **operation duy nhất** trả credentialed material). Một endpoint chỉ trả metadata không phục vụ use case nào thì **MUST NOT** được giữ lại chỉ vì tài liệu trước đây đã liệt kê nó.

  - **`invalidate` request/response contract (canonical — đóng).** Request/response:

    ```text
    POST /internal/subscriptions/:subscription_id/invalidate
    Headers: X-ECOMA-PRINCIPAL: svc.web-push-notification-job · Authorization: <shared secret>
    Body:    {}   — KHÔNG nhận evidence/payload/credential. Điều kiện "provider chứng minh endpoint chết (404/410)"
                    là policy phía worker (web-push-notification-job 01 §16.8, 03 §5/§7.2); control plane
                    không verify được bằng chứng đó và MUST NOT tự fetch endpoint để kiểm chứng (`02-requirements.md` FR-003).
    200 → { "subscription_id": "<id>", "status": "disabled" }      — idempotent: gọi lần 2 vẫn 200
    404 → subscription_id không tồn tại                            — chỉ trả cho caller đã xác thực (401 xảy ra trước lookup)
    401 → sai/thiếu credential, trước lookup, không tiết lộ tồn tại (SR-006)
    ```

    `invalidate` **MUST NOT** nhận hay trả delivery material, `payload`, credential hay key material; response `200` là body ĐÓNG đúng hai field. `status` trong ack là **subscription state** theo vocabulary `FR-004` (`active` · `disabled` · `expired`) — **KHÔNG** phải một trạng thái riêng của operation. Execution hiện tại chỉ đặt `disabled` (nhánh `404`/`410`-provider → endpoint chết vĩnh viễn, §13 worker); `expired` là state dành cho subscription hết hạn theo chính sách vòng đời và **không** do operation này set ở v1 — nên ack của nhánh worker-path luôn là `disabled`. **MUST NOT** phát minh giá trị `"invalidated"` hay bất kỳ giá trị nào ngoài vocabulary `FR-004`: đó không phải state của subscription và ghi nó vào cột `status` sẽ tạo state thứ tư ngoài lifecycle. Idempotency: gọi lặp với cùng `subscription_id` đã `disabled` trả **cùng** `200` (không lỗi transition) — idempotent theo kết quả, không cần `Idempotency-Key`. Invalidate **chỉ** đổi subscription state (`active → disabled`); nó **không** đụng delivery state và **không** thu hồi claim đã thắng (giới hạn tuyến tính hoá ở claim contract). Chỉ nhánh `404`/`410`-provider được gọi operation này; `401`/`403` từ provider thì **không** (worker 01 §16.8).

    **KHÔNG** expose `Admin API`; **KHÔNG** có operation discovery theo `app`/`user`; **KHÔNG** có operation reroute. `web-push-notification-job` **KHÔNG** gọi `Admin API` và **KHÔNG** truy cập D1 `push` (owner → `docs/architecture/01-architecture.md` §4 · [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §6.1).

  - **Claim-result contract (canonical).** `POST .../claim` là **operation duy nhất** cấp lease **và** là operation duy nhất trả delivery material; **không** có `GET` để trả material ngầm định. Khi từ chối, response `409` kèm `reason` **machine-readable**; shorthand trong tài liệu là `409 <reason>`. Tập giá trị đóng (worker **MUST** xử lý đủ mọi giá trị):

    | `reason`                   | Nghĩa                                                      | Worker làm gì                   |
    | -------------------------- | ---------------------------------------------------------- | ------------------------------- |
    | `pending`                  | delivery chưa `queued` (chưa publish xong)                 | để Queue retry/backoff          |
    | `lease_held`               | `processing` và `lease_expires_at > now`                   | không gọi provider, ACK an toàn |
    | `terminal`                 | delivery đã ở terminal state (`state` kèm trong body)      | không gọi provider, ACK an toàn |
    | `expired`                  | `expires_at <= now`                                        | không gọi provider, ACK an toàn |
    | `ineligible_subscription`  | subscription `disabled`/`expired`                          | không gọi provider, ACK an toàn |
    | `ineligible_provider_hold` | provider đang **emergency hold** (`03-operations.md` §6.5) | không gọi provider, ACK an toàn |

    Worker phải xử lý **mọi** `reason`; một `reason` không nhận biết được → coi như lỗi contract, **không** gọi provider, **không** ACK mù (để vào DLQ qua retry bounded). Vocabulary này là **nguồn duy nhất** — delivery plane tham chiếu, không định nghĩa lại ([`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §11).

  - **`claim` request/response contract (canonical — implementation không phải đoán).**

    ```text
    POST /internal/deliveries/:delivery_id/claim
    Headers: X-ECOMA-PRINCIPAL: svc.web-push-notification-job · Authorization: <shared secret>
    Body:    {}   — claim KHÔNG nhận tham số điều khiển state nào; `lease_duration` do control plane
                   cấu hình, `now` do control plane xác định (dưới đây). Worker KHÔNG gửi `now`/generation.

    200 (claim thắng — execution được cấp quyền thực thi; tập field ĐÓNG như bảng dưới):
      { "delivery_id": "...", "notification_id": "...", "app": "...",
        "status": "processing",
        "expires_at": "<RFC3339>",
        "payload_digest": "<optional — chỉ khi control plane có digest algorithm chốt>",
        "dispatch_generation": <int>, "lease_expires_at": "<RFC3339>",
        "transport": "web", "provider_id": "...", "subscription_id": "...",
        "subscription": { "endpoint": "...", "p256dh": "...", "auth": "...", "vapid_key_id": "..." },
        "provider":     { "type": "web-push", "configuration": { ... }, "credential": { ... } } }
      // LƯU Ý: "transport": "web" (Transport) khác "provider.type": "web-push" (provider type).
      // payload KHÔNG có trong response này — nguồn duy nhất là envelope Queue (§6.3).

    409 (claim thua — response CHỈ có các field dưới, không material, không credential):
      { "reason": "<một trong 6 giá trị bảng trên>", "state": "<state hiện tại — CHỈ khi reason = 'terminal'>" }
    ```

    **Không có `payload` trong response `200`.** Envelope Queue (§6.3) là **nguồn duy nhất** của payload; trả payload ở đây sẽ tạo nguồn thứ hai và phá bất biến "payload immutable trong Queue". `payload_digest` (khi control plane trả) **CHỈ** phục vụ đối chiếu — worker **MUST NOT** dùng nó để dựng lại payload. Thuật toán/encoding của digest là **open item** (tên `payload_digest_algorithm`, hành động trước production → `03-operations.md` §11), nên `payload_digest` là **optional** trong response; worker đối chiếu khi có, và **MUST NOT** từ chối một response hợp lệ chỉ vì thiếu digest.

    **Tập field của `200` là ĐÓNG** (khớp nhóm runtime material ở [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §7):

    | Field                             | Kiểu                   | Ghi chú                                                                   |
    | --------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
    | `delivery_id` · `notification_id` | string                 | identity của delivery/notification                                        |
    | `app`                             | string                 | **không** có trong envelope — worker lấy từ đây cho metric/log            |
    | `status`                          | `"processing"` literal | đúng state sau khi claim thắng                                            |
    | `expires_at`                      | RFC3339 string         | hạn nghiệp vụ, worker kiểm tra **trước** khi gọi provider (§5.6)          |
    | `payload_digest`                  | string, **optional**   | chỉ để đối chiếu; thuật toán là open item                                 |
    | `dispatch_generation`             | integer ≥ 1            | fencing token worker gửi kèm mọi write                                    |
    | `lease_expires_at`                | RFC3339 string         | control plane quản lý, worker chỉ đọc                                     |
    | `transport`                       | `web` \| `app`         | **giá trị của `Transport`**, không phải provider type (xem dưới)          |
    | `provider_id` · `subscription_id` | string                 | tham chiếu, không có secret                                               |
    | `subscription`                    | object (4 field, đóng) | `endpoint` · `p256dh` · `auth` · `vapid_key_id` — subscription secret     |
    | `provider`                        | object (3 field, đóng) | `type` · `configuration` · `credential` — `credential` là provider secret |

    **`transport` trong cả envelope lẫn runtime material LUÔN là giá trị của `Transport`** (`web`/`app`) — với delivery v1 là `"web"`. **`web-push` là provider type** (`provider.type`), **KHÔNG** bao giờ là giá trị `transport`; một response/envelope dùng `transport: "web-push"` là **sai contract** và worker **MUST** từ chối an toàn. `transport` trả trong `200` là giá trị đã materialize của delivery, worker **MUST** kiểm tra nó khớp envelope trước khi gửi.

    **`state` trong `409` (canonical, đóng).** `state` **CHỈ** có mặt khi `reason = 'terminal'`; với **mọi** `reason` khác `state` **MUST NOT** có mặt. Lý do: chỉ nhánh `terminal` cần phân biệt state nào đã kết thúc (`delivered`/`failed`/`expired`/`cancelled`) vì `reason` không suy ra được nó; các `reason` còn lại đã xác định điều kiện từ chối và worker **MUST NOT** rẽ nhánh theo `state`. Vì vậy một `409` mang `state` cùng một `reason` khác `terminal` là **sai contract** (worker xử lý như lỗi contract, không gọi provider).

    **Mọi `409` là body ĐÓNG đúng hai field `reason` (+ `state` chỉ khi terminal)**: **MUST NOT** chứa `payload`, `payload_digest`, `subscription`, `provider`, `dispatch_generation`, `lease_expires_at`, hay bất kỳ runtime material/credential nào. Caller chưa thắng claim **không** nhận được gì ngoài `reason`/`state`. Worker **MUST** coi một `409` mang field ngoài tập đó là **vi phạm contract** (không gọi provider, không ACK mù).

    **Eligibility nằm TRONG chính statement claim (canonical).** `ineligible_subscription` và `ineligible_provider_hold` **MUST** được kiểm trong **cùng** guarded `UPDATE` với điều kiện state/lease — **không** phải một `SELECT` eligibility riêng rồi mới `UPDATE` (đúng lý do §5.6 cấm read-then-write: hai statement không có điểm quyết định chung). Predicate đầy đủ (tên bảng theo inventory `03-operations.md` §8; tên cột minh hoạ):

    ```sql
    UPDATE push_deliveries
       SET status              = 'processing',
           dispatch_generation = dispatch_generation + 1,
           lease_expires_at    = :now + :lease_duration
     WHERE delivery_id = :delivery_id
       AND expires_at > :now
       AND ( status = 'queued'
          OR ( status = 'processing' AND lease_expires_at <= :now ) )
       AND EXISTS (SELECT 1 FROM push_subscriptions s
                    WHERE s.subscription_id = push_deliveries.subscription_id
                      AND s.status = 'active')            -- eligibility của subscription
       AND EXISTS (SELECT 1 FROM push_providers p
                    WHERE p.provider_id = push_deliveries.provider_id
                      AND p.emergency_hold = 0);          -- CHỈ emergency hold, KHÔNG phải `disabled`
    ```

    `meta.changes == 1` → thắng. `meta.changes == 0` → thua, **chưa** biết lý do; worker (control plane) xác định `reason` bằng một lần **đọc chẩn đoán** theo thứ tự **cố định**: `terminal` → `expired` → `ineligible_subscription` → `ineligible_provider_hold` → `lease_held` → `pending`. Lần đọc này **CHỈ** đặt tên lý do cho `409` — nó **MUST NOT** là nguồn quyết định thắng/thua (quyết định đã nằm ở `meta.changes`), vì vậy nó không tái tạo lại read-then-write. Mọi nhánh không khớp điều kiện nào rơi về `lease_held` (an toàn: worker không gọi provider).

    **Thứ tự tuyến tính hoá (linearization) và giới hạn (MUST NOT overclaim).** Điểm tuyến tính hoá của claim là **chính lần ghi thắng**; mọi thay đổi subscription/provider **sau** thời điểm đó **MUST NOT** được mô tả là thu hồi claim đã thắng:
    - Subscription bị chuyển `disabled`/`expired`, hoặc provider bị **emergency hold**, **sau** khi claim thắng → claim **vẫn hợp lệ**, execution đang giữ lease vẫn ghi được outcome (`delivered`/`failed`). Đây là hệ quả trực tiếp của §5.6 (expiry/eligibility chặn **claim mới**, không huỷ lần gửi đã bắt đầu) và của §6.5 (hold chỉ chặn phần **chưa** gửi đi).
    - Provider `disabled` **không** nằm trong predicate: nó chỉ dừng routing delivery **mới** (§5.3), delivery đã materialize vẫn claim được.
    - Không có cơ chế nào trong tài liệu này đảm bảo revoke **retroactive** một claim đã thắng, và **MUST NOT** được mô tả như đang có. Muốn dừng một execution đang chạy, công cụ thật là **emergency hold** cho phần chưa gửi + alert/runbook — không phải giả định claim bị thu hồi.

  - **`now` và `lease_duration` (canonical).** `now` **MUST** được control plane xác định **một lần** cho mỗi `claim`, ngay trước statement claim, và dùng **nguyên** giá trị đó cho cả predicate (`expires_at > :now`, `lease_expires_at <= :now`) lẫn `lease_expires_at := :now + :lease_duration`. **MUST NOT** lấy thời gian hai lần trong cùng một claim (hai giá trị `now` khác nhau làm predicate và write không còn nhất quán, và một claim có thể vừa thắng vừa vi phạm guard của chính nó). `lease_duration` là tham số cấu hình của control plane (giá trị vận hành → `03-operations.md`), **không** do worker truyền.
  - **Idempotency của `claim`:** gọi `claim` hai lần cho cùng một message là an toàn — lần đầu `200` (lease mới, generation mới), lần sau `409 lease_held`; **không** có hai lease đồng thời cho cùng một `dispatch_generation`.
  - **Kết quả claim và hành vi Queue (canonical).** Worker **MUST** ánh xạ mỗi kết quả claim sang đúng một hành vi Queue; bảng này là nguồn duy nhất, [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §11 tham chiếu:

    | Kết quả claim                                                                                   | Worker làm gì với message                                                                                                |
    | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
    | `200`                                                                                           | thực thi delivery; ghi `outcome` bằng generation vừa nhận; `ack()` sau khi ghi outcome thành công                        |
    | `409 pending`                                                                                   | **KHÔNG** gọi provider, **KHÔNG** ACK — `retry()` để Queue thử lại theo backoff (đây là kết quả **duy nhất** dùng retry) |
    | `409 lease_held`                                                                                | **KHÔNG** gọi provider, `ack()` an toàn (message là duplicate; execution khác đang giữ lease)                            |
    | `409 terminal` · `409 expired` · `409 ineligible_subscription` · `409 ineligible_provider_hold` | **KHÔNG** gọi provider, `ack()` an toàn (**no-op theo policy**, không phải lỗi transient)                                |
    | lỗi contract (reason không nhận biết, response sai schema, `5xx` từ control plane)              | **KHÔNG** gọi provider, **KHÔNG** ACK mù — để Queue retry bounded rồi vào DLQ                                            |
    | không gọi được control plane (network/timeout)                                                  | **KHÔNG** gọi provider; `retry()` (không chứng minh được delivery đã được xử lý)                                         |

  - **Concurrency sub-scenarios của `claim` (acceptance — mỗi tình huống phải xác định state, response, và hành vi Queue):**

    | #   | Tình huống                                                                                                                               | State kết quả                                                                                               | Response                                        | Queue                                                                       |
    | --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
    | 1   | Hai worker claim **cùng** `delivery_id` gần như đồng thời (hai message duplicate)                                                        | **đúng một** thắng → `processing` + generation `+1`; worker kia không ghi gì                                | worker thắng `200`; worker kia `409 lease_held` | thắng thực thi; kia `ack()` (duplicate)                                     |
    | 2   | Worker A giữ lease hợp lệ; worker B nhận **duplicate** message                                                                           | không đổi (`processing`, generation của A)                                                                  | B `409 lease_held`                              | B `ack()` an toàn                                                           |
    | 3   | Lease của A **hết hạn**; B claim lại                                                                                                     | `processing` với **generation mới** (`+1`), lease mới                                                       | B `200`                                         | B thực thi                                                                  |
    | 4   | A ghi `outcome` bằng **generation cũ** sau khi B đã claim                                                                                | không đổi (state của B giữ nguyên)                                                                          | A `409 stale_write`                             | A `ack()` an toàn (không retry mù)                                          |
    | 5   | Delivery đã **terminal** nhưng message cũ vẫn còn trong Queue                                                                            | không đổi (terminal **không** bị hồi sinh)                                                                  | `409 terminal` (kèm `state`)                    | `ack()` an toàn                                                             |
    | 6   | Notification **hết hạn** (`expires_at <= now`) trước khi claim (kể cả khi đang ở Queue)                                                  | không đổi — claim là **no-op**, delivery vẫn non-terminal cho tới khi reconciliation (c) đánh dấu `expired` | `409 expired`                                   | `ack()` an toàn (**không** retry — retry không làm `expires_at` trôi ngược) |
    | 7   | Delivery `pending` (publisher chưa publish xong / crash sau `Queue.send()`)                                                              | không đổi (`pending`)                                                                                       | `409 pending`                                   | `retry()` theo backoff — **trường hợp duy nhất** retry                      |
    | 8   | Hai execution của **cùng** generation cùng ghi `outcome` (chỉ xảy ra nếu fencing bị vô hiệu; xem "Verification còn là launch gate" §5.6) | **đúng một** thắng; cái sau không đổi state                                                                 | thắng `200`; sau `409 stale_write`              | sau `ack()` an toàn                                                         |

  - `release` và `outcome` **MUST** ghi kèm `dispatch_generation` khớp lease đang giữ. Generation không khớp → `409 stale_write`; delivery đã ở terminal state → `409 terminal`. Cả hai **không** đổi state và **MUST NOT** được worker coi là lỗi transient (worker `ack()` an toàn, không gọi provider, không retry mù).
  - **`release` / `outcome` contract (canonical).** `release` là operation **trả lease**, **không** phải một kết cục của delivery — nó **không** ghi `failed` và **không** kết thúc delivery. Hiệu ứng state phải xác định, nếu không retry protocol (`03-operations.md` §5.1) không hoạt động được:

    ```text
    release (kèm dispatch_generation):
      generation không khớp                     → 409 stale_write (state không đổi)
      delivery đã terminal                      → 409 terminal    (state không đổi)
      status = 'processing' (đang giữ lease)    → 200: status := 'queued' · lease_expires_at := NULL · dispatch_generation KHÔNG đổi
      status = 'queued' (đã release trước đó)   → 200 no-op, idempotent (cùng generation)

    outcome (kèm dispatch_generation):
      generation không khớp                     → 409 stale_write (state không đổi)
      delivery đã terminal                      → 409 terminal    (state không đổi)
      status ≠ 'processing' hoặc lease đã hết   → 409 stale_write (state không đổi)
      status = 'processing' + generation khớp
        + lease còn hiệu lực                    → 200: status := 'delivered' | 'failed'
    ```

    **Thứ tự kiểm khi nhiều điều kiện cùng đúng** (`release` và `outcome` **cùng** thứ tự): generation → terminal → status/lease. Thứ tự này **không** đổi hành vi của worker: mọi `409` ở đây đều dẫn tới cùng xử lý (ACK an toàn, **không** gọi provider, **không** retry mù — bullet trên), nên nó chỉ làm kết quả **xác định** thay vì tuỳ implementation. `status ≠ 'processing'` / lease đã hết là `stale_write` chứ **không** phải `terminal`: delivery **không** ở terminal state, nên `409 terminal` sẽ mô tả sai state.

    **Request/response shape (canonical — đóng; implementation không phải đoán field):**

    ```text
    POST /internal/deliveries/:delivery_id/release
    Headers: X-ECOMA-PRINCIPAL: svc.web-push-notification-job · Authorization: <shared secret>
    Body:    { "dispatch_generation": <int> }        — CHỈ generation; KHÔNG outcome, KHÔNG payload, KHÔNG credential
    200 → { "delivery_id": "...", "status": "queued", "dispatch_generation": <int> }
    409 → { "reason": "stale_write" | "terminal" }   — body ĐÓNG: KHÔNG `state` cho `stale_write`;
                                                        `terminal` có `state` (quy tắc `state` chung, claim contract)

    POST /internal/deliveries/:delivery_id/outcome
    Headers: X-ECOMA-PRINCIPAL: svc.web-push-notification-job · Authorization: <shared secret>
    Body:    { "dispatch_generation": <int>, "outcome": "delivered" | "failed" }
             — `failed` KHÔNG mang provider response body/credential/endpoint; phân loại lỗi là job state của
               worker (D1 `push-job`), KHÔNG phải delivery material (worker §11b; không secret trong log/error —
               worker SR-002/SR-003).
    200 → { "delivery_id": "...", "status": "delivered" | "failed", "dispatch_generation": <int> }
    409 → { "reason": "stale_write" | "terminal" }
    ```

    Response `200` của `release`/`outcome` cũng là **body ĐÓNG** — **MUST NOT** mang payload, credential, subscription, hay provider material. `outcome` là set giá trị đóng `delivered`/`failed` (**không** nhận `expired`/`cancelled`: hai state đó thuộc control plane, worker **MUST NOT** ghi — §5.6).

    Vì `release` để lại delivery ở `queued` với `dispatch_generation` **không đổi**, message redelivery claim lại được ngay và nhận **generation mới**; execution cũ sau đó ghi outcome với generation cũ sẽ bị từ chối (`409 stale_write`). Delivery `queued` sau release mà message bị mất thì reconciliation (c) re-dispatch (`03-operations.md` §4.2). `release` là đường **duy nhất** đưa một delivery non-terminal trở lại `queued` (`02-requirements.md` FR-015).

  - **Credential chỉ trả khi claim thành công:** delivery material kèm provider credential **CHỈ** trả trong response `200` của `claim` (execution đang giữ lease). Trong mọi response khác — mọi `409` — response **MUST NOT** chứa credential, `subscription_id` secret, hay bất kỳ execution material nào: một caller chưa thắng claim **không** nhận được gì ngoài `reason` và `state` (khi terminal). Worker **KHÔNG** lưu credential (`02-requirements.md` SR-002, SR-004).
  - **Chọn credential theo `vapid_key_id` của subscription (canonical).** Với `web-push`, control plane **MUST** trả credential là VAPID key pair **khớp `vapid_key_id` của `Push Subscription` của delivery đó**, **không** phải "key hiện tại của `App`" — push service từ chối message ký bằng key khác key dùng lúc tạo subscription (`docs/architecture/04-platform-facts.md` §2.15; worker side → [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §7, §18). **Trong thời gian rotation, runtime resolution MUST vẫn trả được credential cho mọi `vapid_key_id` còn được subscription `active` tham chiếu** (kể cả key đang được retire) — nếu không, delivery tới subscription cũ mất khả năng gửi (`03-operations.md` §7.2). `vapid_key_id` không resolve được là **permanent failure** của attempt (worker side), không phải transient.

### 8.2. Application boundary

Mọi request phải xác định rõ `app`, và `app` MUST đến từ **authenticated principal**, không phải arbitrary body value: service đối chiếu `app` trong body với identity của principal; không khớp → từ chối. Recipient (`user_id`) chỉ dùng được khi principal có quyền gửi notification tới recipient đó. Application không gửi được notification vào namespace của application khác; application authorization kiểm tra trước khi tạo `Push Notification`.

---

## 9. Security boundary

**Ba loại secret phân biệt** (chi tiết requirement → `02-requirements.md` FR-006; rotation → `03-operations.md` §7):

1. **Provider credential** (`web-push` VAPID private key; `fcm`/`apns` key tương lai) — là provider credential theo `App` (§5.3), mã hoá at rest bằng root key, ghi kèm `credential_encryption_version`.
2. **Subscription delivery secret** (`auth`, `p256dh` của `Push Subscription`) — dữ liệu protocol của Web Push, **không** phải provider credential; vẫn **không** được vào log/Queue dưới dạng thô ngoài payload cần thiết.
3. **Root encryption key** — secret hạ tầng dùng để mã hoá provider credential; là `Cloudflare Worker Secret`, **không** bao giờ nằm trong D1 `push`, Git hay `wrangler` `vars`.

**Ba vòng đời rotation riêng biệt:** provider credential rotation (theo `App`, có `vapid_key_id` cho VAPID §5.3), subscription delivery secret (gắn trực tiếp với subscription — chỉ đổi khi client đăng ký lại subscription), root encryption key (multi-key K1→K2, `credential_encryption_version` theo dõi). **Rotating một loại KHÔNG tự động rotate các loại còn lại.**

Credential của `Push Provider` là secret; service đảm bảo:

1. Credential mã hóa khi lưu trữ, **không** lưu plaintext trong D1 `push`.
2. Credential không xuất hiện trong API response, application log, audit log không được bảo vệ.
3. Credential **không** đưa vào Cloudflare Queue message.
4. Delivery worker chỉ nhận provider reference và dùng credential qua private interface (§8.1).
5. `Admin API` và internal API có authentication/authorization riêng (§8).
6. **Chỉ control plane mới decrypt provider credential**; credential **chỉ được trả** tới execution **đang giữ lease hợp lệ**; delivery worker **KHÔNG** lưu credential bất kỳ đâu.
7. **VAPID `vapid_key_id`**: subscription và provider lưu `vapid_key_id` dùng lúc tạo; worker ký theo `vapid_key_id` của subscription, **không** phải key hiện tại của `App`. Subscription cũ giữ `vapid_key_id` cũ cho tới khi hết hiệu lực/re-subscribe (`03-operations.md` §7.2).

**VAPID key pair** là provider credential của `web-push` theo từng `App`, không phải secret hạ tầng dùng chung — sinh/lưu/rotate/revoke như credential khác (`03-operations.md` §7.2); private key **không** vào Queue, log hay API response; public key phục vụ client ở tầng application, không qua Queue.

**Endpoint validation của `Push Subscription`** chống SSRF (HTTPS-only, cấm userinfo, cấm IP literal/private/reserved, host allowlist so khớp theo nhãn, **không đi theo redirect**) là yêu cầu của **`02-requirements.md` FR-003** — canonical ở đó; validation chạy ở **control plane** khi đăng ký subscription, và **định kỳ re-validate** endpoint đã lưu khi cần thiết (subscription được đánh giá lại; endpoint không còn hợp lệ → `disabled`/handle theo policy). Delivery worker **MUST NOT** follow any redirect; mọi response `3xx` là permanent failure của attempt (`03-operations.md` §5).

`Cloudflare Worker Secret` (hoặc cơ chế tương đương) làm root key cho encryption credential — không cần Secrets Service riêng.

---

## 10. Failure isolation

Failure của một provider không làm hỏng toàn bộ service; failure của một `App` không ảnh hưởng `App` khác — provider configuration và delivery cô lập theo `App`, `Transport`, `Provider`. `Provider disabled` dừng routing delivery mới; delivery đã materialize giữ nguyên `provider_id`, không implicit cancel, không tự động reroute (§5.3). Outbox Publisher: record `pending` → `publishing` → `published` (Queue.send() thành công) hoặc `failed` (vượt ngưỡng attempts); crash sau `Queue.send()` nhưng trước ghi → delivery còn `pending`, outbox `publishing`, consumer nhận `409 pending` và retry/backoff (§6.2). `release` lease trước `retry()` cho transient retry (canonical: `release` trước `retry()`, §5.6.2); lease hết hạn → delivery claimable lại (không có reaper tự chuyển state do lease hết hạn); `expired` là transition riêng do logical delivery reconciliation (§5.6).

---

## 11. Observability boundary

Mọi operation quan trọng có correlation chain: `request_id → notification_id → delivery_id → subscription_id → provider_id`.

Log **không** được chứa: subscription secret, private key, provider credential, access token, payload chứa dữ liệu nhạy cảm ngoài phạm vi cần thiết; chỉ ghi các field thuộc whitelist. Payload notification **MUST NOT** chứa credential, token hay PII ngoài phạm vi hiển thị, và `data` là opaque với worker (`02-requirements.md` FR-008). Inventory metric/log/alert → `03-operations.md` §10–§11; system-wide observability policy → `docs/architecture/03-operations.md` §4.

---

## 12. Data ownership và dependency rule

`push-notification` (Worker + D1 `push` + Queue producer) là owner của:

```text
Device · Push Subscription · Push Provider · Push Provider Credential
App–Provider Mapping · Push Notification · Push Delivery · Push Routing Policy · Outbox · Audit
```

Business model, lifecycle và invariant nghiệp vụ của các entity này do bounded context `push-notification` sở hữu — canonical ở [`docs/domains/push-notification/domain-model.md`](../../domains/push-notification/domain-model.md); thành phần này hiện thực và tham chiếu, không lặp lại business rule.

Các domain service khác chỉ là **producer của notification intent** (bounded context `account`, bounded context `auth`, `payment`, `llm-api` → API/event) — không quản lý trực tiếp `Push Subscription` hay `Push Delivery`. Cross-service đi qua API/event/Service Binding theo `docs/architecture/01-architecture.md` §5.

```text
Business Services ──notification intent──► push-notification
                                              │ delivery command
                                              ▼
                                       Cloudflare Queue
                                              │
                                              ▼
                                     Delivery Jobs (transport-level delivery only)
```

- `push-notification` **không** phụ thuộc implementation của business service.
- Không dependency ngược: delivery worker **không** gọi `payment`/bounded context `account`/`auth`/business service (enforcement → `docs/architecture/05-code-architecture.md`).

---

## 13. Extensibility và architectural direction

Kiến trúc mục tiêu: một API thống nhất; một domain model cho `Web Push` và `App Push`; routing tập trung; delivery bất đồng bộ; failure isolation; không dependency trực tiếp giữa business service và push provider.

- **Hiện tại:** `Transport = web`, `Provider = web-push`, delivery qua `web-push-notification-job`.
- **Mở rộng:** thêm `Transport = app`, `Provider = fcm`/`apns`, thêm `app-push-notification-job` — application vẫn gửi cùng một `Push Notification Request`; khác biệt do `Routing Policy` và `Provider Selection` xử lý (§4.2, §5.5).
- `push-notification` giữ nhỏ ở mức domain và control plane; provider-specific implementation đẩy xuống delivery worker tương ứng.

---

## 14. Application-level invariants

1. `push-notification` là nơi duy nhất thực hiện `Push Routing`; delivery worker không routing lại.
2. `App` là first-class boundary; `Transport` và `Provider` là hai abstraction độc lập.
3. `Push Delivery` luôn tham chiếu một `Push Subscription`; mỗi delivery một `delivery_id` duy nhất.
4. Queue message phải idempotent; không suy luận cùng `Device` chỉ từ IP/User-Agent/metadata không ổn định.
5. `app` ưu tiên hơn `web` khi hai subscription thuộc cùng một `Device`.
6. Provider credential không xuất hiện trong Queue message, API response hay log.
7. Provider/`App` failure cô lập; `Provider disabled` dừng routing mới, không implicit reroute delivery đã materialize.
8. Business service không quản lý trực tiếp subscription/delivery; `push-notification` không thực hiện transport delivery.
9. Việc bổ sung `App Push` không yêu cầu đổi notification contract cơ bản.
10. Mỗi `App` + `Transport` đúng một active primary provider trong v1; không có primary → routing fail safely.
11. `Push Notification`, `Push Delivery`, `Outbox Entry` nằm trong cùng một `db.batch()`; D1 commit và Queue publish không atomic; duplicate Queue publish phải được chấp nhận.
12. `app` trong notification request lấy từ authenticated principal, không phải arbitrary body value.
13. `delivery_id` đảm bảo logical idempotency, **không** đảm bảo exactly-once external provider side effect (§7).
14. API idempotency của `POST /v1/notifications` yêu cầu `Idempotency-Key` **bắt buộc** (≤ 128 ký tự, thiếu → `400`) với scope `(app, principal_id, idempotency_key)`; `delivery_id` **không** phải API idempotency key (§5.4, `02-requirements.md` FR-008).
15. Delivery plane claim delivery bằng **atomic claim** — **guarded conditional write** với predicate nằm trong chính statement ghi (`status = 'queued'` hoặc (`status = 'processing'` và `lease_expires_at <= now`)); thắng/thua xác định bằng số dòng **thực sự** bị thay đổi (`04-platform-facts.md` DB3), **không** read-then-write. Claim thành công cấp `lease_expires_at` mới và tăng `dispatch_generation` (tính trong cùng statement) — lease/generation/material **chỉ** trả khi thắng. Outcome ghi với generation không khớp bị từ chối như stale write; lease hết hạn → claimable lại; **không** có reaper chuyển state **do lease hết hạn** (đánh dấu `expired` là transition riêng, do reconciliation (c) — §5.6). Fencing **KHÔNG** ngăn external duplicate (§5.6). Correctness **MUST NOT** được suy ra từ `db.batch()` hay từ một isolation guarantee: D1 **không** tài liệu hoá isolation level hay row-level locking (`04-platform-facts.md` DB11).
16. Payload materialize tại control plane và **immutable trong Queue**; private delivery runtime API **không** trả routing decision mới, **không** có `GET`, và **chỉ** trả delivery material/credential trong response `200` của `claim` (§6.3, §8.1).
17. Preview **MUST NOT** produce vào queue production; nhiều `App` dùng chung queue `ecoma-push-delivery`, phân biệt bằng `transport` + `provider_id` trong envelope — `app` **không** nằm trong envelope mà lấy từ delivery material (§6.3 · [`web-push-notification-job/01-architecture.md`](../web-push-notification-job/01-architecture.md) §7).
18. **Mọi delivery non-terminal có đường recovery xác định hoặc failure mode được phát hiện + alert trong SLA** — `expires_at` là chặn trên; không có delivery `pending` treo vô thời hạn không alert (§5.6.3, `03-operations.md` §4.2, §11).
19. **Tối đa một outbox record `pending`/`publishing` cho mỗi `delivery_id`**, enforce bằng partial unique index ở D1 — guard chống reconciler/operator đồng thời tạo intent trùng (§6.1, `03-operations.md` §8).
20. **Reconciliation MUST NOT** chuyển terminal → non-terminal; recovery chỉ tạo publish intent hoặc đánh dấu `expired` (§5.6.3, `03-operations.md` §4.2).
21. **Ba cơ chế reconciliation phân biệt** — (a) outbox reconciliation, (b) job reconciliation, (c) logical delivery reconciliation — mỗi cơ chế chỉ ghi state thuộc owner của mình, **không** ghi chéo, và **không** cơ chế nào tự chuyển `pending → queued` (§4.2, §5.6.3, `03-operations.md` §4.2).
22. **`outbox.status = 'published'` KHÔNG chứng minh consumer đã xử lý** — vì vậy recovery của delivery non-terminal **MUST NOT** đòi hỏi một job record tồn tại (§4.2, `03-operations.md` §4.2).
