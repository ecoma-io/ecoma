# Yêu cầu kỹ thuật — Transactional Mailer Job

> **Phạm vi:** yêu cầu giao thức, runtime, idempotency, retry model, bảo mật và non-goals của `transactional-mailer-job`.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · vận hành → [`03-operations.md`](./03-operations.md) · contract producer side → `docs/applications/transactional-mail/01-architecture.md` §5 · constraint toàn hệ thống → `docs/architecture/`.

> **Ghi chú đánh số.** Dãy FR/NFR/SR/CR giữ nguyên cách đánh số đã được tham chiếu từ code (`FR-004`/`FR-005`/`FR-007`/`FR-008` xuất hiện trong comment của `libs/transactional-mailer-job-application`, `libs/transactional-mail-contracts` và migration `apps/transactional-mailer-job/migrations/0001_mail_jobs.sql`); renumber sẽ phá các tham chiếu đó.

## 1. Functional requirements

### FR-001 — Consume Mail Command

Worker MUST consume Mail Command từ Queue `ecoma-mail-delivery` (bounded retry + DLQ — config: `docs/applications/transactional-mailer-job/03-operations.md` §2). Command có `version`; chỉ `version = 1` được xử lý.

#### Acceptance Criteria

- Command hợp lệ được xử lý end-to-end (send → report → ack).
- Command `version ≠ 1` bị reject `unsupported-version`, **không gọi provider**, ack + quarantine marker đã sanitize; **không** mark `failed` (ô nhóm 4, `03-operations.md` §3.1).
- Body không parse được hoặc thiếu `delivery_id` → reject + ack (không retry), ghi quarantine record đã sanitize; **không** raw payload vào DLQ/log (nhóm 3, `03-operations.md` §3.1).

**Thực thi bằng contract library.** Command shape và validator: `@ecoma-io/transactional-mail-contracts` (`src/mail-command.ts` — `validateMailSendCommand`, `MAIL_COMMAND_VERSION`, `ALLOWED_MAIL_SEND_COMMAND_FIELDS`). Worker MUST dùng validator này khi parse Queue message, không viết lại schema. Những luật nghiệp vụ trên (không gọi provider trên reject, không ghi raw payload vào DLQ, v.v.) là thuộc lớp worker; validator chỉ đảm bảo shape/giá trị đã chốt.

---

### FR-002 — Validate Mail Command

Canonical Queue command chứa **chỉ** `version` + `delivery_id` (`01-architecture.md` §4). Command KHÔNG được chứa `message_id`, `app`, template metadata, rendered subject/body, `created_at`, key cấm (danh sách mirror từ control plane). Command cũng KHÔNG chứa — và KHÔNG được bổ sung — `dispatch_generation`: envelope là wake-up signal, không phải authorization token cho một generation (`docs/applications/transactional-mail/01-architecture.md` §5).

#### Acceptance Criteria

- Command hợp lệ: có `version = 1` và `delivery_id` → xử lý tiếp.
- Thiếu `delivery_id` → `missing-delivery-id`; `version !== 1` → `unsupported-version`; reject + ack; không gọi provider. (Đúng bộ `reason` canonical ở `03-operations.md` §3.1 — **không** có giá trị `invalid-command`.)
- Có key cấm (`secret`, `token`, `recipient`, `api_key`, `subject`, `body`...) → `forbidden-field`, reject + ack; log và quarantine record **chỉ ghi tên trường**, không bao giờ ghi giá trị.
- Mọi nhánh reject: **không** gọi provider, **không** ghi nghiệp vụ vào D1 ngoài quarantine record đã sanitize, **không** raw payload vào DLQ.
- Command không canonical **không bao giờ** được retry ⇒ không bao giờ chạm ngưỡng retry-exhausted ⇒ **không bao giờ** đi vào DLQ.

---

### FR-003 — Runtime Resolution

Worker MUST resolve runtime material qua private Service Binding `TRANSACTIONAL_MAIL_SERVICE` (`GET /internal/deliveries/:delivery_id`) trước khi gọi provider. Private interface là **delivery lookup**, không phải routing API; worker không dùng để khám phá delivery khác.

Worker **không** truy cập D1 `mail`; mọi control plane data đi qua private interface.

#### Acceptance Criteria

- Delivery tồn tại → nhận **đúng** envelope `{ message, dispatch_generation }` (`01-architecture.md` §5 — runtime resolution; **không** phải §4, vì §4 là Mail Command contract và Command **không** chứa các field này): `message` gồm `delivery_id`, `message_id`, `app`, `status`, `recipient`, `subject`, `body`, `content_type` (hằng `text/html` ở v1 — `docs/applications/transactional-mail/01-architecture.md` §7.2); `dispatch_generation` ở **ngoài** `message` và là authority duy nhất cho generation đang authorized. Không có biến thể envelope nào khác — control plane trả đúng shape này.
- Response **không** chứa provider credential, endpoint secret, hay token — credential là Worker Secret của `transactional-mailer-job`.
- Delivery không tồn tại (`404`) → ghi job `failed` (`delivery-not-found`), ack.
- Control plane unavailable (fetch lỗi mạng / `5xx` / timeout / `429`) → `retry()` (không ack, không gọi provider).
- Private API `401`/`403` → **không** phải "unavailable": đây là lỗi authn/authz của **chính worker** (signature/clock skew hoặc thiếu permission) → **không** gọi provider, `retry()` bounded (hết `max_retries` → DLQ + alert `Page`), không đánh delivery terminal. Chi tiết → `01-architecture.md` §9.2.2 hàng 19.
- Worker không dùng private interface để tìm delivery khác hay thay đổi delivery.

**Thực thi bằng contract library.** Envelope `{ message, dispatch_generation }` và `message` shape đã có type + validator trong `@ecoma-io/transactional-mail-contracts` (`src/delivery-interface.ts` — `validateGetDeliveryResponse`). Worker validate response bằng validator này thay vì tự kiểm từng field; shape canonical vẫn ở `docs/applications/transactional-mail/01-architecture.md` §7.2 và **không** được định nghĩa lại ở đây.

---

### FR-004 — Eligibility

Worker MUST NOT gửi lại delivery mà control plane đã đánh `sent`/`failed`. `blocked` **không** phải terminal: delivery `blocked` vẫn eligible cho redrive (§FR-008).

#### Acceptance Criteria

- Message đã terminal ở control plane → đồng bộ job terminal, ack, không gọi provider.
- Job terminal + `outcome_report_state = 'pending'` → báo nốt outcome (crash window, **không** gọi provider) → `reported` → ack.
- Message ở control plane đang `blocked` → vẫn eligible; job `blocked` **cùng generation** bị ack (không gửi lại). Chỉ khi redrive có authorize ở control plane đã tăng `dispatch_generation` thì worker — sau khi resolve authority qua private interface — mới claim được một generation lớn hơn generation đang lưu ở row, qua **generation-advance claim** (`01-architecture.md` §9.2.1 đường (b)), và thử lại.
- Command wake-up cho một delivery (chỉ mang `version` + `delivery_id`) **không** mang và **không** chứng minh generation. Worker chốt bằng cách so generation authority (đọc từ private interface) với generation đang lưu ở row: authority **bằng hoặc nhỏ hơn** → **không** claim, **không** reset row về generation cũ, ack.

---

### FR-005 — Delivery qua Provider

Worker MUST gọi provider dùng runtime material (`recipient`, `subject`/`body`, `content_type`) từ private interface, kết hợp endpoint + credential từ **Worker Secret của chính worker**, và lưu attempt vào D1 `mail-job`.

Worker MUST gọi provider qua **provider port** nội bộ — contract (request/result type), chiếu error matrix và trách nhiệm adapter là canonical ở `01-architecture.md` §11.1/§11.2. File này nêu yêu cầu và acceptance criteria, **không** định nghĩa lại shape.

#### Acceptance Criteria

- Provider success (`2xx`) → port trả `accepted`; mark job `sent`, báo outcome `sent`, ack theo hàng 1 của ma trận (ack **sau** khi report `reported`; report transient → `retry()` — `01-architecture.md` §9.2.2). `provider_message_id` là **nullable** (NULL khi adapter không có bằng chứng trả về field đó) và MUST NOT được dùng để kết luận thư đã tới inbox.
- `2xx` nhưng body **không parse được** → **vẫn** `accepted` (không hạ thành lỗi) → mark job `sent` với `provider_message_id = NULL` + `warningCode = malformed-response` vào provider error metric (`03-operations.md` §8) và audit đã sanitize; **không** retry, vì retry sau khi đã accept chỉ có thể gửi trùng (`01-architecture.md` §9.2.2 hàng 9). Body hợp lệ mà provider không có message id thì **không** warning; body hợp lệ mà **tự báo thất bại** (theo contract của provider đã chọn) thì là `rejected` → `permanent` hoặc `retryable`, **không** bao giờ `sent` im lặng (`01-architecture.md` §11.1).
- Provider `429`/`5xx`/network/timeout → ghi `last_error` (`retryable`), `retry()`; `Retry-After` (nếu có) là **sàn** cho lần thử kế tiếp, MUST được clamp về **giây nguyên** ≤ 24 giờ (`docs/architecture/04-platform-facts.md` QU8) và ≤ retention của Queue (QU5) — sàn vượt retention thì retry bị xoá trước khi chạy và delivery rơi vào đường reconciler tốn slot A.
- Timeout hoặc request bị hủy → `retryable`, **không** `failed`; worker MUST ghi `last_error` (`errorCode = timeout`) + metric `delivery-retry` (hàng 6) cho lần gọi đó — nó có thể đã được provider chấp nhận, nên duplicate là residual risk (`01-architecture.md` §9.1). Ngoại lệ: nếu request bị hủy **vì worker đã mất claim** (lease hết hạn hoặc generation-advance — hàng 17/18) thì đó là `lost-claim`: MUST NOT `retry()`, MUST NOT báo outcome, chỉ ghi metric `lost-claim` (`01-architecture.md` §9.2.1).
- Provider `401`/`403` → mark job `blocked` (`credential`), báo outcome `blocked`, ack — **không retry ở Queue**; redrive sau khi sửa credential (`01-architecture.md` §9.4). **KHÔNG** mark `failed`.
- Private API trả `401`/`403` MUST NOT đi vào nhóm provider credential và MUST NOT mark `blocked`/`failed`: đó là lỗi authn/authz của **chính worker**, không phải input của provider port (`01-architecture.md` §9.2.2 hàng 19, `03-operations.md` §3).
- Provider 4xx khác → mark job `failed` (`permanent`), báo outcome, ack — không retry.
- Endpoint hoặc credential chưa cấu hình → mark job `blocked` (`provider-not-configured`, credential-class), báo `blocked`, ack — kiểm tra **sau** claim và **trước** khi gọi port (hàng 4 đòi pre-state `processing` + lease; kiểm tra trước claim thì không có lease để persist `blocked`), không retry-storm.
- Ngân sách **B** của generation kiệt (`attempts` chạm `maxExecutionAttempts`, không còn lease hiệu lực) → mark job `blocked` (`execution-budget-exhausted`), báo outcome `blocked`, ack, alert — **không** reclaim vô hạn và **không** mark `failed` (thư chưa bị provider từ chối).
- Một lần gọi port là **một** attempt của execution đã claim: slot ngân sách **B** được tiêu ở claim, và `attempts` chỉ tăng ở UPDATE claim/reclaim (`01-architecture.md` §9.2.1, FR-006). Adapter MUST NOT retry bên trong lần gọi đó, và MUST NOT tăng `attempts` ở call boundary (nó phá guard nguyên tử của claim); bounded retry thuộc Queue consumer.
- Adapter MUST NOT nhận endpoint/URL từ request, runtime material hay Queue; MUST NOT follow redirect (`3xx` → `rejected` `credential` `http-3xx` → mark `blocked`, cùng hành động hàng 3 — `01-architecture.md` §11.1) và MUST tắt redirect-following cùng retry nội tại của HTTP client/SDK bằng cấu hình; và MUST NOT log endpoint, credential, recipient, subject/body, raw provider response body, hay exception/stack nguyên văn — chỉ `errorClass` + `errorCode` đã sanitize (`01-architecture.md` §13).
- Adapter MUST NOT tuyên bố chống duplicate: `delivery_id` được truyền như **ứng viên** idempotency key, chỉ có tác dụng đã xác minh khi trạng thái provider idempotency là `verified` (`01-architecture.md` §9.3).
- Fake provider: một adapter giả cùng port tạo được các kết quả xác định (`accepted`/`retryable`/`permanent`/`credential`) cùng các nhánh `warningCode`/`retryAfterMs` — chọn theo nội dung request (`recipient`/`subject` chứa token test, theo thứ tự ưu tiên được định nghĩa trong fake), không cần field selector riêng trên port. **Nguồn canonical:** `libs/transactional-mailer-job-infrastructure/src/fake-mail-provider.ts`.
- Sender identity thuộc trusted config của worker: port **không** mang `from`/`sender` và **không** mang `app`; địa chỉ người gửi, envelope và mọi header cố định của relay nằm trong Worker Secret / cấu hình của adapter (`01-architecture.md` §11.1, §13). Cần sender theo từng app là một contract mới phải sửa port — không được adapter tự suy ra.

**Thực thi qua provider port.** Port là seam duy nhất đi ra provider, dùng chung cho adapter relay thật và **fake provider**: worker core, orchestration và test MUST inject port này thay vì gọi network trực tiếp, để orchestration và state machine test được ngay cả khi không có credential provider thật. Provider mặc định v1 **đã chọn: Cloudflare Email Service** (binding `send_email`, `01-architecture.md` §9.3/§11); phần dưới chỉ chốt ranh giới port, không giả định wire protocol của provider ở tầng requirements.

---

### FR-006 — Job State (D1 `mail-job`)

Worker MUST ghi job execution state vào D1 riêng: insert `processing` **chưa giữ lease** với `attempts = 0` và `execution_generation = 0`, rồi tăng `attempts` **trong chính UPDATE claim** (đường (a): attempts++ → 1 ở claim đầu; đường (b): reset attempts = 1 cho generation mới), ghi `last_error`, chuyển `sent`/`failed`/`blocked`, duy trì `outcome_report_state` (`none|pending|reported|superseded|orphaned`) và `report_lease_owner`/`report_lease_expires_at` (và `blocked_at` khi vào `blocked`), và duy trì `dispatch_generation`, `execution_generation`, `lease_owner`, `lease_expires_at`.

Worker MUST dùng **execution claim (lease)** trong D1 `mail-job` để đảm bảo chỉ một execution gọi provider cho một `(delivery_id, dispatch_generation)` — chi tiết protocol và giới hạn → `01-architecture.md` §9.2.1.

Ma trận transition lease/outcome đầy đủ (mọi transition: provider success, permanent failure, `blocked`, transient, private interface unavailable, D1 unavailable, crash trước/sau persist, report `applied`/`duplicate`/`stale`/`404`/`401`/`403`, private API `401`/`403` (auth của chính worker), duplicate command, lease reclaim, redrive giữa execution, provider in-flight khi lease hết hạn) — kèm state bền vững trước/sau, lease, ack/retry, guard và metric — là **nguồn canonical** ở `01-architecture.md` §9.2.2; file này chỉ tham chiếu.

`attempts` là **ngân sách B** cho một `(delivery_id, dispatch_generation)`: nó đếm **execution** (không đếm lần gọi provider), tăng trong cùng UPDATE claim, bị chặn bởi `maxExecutionAttempts`, và reset khi và chỉ khi row advance sang generation mới. Đây không phải một bộ đếm xuyên database; nó bù với ngân sách **A** của control plane (`recovery_cycle_count`) theo `docs/applications/transactional-mail/01-architecture.md` §6.5.

#### Acceptance Criteria

- Mỗi message mới → 1 job row; `attempts` đạt **1** sau claim đầu tiên (insert đặt 0 để claim (a) tăng thành 1 — không đếm đôi).
- Redelivery (cùng `delivery_id`, không terminal): nếu lease đã release/hết hạn **và** `attempts < maxExecutionAttempts` → claim lại (đường (a)) + attempts++; nếu lease còn hiệu lực → ack, không gọi provider; nếu `attempts` đã chạm `maxExecutionAttempts` và không có lease hiệu lực → chuyển `blocked` (`execution-budget-exhausted`), báo outcome `blocked`, ack (§9.2.1 đường (c)).
- Claim (a) MUST mang guard `attempts < :maxExecutionAttempts`; khi ngân sách B kiệt mà **không** có lease hiệu lực, worker MUST đánh dấu `blocked` bằng conditional UPDATE có guard (không cắt ngang execution đang chạy) rồi alert — **không** để job kẹt ở `processing` vô hạn và **không** reclaim vô hạn.
- `attempts` MUST NOT tăng ở bước persist lỗi transient (chỗ đó chỉ ghi `last_error` + release lease); mỗi execution chỉ tiêu đúng một slot B, tại claim.
- Job `blocked` (non-terminal) gặp generation authority **lớn hơn** (từ redrive có authorize) → thử lại qua generation-advance claim; `blocked` không chặn redrive, nhưng generation authority **cùng hoặc nhỏ hơn** generation đang lưu thì không claim (`01-architecture.md` §9.4).
- Job `blocked` mà điều kiện system-level đã được sửa → delivery chỉ trở lại eligibility khi generation authority (đọc qua private interface) **lớn hơn** generation đang lưu ở row, tức sau thao tác redrive có authorize ở control plane; bản thân command wake-up **không** mang generation nên không tự mở khoá. Worker **không** tự xoá marker `blocked`, **không** tự send vào Queue.
- **Generation-advance claim là transition nguyên tử duy nhất** đưa row sang generation mới: một conditional UPDATE tăng `dispatch_generation`, bump `execution_generation`, lấy lease, đặt `status = 'processing'`, `outcome_report_state = 'none'` và xoá `blocked_at`; guard `dispatch_generation < :new_generation` + lease chưa/không còn hiệu lực.
- Lease không release được vì **D1 lỗi** → lease còn hiệu lực tới `lease_expires_at`; recovery là reclaim qua path (a) §9.2.1 khi command cho cùng `(delivery_id, dispatch_generation)` tới (phát hiện lease hết hạn nằm ở §10 trách nhiệm 1 — sweep đó chỉ alert, không claim), hoặc control-plane reconciler — **không** có đường nào coi release là đã thành công.
- D1 ghi lỗi ở BẤT KỲ bước nào → `retry()`, **không ack**.
- Claim lease là một conditional UPDATE duy nhất (không read-then-write); chỉ execution có `affected rows = 1` được gọi provider.
- Execution gặp lease còn hiệu lực → **không** gọi provider; ack message (duplicate-suppressed) hoặc `retry()` khi lỗi hạ tầng.
- Trước provider call, owner re-validate lease và (với operation dài) gia hạn lease; lease duration MUST lớn hơn tổng worst-case của runtime resolution + provider timeout + D1 write + margin.
- Persist kết quả phải guard theo `lease_owner` + `execution_generation` + `dispatch_generation`; nếu `affected rows = 0` thì execution không còn sở hữu → **không** ghi state, **không** báo outcome, **không** gửi lại.
- Lease hết hạn + worker crash → execution kế tiếp claim được, `execution_generation` tăng; owner cũ không thể ghi.
- **Lease KHÔNG chứng minh exactly-once.** Crash trong lúc provider request, hoặc sau khi provider accept nhưng trước khi persist, vẫn có thể sinh duplicate mail — rủi ro này phải được ghi nhận là không loại bỏ được, giảm thiểu bằng provider idempotency key khi provider hỗ trợ.

---

### FR-007 — Báo Outcome cho Control Plane

Worker MUST báo kết quả qua `POST /internal/deliveries/:delivery_id/outcome`. Body: `{ outcome: 'sent'|'failed'|'blocked', error_class?, dispatch_generation }` — `dispatch_generation` **bắt buộc**, `error_class` **optional** nhưng khi có mặt phải nằm trong bộ canonical (`03-operations.md` §3). `blocked` do **ngân sách B** (`execution-budget-exhausted`) gửi **không kèm** `error_class` (lý do cụ thể là state nội bộ của worker, control plane không cần). Control plane phân loại theo `docs/applications/transactional-mail/01-architecture.md` §6.2.2.

#### Acceptance Criteria

- Callback MUST mang `dispatch_generation`; thiếu field này là lỗi client (`400`) và MUST NOT được bỏ qua.
- Callback mang `error_class` **ngoài** bộ canonical → control plane trả `400`; worker **không** coi đó là transient, giữ `outcome_report_state = 'pending'` + alert (metric `outcome-contract-rejected`), **không** retry vòng vô hạn, **không** đánh terminal, **không** gửi lại mail (`01-architecture.md` §9.5 hàng `400`).
- `outcome = 'blocked'` do ngân sách **B** (`execution-budget-exhausted`) gửi **không kèm** `error_class` — worker MUST NOT gửi chuỗi nội bộ đó làm `error_class`; control plane sẽ từ chối (`400`) nếu nhận chúng. Với blocked do 401/403/provider-not-configured, gửi **kèm** `error_class = 'credential'`.
- Path success: persist `sent` + `outcome_report_state = 'pending'` cùng lúc release lease → report `sent` → `result ∈ {applied, duplicate}` → `outcome_report_state = 'reported'` → ack.
- Path failed: persist `failed` + report state `pending` → report `failed` + `error_class` → `result ∈ {applied, duplicate}` → `reported` → ack.
- Path blocked: persist `blocked` + `blocked_at` + report state `pending` → report `blocked` **kèm** `error_class` (`credential` cho nhóm 401/403/provider-not-configured) → `result ∈ {applied, duplicate}` → `reported` → ack (non-terminal ở control plane; không retry-storm). Riêng blocked do **ngân sách B**: report `blocked` **không kèm** `error_class` (hàng trên) — lý do `execution-budget-exhausted` chỉ nằm ở state nội bộ (`mail_jobs.last_error_class`), không phải `error_class` gửi lên.
- **Chỉ được đặt `outcome_report_state = 'reported'` khi control plane trả `result ∈ {applied, duplicate}`.** `result = stale` **không** phải success: đặt `outcome_report_state = 'superseded'`, ack, ghi metric `outcome-stale` + audit event; **không** retry vòng.
- `result = 400` (contract violation) → giữ `outcome_report_state = 'pending'`, alert (metric `outcome-contract-rejected`), **không** retry vòng vô hạn, **không** đánh terminal, **không** gửi lại mail (`01-architecture.md` §9.5).
- HTTP 200 **không** phải bằng chứng đã báo xong: worker phân loại theo **body** (`applied` / `duplicate` / `stale`), không theo status code.
- Report lỗi hạ tầng (unavailable/5xx/timeout) → `retry()`.
- Report `401`/`403` → **không** phải transient: giữ `outcome_report_state = 'pending'`, alert `Page`, **không** retry vòng vô hạn, **không** gửi lại mail, **không** đánh `orphaned` (delivery vẫn đúng ở control plane); recoverable sau khi sửa permission/identity (`01-architecture.md` §9.2.2 hàng 19, §9.5).
- Report `404` (message biến mất) → `outcome_report_state = 'orphaned'`, ack, metric + alert operator; **không** giữ ở `pending` và **không** retry vòng.
- Chỉ lỗi transient (timeout/network/`5xx`/`429`/API unavailable) mới giữ `outcome_report_state = 'pending'` và được reconcile báo lại; sweeper chỉ quét `pending`, dùng conditional update **đúng** đường (d) §9.2.1 (guard trong statement: `outcome_report_state = 'pending'` + report-lease hết hiệu lực; `report_attempts` tăng trong cùng UPDATE), và bound dừng auto-retry là **`report_attempts < maxReportAttempts`** (persisted) áp ở **predicate chọn row** của sweep — không nằm trong (d) và không đo tuổi từ `updated_at`.

**Thực thi bằng contract library.** Body outcome và response `{ result, current_dispatch_generation? }` có type + validator trong `@ecoma-io/transactional-mail-contracts` (`src/delivery-interface.ts` — `validatePostDeliveryOutcomeRequest`, `validatePostDeliveryOutcomeResponse`; bộ `MAIL_ERROR_CLASS_VALUES` gồm đúng 5 giá trị). Worker dùng validator để tự chặn trước khi gửi (`400` là lỗi client — phải bắt trước, không chờ server trả). Các luật trên (`stale` không phải success, `blocked` không kèm `error_class` khi ngân sách B kiệt, quét `pending`) **không** nằm trong validator — chúng thuộc lớp worker và được test ở service.

---

### FR-008 — Duplicate Message

Worker MUST xử lý duplicate an toàn theo `delivery_id`.

#### Acceptance Criteria

- Duplicate message, job đã terminal, `outcome_report_state ∈ {reported, superseded, orphaned}` → ack, không gửi lại.
- Duplicate message, job `sent`/`failed`/`blocked` với `outcome_report_state = 'pending'` → báo nốt outcome (không gọi provider), ack.
- Duplicate message không được tạo duplicate logical delivery.
- Job `blocked` **không** bị coi là terminal: khi worker resolve authority từ control plane và thấy `dispatch_generation` **lớn hơn** generation đang lưu ở job (tức redrive đã authorize), delivery MUST được thử lại.
- Duplicate message tới trong khi một execution đang giữ lease còn hiệu lực → **ack**, không gọi provider, metric `duplicate-suppressed`.
- Duplicate với `dispatch_generation` (authority) **bằng hoặc nhỏ hơn** generation đã lưu ở job → coi là duplicate/stale, không gửi lại và **không** reset row về generation cũ.
- **Command là wake-up signal, KHÔNG phải authorization token.** Envelope **không** mang `dispatch_generation`; command không có "generation của nó" và worker **không thể** phân biệt command cũ với command mới từ payload. Một command chỉ cho phép worker resolve lại authority; generation được xử lý do durable state hiện tại của control plane quyết định.
- Queue command tới muộn **không** tự authorize generation nào: worker luôn resolve generation authority từ control plane, nên nó chỉ có thể dẫn tới việc worker claim theo authority hiện tại (nếu authority lớn hơn generation đã lưu) hoặc ack — **không** đổi generation, **không** đổi recipient/nội dung, **không** bỏ qua durable state.
- Job `blocked` **không** được retry trong cùng generation; chỉ redrive có authorize ở control plane (tăng `dispatch_generation`) mới tạo generation mới eligible.

---

## 2. Non-functional requirements

### NFR-001 — Per-message ack/retry

Một message fail MUST NOT force retry các message khác trong cùng batch — dùng `ack()`/`retry()` per message.

#### Acceptance Criteria

- Fail message A (retryable) → A `retry()`, B `ack()` bình thường.

---

### NFR-002 — Không secret/recipient trong log

Recipient, subject/body, endpoint, credential MUST NOT xuất hiện trong log ở bất kỳ đường nào (thành công hay lỗi) — log qua whitelist field.

#### Acceptance Criteria

- Không log sentinel recipient/credential/subject trên path success và path provider failure.
- Command chứa secret bị reject → log không có giá trị secret.

---

### NFR-003 — At-least-once + idempotency

Queue là at-least-once (`docs/architecture/04-platform-facts.md` QU1); worker idempotent theo `delivery_id`. Crash window (provider đã nhận, chưa persist) được chấp nhận — duplicate external mail có thể xảy ra (`docs/applications/transactional-mailer-job/01-architecture.md` §9.1).

#### Acceptance Criteria

- Redelivery cùng `delivery_id` không gửi lại khi job đã terminal.
- Redelivery khi job còn `processing` → nếu lease đã hết hạn **và** `attempts < maxExecutionAttempts` thì claim lại (attempts++); nếu lease còn hiệu lực thì ack (duplicate-suppressed), không gọi provider; nếu `attempts` chạm `maxExecutionAttempts` và không có lease hiệu lực thì chuyển `blocked` (`execution-budget-exhausted`), ack.
- Command mới cho job `blocked` (không phải redelivery — lần trước đã ack) → redrive, thử lại.
- Failure của một delivery không fail cả batch; failure tạm thời của runtime API → retry theo policy.

---

### NFR-004 — Bounded retry

Retry bounded theo `max_retries` rồi vào DLQ (`docs/architecture/04-platform-facts.md` QU2/QU3). Không retry vô hạn. Bounded **vòng lặp recovery** ở worker là ngân sách **B** (`attempts` / `maxExecutionAttempts`): khi kiệt, job `blocked` (`execution-budget-exhausted`) chứ **không** reclaim vô hạn.

#### Acceptance Criteria

- Retry path chỉ qua `message.retry()`; DLQ nối cho consumer.
- Lỗi permanent/credential không bao giờ đi vào retry loop; `credential` đi đường `blocked` + redrive có guard.
- Claim vượt `maxExecutionAttempts` → không còn reclaim tự động cho generation đó; job `blocked` + alert; tiếp tục chỉ qua redrive có authorize (`01-architecture.md` §9.2.1 đường (c), `docs/applications/transactional-mail/01-architecture.md` §6.5).
- Sweep báo nốt outcome (`pending`) **không** tiêu ngân sách B và **không** gọi provider — nó chỉ reconcile report state.

---

## 3. Security requirements

### SR-001 — Không truy cập D1 của service khác

Worker MUST NOT đọc/ghi D1 `mail` hay database khác. Mọi control plane data đi qua `TRANSACTIONAL_MAIL_SERVICE`.

#### Acceptance Criteria

- Không có binding nào tới `mail`; chỉ có D1 `mail-job`.

---

### SR-002 — Command không chứa secret

Command lọt key cấm bị reject trước khi chạm provider hay D1. Canonical command chứa **chỉ** `version` + `delivery_id`; KHÔNG chứa rendered subject/body hay credential. Credential là Worker Secret của `transactional-mailer-job`, không đến từ runtime material hay private interface.

Provider idempotency: worker MUST gửi `delivery_id` làm provider idempotency key **khi** provider hỗ trợ; capability này **chưa xác minh** — production gate (`docs/applications/transactional-mail/01-architecture.md` §10). Chưa xác minh thì exactly-once external delivery không được guarantee.

#### Acceptance Criteria

- Command chứa key secret/api_key → reject, provider không được gọi.
- Danh sách key cấm mirror danh sách phía control plane.

---

### SR-003 — Timeout hữu hạn

External request MUST có timeout hữu hạn (mặc định 10 s); timeout phân loại `retryable`.

#### Acceptance Criteria

- Mọi provider request có timeout cấu hình được.
- Timeout không giữ Queue message vô hạn.

---

### SR-004 — Authenticate caller tới private interface (release gate)

Worker MUST authenticate chính nó khi gọi private interface của `transactional-mail` (`GET /internal/deliveries/:delivery_id`, `POST .../outcome`), theo **canonical internal auth contract** — contract **đã merge** (PR #197 → `97b85b9`), nhưng **phía receiver chưa implement** registry + kho nonce **và worker chưa có code ký** nên vẫn release-gated (`docs/applications/transactional-mail/01-architecture.md` §7.4). Worker ký bằng credential **riêng của chính nó** trong registry của receiver; Service Binding **không** phải authentication: nó chứng minh request đến từ một Worker trong account, **không** chứng minh đó là `transactional-mailer-job`.

#### Acceptance Criteria

- Mọi request tới private interface MUST được ký theo canonical contract; thiếu/sai → control plane trả `401` và worker coi là thất bại, **không** retry mù.
- Worker MUST NOT coi Service Binding, `X-ECOMA-PRINCIPAL`, hay header tự khai nào là authentication.
- Worker MUST NOT định nghĩa một protocol cạnh tranh. Kể từ khi PR #197 merge, `main` **chính là** bản canonical — `@ecoma-io/internal-auth-contracts` là bản cài đặt duy nhất; worker ký qua đường import đó, đúng `PROTOCOL_ID` và length-prefix **byte UTF-8** (`docs/applications/transactional-mail/01-architecture.md` §7.4).
- Credential ký là secret **riêng của worker**, tách khỏi provider credential và tách khỏi khoá HMAC quarantine record (`03-operations.md` §3.1).
- **Release-blocked** cho tới khi receiver implement xong registry + kho nonce + middleware **và worker có code ký theo contract** (`docs/applications/transactional-mail/01-architecture.md` §7.4) — contract đã merge **không** tự động qua gate này; khi đó MUST đối chiếu khớp các hằng ở `docs/applications/transactional-mail/01-architecture.md` §7.4 trước khi release.

---

## 4. Constraints

### CR-001 — Không thêm runtime dependency

Chạy với dependency repo hiện có, đúng runtime `runtime:edge` (taxonomy → `docs/architecture/05-code-architecture.md`).

#### Acceptance Criteria

- Không runtime dependency mới.
- Không import Node builtin.

---

### CR-002 — Platform limits

Job phải vận hành trong giới hạn platform: Queue batch/ack semantics (`docs/architecture/04-platform-facts.md` QU4), D1 statement/parameter (DB4), consumer duration (QU6). Giới hạn chi tiết → overview; service chỉ cần bảo đảm per-message ack và job state ghi được trong budget đó.

---

## 5. Non-goals

Các boundary ngoài phạm vi worker (canonical ở [`01-architecture.md`](./01-architecture.md) §2.2): không render template · không quyết định recipient (chỉ nhận qua runtime material) · không chọn/reroute provider (single relay cấu hình ở chính worker — provider mặc định v1: Cloudflare Email Service) · không truyền credential ra ngoài (credential là Worker Secret của chính worker) · không đọc/ghi D1 `mail` · không business logic của application.

Bổ sung cho danh sách trên, ở dạng yêu cầu chứ không phải mô tả:

- Không render template, không chọn template, không quyết định recipient — recipient/subject/body chỉ đến từ runtime material.
- Không chọn/reroute provider: một relay cấu hình cố định ở chính worker (provider mặc định v1 là Cloudflare Email Service).
- Không đọc/ghi D1 `mail` của control plane; job state chỉ ở D1 `mail-job`.
- Không tự xoá marker `blocked` và không tự bump `dispatch_generation` — chỉ redrive có authorize ở control plane mới làm được.
- Không expose API public nào.
