# Web Push Notification Job Operations

> **Phạm vi:** Queue/retry/DLQ operations, provider failure handling, runbook, rollout, capacity của `web-push-notification-job`.
> Error matrix canonical → `docs/applications/push-notification/03-operations.md` §5 · outbox runbook (control plane) → `docs/applications/push-notification/03-operations.md` §4 · system Queue rules → `docs/architecture/03-operations.md` §11.3 · platform fact → `docs/architecture/04-platform-facts.md` §2.8.

## 1. Runtime

```text
web-push-notification-job
├── Cloudflare Worker
├── Cloudflare Queue consumer
└── Cloudflare D1 `push-job`
```

Worker không expose public HTTP API và **không truy cập D1 của `push-notification` hay service khác**. D1 `push` thuộc control plane; D1 `push-job` thuộc service này, authoritative cho job state (attempt, processed marker, việc kẹt — `01-architecture.md` §11b). Không có path nào tới PostgreSQL. Private communication với `push-notification` qua `Service Binding` hoặc cơ chế private tương đương.

**D1 `push-job`:** migration bằng `wrangler d1 migrations` (track D1 — `docs/architecture/02-delivery.md` §3). D1 **không** thuộc Backup/DR scope (`docs/architecture/03-operations.md` §3.1); retention/quota chưa chốt → `docs/architecture/03-operations.md` §10; recovery ở mức service → §17. Time Travel không phải cam kết phục hồi (`docs/architecture/04-platform-facts.md` DB5).

## 2. Deployment

Deployment phải bao gồm: Worker · Queue Consumer · Dead Letter Queue · Service Binding · D1 binding `push-job` · Runtime Secrets.

- Deployment MUST không yêu cầu downtime của `push-notification`.
- Worker version mới phải consume được các Queue message version đang được hỗ trợ.
- Mechanics deploy/rollback chung → `docs/architecture/02-delivery.md` §7–§8.

## 3. Configuration

Runtime configuration tối thiểu:

```text
QUEUE · PUSH_NOTIFICATION_SERVICE · LOG_LEVEL · ENVIRONMENT
```

Ngoài biến cấu hình, Worker phải có **D1 binding** tới `push-job` — không có binding này thì job state không ghi được (FR-022). Sensitive configuration (`delivery runtime authentication`, encryption key nếu dùng) không lưu trong source code — chính sách secret → `docs/architecture/02-delivery.md` §6.

## 4. Queue Configuration

Queue phải có: `consumer`, `batch size`, `batch timeout`, `max retries` (retry policy + backoff), `max concurrency`, `dead letter queue`, per-message ACK/retry.

- **Per-message ACK/retry là bắt buộc:** mỗi message trong batch ACK, retry hoặc chuyển DLQ độc lập; message fail permanent MUST không retry lại các message khác trong batch.
- **Retention:** message không được consume trong retention bị xoá vĩnh viễn; message trong DLQ sống trong cửa sổ retention ngắn (giá trị → `docs/architecture/04-platform-facts.md` QU3/QU5, hệ quả vận hành → `docs/architecture/03-operations.md` §11.3). Không có retention-loss path nào khác để lấy message về — vì vậy cần reconciliation: **job reconciliation** (§14.10) cho việc **đã có job record**, và **logical delivery reconciliation** (cơ chế (c)) của control plane (`docs/applications/push-notification/03-operations.md` §4.2) cho message **chưa từng được consume**.
- Queue message phải có schema version (NFR-008).
- Concurrency phù hợp `provider rate limit`, expected latency, Worker limits (`docs/architecture/04-platform-facts.md` §2.2). Không scale worker vượt khả năng xử lý của provider.
- **Retry policy của Queue phải khớp protocol retry (§5):** `max_retries`, `retry delay`, DLQ phải được đối chiếu với ba nhóm outcome và thao tác release lease trước `retry()` — nếu không, retry của Queue không thực sự tới provider (§5). Giá trị cụ thể là operational item chưa chốt (`docs/architecture/03-operations.md` §10).

### 4.1 Environment isolation

- Mỗi environment (`development`, `staging`, `production`) có Queue · D1 · provider configuration · secrets **độc lập**.
- `staging` và `production` **không** dùng chung provider credential.
- **Preview safety:** Preview **produce được nhưng không consume được** (`docs/architecture/04-platform-facts.md` QU7). Preview producer không được cấu hình để đẩy vào queue production theo đường làm cho production consumer xử lý; delivery path của Preview phải dùng queue riêng hoặc bị vô hiệu. Worker **MUST NOT** consume từ production queue khi chạy ở Preview; **MUST NOT** dùng D1/credential production khi chạy ở Preview.
- Fan-out nhiều `App` dùng **cùng một queue** `ecoma-push-delivery`; message phân biệt theo `transport`/`provider_id` trong envelope; `app` **không** có trong envelope (7 trường cố định — `01-architecture.md` §5) — worker lấy `app` từ delivery material (`01-architecture.md` §7) — **không** tạo queue riêng cho từng `App` ở v1.

## 5. Retry Policy

Phân loại mã lỗi theo **error matrix canonical** ở `docs/applications/push-notification/03-operations.md` §5; mục này chỉ nêu policy của delivery worker. Ba nhóm outcome, xử lý thống nhất:

- **Determinate terminal** — `2xx`/`404`/`410`/`401`/`403`/`413`. Ghi outcome kèm `dispatch_generation`, rồi **ACK**. `404`/`410` → class `endpoint_invalid` → mark failed, invalidate subscription, ACK (**không** retry); `401`/`403` → provider-level path, **không** invalidate subscription (§7.2); `413` → payload failure.
- **Determinate retryable — provider đã trả lời hoặc lỗi trước khi gọi provider** (`429`, `5xx`, lỗi validate/kết nối/runtime-resolve trước khi gửi) → **release lease** rồi `retry()`.
- **Indeterminate — request CÓ THỂ đã tới provider** (timeout sau khi đã gửi, connection reset giữa response, runtime API fail sau khi gọi provider) → cũng **release lease** rồi `retry()`; đây là nguồn duplicate tiềm năng (alert policy §12).

Quy tắc:

- **Worker MUST release lease trước khi trả `retry()`** (`POST /internal/deliveries/:delivery_id/release`, kèm `dispatch_generation`). Không release → delivery vẫn `processing` với lease còn hiệu lực → message redelivery gặp `409 lease_held` và bị ACK/skip → **retry vô hiệu** (lỗi correctness trung tâm). Generation không khớp khi release → `409`, state không đổi, ACK an toàn.
- Retry bounded, exponential backoff, jitter nếu cần, **per-message** — không theo batch; không retry vô hạn (trần `max_retries` Queue + attempt budget job state). **MUST NOT ACK** delivery vẫn còn cần xử lý.
- Phân biệt hai nhóm retryable ("request chưa tới provider" vs "có thể đã tới provider") MUST quan sát được trong **job state + log + metric**.
- Không hard-code `401/403 = invalid subscription`.
- **Retry authority:** retry external thuộc delivery worker + Cloudflare Queue; worker **không** retry publish. Retry publish thuộc control plane outbox. Error matrix canonical — `docs/applications/push-notification/03-operations.md` §5. `POST /admin/v1/deliveries/:id/retry` là administrative recovery (không tự động).

## 6. Dead Letter Queue

Message chuyển tới DLQ khi: retry exhausted · unsupported message · poison message · unrecoverable processing error.

DLQ message phải giữ: `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, original message, failure metadata. Không đưa secret vào DLQ payload (bao gồm `auth`, `p256dh`, VAPID private key, provider secret, authorization header).

## 7. Provider Failure Handling

Tách bạch bốn loại failure — không gộp chung:

### 7.1. Subscription failure

Provider chứng minh subscription invalid (`404` hoặc `410`) → mark delivery failed → disable subscription → ACK. Chỉ loại này mới invalidate subscription.

### 7.2. Provider credential/configuration failure

`401`/`403` → record provider-level failure theo `provider_id` → alert operator → mark delivery failed (permanent cho delivery attempt — FR-009) → ACK. Không retry; **không** invalidate subscription. Remediation ở control plane cho các delivery **tiếp theo**: rotate credential, hoặc **disable provider cho routing mới** — delivery đã materialize **không** bị ảnh hưởng bởi `disable` (routing mới) và vẫn tiếp tục xử lý. Muốn chặn delivery **đã materialize**, control plane phải dùng **emergency hold** của provider (§9). Không disable subscriptions của provider chỉ do credential/configuration lỗi.

### 7.3. Provider outage

`5xx`/`429`/network (provider down hoặc throttling) → transient → retry với backoff → theo dõi backlog, giảm pressure thay vì tăng concurrency. Không reroute — delivery giữ `provider_id` đã materialize.

### 7.4. Payload failure

`413` → permanent → mark delivery failed → ACK (không retry). Payload failure là delivery-level issue; không ảnh hưởng subscription eligibility.

## 8. Provider Credential Rotation

Khi `push-notification` thay đổi credential (Backoffice → Admin API → provider configuration updated), các delivery mới dùng credential mới; delivery đang nằm trong Queue **không** chứa credential cũ. Worker resolve credential tại delivery time qua private runtime interface và không cache credential lâu hơn policy cho phép. Worker không cần biết credential được encrypt thế nào trong database — decrypt thuộc control plane.

## 9. Provider Disable và Emergency Hold

Hai operation của provider **KHÁC NHAU** — không đánh đồng:

- **`disable for new routing`** → không có delivery mới (routing phía control plane). Delivery **đã materialize** (kể cả đang trong Queue) **giữ nguyên** `provider_id` và **tiếp tục được xử lý** — `disable` **KHÔNG** làm delivery ineligible. Worker **không** tự ý reroute (`01-architecture.md` §9).
- **`emergency hold/revoke`** → delivery **đã materialize** trở thành **ineligible**: claim trả `409 ineligible_provider_hold`, worker **không** gọi provider, **không** tự reroute. Emergency hold **không** recall được request provider đã accept.

Worker chỉ đọc kết quả claim (`01-architecture.md` §9, §11); phân biệt hai operation (bảng đối chiếu, audit `provider_held`/`provider_released`, runbook khẩn cấp) → canonical `docs/applications/push-notification/01-architecture.md` §5.3, `docs/applications/push-notification/03-operations.md` §6.3, §14.

## 10. Rollout và Worker Restart

**Worker restart** có thể xảy ra bất kỳ lúc nào: persistent delivery state quyết định `already delivered` hay `still pending` — không dựa vào process memory; duplicate Queue message sau restart phải an toàn (FR-001, NFR-002).

**Rollout sequence:** `deploy new Worker → health/startup verification → consume small backlog → observe error rate → continue rollout`. Theo dõi: `queue backlog`, `delivery latency`, `delivery success rate`, `retry rate`, `DLQ rate`, `provider error rate`, `worker exceptions`.

Rollback Worker version → `docs/architecture/02-delivery.md` §8. Rollback khi: abnormal failure rate · unexpected duplicate delivery · schema incompatibility · provider authentication failure · persistent runtime resolution failure.

## 11. Observability

Dashboard tối thiểu:

- **Queue:** `queue backlog` · `queue age` · `consumer errors` · `DLQ size`
- **Delivery:** `delivery success rate` · `delivery failure rate` · `retry rate` · `delivery latency`
- **Provider:** `provider requests` · `provider errors` · `provider latency` · `provider rate limiting`
- **Subscription:** `active subscriptions` · `invalidated subscriptions` · `subscription invalidation rate`
- **Job state (D1 `push-job`):** job đã nhận nhưng quá ngưỡng chưa kết thúc (kẹt) · processed marker lỗi / reconciliation sweep age · tuổi message lớn nhất trong Queue (so với retention — `docs/architecture/03-operations.md` §11.3)

**Metric tối thiểu phải expose:** `deliveries_consumed` · `deliveries_delivered` · `deliveries_failed` · `deliveries_retried` · `deliveries_skipped` · `subscriptions_invalidated` · `provider_request_total/success/failure/latency` · `queue_consumer_errors` · `runtime_resolution_errors` · `retry_count` · `dlq_messages`.

**Log và dimension:** Mỗi delivery execution emit structured logs với `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `attempt`, `outcome`, `duration`. Redaction bắt buộc: `auth`, `p256dh`, VAPID private key, provider secret, authorization header. Dimension tối thiểu `provider_id`, `app`, `transport`; **không** dùng `user_id`, `notification_id`, `delivery_id`, `endpoint` làm high-cardinality label. Correlation chain `request_id → notification_id → delivery_id → subscription_id → provider_id` có mặt trong mọi log. Observability **không** là serving-path dependency.

## 12. Alerts

```text
Queue backlog tăng liên tục · DLQ > 0 → Page (khớp docs/architecture/03-operations.md §5)
Reconciliation: job kẹt quá ngưỡng chưa kết thúc, hoặc sweep thất bại/quá hạn
Retry indeterminate (request có thể đã tới provider) tăng — nguồn duplicate tiềm năng (§5)
Delivery failure rate tăng · Provider error rate tăng · Runtime API failure tăng
Worker exception tăng · Provider authentication failure
```

Alert MUST được **aggregate theo `provider_id`, `app`, `transport`** — không alert theo một message failure đơn lẻ; không dùng `delivery_id`/`notification_id` làm alert dimension (chỉ dùng trong log/tracing).

**Ngoại lệ:** `DLQ > 0` và alert reconciliation **không** nằm dưới quy tắc aggregate — đó là alert về dữ liệu đang chết, không phải rate.

## 13. Operational Correlation

Mọi incident phải truy được: `request_id → notification_id → delivery_id → subscription_id → provider_id`. Khi debug một notification cụ thể, operator phải xác định được: `created → routed → queued → consumed → delivered / failed`.

## 14. Common Failure Modes

### 14.1. Queue backlog tăng

Kiểm tra theo thứ tự: `worker active? → runtime API healthy? → provider reachable? → provider rate limited? → worker concurrency đủ?`. Không tăng concurrency trước khi xác định provider là bottleneck.

### 14.2. Delivery failures tăng đột biến

Phân loại theo `provider_id`, error class, `transport`, subscription status. Nếu chỉ một provider bị ảnh hưởng, không kết luận worker lỗi toàn hệ thống.

### 14.3. Runtime resolution failures

Kiểm tra: Service Binding · authentication · `push-notification` health · `delivery_id` existence · subscription/provider state. Không truy cập DB trực tiếp để workaround.

### 14.4. DLQ tăng

Phân loại trước: `schema error` · `unsupported transport` · `provider error` · `runtime API error` · `bug`. Chỉ replay sau khi nguyên nhân đã được xử lý. Không replay message có subscription đã permanent invalid (§15).

### 14.5. Duplicate notification

1. Tìm `notification_id`/`delivery_id`. 2. Kiểm tra Queue delivery count (at-least-once redelivery). 3. Kiểm tra idempotency state. 4. Kiểm tra crash window — model canonical ở `docs/applications/push-notification/01-architecture.md` §7. 5. Kiểm tra worker acknowledgement/retry behavior.

Duplicate do Queue redelivery + idempotency thiếu phải sửa ở consumer. Duplicate trong crash window là hành vi đã chấp nhận — không "sửa" bằng cách giảm Queue retry mà bỏ qua idempotency.

### 14.6. 401/403 spike

1. Phân loại theo `provider_id`. 2. Kiểm tra credential còn hạn / rotation đang dở. 3. Kiểm tra provider configuration thay đổi gần đây. 4. **KHÔNG** disable subscription hàng loạt. Xử lý ở provider level: rotate credential / sửa configuration / disable provider nếu systemic (§7.2).

### 14.7. 404 / 410 invalid subscription spike

1. Phân loại theo `provider_id`, `app`, `transport`. 2. Xác định `404`/`410` do endpoint hết hạn (bình thường sau khi user revoke) hay classification sai (`401`/`403` bị coi là invalid?). 3. Kiểm tra subscription invalidation rate. 4. Nếu bất thường: dừng mảng invalidate, điều tra root cause. Chỉ `404` hoặc `410` hợp lệ để invalidate subscription — cả hai đều là class `endpoint_invalid`; `http_status` giữ **riêng** `404` và `410` trong metrics/log (`provider_request_failure`) nên spike 404 và spike 410 tách biệt, điều tra theo từng giá trị.

### 14.8. 429 spike

1. Kiểm tra provider rate limit / throttling. 2. Giảm effective concurrency thay vì tăng. 3. Kiểm tra retry có respect `Retry-After`. 4. Theo dõi backlog — không resolve bằng tăng concurrency vô hạn.

### 14.9. Outbox backlog (control plane)

Delivery chưa bao giờ xuất hiện trong Queue → kiểm tra `push-notification` outbox backlog / publisher publish fail. Runbook: `docs/applications/push-notification/03-operations.md` §4. Worker không tự xử lý outbox.

Nếu delivery kẹt ở `pending` và **không** còn outbox record khả dụng, đường phục hồi là **operator** gọi `POST /admin/v1/deliveries/:id/republish` trên control plane (không phải worker; worker **MUST NOT** gọi Admin API). Quyết định table đầy đủ → `docs/applications/push-notification/03-operations.md` §4.2; alert bắt buộc → cùng file §11.

### 14.10. Message mất sau Queue retention (không tới DLQ)

Delivery **không bao giờ** xuất hiện trong Queue hoặc biến mất trước khi vào DLQ. Hai trường hợp tách biệt:

1. Kiểm tra tuổi message lớn nhất trong Queue so với retention (`docs/architecture/04-platform-facts.md` QU5).
2. **Message đã có consumer** (đã claim, có job record): đọc D1 `push-job` — delivery đã nhận nhưng quá ngưỡng chưa kết thúc? hoặc đã persist outcome nhưng chưa ack? → **job reconciliation** (FR-022) re-deliver qua Queue. Cơ chế này **chỉ** tìm được việc **đã có job record**.
3. **Message chưa từng được consume** (không có job record nào): job reconciliation **không** thấy được. Trường hợp này do **(c) logical delivery reconciliation** của **control plane** phát hiện — quét D1 `push` cho delivery non-terminal quá ngưỡng và re-dispatch **cùng `delivery_id`** (canonical → `docs/applications/push-notification/03-operations.md` §4.2; runbook → cùng file §15.8). Cơ chế (c) **không** ghi job state. Lưu ý: recovery của control plane **MUST NOT** đòi hỏi một job record tồn tại — `outbox.status = 'published'` **không** chứng minh consumer đã xử lý, nên thiếu job record là trạng thái **bình thường**, không phải lý do để bỏ qua delivery.
4. Worker **không** ghi logical delivery state — việc đó thuộc `push-notification`.

Mất message sau retention là **mất việc đã enqueue, không mất state** (`docs/architecture/03-operations.md` §11.3). **Không** nguồn nào **một mình** phủ hết: job reconciliation phủ việc đã có job record; cơ chế (c) của control plane phủ message chưa từng được consume.

**Hệ quả cho retention của idempotency record (không thuộc worker, ghi để tránh suy luận sai):** vì đường recovery có thể sống **lâu hơn** `queue_retention`, control plane **MUST NOT** xoá idempotency record khi Queue đã hết retention — điều kiện xoá canonical → `docs/applications/push-notification/02-requirements.md` FR-008. Worker **MUST NOT** suy ra "hết retention nghĩa là xong việc".

### 14.11. Crash windows

Các cửa sổ crash chính của luồng delivery (W1–W4 thuộc delivery plane; W5 thuộc control plane). Ba cơ chế reconciliation, ký hiệu dùng trong bảng: **(a)** outbox reconciliation · **(b)** job reconciliation (§14.10, D1 `push-job`) · **(c)** logical delivery reconciliation (control plane, D1 `push`) — cả ba canonical ở `docs/applications/push-notification/03-operations.md` §4.2; transition `pending → queued` canonical ở `docs/applications/push-notification/01-architecture.md` §6.2:

| #   | Crash window                                                              | Delivery state                 | Có job record?                               | ACK/retry                               | Đường hồi phục                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Worker crash **trước** claim                                              | `queued`, không lease          | có nếu attempt record đã ghi, không nếu chưa | Queue redelivery                        | claim thắng; message mất: **có** attempt record → **job reconciliation (b)** re-deliver; **không** có → chỉ **logical delivery reconciliation (c)** (`docs/applications/push-notification/03-operations.md` §4.2) thấy được → re-dispatch cùng `delivery_id`                        |
| W2  | Crash **sau** claim, **trước** khi gọi provider                           | `processing`, lease sẽ hết hạn | có (attempt mở)                              | Queue redelivery                        | lease hết hạn → claim mới; **job reconciliation (b)** phát hiện attempt kẹt; không còn message → **logical delivery reconciliation (c)** (`docs/applications/push-notification/03-operations.md` §4.2) re-dispatch cùng `delivery_id`                                               |
| W3  | Crash **sau** khi provider đã nhận request, **trước** khi persist outcome | `processing`, lease sẽ hết hạn | có (attempt mở, outcome chưa ghi)            | Queue redelivery                        | lease hết hạn → claim mới → gửi lại → **duplicate bên ngoài là crash window đã chấp nhận**; nếu message redelivery cũng mất sau đó → như W2 — **job reconciliation (b)** hoặc **logical delivery reconciliation (c)** (`docs/applications/push-notification/03-operations.md` §4.2) |
| W4  | Crash **sau** persist outcome, **trước** ACK                              | terminal                       | có (processed marker)                        | redelivery → claim trả `terminal` → ACK | không gọi provider (claim trả `409 terminal`, `state` trong body)                                                                                                                                                                                                                   |
| W5  | Publisher crash **sau** `Queue.send()`, trước khi mark `published`        | delivery vẫn `pending`         | —                                            | duplicate message, claim chỉ một thắng  | outbox (a) publish lại → duplicate message → atomic claim cho một execution thắng                                                                                                                                                                                                   |

- **Ai được ghi:** W1–W4 — worker ghi job state trên D1 `push-job`, control plane ghi logical delivery state qua claim/outcome/release; W5 — chỉ control plane ghi outbox record. Worker **không** ghi logical delivery state.
- Fencing (generation) ngăn hai execution cùng ghi outcome, nhưng **KHÔNG** loại bỏ duplicate phía provider ở W3 — crash window đã chấp nhận.

## 15. Replay

Replay từ DLQ phải giữ nguyên `delivery_id`; không tạo `Push Delivery` mới. Trước replay kiểm tra `delivery state` · `subscription state` · `provider state`:

- Delivery đã `delivered` → replay MUST không gửi lại.
- Subscription đã `disabled`/`expired` vì invalid (permanent) → **không replay**.
- Provider đang **emergency hold** hoặc credential đang lỗi → xử lý nguyên nhân trước khi replay. `disable for new routing` **không** chặn replay của delivery đã materialize (§9).
- Không replay message có `transport`/`provider.type` ngoài scope worker.

## 16. Security Operations

Operator MUST không đưa secret vào: issue · incident channel · log query · screenshot · DLQ. Credential rotation thực hiện qua Admin API của control plane; sau rotation verify: `new test delivery succeeds` · `old credential is no longer used` (§8).

**Caller authorization của private delivery-runtime API** (một contract duy nhất): shared secret xác thực **server-side trước** khi xử lý + principal header `X-ECOMA-PRINCIPAL` (`svc.web-push-notification-job`); **không** dùng `X-ECOMA-APP`; header tự khai **không** phải bằng chứng danh tính; sai/thiếu → `401`, **không** tiết lộ delivery có tồn tại hay không. **Service Binding KHÔNG phải authorization boundary.** Quyền tối thiểu của worker: claim/release/outcome/invalidate subscription/job state trên D1 `push-job`, và produce vào Queue `ecoma-push-delivery` **chỉ** cho reconciliation re-deliver của cùng `delivery_id` (FR-022); **MUST NOT** gọi Admin API; **MUST NOT** truy cập D1 `push` (`02-requirements.md` SR-004/SR-005; canonical → `docs/applications/push-notification/01-architecture.md` §8.1).

## 17. Disaster Recovery

Storage authoritative duy nhất của service này là D1 `push-job` (job execution state); D1 **không** thuộc Backup/DR scope (`docs/architecture/03-operations.md` §3.1) — không backup strategy, không restore runbook, không RPO/RTO. Push Delivery/Subscription/Provider thuộc D1 `push` của `push-notification` — service chỉ đọc qua private delivery-runtime API, không backup và không restore.

- **Mất D1 `push-job` là chấp nhận được** (dữ liệu không business-critical — `docs/architecture/01-architecture.md` A19). Recovery **ở mức service**: job state còn đọc được thì reconciliation xử lý; phần đã mất chỉ còn logical delivery state bên control plane (recovery tổng thể của control plane → `docs/applications/push-notification/03-operations.md` §12).
- Time Travel là platform capability destructive (`docs/architecture/04-platform-facts.md` DB5), **không** phải cam kết phục hồi và **không** phải runbook của service này.
- Worker runtime disposable; mất Worker instance không làm mất delivery state.
- Mất Queue consumer tạm thời không làm mất message trước khi retry/DLQ policy exhausted.
- ⚠️ Message bị xoá do **retention** không nằm trong cửa sổ đó: việc đã enqueue mất, job state (nếu delivery **đã có job record**) còn trong D1 `push-job` → tìm lại bằng job reconciliation (§14.10); message **chưa từng được consume** không có job record → do cơ chế (c) của control plane (`docs/applications/push-notification/03-operations.md` §4.2).

## 18. Capacity Management

Capacity điều chỉnh theo: `queue backlog` · `oldest message age` · `delivery latency` · `provider throughput` · `worker execution time`. Mục tiêu: giữ backlog ổn định, tránh vượt provider rate limit. Không dùng raw request rate của `push-notification` làm sole scaling signal.

Trần concurrency là **một** giá trị duy nhất: platform limit (`docs/architecture/04-platform-facts.md` QU6 — tối đa 250 invocation), **cùng** trần canonical ở `docs/applications/push-notification/03-operations.md` §16 — **không** hai số khác nhau. Provider throttling (`429`) → **giảm** effective concurrency, không tăng (§14.8).

## 19. Operational Invariants

1. Worker không có public application API.
2. Secret không nằm trong Queue hoặc DLQ (bao gồm `auth`, `p256dh`, VAPID private key, provider secret, authorization header).
3. Retry phải bounded (per-message, backoff, không vô hạn).
4. Chỉ subscription failure được provider chứng minh (`404` hoặc `410`) mới invalidate subscription; `401/403` là provider-level failure, không bulk-disable.
5. Credential rotation không yêu cầu thay đổi Queue contract.
6. Worker restart không làm mất persistent delivery state.
7. Rollback Worker không phá vỡ supported Queue schema; deployment không yêu cầu downtime của `push-notification`.
8. Queue envelope immutable: `version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload`. `payload` materialize tại control plane, worker không đọc lại để thay thế; D1 `push-job` ngoài Backup/DR scope.
9. `provider disabled` (dừng routing mới) **không** phải điều kiện ineligible cho delivery đã materialize; provider **emergency hold** thì **là** ineligible — worker không gọi provider, không reroute.
10. Worker release lease trước khi trả `retry()` cho Queue; fencing không loại bỏ duplicate phía provider; worker không ghi logical delivery state.
11. `claim` là operation **duy nhất** cấp quyền thực thi và **duy nhất** trả delivery material/credential — **không** có `GET`; mọi `409` không chứa material hay credential.
12. Không delivery nào ở `pending` treo im lặng: control plane **MUST** phát hiện + alert trong SLA (canonical → `docs/applications/push-notification/03-operations.md` §4.2, §11); operator recovery cho delivery non-terminal là `POST /admin/v1/deliveries/:id/republish` — **không** phải việc của worker.

> Architectural invariants (no reroute, D1 ownership, idempotency theo `delivery_id`, per-message ACK, state machine) → `01-architecture.md` §23.
