# Web Push Notification Job Requirements

> **Phạm vi:** FR/NFR/SR và non-goals của `web-push-notification-job`. Design → [`01-architecture.md`](./01-architecture.md) · vận hành → [`03-operations.md`](./03-operations.md) · error matrix canonical → `docs/applications/push-notification/03-operations.md` §5.

## 1. Functional Requirements

> Ghi chú đánh số: dãy FR của tài liệu này có lỗ hổng — `FR-010`, `FR-015`, `FR-016` **không tồn tại trong file này** (ba số đó thuộc `docs/applications/push-notification/02-requirements.md`, không phải cùng dãy). Giữ nguyên số hiện có vì `FR-022` được tham chiếu từ ngoài tài liệu này (`docs/applications/push-notification/03-operations.md` §4.2; `docs/applications/transactional-mailer-job/03-operations.md` §10); renumber sẽ phá các tham chiếu đó.

### FR-001 — Queue Consumption

Worker MUST consume `Delivery Command` từ Cloudflare Queue, chỉ xử lý message thuộc `transport = web` và `provider.type = web-push`. Worker MUST hỗ trợ **per-message acknowledgement/retry**: mỗi message trong một batch ACK, retry hoặc chuyển DLQ độc lập theo outcome của chính nó. Message không thuộc scope MUST được xử lý như unsupported delivery — không gửi provider, không retry vô hạn.

### FR-002 — Message Validation

Worker MUST validate `version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload`. Thiếu field bắt buộc MUST không gửi tới external provider. `version` không được hỗ trợ MUST xử lý theo non-retryable error policy. Envelope fields phải là **immutable**; payload đã materialize tại control plane.

### FR-003 — Runtime Resolution

Worker MUST resolve runtime delivery data cho `delivery_id` — đủ để validate delivery, load subscription, load provider, obtain provider credential. **Runtime resolution LÀ `claim`** (`POST /internal/deliveries/:delivery_id/claim`): private delivery runtime API **không** có operation đọc material riêng, và material + credential **CHỈ** có trong response `200` của `claim` (canonical → `docs/applications/push-notification/01-architecture.md` §8.1). Worker **MUST NOT** giả định tồn tại một bước lấy material trước khi claim; mọi `409` (mọi `reason`) **MUST NOT** chứa material hay credential, và worker **MUST NOT** dùng bất kỳ nguồn nào khác (D1 `push`, D1 `push-job`, cache) để thay thế. Worker MUST chỉ resolve đúng delivery được chỉ định; MUST NOT dùng runtime API để tìm delivery thay thế. Runtime API **không** trả routing decision mới. Runtime material **MUST NOT** chứa payload có thể **thay thế** payload của envelope; **MAY** trả `payload_digest` — `payload` nguồn sự thật duy nhất là envelope Queue, digest **chỉ để đối chiếu**, mismatch → contract violation (không gọi provider, đánh dấu attempt failure an toàn, alert). `app` (không có trong envelope) suy ra từ delivery material cho metric/log (`01-architecture.md` §7).

### FR-004 — Delivery Eligibility

Worker MUST xác định delivery còn eligible từ kết quả claim (`01-architecture.md` §11) trước khi external delivery — dựa trên `delivery status`, `subscription status`, `notification expires_at`, provider **emergency hold**, `transport`, `provider type`. Không còn eligible MUST skip **mà không gọi provider và không ghi state nào ngoài quyền worker** (worker chỉ ghi outcome `delivered`/`failed`; các terminal state khác — `expired`, `cancelled` — do control plane ghi; `01-architecture.md` §9, §11, §16). `provider disabled` **KHÔNG** phải điều kiện ineligible: delivery đã materialize giữ `provider_id` và **tiếp tục được xử lý**; provider **emergency hold** thì **LÀ** điều kiện ineligible (`ineligible_provider_hold`) — không gọi provider. Worker MUST NOT reroute sang provider khác.

### FR-005 — Web Push Delivery

Worker MUST thực hiện delivery bằng Web Push Protocol với subscription endpoint/keys và provider configuration/credential do control plane chọn. Happy path: `Queue → resolve runtime → Web Push → provider success → delivery = delivered → ACK`. Endpoint được control plane validate (scheme/allowlist `Browser Push Service`) tại thời điểm đăng ký subscription và bất biến theo routing decision; worker **MUST NOT** re-validate allowlist, **MUST NOT** tự lọc/đổi endpoint — dùng đúng giá trị nhận từ runtime resolution (canonical → `docs/applications/push-notification/02-requirements.md` FR-003). **Worker MUST NOT follow any redirect.** Mọi response `3xx` từ provider **MUST** được coi là **permanent failure** của attempt: ghi failed, ACK, không gọi tiếp sang host khác, **không** invalidate subscription — kiểm tra này không cần load allowlist, vì không thể đi theo redirect (canonical → `docs/applications/push-notification/03-operations.md` §5; `01-architecture.md` §16).

### FR-006 — Idempotency

Worker MUST dùng `delivery_id` làm idempotency key — guarantee **logical delivery identity**, MUST NOT diễn giải là exactly-once external provider side effect (`01-architecture.md` §10; model canonical → `push-notification/01-architecture.md` §7). Duplicate execution MUST NOT tạo duplicate logical delivery; delivery đã `delivered` MUST NOT gửi provider lần nữa.

### FR-007 — Delivery State

Worker MUST cập nhật delivery outcome (`delivered`, `failed`) thông qua private interface. Worker MUST NOT tạo state ngoài state machine định nghĩa ở control plane. Worker MUST ghi outcome kèm `dispatch_generation` nhận từ response `200` của `claim` (`01-architecture.md` §7) — envelope Queue **không** chứa field này và **không** có operation đọc nào trả nó; generation không khớp → stale write bị từ chối, ACK an toàn — **không** gửi lại provider. Lease/fencing: `dispatch_generation` + `lease_expires_at`; worker không tự gia hạn lease, không background reaper (canonical → `docs/applications/push-notification/01-architecture.md` §5.6).

### FR-008 — Retry

Worker MUST retry transient errors (network, timeout, temporary provider failure, rate limiting, temporary server failure). Phân loại MUST theo error matrix canonical (`docs/applications/push-notification/03-operations.md` §5). Retry MUST: có giới hạn, dùng backoff, không tạo delivery mới, giữ nguyên `delivery_id`, áp dụng **per-message** — không theo batch. **Retry external** thuộc worker + Cloudflare Queue; worker **không** retry publish; control plane **không** retry delivery. `POST /admin/v1/deliveries/:id/retry` là administrative recovery (giữ nguyên `delivery_id`).

Trước khi trả `retry()`, worker **MUST release lease** (`POST /internal/deliveries/:delivery_id/release`, kèm `dispatch_generation`) — nếu không, delivery vẫn `processing` với lease còn hiệu lực → message redelivery gặp `409 lease_held` và bị ACK/skip → **retry của Queue không thực sự retry provider**. Áp dụng cho **cả** nhóm request chưa tới provider (`429`/`5xx`/lỗi trước khi gửi) **và** nhóm indeterminate request có thể đã tới provider (timeout sau khi gửi, connection reset giữa response); hai nhóm MUST phân biệt được trong job state/log/metric (`01-architecture.md` §12). Quy tắc này **chỉ** áp dụng khi claim **đã** thắng (worker đang giữ lease): claim bị từ chối `409 pending` thì **không có lease để release** — worker chỉ `retry()` và để Queue backoff.

### FR-009 — Permanent Failure, Subscription Invalidation và Provider Authentication Failure

Worker MUST không retry vô hạn permanent errors. Khi **provider response chứng minh** subscription không còn hợp lệ (`404` hoặc `410`): (1) mark delivery failed/permanent; (2) request disable/expire subscription; (3) ACK sau khi state persist. Worker MUST NOT xóa trực tiếp DB record, tạo subscription mới hay chọn subscription khác.

Provider credential/configuration failure (`401`/`403`) và payload failure (`413`) là permanent cho delivery attempt nhưng MUST NOT dẫn tới disable subscription; worker MUST NOT disable subscriptions hàng loạt vì credential/configuration sai.

### FR-011 — Provider Selection

Worker MUST dùng `provider_id` từ Queue message. Worker MUST NOT chọn provider khác khi provider hiện tại fail; MUST NOT infer provider từ browser hoặc endpoint metadata.

### FR-012 — Payload Preservation

Worker MUST preserve notification payload semantics; MAY thực hiện transformation cần thiết cho Web Push Protocol. Worker MUST NOT thay đổi `title`, `body`, `url`, `application data` theo business logic riêng. Worker MUST NOT làm body mã hoá vượt **4096 octets** (trần Web Push — `docs/architecture/04-platform-facts.md` §2.15 WP5; ngân sách do control plane enforce — `docs/applications/push-notification/02-requirements.md` FR-008); nếu transformation bắt buộc khiến vượt trần → **permanent payload failure**, không retry, không cắt payload âm thầm (`01-architecture.md` §15).

### FR-013 — Timeout

External provider request MUST có timeout hữu hạn; MUST không giữ Queue execution ở trạng thái processing vô hạn.

### FR-014 — Duplicate Concurrency

Worker MUST xử lý race condition khi cùng `delivery_id` được consume đồng thời; chỉ một execution được hoàn tất logical delivery, execution còn lại skip hoặc retry safely tùy persistent state. External send trùng lặp (nếu có) thuộc crash-window (FR-006). Stale write (không khớp `dispatch_generation`) MUST bị từ chối, coi là duplicate/conflict và ACK an toàn — **không** gửi lại provider.

### FR-017 — Runtime API Failure

Private delivery-runtime API tạm thời unavailable → transient failure. Worker MUST NOT fallback sang truy cập D1 của `push-notification` (hay service khác), direct database access, đọc control plane state từ D1 `push-job`, alternate subscription hay alternate provider. D1 `push-job` là job state — không thay thế được runtime API vì không chứa delivery/subscription/provider runtime. Delivery material + credential **CHỈ** có trong response `200` của `POST .../claim` (FR-003); runtime API **không** trả routing decision mới. Payload đã materialize tại control plane. Caller authorization bắt buộc ở tầng ứng dụng: principal header `X-ECOMA-PRINCIPAL` (giá trị `svc.web-push-notification-job`) + shared secret, verify **trước** khi xử lý — sai/thiếu → `401`, **không** tiết lộ delivery tồn tại hay không (SR-004). **Không** có `X-ECOMA-APP`; header tự khai **không** phải bằng chứng danh tính; Service Binding **không** phải authorization boundary. Quyền tối thiểu: claim/release/ghi outcome/invalidate subscription/job state trên D1 `push-job`; **MUST NOT** gọi Admin API; **MUST NOT** truy cập D1 `push`.

### FR-018 — Queue Acknowledgement

Worker MUST dùng per-message acknowledgement/retry. Chỉ ACK khi: delivery succeeded; hoặc delivery permanently failed và outcome đã record; hoặc message invalid/unsupported đã xử lý an toàn. Worker MUST để Queue retry khi transient error (`429`/`5xx`/network/timeout), runtime API transient failure. Message fail permanent MUST không force retry các message khác trong cùng batch.

### FR-019 — Dead Letter

Message không xử lý được sau khi hết retry MUST vào DLQ. DLQ message phải truy vết được bằng `delivery_id`, `notification_id`, `provider_id`, `subscription_id`.

### FR-020 — Observability

Mỗi delivery execution MUST emit structured logs với `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `attempt`, `outcome`, `duration`. Secret MUST được redact.

### FR-021 — Metrics

Worker MUST expose metrics cho `consumed`, `delivered`, `failed`, `retried`, `skipped`, `invalidated`, `dlq` và provider-level `success`/`failure`/`latency`. Inventory đầy đủ → `03-operations.md` §11.

### FR-022 — Job State và Reconciliation

Worker MUST lưu job execution state trên D1 `push-job` (attempt record, processed marker, **envelope của lần consume đầu**, việc kẹt), idempotent theo `delivery_id` — duplicate Queue message MUST được nhận diện và skip trước khi gọi provider.

**Job state tối thiểu (canonical → `01-architecture.md` §11b).** Bốn nhóm, không được rút gọn:

1. **attempt record** — idempotent theo (`delivery_id`, `attempt`).
2. **processed marker** — duplicate Queue message skip ngay.
3. **envelope của lần consume đầu** — **đủ bảy trường** của envelope Queue (`version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload`; canonical → `docs/applications/push-notification/02-requirements.md` FR-013). Đây là thứ **duy nhất** cho phép job reconciliation dựng lại **chính xác** envelope bất biến ban đầu để re-deliver đúng message **sau khi** message Queue gốc đã biến mất — ghi job id/trạng thái xử lý là **không đủ** để phục hồi payload. Envelope lưu ở D1 `push-job` **MUST NOT** chứa thêm gì ngoài bảy trường: **không** provider credential, **không** subscription secret (`auth`/`p256dh`), **không** VAPID private key, **không** authorization header.
4. **reconciliation data (việc kẹt)** — đã nhận nhưng quá ngưỡng chưa kết thúc, hoặc đã persist outcome nhưng chưa ACK.

Mất D1 `push-job` làm mất khả năng re-deliver **của worker** cho việc **đã nhận**; phần message **chưa từng** được consume không có job record và thuộc cơ chế (c) của control plane (`docs/applications/push-notification/03-operations.md` §4.2). Worker MUST có reconciliation job định kỳ quét D1 `push-job` tìm: delivery đã nhận nhưng quá ngưỡng chưa kết thúc; delivery đã persist outcome nhưng chưa ack. **Job reconciliation** (quét D1 `push-job`) phải tách biệt với **outbox reconciliation** của control plane (`docs/applications/push-notification/03-operations.md` §4.2). Reconciliation của worker **không** ghi logical delivery state — chỉ xử lý job state và/hoặc re-deliver qua Queue. Worker MUST NOT lưu job state vào KV, bộ nhớ Worker hay `/tmp` như là nơi duy nhất.

**Re-deliver qua Queue là quyền được cấp tường minh.** Worker produce message tới Queue `ecoma-push-delivery` qua binding `QUEUE` (đã khai báo trong `apps/web-push-notification-job/wrangler.jsonc`) — **chỉ** cho reconciliation re-deliver của **cùng** `delivery_id` mà job state đã ghi nhận. Message phải giữ nguyên envelope contract (FR-013). Worker **MUST NOT** dùng quyền produce này để reroute, đổi `provider_id`/`transport`/`subscription_id`, tạo delivery mới, hay publish một notification khác. Re-deliver lặp lại an toàn vì atomic claim của control plane chỉ cho một execution thắng (`docs/applications/push-notification/01-architecture.md` §5.6).

**Giới hạn phạm vi:** job reconciliation **chỉ** phát hiện việc **đã có job record** (đã claim, đã persist outcome nhưng chưa ACK). Message **chưa từng được consume** không để lại job record nào → **không** thuộc cơ chế này, mà do **(c) logical delivery reconciliation** của **control plane** phát hiện từ D1 `push` và re-dispatch **cùng `delivery_id`** (canonical → `docs/applications/push-notification/03-operations.md` §4.2, **không** định nghĩa lại). Hai cơ chế **không** ghi chéo state: (b) không ghi logical delivery state; (c) không ghi job state.

- Đọc toàn bộ job state không cần Queue và không cần `push-notification`.
- Sau khi mất Queue message (hết retention) nhưng delivery **đã có job record**, job reconciliation vẫn nhận diện được việc kẹt từ D1 `push-job`; message chưa từng được consume (không job record) do cơ chế (c) của control plane xử lý.
- Duplicate message cho delivery đã có processed marker → skip, không gọi provider.

## 2. Non-Functional Requirements

### NFR-001 — Reliability

Worker MUST tolerate duplicate queue delivery, temporary provider outage, temporary runtime API outage, worker restart, network failure mà không tạo duplicate logical delivery.

### NFR-002 — Durability

Worker MUST rely trên persistent delivery state owned by `push-notification` và persistent job state trên D1 `push-job`. Không dùng in-memory state để quyết định delivery đã hoàn thành.

### NFR-003 — Scalability

Worker MUST scale independently from `push-notification` API; Queue backlog là đủ để drive worker scaling.

### NFR-004 — Failure Isolation

Mỗi message được xử lý, ACK, retry và chuyển DLQ độc lập: message thất bại MUST NOT làm thất bại hoặc force retry message khác trong cùng batch. Provider failure MUST NOT làm worker crash permanently.

### NFR-005 — Security

Provider credential và subscription credential data MUST: không nằm trong Queue, logs, error response; chỉ được access bởi trusted worker execution.

### NFR-006 — Performance

Worker MUST tránh runtime calls không cần thiết — mỗi delivery chỉ lookups cần thiết cho `delivery`/`subscription`/`provider`; không discovery hay broad queries.

### NFR-007 — Timeout Safety

Tất cả external I/O phải có timeout; không có unbounded retry hay unbounded execution.

### NFR-008 — Evolution

Queue message MUST có schema version; worker từ chối rõ ràng version không hỗ trợ; breaking change MUST tạo version mới. Trong rollout, consumer MUST hỗ trợ version hiện tại + version cũ (`docs/applications/push-notification/03-operations.md` §9.2). Envelope fields: `version`, `delivery_id`, `notification_id`, `subscription_id`, `provider_id`, `transport`, `payload` — immutable. Payload materialize tại control plane, worker **không** đọc lại để thay thế.

### NFR-009 — Operational Safety

Worker phải có thể pause/resume consumption, deploy version mới, rollback mà không cần thay đổi notification routing logic.

### NFR-010 — Stateless Runtime

Worker runtime SHOULD stateless. Business state bền nằm ở `push-notification` (logical delivery, qua private interface) và D1 `push-job` (job execution). Queue giữ message tạm thời với retention hữu hạn — không phải nơi state bền (`docs/architecture/03-operations.md` §11.3, `docs/architecture/04-platform-facts.md` QU3/QU5).

## 3. Security Requirements

### SR-001 — Credential Isolation

Worker credential được cấp qua secure runtime mechanism; provider secret MUST NOT được commit vào repository.

### SR-002 — Queue Safety

Queue payload MUST NOT chứa provider private key, provider secret, access token. Không có secret xuất hiện trong Queue, log, metric, error response.

### SR-003 — Log Redaction

Worker MUST redact: subscription auth, `p256dh`, VAPID private key, provider secret, authorization header.

### SR-004 — Runtime API Authorization

Private delivery-runtime API MUST xác thực caller là trusted `web-push-notification-job`. Cloudflare **không** phân biệt Service Binding với Internet, nên authenticator bắt buộc ở tầng ứng dụng, verify **trước** khi xử lý: shared secret (qua Worker Secret) xác thực **server-side** cộng principal header `X-ECOMA-PRINCIPAL` (giá trị `svc.web-push-notification-job`). **Không** dùng `X-ECOMA-APP` (claim/lookup theo `delivery_id`; `app` thuộc control plane). Header tự khai **KHÔNG** phải bằng chứng danh tính — principal chỉ được tin sau khi credential đã xác thực; principal header có mặt nhưng không khớp principal gắn với credential → `401`. Sai/thiếu credential → từ chối `401` **trước** lookup, **không** tiết lộ delivery tồn tại hay không. **Service Binding KHÔNG phải authorization boundary.** Worker MUST dùng Service Binding `PUSH_NOTIFICATION_SERVICE` → `ecoma-push-notification`.

### SR-005 — Least Privilege

Worker permission chỉ đủ để: đọc selected delivery runtime, `claim`/`release` lease, cập nhật delivery outcome, invalidate subscription, read/write job state trên D1 `push-job`, và produce vào Queue `ecoma-push-delivery` **chỉ** cho reconciliation re-deliver của cùng `delivery_id` (FR-022). Worker **MUST NOT** gọi Admin API; **MUST NOT** truy cập D1 `push`; không binding tới D1 của service khác, không có PostgreSQL/Hyperdrive binding.

## 4. Non-goals

- **Không routing/reroute** — chọn transport, chọn provider, tìm subscription thay thế thuộc `push-notification` (`01-architecture.md` §2.2).
- **Không support transport ngoài `web`** ở phiên bản đầu; thêm transport thuộc job worker khác.
- **Không sở hữu logical delivery state** — chỉ job execution state trên D1 `push-job`.
- **Không phải backup/DR owner** — D1 `push-job` **ngoài** Backup/DR scope (`docs/architecture/03-operations.md` §3.1): không backup strategy, không restore runbook, không RPO/RTO. Mất D1 `push-job` là **chấp nhận được**; recovery ở **mức service** qua reconciliation (FR-022, `01-architecture.md` §2.2). Time Travel là platform capability destructive, **không** phải cam kết phục hồi (`docs/architecture/04-platform-facts.md` DB5).
