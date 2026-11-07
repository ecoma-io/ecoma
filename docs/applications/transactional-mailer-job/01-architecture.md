# Kiến trúc thành phần — Transactional Mailer Job

> **Phạm vi:** boundary, lifecycle, state ownership, idempotency, retry model, invariants của `transactional-mailer-job`.
> Mail Command contract (producer side) → `docs/applications/transactional-mail/01-architecture.md` §5 · error matrix → [`03-operations.md`](./03-operations.md) §3 · requirement → [`02-requirements.md`](./02-requirements.md).

## 1. Mục đích

`transactional-mailer-job` là delivery worker thực hiện mail delivery cho các `Mail Message` mà `transactional-mail` đã render và enqueue. Worker thuộc **delivery plane**:

```text
transactional-mailer-job
├── Cloudflare Worker (module worker, KHÔNG có HTTP route)
├── Cloudflare Queue consumer `ecoma-mail-delivery`
└── Cloudflare D1 `mail-job` (job execution state của chính service này)
```

```text
transactional-mail (D1 `mail`)
       │
       │ Mail Command
       ▼
Cloudflare Queue
       │
       ▼
transactional-mailer-job ──── D1 `mail-job`
       │
       │ relay protocol
       ▼
Mail Relay (provider)
```

Worker không quyết định gửi cho ai, template nào — quyết định đã materialize ở control plane và đóng vào Mail Command. Worker chỉ thực hiện giao.

## 2. Phạm vi

### 2.1. Trong phạm vi

1. Consume Mail Command từ Cloudflare Queue.
2. Validate message schema và version; **reject** command không canonical (thiếu `delivery_id`, body không parse được, version không hỗ trợ, chứa field bị cấm) — non-retryable, không gọi provider, ack + quarantine marker đã sanitize.
3. Resolve runtime delivery data qua private interface của `transactional-mail`.
4. Kiểm tra delivery còn eligible (chưa terminal ở control plane).
5. Thực hiện mail delivery qua provider port (§11.1) và adapter của relay; phân loại kết quả theo error matrix.
6. Retry các lỗi retryable; ghi và dùng job state trên D1 `mail-job`.
7. Báo outcome cho control plane qua private interface.
8. Ack hoặc retry từng Queue message theo outcome của chính nó.

### 2.2. Ngoài phạm vi

Worker không chịu trách nhiệm: render template / chọn template · quyết định recipient (chỉ nhận qua runtime material) · chọn/reroute provider (single relay cấu hình ở chính worker này — provider mặc định v1: Cloudflare Email Service, §9.3/§11) · truyền provider credential cho bên khác (credential là Worker Secret của chính worker này, không đi qua Queue/private interface) · đọc/ghi D1 `mail` của control plane · business logic của application.

## 3. Worker Boundary

Ranh giới của worker là một Mail Command cụ thể (`delivery_id`). Queue message là **wake-up signal** cho delivery đó, không phải authorization token: nó chỉ nói "delivery này có thể cần xử lý", và mọi quyết định về recipient, template, nội dung đã render **cùng generation nào được authorize** đều do control plane chốt và worker resolve qua private interface. Worker coi `delivery_id` là immutable — worker không thay đổi chúng để tìm delivery khác.

## 4. Mail Command contract

- Contract mirror của control plane — shape đầy đủ ở `docs/applications/transactional-mail/01-architecture.md` §5; required fields của consumer ở [`02-requirements.md`](./02-requirements.md) FR-002.
- Canonical command chứa **chỉ** `version` + `delivery_id` — đây là toàn bộ contract. `version` bắt buộc; command `version !== 1` bị reject `unsupported-version` (non-retryable).
- **Nguồn sự thật của shape là code, không phải mục này:** `@ecoma-io/transactional-mail-contracts` (`libs/transactional-mail-contracts`), entrypoint `@ecoma-io/transactional-mail-contracts`, `src/mail-command.ts` — `validateMailSendCommand`, `MAIL_COMMAND_VERSION`, `ALLOWED_MAIL_SEND_COMMAND_FIELDS`. Worker **import** contract này thay vì viết lại shape ở phía consumer: một định nghĩa cho mỗi wire contract (`docs/architecture/05-code-architecture.md`). Mục dưới đây chỉ mô tả **hành vi** của consumer, không định nghĩa lại schema.
- **Command là wake-up signal, không phải authorization token.** Envelope **không** mang `dispatch_generation` và **không** được thêm field đó: generation được resolve từ control plane (§9.2). Một command chỉ có thể dẫn tới xử lý generation mà control plane đã authorize và đã ghi bền vững; bản thân command không authorize redrive, không đổi generation, không đổi recipient/nội dung, và không bỏ qua durable state hiện tại.
- Command **không** chứa rendered subject/body, `message_id`, `app`, template metadata hay `created_at`; worker resolve chúng từ control plane qua private interface (§5). Worker không render lại nội dung.
- Command KHÔNG được chứa `recipient`, `secret`, `token`, `subject`, `body`, credential: danh sách key cấm mirror từ control plane; command lọt key cấm bị reject `forbidden-field` (non-retryable) — kiểm tra trước khi chạm provider hay D1.
- Kích thước command nằm trong giới hạn Queue message (`docs/architecture/04-platform-facts.md` QU6); payload lớn không có trong Queue vì nó chỉ tham chiếu `delivery_id`.

## 5. Runtime resolution và delivery runtime

Queue chỉ tham chiếu `delivery_id`. Worker resolve runtime material qua private interface của `transactional-mail` (Service Binding `TRANSACTIONAL_MAIL_SERVICE`):

```text
Queue → delivery_id → GET /internal/deliveries/:delivery_id → { message, dispatch_generation }
```

- Worker được phép nhận: message status, recipient, subject/body render, `content_type`, delivery identifier, `dispatch_generation`. `dispatch_generation` là generation của delivery (fencing) để phân biệt các lần redrive khác nhau.
- **Shape của request/response private interface cũng nằm trong contract library:** `@ecoma-io/transactional-mail-contracts` (`libs/transactional-mail-contracts`), `src/delivery-interface.ts` — `validateGetDeliveryResponse`, `validatePostDeliveryOutcomeRequest`, `validatePostDeliveryOutcomeResponse`, cùng `validateDeliveryMessage`. Worker dùng chung các validator này; **không** định nghĩa lại shape `{ message, dispatch_generation }` hay body outcome ở phía `transactional-mailer-job`. Định nghĩa canonical và bảng phân loại `applied`/`duplicate`/`stale` vẫn ở `docs/applications/transactional-mail/01-architecture.md` §6.2.2/§7.2 — contract library chỉ chở shape, không chở thuật toán.
- Interface là **delivery lookup**, không phải routing API — worker không dùng để khám phá delivery khác.
- `transactional-mailer-job` **không** truy cập D1 `mail` — mọi control plane data đi qua private interface; worker có D1 riêng (`mail-job`) cho job state (§7).
- **Credential không đi qua private interface.** Provider endpoint và credential là Worker Secret của `transactional-mailer-job`; control plane chỉ authorizes delivery, không truyền credential. Credential không bao giờ nằm trong Queue, DLQ, log.
- **Worker là caller phải authenticate chính nó — release gate còn cả hai phía.** Service Binding chứng minh request đến từ một Worker trong account, **không** chứng minh đó là `transactional-mailer-job`; vì vậy worker **phải** ký mọi request tới private interface (cả `GET /internal/deliveries/:delivery_id` và `POST /internal/deliveries/:delivery_id/outcome`) theo **canonical internal auth contract**, không được dựa vào Service Binding hay header tự khai. Contract đó **đã merge** (PR #197 → `97b85b9`) — chi tiết và các hằng cần đối chiếu ở `docs/applications/transactional-mail/01-architecture.md` §7.4. Worker ký bằng credential **riêng của chính mình**, là một entry trong credential registry của receiver. Gate còn lại: cả hai phía **đã implement** — receiver có registry + kho nonce + middleware (`docs/applications/transactional-mail/01-architecture.md` §7.4), worker có signed client (`libs/transactional-mailer-job-infrastructure/src/internal-delivery-client.ts`, wire qua `TRANSACTIONAL_MAIL_SERVICE`) — nhưng chưa có deployment nào để xác minh trên runtime, nên worker vẫn **chưa thể** release production (`docs/applications/transactional-mail/03-operations.md` §1.1 tầng (4)). Worker **không** tự định nghĩa protocol cạnh tranh và **không** mở kho nonce của chính mình — worker chỉ ký, không verify.

## 6. Delivery lifecycle

```text
Queue Message ({ version, delivery_id })
     │
     ▼
Validate (version, schema, forbidden keys)
     │
     ▼
Resolve delivery + dispatch_generation (private interface — authority)
     │
     ├── 404 ----------> job failed (delivery-not-found) → báo outcome → ack
     │
     ▼
Check Eligibility (message chưa terminal ở control plane?)
     │
     ▼
Claim lease (một conditional UPDATE — §9.2.1)
     ├── attempts = maxExecutionAttempts → mark blocked (execution-budget-exhausted) → ack, KHÔNG gọi provider
     ├── generation mới hơn → generation-advance claim   (redrive có authorize)
     ├── generation bằng    → claim lại nếu lease đã hết hạn (retry/reclaim sau crash)
     └── generation bằng    → lease còn hiệu lực / terminal / blocked → KHÔNG gọi provider
     │
     ▼
Send qua provider port (§11.1) → adapter relay
     │
     ├── ok ---------> mark sent → report state 'pending' → báo outcome → ack
     ├── retryable --> release lease + retry()  (redelivery claim lại; không gửi trùng)
     ├── permanent ---> mark failed → báo outcome → ack   (terminal per-message)
     ├── credential --> mark blocked (credential) → báo outcome blocked → ack   (non-terminal; redrive được)
     └── contract ---> reject + ack + quarantine marker   (non-terminal; KHÔNG gọi provider)
```

Worker chỉ ack sau khi outcome đã persist bền vững (hoặc delivery đã vào retry path). D1 ghi lỗi → `retry()`, không ack.

## 7. State ownership (D1 `mail-job`)

Hai tầng state, hai owner:

| Tầng                | Owner                      | Lưu ở đâu                     | Vai trò                                                          |
| ------------------- | -------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Logical message     | `transactional-mail`       | D1 `mail` (qua private API)   | Trạng thái đúng của thư: `accepted/queued/sent/failed/blocked`   |
| Job execution       | `transactional-mailer-job` | D1 `mail-job` (binding riêng) | Việc đã làm: attempt, outcome, delivery nào đã xử lý, marker ack |
| Provider credential | `transactional-mailer-job` | Worker Secret (không phải D1) | Credential của relay; không lưu trong Queue/DLQ/log              |

Trường chính của `mail_jobs`: `delivery_id` (PK — idempotency key cấp logical delivery) · `message_id` · `dispatch_generation` (int, bắt buộc) · `execution_generation` (int) · `lease_owner` · `lease_expires_at` · `status` (`processing|sent|failed|blocked`) · `attempts` · `last_error` · `last_error_class` · `provider_message_id` · `provider_call_at` (epoch-ms marker ranh giới gọi provider — migration `0003`: first-write-only, **per-delivery**, không đường nào reset kể cả redrive; biến thời gian của cửa sổ an toàn idempotency §9.6) · `outcome_report_state` (`none|pending|reported|superseded|orphaned`) · `report_lease_owner` · `report_lease_expires_at` · `report_attempts` (counter bền vững cho reconciliation của report — xem §9.5) · `blocked_at` · timestamps; index `(outcome_report_state, updated_at)` để sweep report (index phục vụ **quét và sắp xếp** theo `outcome_report_state='pending'` + `updated_at`; bound dừng auto-retry là predicate **riêng** `report_attempts < maxReportAttempts` áp cho từng row — §9.5, không nằm ở index), index `(status, lease_expires_at)` để tìm lease hết hạn.

**`outcome_report_state` là state riêng của việc báo outcome, tách hẳn khỏi `status` của delivery** — nó mô tả **generation hiện tại đang lưu ở row này**:

| `outcome_report_state` | Nghĩa                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`                 | Chưa có result nào cho generation hiện tại (execution đang chạy, hoặc row vừa được advance sang generation mới). Tương đương `status = processing`. |
| `pending`              | Result đã được persist bền vững (`status ∈ sent/failed/blocked`) nhưng control plane **chưa** xác nhận. Cần báo (ngay, hoặc qua reconcile).         |
| `reported`             | Control plane đã **chấp nhận bền vững**: `result ∈ {applied, duplicate}`. Terminal cho report.                                                      |
| `superseded`           | Control plane xác định report là **stale** so với một dispatch generation mới hơn. Terminal; **không** báo lại tự động.                             |
| `orphaned`             | Delivery không còn tồn tại ở control plane (`404`). Terminal; cần operator.                                                                         |

Bất biến: `outcome_report_state = 'none'` ⟺ `status = 'processing'`; mọi giá trị khác đòi `status ∈ {sent, failed, blocked}`. Khi row được advance sang một `dispatch_generation` mới (§9.2.1), report state của generation cũ **được thay** bằng `none` cho generation mới — sự kiện `superseded` đã được ghi bằng metric/audit tại thời điểm nhận kết quả, nên không mất bằng chứng.

`sent` = provider **đã chấp nhận** việc gửi — không phải bằng chứng thư tới inbox hay được đọc. `failed` là terminal **per-message** (thư này không được gửi). `blocked` là non-terminal cho điều kiện **system-level** (credential `401/403`, provider-not-configured, hoặc ngân sách **B** của generation kiệt — `execution-budget-exhausted`): thư chưa bị từ chối, chỉ chưa gửi được — cần redrive sau khi sửa cấu hình (§9.4).

Trường `attempts` là **ngân sách B** cho một `(delivery_id, dispatch_generation)`: nó tăng trong chính UPDATE nhận execution (claim/reclaim), bị chặn bởi `maxExecutionAttempts`, và **reset khi và chỉ khi** row được advance sang generation mới (§9.2.1 đường (b)). Đây **không** phải một bộ đếm xuyên database; nó bù với ngân sách **A** của control plane (`recovery_cycle_count`) theo `docs/applications/transactional-mail/01-architecture.md` §6.5.

- D1 `mail-job` là authoritative cho job state — không phải KV, không phải memory Worker.
- D1 `mail-job` **không** chứa logical message state, recipient hay nội dung thư.
- Queue không phải source of truth: message mất trong retention được tìm lại bằng reconciliation — control plane reconcile theo `mail_messages` + `mail_outbox`; **quét D1 `mail-job` chỉ cứu được trường hợp job record đã tồn tại**, không cứu được message mất trước khi job record được tạo. Trigger: scheduled handler của chính mỗi Worker ([`03-operations.md`](./03-operations.md) §10).
- Mọi ghi qua `db.batch()` (platform behavior → `docs/architecture/04-platform-facts.md` DB2; D1 transaction tương tác chưa xác minh → `docs/architecture/01-architecture.md` §10).

### 7.1. Persistence boundary (đã materialize — J1)

Hai gói persistence đã tồn tại trong code; từ đây **code là canonical** cho shape chính xác, mục này chỉ giữ ranh giới:

- Port: `libs/transactional-mailer-job-application/src/mail-job-repository-port.ts` — package `@ecoma-io/transactional-mailer-job-application` (`type:application`): interface `MailJobRepository` + `QuarantineRepository` dùng chung cho **cả** execution lẫn reporting, cùng record types, pure rules (`mail-job-rules.ts`) và model/validator (`mail-job-model.ts`). Application không import D1 hay Cloudflare.
- Implement: `libs/transactional-mailer-job-infrastructure/src/d1-mail-job-repository.ts` + `d1-quarantine-repository.ts` (`type:infrastructure`) — sáu statement canonical §9.2.1 và §9.6 (a)/(b)/(c)/(d)/(e)/(g) nguyên văn guard, renew/persist/release có guard owner+token, ba query sweep §10, decode row fail-closed (`mail-job-row.ts`).

Ranh giới và giới hạn của tầng này:

- **Chỉ một contract persistence duy nhất.** J2 (Queue consumer) và J3 (outcome report + sweep) đều gọi port này; không bên nào viết SQL riêng cho `mail_jobs`.
- Mọi result là union tường minh (`applied`/`created`/`duplicate`/`claimed`/`denied`/`acquired`, quarantine thêm `updated`): affected rows = 0 **không bao giờ** được nuốt thành thành công — repository đọc lại tối thiểu state cần thiết và phân loại bằng pure rules.
- Tầng này **không** chứa Queue ack/retry, không gọi provider, không HTTP, không scheduled handler: nó là persistence primitives, không phải orchestration. Wire runtime chưa tồn tại — Worker hiện **chưa** production-ready và việc bật deploy chưa được cho phép.
- `last_error`/`last_error_class` đi qua sanitizer token (lowercase kebab-case, ≤64) ngay ở writer; `field_name` của quarantine đi qua sanitizer identifier-ish riêng vì tên key canonical như `api_key` chứa `_`. Schema không bound được nội dung cột, nên ranh giới nằm ở writer.
- Encoding/raw-body của Queue command cho digest quarantine — **quyết định đã chốt (implementation v1):** representation "raw" được định nghĩa ở application boundary là **chuỗi do consumer nhận được từ Queue** (`Message.body` dạng `string`; producer serialize command **đúng một lần** thành JSON string, Queue giữ nguyên chuỗi). Digest quarantine = HMAC-SHA-256 trên **byte UTF-8 của chuỗi đó**, khoá là Worker Secret HMAC riêng của worker — repository nhận digest **đã tính sẵn**, không tự tính từ một object đã parse. Giới hạn ghi tường minh: chuỗi consumer nhận được không phải là bằng chứng về wire bytes của Cloudflare Queues — digest xác định duy nhất representation đã định nghĩa, không tuyên bố gì về encoding bên dưới Queue.

## 8. Delivery Eligibility

Worker kiểm tra delivery còn eligible trước khi gọi provider:

- message ở control plane đã `sent`/`failed` → **không gửi lại**: đồng bộ job terminal, ack (hoặc báo nốt outcome nếu marker chưa ghi — crash window).
- message ở control plane đang `blocked` → **vẫn eligible** (`blocked` là non-terminal): đây là redrive bình thường sau khi cấu hình provider đã sửa (§9.4).
- delivery không tồn tại (`404`) → ghi job `failed` (`delivery-not-found`), báo control plane, ack (không retry).
- Job `blocked` **cùng generation hiện tại** → **không** gửi lại và **không** tự tạo redelivery; ack command. Vì lần xử lý trước đã ack, không có Queue redelivery tự động nào tới: lần thử lại chỉ đến từ redrive của control plane đã tăng `dispatch_generation`, và khi đó đường **generation-advance claim** (§9.2.1 đường (b)) mới claim được (§9.4).
- Provider endpoint hoặc credential không cấu hình/hợp lệ → `provider-not-configured` / `credential`, mark job `blocked`, báo outcome `blocked`, ack (không retry-storm).

Không có reroute: một single relay được cấu hình cố định ở chính worker (Worker Secret), không do control plane chọn và không fallback sang provider khác khi fail.

## 9. Idempotency

`delivery_id` là idempotency key → logical delivery idempotency: `same delivery_id → same logical delivery`.

### 9.1. Logical idempotency ≠ external exactly-once

Crash window được chấp nhận: provider accepted → worker crash trước khi persist `sent` → Queue retry → duplicate external mail có thể xảy ra. Worker chỉ đảm bảo: không tạo logical delivery mới; state transition không lặp sai. Client có thể dùng correlation/`message_id` để dedupe UX về sau.

### 9.2. Duplicate handling

Worker resolve `dispatch_generation` hiện tại từ control plane **trước** khi quyết định có claim hay không. Queue command **không mang generation identity**: nó là **wake-up signal** cho một `delivery_id`, không phải authorization token cho một generation cụ thể (semantics canonical → `docs/applications/transactional-mail/01-architecture.md` §5). Generation áp dụng khi xử lý command luôn là **generation hiện tại mà control plane đã authorize và đã ghi bền vững**, đọc qua private interface; worker **không thể** phân biệt command cũ với command mới từ payload.

```text
resolve delivery + dispatch_generation (private interface)
    ↓
delivery không tồn tại (404) → job failed (delivery-not-found) → ack
    ↓
job chưa tồn tại → INSERT row với generation hiện tại → claim (§9.2.1)
    ↓
generation hiện tại > mail_jobs.dispatch_generation
    → GENERATION-ADVANCE CLAIM (§9.2.1): bump generation + lấy lease trong một UPDATE
      ├── affected rows = 1 → gọi provider (redrive hợp lệ)
      └── affected rows = 0 → không có lease hiệu lực / terminal → ack (xem dưới)
    ↓
generation hiện tại = mail_jobs.dispatch_generation
    ├── outcome_report_state = 'reported' hoặc 'superseded'  → ack (không gửi lại)
    ├── outcome_report_state = 'pending'                     → BÁO NỐT outcome (crash window) → ack, KHÔNG gọi provider
    ├── outcome_report_state = 'orphaned'                    → ack (đã quarantine) + metric
    ├── status = 'processing' → claim lại (lease hết hạn) hoặc ack (lease còn hiệu lực)
    ├── status = 'blocked'    → ack, chờ redrive có authorize (§9.4)
    └── status = 'sent'/'failed' → ack
```

- **Fencing (`dispatch_generation`):** worker nhận generation từ control plane qua private interface và persist vào `mail_jobs.dispatch_generation` (§9.2.1). Outcome callback **bắt buộc** gửi `dispatch_generation` cùng kết quả; control plane phân loại `applied` / `duplicate` / `stale` — **`stale` không phải success** và worker không được dựa vào HTTP 200 để kết luận đã báo.
- **Lease/fencing execution:** worker phải claim lease atomically. Chỉ execution claim được mới gọi provider; execution gặp lease còn hiệu lực **không** gọi provider.
- Trước khi gọi provider, worker **phải re-validate** lease còn hiệu lực; và với operation dài thì renew trước provider call. Outcome chỉ được ghi khi execution còn sở hữu lease và generation khớp.
- Báo outcome thất bại **sau khi** đã persist execution state thành công **không** bao giờ là lý do gửi lại: lần redelivery sau đọc `outcome_report_state = 'pending'` và chỉ **báo nốt** outcome, không gọi lại provider.
- Concurrency: conditional UPDATE + lease đảm bảo exclusive execution; execution thua không lấy được lease đứng ngoài, không gọi provider.
- **Stale execution không bao giờ ghi đè durable state mới hơn.** Mọi ghi state/outcome đều là conditional write có guard owner + token + generation (§9.2.1), nên execution đã mất claim **không thể** lật ngược trạng thái của generation mới hơn. Giới hạn phải nói rõ: fencing bảo vệ **durable state**, nó **không** huỷ được một provider request **đã rời khỏi** Worker — xem "Giới hạn — KHÔNG có exactly-once" bên dưới.

### 9.2.1. Execution claim (lease) protocol — D1 `mail-job`

Lease là cơ chế **durable** để chỉ một execution được gọi provider cho một `(delivery_id, dispatch_generation)`. Lease nằm trong D1 `mail-job`, không nằm trong memory Worker.

Worker có **sáu** statement claim/ghi quyết định, **tất cả** đều là **một conditional UPDATE duy nhất** (không read-then-write): (a) claim cùng generation, (b) generation-advance claim khi redrive bump generation, (c) chốt `blocked` khi ngân sách B kiệt, (d) acquire report-lease trước khi báo nốt outcome, (e) ghi marker ranh giới gọi provider `provider_call_at` ngay trước mỗi request provider (§9.6), và (g) chốt `blocked` (`provider-ambiguous-outcome`) khi kết quả provider mơ hồ ngoài cửa sổ an toàn (§9.6). Các statement này là **nguồn duy nhất** — không có read-then-write nào khác cho cùng mục đích.

**(a) Claim cùng generation** — tiếp tục một delivery đang in-flight cho generation hiện tại (retry sau lỗi transient, reclaim sau khi lease hết hạn do crash). Đây cũng là chỗ tiêu **ngân sách B** (`attempts`):

```sql
UPDATE mail_jobs
   SET execution_generation = execution_generation + 1,
       attempts             = attempts + 1,                        -- tiêu một slot ngân sách B
       lease_owner          = :owner,          -- định danh execution (UUID sinh local)
       lease_expires_at     = :now + :leaseMs,
       status               = 'processing',
       outcome_report_state = 'none',
       updated_at           = :now
 WHERE delivery_id            = :delivery_id
   AND dispatch_generation    = :generation                       -- fencing theo control plane
   AND attempts               <  :maxExecutionAttempts            -- ngân sách B chưa kiệt
   AND (lease_expires_at IS NULL OR lease_expires_at <= :now)     -- không có lease hiệu lực
   AND status NOT IN ('sent', 'failed', 'blocked')                -- terminal/blocked không claim lại
```

Job chưa có row → INSERT chưa giữ lease với `execution_generation = 0`, `attempts = 0`, `status = 'processing'`, `outcome_report_state = 'none'` và `dispatch_generation = :generation` **đọc từ control plane** (`ON CONFLICT DO NOTHING` rồi claim lại bằng đường (a)).

**(b) Generation-advance claim** — một redrive có authorize đã bump generation ở control plane; job row còn ở generation cũ. Generation đổi ⇒ **ngân sách B reset** cho generation mới:

```sql
UPDATE mail_jobs
   SET dispatch_generation  = :new_generation,                     -- tiến tới generation mới
       execution_generation = execution_generation + 1,
       attempts             = 1,                                   -- B reset: generation mới, ngân sách mới
       lease_owner          = :owner,
       lease_expires_at     = :now + :leaseMs,
       status               = 'processing',
       outcome_report_state = 'none',
       blocked_at           = NULL,
       report_lease_owner   = NULL,                                -- clear report-lease của generation cũ
       report_lease_expires_at = NULL,                             -- report state đã về 'none'; không giữ lease cũ
       report_attempts      = 0,                                   -- bound của sweep reset cho generation mới
       updated_at           = :now
 WHERE delivery_id            = :delivery_id
   AND dispatch_generation    < :new_generation                    -- CHỈ generation mới hơn
   AND (lease_expires_at IS NULL OR lease_expires_at <= :now)      -- không có lease hiệu lực
   AND status NOT IN ('sent', 'failed')                            -- generation mới không áp cho terminal
```

**(c) Ngân sách B kiệt → `blocked`** — claim (a) trả `affected rows = 0` **và** lý do là ngân sách, không phải có lease hiệu lực. Worker chốt kết quả bằng **một** conditional UPDATE khác, rồi báo outcome `blocked` và ack:

```sql
UPDATE mail_jobs
   SET status               = 'blocked',
       blocked_at           = :now,
       last_error_class     = 'execution-budget-exhausted',
       outcome_report_state = 'pending',
       lease_owner          = NULL, lease_expires_at = NULL,
       updated_at           = :now
 WHERE delivery_id            = :delivery_id
   AND dispatch_generation    = :generation
   AND attempts               >= :maxExecutionAttempts            -- CHỈ khi B đã kiệt
   AND (lease_expires_at IS NULL OR lease_expires_at <= :now)     -- KHÔNG cắt ngang execution đang chạy
   AND status NOT IN ('sent', 'failed', 'blocked')                -- idempotent + không đè kết quả
```

- **Vì sao guard `lease_expires_at` bắt buộc ở (c):** execution tiêu slot B **cuối cùng** vẫn có thể đang chạy và sắp thành công. Nếu (c) không đòi "không có lease hiệu lực", nó sẽ đánh dấu `blocked` trong khi owner còn sống, và owner đó persist kết quả vào affected rows = 0 (mất kết quả thật). Vì vậy (c) **chỉ** áp khi generation không còn execution sống; hai handler cùng chạy (c) là idempotent (lần thứ hai gặp `status = 'blocked'` → affected rows = 0).
- **Phân biệt "hết B" với "có lease":** worker phân loại `affected rows = 0` bằng cách đọc `attempts` + `lease_expires_at` + `status` của row. `attempts >= maxExecutionAttempts` và không có lease hiệu lực ⇒ (c). Còn lease hiệu lực (hoặc row terminal) ⇒ **không** đánh dấu gì, xử lý theo §9.2 (thường là ack).
- **Vì sao cần đường (b):** redrive bump `dispatch_generation` ở control plane, nhưng row `mail_jobs` vẫn ở generation cũ với `status = 'blocked'`. Nếu chỉ có đường (a), điều kiện `dispatch_generation = :generation` không bao giờ thoả (row ở generation cũ) và guard `status NOT IN (...)` cũng loại `blocked` — job vĩnh viễn không claim được và redrive vô hiệu. Đường (b) là transition nguyên tử duy nhất đưa row sang generation mới **và** lấy lease trong cùng một UPDATE.
- **`dispatch_generation < :new_generation` (strict):** guard này so **generation authority đọc từ control plane** với generation đã lưu ở row, **không** so với giá trị nào trên command (command không mang generation). Khi authority **không lớn hơn** generation đã lưu, đường (b) **không** claim được và **không bao giờ** reset row về generation cũ. Một command tới muộn chỉ là _trigger_ để worker resolve lại authority; bản thân nó **không mang** và **không chứng minh** generation, nên nó **không thể** tự authorize một generation mà redrive chưa bump.
- **Lease còn hiệu lực chặn cả hai đường.** Owner cũ giữ lease thì generation-advance claim phải chờ `lease_expires_at` — delay **bounded** bởi `leaseMs`, không vô hạn. Điều này giữ nguyên nguyên tắc one-lease-only giữa các generation.
- **Generation-advance claim clear report-lease của generation cũ trong cùng statement.** Vì `outcome_report_state` về `none` và generation đổi, một `report_lease_owner` còn sót lại của generation cũ là state mồ côi: giữ nó sẽ khiến bước acquire report-lease (d) của generation mới bị chặn tới `report_lease_expires_at` (tối đa `reportLeaseMs`) dù row đã sang generation mới và không còn execution nào của generation cũ sống. Vì vậy (b) MUST set cả `report_lease_owner = NULL` và `report_lease_expires_at = NULL`. Việc này an toàn vì report của generation cũ đã bị thay bằng `none` (không còn gì để bảo vệ) và mọi lần ghi report đều guard `report_lease_owner`; một sweeper của generation cũ chạy sau đó sẽ thấy `outcome_report_state = 'none'` → không acquire được (guard (d) đòi `'pending'`).
- `affected rows = 1` → execution sở hữu lease, và **chỉ nó** được gọi provider.
- `affected rows = 0` → không lấy được quyền; **không** gọi provider; xử lý theo §9.2 (thường là ack).
- Job chưa có row → INSERT **chưa giữ lease** với `execution_generation = 0`, `attempts = 0`, `status = 'processing'`, `outcome_report_state = 'none'` và `dispatch_generation = :generation` **đọc từ control plane** (`ON CONFLICT DO NOTHING` rồi claim lại bằng đường (a), để hai execution đồng thời không cùng thắng). Nhờ vậy `attempts` và `execution_generation` đạt **1** ở claim đầu tiên — không đếm đôi.
- `execution_generation` là **monotonic claim token**: mỗi lần claim (đường a hoặc b) tăng 1, nên một owner cũ luôn có token nhỏ hơn owner mới.

**Chỉ owner được gọi provider.** Trước khi gọi provider, owner **phải re-validate** lease còn hiệu lực (`lease_expires_at > now` **và** `lease_owner = :owner` **và** `execution_generation` khớp token đã claim); nếu không, dừng, không gọi provider. Re-validate lặp lại **ngay trước** provider call để thu hẹp cửa sổ một generation mới đã supersede execution này.

**Renewal và độ dài lease.** Với operation dài (runtime resolution + provider request + persist kết quả), owner **gia hạn lease trước khi bắt đầu** provider call, bằng conditional update có guard `lease_owner = :owner AND execution_generation = :token`. `leaseMs` phải **lớn hơn** tổng worst-case bounded của: runtime resolution timeout + provider request timeout (mặc định 10 s) + thời gian ghi D1 + margin; giá trị cụ thể là **giá trị vận hành chốt ở deploy** và phải được validate lại khi bất kỳ timeout nào thay đổi. Lease ngắn hơn provider request sẽ tạo overlap giả (xem giới hạn dưới).

**Ghi kết quả (chỉ owner hiện tại).** Persist result bằng conditional update có guard `lease_owner = :owner AND execution_generation = :token AND dispatch_generation = :generation`, và **kèm luôn việc release lease trong cùng statement** (`lease_owner = NULL`, `lease_expires_at = NULL`, `outcome_report_state = 'pending'`). Nếu affected rows = 0, execution này **không còn sở hữu** — nó **không** ghi `sent`/`failed`/`blocked`, **không** báo outcome, và **không** gửi lại; chỉ ghi metric `lost-claim`.

**(d) Acquire report-lease** — trước khi một execution báo nốt outcome (§9.5), nó phải **claim report-lease** bằng **một** conditional UPDATE có guard trên `outcome_report_state = 'pending'` + report-lease hết hiệu lực (`report_lease_expires_at IS NULL OR report_lease_expires_at <= :now`) — và **set** `report_lease_owner`, `report_lease_expires_at`, `report_attempts`; owner là thứ được ghi và được kiểm ở bước **release** (bên dưới), không phải predicate của bước claim — để hai sweeper (hoặc sweeper và một Queue redelivery) không báo trùng trên cùng row:

```sql
UPDATE mail_jobs
   SET report_lease_owner     = :owner,          -- định danh execution/sweeper (UUID sinh local)
       report_lease_expires_at = :now + :reportLeaseMs,
       report_attempts        = report_attempts + 1,   -- counter bền vững cho bound của sweep (§9.5)
       updated_at              = :now
 WHERE delivery_id             = :delivery_id
   AND dispatch_generation     = :generation
   AND outcome_report_state    = 'pending'                                     -- chỉ report chưa xong
   AND (report_lease_expires_at IS NULL OR report_lease_expires_at <= :now)    -- không có report-lease hiệu lực
```

- `affected rows = 1` → chỉ execution này được gửi `POST .../outcome`; sau đó nó chốt `reported`/`superseded`/`orphaned` **và** release report-lease (`report_lease_owner = NULL`, `report_lease_expires_at = NULL`) trong **cùng** conditional UPDATE ghi kết quả, có guard `report_lease_owner = :owner` — **không** release mù, cùng nguyên tắc với release của execution lease.
- `affected rows = 0` → không báo; xử lý theo §9.2 (thường là ack). Report-lease **không** thay thế execution lease: nó chỉ bảo vệ bước báo outcome, và **không** cho phép gọi provider.
- `reportLeaseMs` là **giá trị vận hành chốt ở deploy** (`03-operations.md` §3), cùng nhóm với `leaseMs`; nó phải lớn hơn worst-case bounded của một lần gọi `POST .../outcome` + ghi D1 + margin.
- Một report-lease hết hạn mà chưa release (crash giữa lúc báo và lúc ghi kết quả) được claim lại sau `report_lease_expires_at`; nếu control plane đã nhận outcome trước đó thì lần báo lại nhận `duplicate` — an toàn vì idempotency ở control plane.

**(e) Marker ranh giới gọi provider `provider_call_at`** — first-write-only, guard ownership chuẩn (lease + `execution_generation` + `dispatch_generation`), gọi ngay trước mỗi request provider; statement canonical và hai kết quả `applied`/`already-marked` ở §9.6.

**(g) Chốt `blocked` cho mơ hồ ngoài cửa sổ an toàn** khi kết luận mơ hồ nằm ngoài cửa sổ (persist-denied hoặc `already-marked` ngoài cửa sổ): release lease không-kết-quả rồi chốt `provider-ambiguous-outcome`; statement canonical và điều kiện chốt ở §9.6.

### 9.2.2. Ma trận transition lease/outcome (canonical)

Bảng này là **nguồn duy nhất** cho vòng đời lease và báo outcome ở mức transition; `02-requirements.md` và `03-operations.md` chỉ tham chiếu. Cột "Guard bắt buộc" nêu tên field, còn **statement canonical** của từng guard nằm ở §9.2.1 — claim/advance/blocked ở (a)/(b)/(c), và acquire report-lease ở (d). Mọi **release lease** đều là conditional update có guard `lease_owner` + `execution_generation`; **không** có đường release nào là "luôn thành công", và **không** đường nào ack làm mất delivery intent khi vẫn còn đường recovery bền vững.

Mọi tham chiếu `§9.2.2 hàng N` trong toàn bộ tài liệu chỉ **bảng transition này**. Bảng **Kịch bản kiểm chứng** ở cuối §9.2.2 cũng đánh số 1–19 nhưng dùng cột `#` và là kịch bản kiểm chứng, **không** phải transition — nó không bao giờ được tham chiếu bằng `hàng N`.

| #   | Transition                                                 | Durable state trước → sau                                                                    | Lease                                                                     | Queue message                                                                           | Gọi provider lại?                                     | Resume report                                                          | Guard bắt buộc                                                                             | Metric / alert                         |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| 1   | Provider success (`2xx`)                                   | `processing` (+lease) → `sent` + report `pending`                                            | Release trong **cùng** UPDATE persist                                     | ack **sau** khi report `reported`; transient → `retry()`                                | **Không** — result đã persist                         | Ngay, rồi sweeper nếu fail                                             | `lease_owner` + `execution_generation` + `dispatch_generation`                             | `delivery-success`                     |
| 2   | Permanent per-message failure                              | `processing` (+lease) → `failed` + report `pending`                                          | Release trong cùng UPDATE persist                                         | Như hàng 1                                                                              | **Không**                                             | Ngay, rồi sweeper                                                      | như hàng 1                                                                                 | `delivery-failed` (`permanent`)        |
| 3   | Credential/config provider fail (`401/403`)                | `processing` (+lease) → `blocked` + `blocked_at` + report `pending`                          | Release trong cùng UPDATE persist                                         | Như hàng 1; **không** retry-storm                                                       | **Không**                                             | Ngay, rồi sweeper                                                      | như hàng 1                                                                                 | `blocked` + Page                       |
| 4   | Endpoint/credential chưa cấu hình                          | `processing` (+lease) → `blocked` (`provider-not-configured`) + report `pending`             | Release trong cùng UPDATE persist                                         | Như hàng 1                                                                              | **Không**                                             | Ngay, rồi sweeper                                                      | như hàng 1                                                                                 | `blocked` + Page                       |
| 5   | Ngân sách **B** kiệt (`attempts = max`)                    | `processing` (không lease) → `blocked` (`execution-budget-exhausted`) + report `pending`     | **Không** giữ lease; UPDATE (c) đòi "không lease hiệu lực"                | ack sau khi report `reported`                                                           | **Không**                                             | Ngay, rồi sweeper                                                      | `attempts >= maxExecutionAttempts` + không lease hiệu lực + `status NOT IN (...)`          | `execution-budget-exhausted` + Page    |
| 6   | Transient provider/network/timeout                         | `processing` (+lease) → `processing` (không lease) + `last_error`; `attempts` **không** tăng | Release trong cùng UPDATE                                                 | `retry()`; redelivery claim lại được ngay                                               | Có (execution kế tiếp)                                | n/a (chưa có result)                                                   | như hàng 1                                                                                 | `delivery-retry`                       |
| 7   | Private API unavailable **trước** provider call            | `processing` (+lease) → `processing` (không lease)                                           | Release có guard owner+token                                              | `retry()`                                                                               | Chưa từng gọi → không có side effect                  | n/a                                                                    | `lease_owner` + `execution_generation`                                                     | `runtime-resolution-failure`           |
| 8   | D1 lỗi **trước** khi ghi state bền vững                    | `processing` (+lease, **không đổi được**)                                                    | Release **thất bại** (chính D1 lỗi) → lease tự hết hạn                    | `retry()` — **không** ack khi chưa persist                                              | Message quay lại khi lease còn hiệu lực → hàng 15     | n/a                                                                    | không có ghi thành công → không có guard nào áp                                            | `d1-write-error` + Page                |
| 9   | Crash **sau** provider success, **trước** persist          | `processing` (+lease chết) → sau `lease_expires_at`: `processing` (lease mới, `attempts++`)  | Lease cũ tự hết hạn; claim (a) tiêu **B**                                 | Message bị redeliver → claim lại                                                        | **Có thể** → duplicate mail (residual, §9.2 giới hạn) | n/a (chưa persist)                                                     | `lease_expires_at <= now` + `status` + `dispatch_generation` + `attempts < max`            | `lost-claim` / `duplicate-mail`        |
| 10  | Crash **sau** persist, **trước** report                    | `sent`/`failed`/`blocked` + report `pending` (lease đã release ở hàng 1–4)                   | Đã release; **không** claim lại                                           | Redelivery hoặc sweeper — **chỉ** báo nốt outcome                                       | **Không** (status terminal chặn claim)                | Sweeper quét `pending`, hoặc redelivery báo nốt                        | `report_lease_owner` + `report_lease_expires_at`                                           | `report-age` + Page                    |
| 11  | Outcome callback transient failure                         | report `pending` (không đổi)                                                                 | Đã release ở hàng 1–4; **không** giữ lại để báo                           | `retry()` hoặc sweeper                                                                  | **Không**                                             | Sweeper                                                                | `report_lease_owner` + `report_lease_expires_at`                                           | `report-retry`                         |
| 12  | Outcome callback `applied` / `duplicate`                   | report `pending` → `reported` (terminal cho report)                                          | không giữ                                                                 | ack                                                                                     | **Không**                                             | Xong                                                                   | `report_lease_owner` + `report_lease_expires_at`                                           | `report-success`                       |
| 13  | Outcome callback `stale`                                   | report `pending` → `superseded` (terminal)                                                   | không giữ                                                                 | ack                                                                                     | **Không** — không retry vòng                          | **Không** bao giờ báo lại                                              | `report_lease_owner` + `report_lease_expires_at`                                           | `outcome-stale` + audit                |
| 14  | Outcome callback `404` (message biến mất)                  | report `pending` → `orphaned` (terminal)                                                     | không giữ                                                                 | ack                                                                                     | **Không** — không retry vòng                          | **Không**                                                              | `report_lease_owner` + `report_lease_expires_at`                                           | `outcome-orphaned` + Page (operator)   |
| 15  | Duplicate Queue command, lease còn hiệu lực                | không đổi (ngoài `updated_at`)                                                               | Giữ nguyên (owner sống)                                                   | **ack** (`duplicate-suppressed`)                                                        | **Không**                                             | n/a                                                                    | claim (a) `affected rows = 0` (lease hiệu lực)                                             | `duplicate-suppressed`                 |
| 16  | Lease hết hạn / reclaim                                    | `processing` (lease cũ) → `processing` (lease mới, `execution_generation++`, `attempts++`)   | Claim lại có guard; owner cũ mất quyền ghi                                | command redelivery claim được                                                           | Có (execution mới)                                    | n/a                                                                    | `lease_expires_at <= now` + `status NOT IN (sent,failed,blocked)` + gen + `attempts < max` | `lost-claim`                           |
| 17  | Redrive sang generation mới khi execution cũ chạy          | row gen N + lease → sau `lease_expires_at` claim (b) sang N+1 (`exec_gen++`, `attempts = 1`) | Claim (b) chờ lease cũ hết hạn (`leaseMs` bounded)                        | command wake-up ack nếu chưa claim được                                                 | gen N+1 có; gen N nếu đang gửi → outcome `stale`      | n/a                                                                    | `dispatch_generation < :new` + không lease hiệu lực + `status NOT IN (sent,failed)`        | `generation-advance` / `outcome-stale` |
| 18  | Provider request đang in-flight khi lease hết hạn          | hai execution cùng gọi provider cho cùng generation                                          | **Không** guard nào cứu được — ghi nhận residual risk                     | n/a                                                                                     | **Có** → duplicate có thể xảy ra                      | n/a                                                                    | không có (giới hạn nền tảng, §9.2)                                                         | `duplicate-mail` + alert               |
| 19  | Private API `401`/`403` (authn/authz của **chính worker**) | lookup: `processing` (+lease) → `processing` (không lease); report: `pending` (giữ nguyên)   | Release có guard owner + token (như hàng 7); report đã release ở hàng 1–4 | lookup: `retry()` bounded (hết lượt → DLQ + alert); report: **không** vòng retry vô hạn | **Không** — không có kết quả nào để ghi               | lookup: không áp dụng; report: giữ `pending`, resume sau khi sửa quyền | `lease_owner` + `execution_generation` + `dispatch_generation`                             | `internal-auth-failure` + alert `Page` |

**Quy tắc chốt cho toàn bộ ma trận:**

- **Báo lại outcome không bao giờ kéo theo gửi lại mail.** Hàng 10–14 chỉ chạm `outcome_report_state`; provider **không** được gọi lại khi result đã persist bền vững, vì claim (a)/(b) bị chặn bởi `status NOT IN ('sent','failed','blocked')`.
- **Chỉ lỗi transient mới được retry report tự động** (hàng 11). `stale` → `superseded`, `404` → `orphaned` là terminal cho report — không giữ ở `pending` và không retry vòng (§9.5).
- **`401`/`403` từ private API không phải transient** (hàng 19). Đây là lỗi authn/authz của **chính worker** (signature/clock skew, hoặc thiếu permission) — **khác** control plane quá tải (`5xx`/timeout, hàng 7) và **khác** delivery hỏng (`404` → `orphaned`, hàng 14). Xử lý: **không** đánh delivery thành terminal/`orphaned` (state ở control plane vẫn đúng), **không** gửi lại mail, và **không** tạo vòng retry vô hạn — alert `Page`, giữ report ở `pending` (recoverable sau khi sửa quyền); với lookup thì `retry()` bounded rồi DLQ. Không được gộp nhóm này vào "API unavailable": một outage tự hết, một permission sai thì không.
- **`blocked` cùng generation không claim được bằng retry/reclaim thường** (hàng 3–5): guard `status NOT IN ('sent','failed','blocked')` của đường (a) loại nó; đường duy nhất đưa nó trở lại là generation-advance claim (hàng 17) sau redrive có authorize.
- **Claim generation mới là conditional và atomic** (hàng 17, đường (b) §9.2.1): `dispatch_generation < :new_generation` + không lease hiệu lực, tất cả trong một UPDATE.
- **Owner mất claim không ghi đè kết quả** (hàng 9, 17): guard token làm affected rows = 0; execution cũ **không** ghi state và **không** báo outcome.
- **Ack không bao giờ là đường mất intent duy nhất.** Mọi ack ở ma trận trên đều để lại ít nhất một đường recovery bền vững: owner sống hoàn tất, **control-plane reconciler** cho delivery còn non-terminal quá ngưỡng tuổi (`docs/applications/transactional-mail/03-operations.md` §5.3 — lần re-enqueue đó cho execution kế tiếp claim lại qua đường (a) sau `lease_expires_at`), hoặc report sweeper. **Lưu ý về "stale-lease reclaim":** nó **không** phải một đường độc lập tự chạy — sweep của worker **chỉ alert** (`03-operations.md` §10 hàng 1) và không claim lease. Một row lease-hết-hạn chỉ được claim lại khi **có một command mới tới** (§9.2.1 đường (a)); nếu ack đã bỏ command cuối cùng thì command mới đó phải do control plane reconcile re-enqueue mà ra, tức là đường này **tiêu một slot A không hoàn lại**. Vì vậy ack-then-owner-crash là một nguồn churn A có thật, được bound bởi `maxRecoveryCycles` chứ không phải bởi một lease reclaim miễn phí. Riêng hàng 8 **không** ack: Queue retry còn khả dụng và chưa persist được gì, nên ack ở đó chỉ đẩy việc phục hồi sang reconciler chậm hơn mà không có lợi — ack chỉ dùng khi state đã bền vững hoặc khi intent đã nằm an toàn ở một durable record khác.
- **D1 chết chặn cả việc release lease:** fallback là "lease tự hết hạn theo thời gian + reclaim", **không** phải "coi release là thành công" (hàng 8).
- **Ambiguity còn lại không xoá được bằng tài liệu:** hàng 9 và 18 — khi provider không có idempotency key, crash trong lúc request và overlap do lease hết hạn **có thể** sinh duplicate external mail; đây là residual risk phải ghi nhận, không được mô tả là đã giải quyết (§9.3).

**Gặp lease còn hiệu lực (competing execution hoặc duplicate Queue message).** Execution không claim được vì lease còn hiệu lực **không** gọi provider. Hành vi per-message: ack khi job terminal, ack khi `blocked` cùng generation (§9.4), `retry()` khi lỗi hạ tầng lúc đọc/claim (`03-operations.md` §3 nhóm 7). **Ack ở đây không mất delivery**: nếu owner chết, recovery chạy qua control-plane reconciler cho delivery còn non-terminal quá ngưỡng tuổi (`docs/applications/transactional-mail/03-operations.md` §5.3), và execution kế tiếp claim lại qua đường (a) sau `lease_expires_at`. Sweep của worker **không** phải đường đó — nó chỉ alert và không claim (§10 hàng 1, `03-operations.md`).

**Lease không release được vì D1 lỗi** _(fallback)_: lease **không** bị coi là đã release. Nó tự hết hạn theo thời gian, và recovery là một trong hai đường ở hàng "Duplicate Queue message gặp lease còn hiệu lực". Vì vậy một lease "mồ côi" chỉ gây **delay bounded**, không gây mất delivery intent — intent bền vững nằm ở control plane.

**Tương tác với `dispatch_generation` của control plane.** Đây là hai tầng fencing **khác nhau, cùng tồn tại**:

| Tầng                           | Ở đâu                | Bảo vệ điều gì                                                 |
| ------------------------------ | -------------------- | -------------------------------------------------------------- |
| `dispatch_generation`          | control plane `mail` | Delivery này có còn được phép gửi không (redrive đã bump chưa) |
| `execution_generation` + lease | worker `mail-job`    | Execution nào được gọi provider cho generation đó              |

Claim yêu cầu **cả hai**: `dispatch_generation` khớp authority ở control plane **và** không có lease hiệu lực. Execution cũ với `dispatch_generation` cũ **không** claim được cho generation mới, và outcome của nó bị control plane từ chối (`result = stale`).

**Giới hạn — KHÔNG có exactly-once.** Database fencing **không** thể hoàn tác hay ngăn một external side effect mà một execution cũ **đã bắt đầu** (HTTP request đã rời khỏi Worker, provider đã nhận, kể cả đã gửi mail) trước khi nó mất claim. Các cửa sổ còn lại:

- Worker crash **trước** khi gọi provider → không có side effect; execution mới claim lại và gửi.
- Worker crash **trong** provider request → provider **có thể** đã nhận và gửi; execution mới claim lại sau khi lease hết hạn và gửi lần nữa. **Lease không cứu được trường hợp này.**
- Worker crash **sau khi provider accept nhưng trước khi persist** → cùng như trên.
- Lease hết hạn trong lúc execution cũ vẫn đang chạy (GC pause, provider chậm hơn `leaseMs`) → hai execution cùng gọi provider.

Vì vậy: **lease không chứng minh exactly-once delivery**. Bắt buộc **provider-side idempotency khi provider hỗ trợ** (gửi `delivery_id` làm idempotency key — §9.3); khi provider không hỗ trợ, **residual risk của crash/overlap là duplicate mail và phải được ghi nhận là rủi ro không loại bỏ được**, không được mô tả là đã giải quyết. Thực thi **one-lease-only** để **giảm** xác suất overlap, không phải để loại bỏ nó.

**Kịch bản kiểm chứng (kỳ vọng hành vi):**

| #   | Kịch bản                                                                                        | Kỳ vọng                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hai consumer claim đồng thời cùng `(delivery_id, generation)`                                   | Chỉ một conditional UPDATE trả affected rows = 1; execution thua **không** gọi provider, ack (duplicate-suppressed).                                                                                                                                                                                                                              |
| 2   | Một execution giữ lease hiệu lực, một duplicate Queue message tới                               | Message thứ hai không gọi provider; ack; metric `duplicate-suppressed`; job row không đổi ngoài `updated_at`.                                                                                                                                                                                                                                     |
| 3   | Lease hết hạn trong khi execution cũ bị delay                                                   | Execution mới claim được, `execution_generation` tăng; execution cũ re-validate lease **trước** provider call và dừng.                                                                                                                                                                                                                            |
| 4   | Execution cũ cố persist outcome **sau khi** execution mới đã claim                              | Conditional write affected rows = 0 (token/owner lệch); execution cũ không ghi và không báo outcome; metric `lost-claim`.                                                                                                                                                                                                                         |
| 5   | Worker restart **trước** provider invocation                                                    | Không có side effect; sau khi lease hết hạn execution mới claim và gửi; chỉ một mail.                                                                                                                                                                                                                                                             |
| 6   | Worker restart **trong** provider request                                                       | Provider có thể đã gửi; execution mới gửi lại sau khi lease hết hạn → **duplicate mail có thể xảy ra**; giảm thiểu bằng provider idempotency key khi provider hỗ trợ (§9.3).                                                                                                                                                                      |
| 7   | Worker restart **sau khi** provider accept, **trước khi** persist state                         | Như #6; đồng thời job row còn `processing` với lease cũ → reclaim theo lease (§10).                                                                                                                                                                                                                                                               |
| 8   | Lần đầu `blocked` ở generation N, rồi redrive (generation N+1)                                  | Command wake-up tới → resolve authority = N+1 > row N → **generation-advance claim** thành công, `status = processing`, `outcome_report_state = 'none'`; worker gọi provider; row không còn `blocked`.                                                                                                                                            |
| 9   | Command wake-up tới khi `mail_jobs` còn ghi generation N, authority là N+1                      | Claim đường (b) áp dụng (`dispatch_generation < :new_generation`); nếu lease cũ còn hiệu lực thì claim thất bại → worker ack, chờ `lease_expires_at` rồi claim lại (delay bounded bởi `leaseMs`).                                                                                                                                                 |
| 10  | Command publish lúc authority còn là N tới **sau khi** N+1 đã được authorize                    | Worker resolve authority = N+1; bản thân command **không** mang và **không** chứng minh generation nào, nên nó **không** authorize gì. Nếu row còn N → claim được sang N+1 (authority là nguồn duy nhất); nếu row đã N+1 → guard `dispatch_generation < :new_generation` thất bại → **không** reset về N, không gọi provider, ack.                |
| 11  | Hai consumer claim **generation-advance** đồng thời cùng N+1                                    | Chỉ một conditional UPDATE trả affected rows = 1 (lease winner); execution thua không gọi provider, ack.                                                                                                                                                                                                                                          |
| 12  | Execution gen N đang giữ lease khi gen N+1 được redrive                                         | Generation-advance claim của gen N+1 **thất bại** lúc này (lease còn hiệu lực); execution gen N vẫn được ghi state của chính nó (guard token còn đúng) nhưng outcome của nó bị control plane trả `stale`. Sau `lease_expires_at`, claim gen N+1 thành công.                                                                                       |
| 13  | Duplicate command của cùng `delivery_id` sau khi job ở generation hiện tại đã terminal (`sent`) | Guard `status NOT IN ('sent','failed')` chặn; `outcome_report_state = 'reported'`/`'superseded'` → ack, không gửi lại, không đổi row.                                                                                                                                                                                                             |
| 14  | `outcome_report_state = 'pending'` và Queue redelivery (crash window)                           | Worker **chỉ báo nốt** outcome (không gọi provider) → `reported` → ack. Lease không bị lấy lại.                                                                                                                                                                                                                                                   |
| 15  | Duplicate Queue message khi một execution khác giữ lease hiệu lực, rồi owner đó crash           | Message thứ hai ack (`duplicate-suppressed`); sau `lease_expires_at`, execution kế tiếp claim lại được (đường (a)) — không mất delivery.                                                                                                                                                                                                          |
| 16  | Retryable error rồi Queue redelivery **trước** khi lease hết hạn                                | Hai nhánh, cả hai đều không mất delivery: (a) release đã commit (đường thường) → redelivery claim lại được ngay; (b) redelivery tới khi lease **còn** hiệu lực (release chưa commit hoặc D1 lỗi) → không gọi provider, ack, và recovery đảm bảo qua stale-lease reclaim hoặc control-plane reconciler sau `lease_expires_at` (§10 trách nhiệm 1). |
| 17  | Retryable error rồi Queue redelivery **sau** khi lease đã hết hạn                               | Claim lại thành công (đường (a)), `execution_generation` tăng, gọi provider; không có hai execution song song.                                                                                                                                                                                                                                    |
| 18  | D1 lỗi khi đang cố release lease                                                                | Release **không** xảy ra (conditional update fail); **không** ack. Lease cũ còn hiệu lực tới `lease_expires_at`, sau đó execution kế tiếp reclaim — không mất delivery intent.                                                                                                                                                                    |
| 19  | Redrive ngay sau khi job vào `blocked`                                                          | Nếu lease của execution cũ đã release thì claim gen mới thành công ngay; nếu chưa, claim thất bại tới `lease_expires_at` rồi thành công — delay bounded, không vô hạn.                                                                                                                                                                            |

### 9.3. Provider idempotency (trạng thái capability — production gate)

**Provider mặc định đã chọn (implementation v1): Cloudflare Email Service** qua binding `send_email` in-process (`env.SEND_EMAIL.send(...)`). Sender identity ghim `no-reply@ecoma.io` ở `allowed_sender_addresses` của binding; sender domain cần được onboard Email Service trước khi binding hoạt động thật (`E_SENDER_DOMAIN_NOT_AVAILABLE` → credential-class → `blocked` — §11). Trạng thái capability idempotency của Cloudflare Email Sending: **`unsupported`** — tài liệu chính thức của Workers API (`send()` binding) không công bố bất kỳ header/parameter idempotency key nào, và sandbox binding cũng không có đường truyền key đó; bằng chứng chiều âm theo đúng tiêu chí bên dưới. **Hệ quả tường minh:** với `unsupported`, KHÔNG có nhánh auto-resend an toàn nào sau persist-denied hay mất claim — mọi mơ hồ sau khi đã chạm provider đều chốt `provider-ambiguous-outcome` (§9.6) và đỏi operator, kể cả trong cửa sổ an toàn; `MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS` với provider này chỉ còn vai trò chốt `blocked` sớm nhất có thể, không còn mở nhánh resend nào. Residual duplicate risk được chấp nhận tường minh (hàng `unsupported` của bảng dưới). Credential Resend (`MAIL_PROVIDER_ENDPOINT`/`MAIL_PROVIDER_TOKEN`) KHÔNG được đặt cạnh provider này.

Adapter phụ **Resend** (`POST https://api.resend.com/emails`, bearer token, body `{from, to, subject, html}`) giữ lại với `MAIL_PROVIDER_KIND=resend`: HTTP API thuần JSON tương thích Cloudflare Workers, không cần SDK. Trạng thái capability idempotency của Resend: **`unverified`** — tài liệu chính thức công bố header `Idempotency-Key` (giá trị ≤ 256 ký tự, giữ kết quả 24 giờ), nhưng chưa có bằng chứng sandbox quan sát được theo tiêu chí bên dưới, nên status không được nâng lên `verified`. Trước production, trạng thái MUST khác `unverified` (gate bên dưới vẫn nguyên). Endpoint/token/sender là Worker Secret + config của chính worker; khi thiếu → fail-closed, không fallback sang fake provider ở production.

`delivery_id` là **provider idempotency key dự kiến**: nếu provider được chọn hỗ trợ idempotency key/`Idempotency-Key` thì worker gửi `delivery_id` để provider khử trùng ở phía họ. Worker truyền nó qua provider port (§11.1) như **ứng viên** key: việc gửi key không kèm tuyên bố nào về tác dụng của nó.

Capability này có **ba trạng thái**, một giá trị tại một thời điểm:

| Trạng thái                                | Nghĩa                                                                                                                                       | Hệ quả                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `unverified`                              | Chưa có bằng chứng provider có hay không dedupe theo key mà worker gửi                                                                      | Gửi key vẫn được, nhưng **không** được coi là đã dedupe; duplicate vẫn xảy ra được. **Production gate chưa qua.**                     |
| `verified`                                | Có bằng chứng kiểm chứng được rằng provider dedupe theo **đúng** key worker gửi, trong cửa sổ ≥ retry horizon của delivery                  | Retry/redelivery trong cửa sổ đó được coi là đã khử trùng. **Không** mở rộng thành exactly-once — crash window (§9.1) vẫn còn nguyên. |
| `unsupported` (**Cloudflare — hiện tại**) | Provider không có cơ chế idempotency key (binding `send_email` không nhận idempotency key — `docs/architecture/04-platform-facts.md` §2.19) | Residual duplicate risk được ghi nhận và **chấp nhận tường minh** trước production; không im lặng coi như đã giải quyết.              |

- **Retry horizon** (dùng ở bảng trên) = khoảng thời gian từ lần thử đầu tiên đến lần thử cuối cùng mà pipeline này có thể phát sinh cho một delivery: hàng rào cứng là `delaySeconds` ≤ 24 giờ mỗi lần (`docs/architecture/04-platform-facts.md` QU8) nhân `maxExecutionAttempts` ở worker, cộng các đường phục hồi của control plane (`maxRecoveryCycles`, thao tác repair/redrive có authorize). Cửa sổ dedupe của provider MUST được so với con số này, không phải so với "vài lần retry".
- **Bằng chứng hợp lệ — chiều dương (`verified`):** tài liệu của provider nêu đúng tham số/header key cùng semantics, **cộng** hành vi quan sát được trên sandbox của provider. **Không** phải bằng chứng: gửi cùng ID nhiều lần rồi thấy một thư trong hộp nhận (có thể do mailbox dedupe, hoặc do các lần đó chưa từng được provider chấp nhận), và **không** phải bằng chứng: `delivery_id` unique trong D1 — key unique là điều kiện **cần** cho idempotency, không nói được provider đã gửi hay chưa (§9.1 crash window là bằng chứng ngược lại).
- **Bằng chứng hợp lệ — chiều âm (`unsupported`):** tài liệu của provider nêu rõ không có cơ chế idempotency key, **hoặc** sandbox cho thấy không tồn tại header/parameter nào nhận `delivery_id`. "Gửi hai lần thấy hai thư" là **không** đủ — nó chỉ nói lần đó không dedupe, không nói provider không có cơ chế. `unsupported` không có bằng chứng tương ứng → giữ `unverified`, gate chưa qua.
- **Gate:** trước khi enable provider thật cho production, trạng thái MUST khác `unverified`, và giá trị đã chốt được ghi ngay tại mục này kèm bằng chứng tương ứng. `unsupported` cũng là gate đã qua — với residual duplicate risk được ghi nhận tường minh.
- **`verified` KHÔNG mở rộng thành exactly-once.** Nó chỉ có nghĩa là retry/redelivery trong cửa sổ dedupe đã xác minh được provider khử trùng. Crash window (§9.1, §9.2.2 hàng 9 và hàng 18) vẫn còn nguyên, và duplicate mail vẫn là residual risk phải ghi nhận.
- **Hazard của việc giữ nguyên `delivery_id` xuyên generation** (§11.2): redrive tăng `dispatch_generation` nhưng **không** đổi key, nên một provider `verified` có thể dedupe cả lần gửi corrective của redrive. Hai nhánh nguy hiểm phải được operator hiểu trước production: (1) attempt trước đó từng tới provider nhưng **chưa** được chấp nhận (crash/timeout) → redrive bị dedupe → worker có thể ghi `sent` cho một thư không bao giờ được gửi; (2) provider trả `409`/`422` cho lần gửi trùng **đang xử lý** → theo bảng chiếu §11.1 nó rơi vào "`4xx` khác" ⇒ `permanent` ⇒ `failed` (hàng 2), trong khi attempt đầu có thể vẫn gửi thành công. **Không** được workaround bằng cách đổi key (đổi key thì mất giá trị khử trùng); đúng xử lý là ghi nhận hazard này ở đây, chốt semantics dedupe của provider khi chọn, và kiểm tra trạng thái delivery tại provider trước khi redrive một delivery đã từng đi qua provider.
- Provider **đã chọn (v1): Cloudflare Email Service** với trạng thái **`unsupported`** (bằng chứng chiều âm: Workers API `send()` không nhận bất kỳ idempotency key nào — tài liệu, `docs/architecture/04-platform-facts.md` §2.19); hệ quả tường minh ghi ở đầu mục này.
- Worker MUST persist provider message identifier và outcome khi provider trả về — dùng cho điều tra/khiếu nại, không dùng để kết luận đã tới inbox.
- Provider **acceptance** (binding `send()` resolve) chỉ là acceptance, **không** phải bằng chứng email đã tới inbox hoặc đã được đọc. Rejection bất đồng bộ sau khi accept (bounce/complaint trả về muộn) **có** kênh ingest: Event Subscriptions của provider publish lifecycle event vào Queue và worker persist vào `mail_lifecycle_events` (§11.3) — nhưng bảng đó là lớp quan sát thuần, chưa có đường nào biến bounce/complaint thành hành động; khoảng trống đó được ghi nhận tường minh ở §11.3.

### 9.4. Blocked (điều kiện system-level) và redrive

`blocked` là trạng thái non-terminal cho lỗi **system-level**, tách hẳn khỏi `failed` (per-message):

- Trigger: provider trả `401`/`403` (credential sai/hết hạn), endpoint/credential chưa cấu hình (`provider-not-configured`), ngân sách **B** của generation đã kiệt (`execution-budget-exhausted` — `mail_jobs.attempts` chạm `maxExecutionAttempts`), hoặc kết quả provider mơ hồ ngoài cửa sổ an toàn idempotency (`provider-ambiguous-outcome` — §9.6: `provider_call_at` đã hơn `MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS` khi claim lại hoặc persist-denied). Cả bốn đều là điều kiện **system-level**, không phải provider từ chối nội dung thư.
- Hành vi: persist `status = blocked` + `last_error_class` + `outcome_report_state = 'pending'`, release lease, báo outcome `blocked` cho control plane, **ack** message (không retry-storm), và alert operator. **KHÔNG** mark `failed` — thư chưa bị provider từ chối.
- **Redrive là thử lại có kiểm soát, không phải gửi lại tự động.** Chỉ **một** hành vi làm delivery `blocked` trở lại eligible: **control plane tăng `dispatch_generation`** (atomic batch ở `docs/applications/transactional-mail/01-architecture.md` §6.4). Các bước: 0. **Bước 0 — carve-out cho `provider-ambiguous-outcome`: redrive KHÔNG phải unblock.** Marker `provider_call_at` là per-delivery và không đường nào reset (§9.6 — statement (b) không đụng cột này), nên attempt đầu của generation mới gặp statement (e) với kết quả `already-marked` mang **marker cũ từ trước khi block**. Marker đó thường đã ngoài cửa sổ an toàn (chính tuổi marker là nguyên nhân chốt `blocked` ở lần trước), nên attempt này bị re-block ngay tại statement (g) — release lease rồi chốt `blocked` lần nữa, KHÔNG gọi provider. Đây là **hành vi fail-closed cố ý** của double-send gate, không phải bug: quyết định chấp nhận rủi ro double-send của operator (bước 1) và việc generation mới có giá trị bắt đầu claim mới là hai điều kiện khác nhau; chấp nhận rủi ro không xoá được sự thật rằng một request của delivery này **đã có thể đã rời worker** (`provider_call_at` không reset ⇒ quyền gọi provider quy về tuổi marker, không thuộc ownership — §9.6). Với class này, redrive chỉ re-confirm `blocked` (đốt một slot ngân sách A) và là một **dead-end bền vững** cho generation đó: kể cả khi operator đã xác minh provider chưa từng nhận thư, không đường tự động nào của worker deliver lại được mail — mọi attempt của generation mới đều đi qua đúng chuỗi `already-marked` ngoài cửa sổ ⇒ (g) chốt lại (xem ngữ cảnh vận hành: `03-operations.md` §3.1 hàng 8a, §8 alert `provider-ambiguous-outcome`, §11 hàng 3/11).
  1. Sửa credential/cấu hình provider ở delivery worker (rotate Worker Secret → deploy version mới — [`03-operations.md`](./03-operations.md) §5). **Chỉ áp cho trigger credential/config**: với `execution-budget-exhausted` thì **không** có gì để sửa — bỏ qua bước này, đi thẳng bước 2, vì generation mới tự reset ngân sách B. Với `provider-ambiguous-outcome` thì phải qua **bước 0** — operator **tự cân nhắc rủi ro double-send** (email có thể đã đến tay provider): kiểm provider/receiver đã nhận thư của delivery này chưa, trước khi quyết định redrive; nếu không redrive, delivery giữ nguyên `blocked`.
  2. Gọi endpoint redrive **có authorize** ở control plane (`docs/applications/transactional-mail/01-architecture.md` §7.5 — caller/permission model **chưa chốt, là implementation gate**). Control plane — **producer duy nhất** của `ecoma-mail-delivery` — trong **một** `db.batch()`: `dispatch_generation++`, `status = 'queued'`, `recovery_cycle_count++`, reset outbox row (cùng `delivery_id`, `publish_attempts = 0`). Sau đó nó publish command **cùng `delivery_id`**.
  3. Worker nhận command → **resolve `dispatch_generation` hiện tại từ control plane** (§9.2) → thấy `new_generation > mail_jobs.dispatch_generation` → **generation-advance claim** (§9.2.1 đường (b)) → thử lại. Worker **không** send vào Queue và **không** tự bump generation.
- **Một command publish lại KHÔNG authorize và KHÔNG chứng minh gì.** Queue command chỉ mang `version` + `delivery_id`; nó **không** mang và **không** chứng minh generation, và worker **không thể** phân biệt command cũ với command mới từ payload. Một command còn sót lại sau khi control plane đã authorize generation mới chỉ làm worker resolve lại; worker so generation authority (từ control plane) với row và:
  - `status = blocked` cùng generation authority → **không** gửi lại, ack. Delivery `blocked` **không** được retry trong cùng generation; chỉ redrive có authorize ở control plane mới đưa nó sang generation mới eligible.
  - generation row **nhỏ hơn** generation authority → chính redrive đã authorize → claim đường (b), gửi lại.
  - generation row **bằng hoặc lớn hơn** generation authority → **không** claim, **không** reset row về generation cũ, ack.
    Vì generation dùng để claim luôn đọc từ control plane, một command tới muộn **không thể** mở khoá một delivery mà redrive chưa authorize, **không** đổi generation, **không** đổi recipient/nội dung, và **không** bỏ qua durable state hiện tại của control plane.
- **Worker reconcile không tạo redrive.** Job `blocked` tồn đọng quá ngưỡng → worker **phát hiện + alert**; nó **không** xoá marker `blocked`, **không** tăng generation, **không** tự tạo redelivery. Làm vậy sẽ là đường redrive thứ hai không authorize và không có guard chu kỳ.
- **Cách worker biết được phép thử lại:** `dispatch_generation` **lớn hơn** giá trị đang lưu ở `mail_jobs`, trong đó generation là authority đọc từ private interface. Generation **bằng hoặc nhỏ hơn** → duplicate/stale → không gửi lại.
- **Hai service phải đồng thuận về eligibility:** control plane nhìn `mail_messages.status` + `dispatch_generation`; worker nhìn `mail_jobs.status` + `dispatch_generation`. Không bên nào suy ra eligibility từ một marker không có generation đi kèm.
- **Giới hạn chu kỳ:** mỗi redrive tăng `recovery_cycle_count` ở control plane. Khi chạm `maxRecoveryCycles` (`docs/applications/transactional-mail/01-architecture.md` §6.5), control plane **dừng** re-dispatch tự động, giữ nguyên delivery intent + bằng chứng vận hành, alert operator; mọi lần thử tiếp theo phải qua một hành động có authorize tường minh **kèm cờ override** (khi đó `recovery_cycle_count` vẫn tăng, nên đường tự động không mở lại). Worker tương ứng không còn nhận command tự động nào cho delivery đó.

### 9.5. Vòng đời báo outcome (bounded, không có vòng lặp vô hạn)

Báo outcome là một **quá trình có trạng thái bền vững**, không phải một lần gọi API. State nằm ở `mail_jobs.outcome_report_state` (§7):

| Kết quả control plane trả về                        | Phân loại                                                                                                                          | `outcome_report_state` sau đó | Hành vi worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`                                           | Control plane đã ghi outcome bền vững                                                                                              | `reported`                    | Terminal cho report. Không báo lại.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `duplicate`                                         | Cùng generation + cùng outcome đã ghi trước đó                                                                                     | `reported`                    | Terminal; idempotent, không phải lỗi.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `stale`                                             | Generation cũ, hoặc state không còn `accepted/queued`                                                                              | `superseded`                  | Terminal. Metric `outcome-stale` + audit event (đã ghi tại thời điểm nhận). **Không** auto-retry report.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `404`                                               | Delivery không còn tồn tại ở control plane                                                                                         | `orphaned`                    | Terminal. Metric + alert operator. **Không** auto-retry report.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `401` / `403`                                       | **Non-transient** — authn/authz của **chính worker**                                                                               | `pending` (giữ nguyên)        | Alert `Page`; **không** đánh terminal, **không** retry vòng, **không** gửi lại mail. Sửa permission/identity rồi sweep báo lại.                                                                                                                                                                                                                                                                                                                                                                                             |
| `400`                                               | **Contract violation** — callback không hợp lệ (thiếu `dispatch_generation`, `outcome` sai, hoặc `error_class` ngoài bộ canonical) | `pending` (giữ nguyên)        | Đây **không** phải lỗi transient và **không** phải lỗi authn/authz: control plane từ chối request như sai contract. Worker **không** retry vô hạn (retry sẽ lặp lại đúng request sai đó); dừng auto-retry cho row này, alert (metric `outcome-contract-rejected`), và **không** đánh `sent`/`failed`/`blocked`/`superseded`/`orphaned`. Giữ `pending` để một lần sửa worker (bug mapping `error_class`, hoặc thiếu field) rồi sweep báo lại cho kết quả đúng — cùng tinh thần với hàng `401`/`403`. **Không** gửi lại mail. |
| timeout / network / `5xx` / `429` / API unavailable | `retryable`                                                                                                                        | `pending`                     | Báo lại có backoff qua reconcile sweep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Quy tắc:

- **Chỉ lỗi transient mới retry tự động**: timeout, network, `429` (khi có), `5xx`, private API tạm thời không sẵn sàng. `applied`/`duplicate` → **hoàn tất** report. `stale` → `superseded`. `404` → `orphaned`. **`401`/`403` không nằm trong nhóm transient**: đó là lỗi authn/authz của **chính worker**, không phải control plane quá tải — giữ `pending`, alert `Page`, không retry vòng, không gửi lại mail (§9.2.2 hàng 19). **`400` cũng không nằm trong nhóm transient**: đó là contract violation phía callback (bug mapping `error_class` hoặc thiếu field) — giữ `pending`, alert, không retry vòng vô hạn, không gửi lại mail. **`stale` và `404` không bao giờ được giữ ở `pending`**, nên không tạo vòng retry vô hạn.
- **Báo lại không bao giờ kéo theo gửi lại mail.** Report đã `pending` được reconcile bằng cách **chỉ báo nốt outcome** — không gọi provider (§9.2).
- **Generation cũ không ghi đè kết quả mới.** Mỗi lần advance generation, report state được thay bằng `none` cho generation mới (§7). Một report trễ của generation cũ bị control plane trả `stale`, và worker ghi `superseded` — nó **không** ghi đè outcome của generation mới.
- **HTTP 200 không phải bằng chứng đã báo xong.** Worker chỉ chuyển sang `reported` khi body là `applied`/`duplicate`. Body `stale` (dù HTTP 200) chuyển sang `superseded`.
- **Sweeper độc quyền (đúng statement (d)):** acquire report-lease dùng **đúng** statement canonical ở §9.2.1 đường (d), không phải một biến thể tự nghĩ ra, để nhiều sweeper chạy song song không báo trùng; cùng với idempotency (`duplicate`) ở control plane, báo trùng vẫn an toàn nhưng bị hạn chế. Guard **trong** (d) là `dispatch_generation` + `outcome_report_state = 'pending'` + report-lease hết hiệu lực (`report_lease_expires_at IS NULL OR <= now`); `report_attempts` tăng trong **cùng** UPDATE đó. Bound `report_attempts < maxReportAttempts` **không** nằm trong (d) — nó là predicate **chọn row** của sweep (mục "Sweep có biên" ngay dưới), nên một implementation copy (d) nguyên văn vẫn phải tự áp bound ở truy vấn quét.
- **Sweep có biên:** sweeper chỉ quét `outcome_report_state = 'pending'`, dùng index `(outcome_report_state, updated_at)`, xử lý theo batch. Bound của sweep là **`report_attempts < maxReportAttempts`** (persisted) — **không** đo tuổi từ `updated_at` để dừng auto-retry (acquire (d) set `updated_at = :now`), nhưng có thể dùng `updated_at` làm nhịp backoff; khi `report_attempts >= maxReportAttempts` → **không** auto-retry, alert, giữ `pending`; `applied/duplicate/stale/404` vẫn được xử lý; `400`/`401`/`403` được xử lý theo hàng tương ứng. **Không bao giờ có vòng retry vô hạn.**
- **Alert không log nội dung:** alert chỉ nêu `delivery_id`, `generation`, report state, error class/code. **Không** log recipient, subject/body render, verification token hay provider credential (§13).

### 9.6. Cửa sổ an toàn idempotency — statement (e) và (g)

§9.3 chốt rằng Resend giữ `Idempotency-Key` **~24 giờ** (trạng thái `unverified` — số tài liệu). Điều đó cho phép một **cửa sổ an toàn** theo thời gian: một lần gọi lại provider với cùng key **trong** cửa sổ là an toàn (provider dedupe, hoặc chưa từng thấy request đầu); **ngoài** cửa sổ, gọi lại không còn chống duplicate và bị cấm tự động. **Với provider mặc định Cloudflare (idempotency `unsupported` — §9.3), không có key nào để dedupe, nên nhánh "gọi lại trong cửa sổ là an toàn" KHÔNG tồn tại: mọi mơ hồ sau khi đã chạm provider chốt `provider-ambiguous-outcome` ở (g) bất kể tuổi marker.** Cửa sổ an toàn chỉ còn một chiều: chốt `blocked` cho mơ hồ đã quá già để bất kỳ provider nào còn giữ trạng thái — nhánh resend tự động bị tắt hoàn toàn.

**Statement (e) — ghi marker ranh giới gọi provider** (migration `0003`): conditional UPDATE duy nhất, first-write-only (`provider_call_at IS NULL` trong WHERE), guard ownership chuẩn (lease + `execution_generation` + `dispatch_generation`), gọi **ngay trước** mỗi request provider rời khỏi worker. Marker là **per-delivery**: không đường nào reset nó — kể cả khi redrive tăng `dispatch_generation` (statement (b) không đụng cột này) — vì marker là một sự thật về thế giới ("đã có request có thể rời worker") và `Idempotency-Key` `mailjob_${deliveryId}` cố định xuyên generation (§9.3, §11.2). Hai kết quả:

- `applied`: attempt này vừa ghi marker — request sắp đi là lần gọi đầu tiên của delivery.
- `already-marked`: marker đã tồn tại từ một attempt trước của cùng delivery; statement trả kèm `record` hiện tại, và **không** tự cấp quyền gọi provider — caller bắt buộc đánh giá `isWithinProviderSafeWindow` trên `record.providerCallAt` trước khi quyết định gửi (quyền gọi thuộc về tuổi marker, không thuộc ownership guard). Mọi denial khác (`missing-job`/`lease-lost`/`inconsistent`) nghĩa là **không** gọi provider.

```sql
UPDATE mail_jobs
   SET provider_call_at = :now,
       updated_at       = :now
 WHERE delivery_id            = :delivery_id
   AND lease_owner            = :owner
   AND execution_generation   = :execution_generation
   AND dispatch_generation    = :generation
   AND status                 = 'processing'
   AND outcome_report_state   = 'none'
   AND provider_call_at IS NULL                                -- first-write-only
```

**Statement (g) — chốt `blocked` cho mơ hồ ngoài cửa sổ.** Khi caller kết luận mơ hồ nằm ngoài cửa sổ (persist-denied qua `resolveAmbiguityAfterLostClaim`, hoặc `already-marked` ngoài cửa sổ ở attempt mới), nó release lease không-kết-quả rồi chốt operator-needed bằng **một** conditional UPDATE khác:

```sql
UPDATE mail_jobs
   SET status               = 'blocked',
       blocked_at           = :now,
       last_error_class     = 'provider-ambiguous-outcome',
       outcome_report_state = 'pending',
       lease_owner          = NULL, lease_expires_at = NULL,
       updated_at           = :now
 WHERE delivery_id            = :delivery_id
   AND dispatch_generation    = :generation
   AND (lease_expires_at IS NULL OR lease_expires_at <= :now)
   AND status NOT IN ('sent', 'failed', 'blocked')
   AND provider_call_at IS NOT NULL                            -- chỉ mơ hồ thật mới chốt
```

- **Không có điều kiện `attempts`** (khác (c)): nguyên nhân chốt là **tuổi marker**, không phải ngân sách B — mơ hồ ngoài cửa sổ phải chốt được ở **bất kỳ** attempt nào, vì gọi lại provider ngoài cửa sổ không còn chống duplicate; chỉ chốt khi ngân sách cạn sẽ để redelivery gọi lại provider ngoài cửa sổ (đúng hazard mà statement này chặn).
- Guard `provider_call_at IS NOT NULL` là lớp cuối chống misuse ở tầng persistence: không bao giờ chốt `provider-ambiguous-outcome` cho một job chưa từng chạm ranh giới gọi provider.
- Job `blocked` bền vững với report `pending` để alert sweep block-backlog đón; mở khoá chỉ bằng redrive có authorize — và **redrive không phải unblock tự động** cho class này (§9.4 bước 0): generation mới gặp lại `already-marked` với marker cũ ngoài cửa sổ ⇒ (g) chốt `blocked` lại ngay — đúng vai trò double-send gate. `Idempotency-Key` không đổi xuyên generation (§9.3, §11.2) nên **không được workaround bằng reset marker trong (b)**: reset sẽ rẻ hoá thành auto-resend ngoài cửa sổ — chính double-send ở dạng khác.
- **Cấu hình:** `MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS` (chồng trần 24h, loader từ chối cửa sổ ≤ `providerTimeoutMs` — `03-operations.md` §3).

### 9.7. Các đường recovery dùng chung một state machine

Ba cơ chế (retry tự động, reconcile, DLQ replay) **không** được trở thành ba producer độc lập của ba command khác nhau cho cùng một delivery:

- **Một producer duy nhất:** `transactional-mail` là producer duy nhất của Queue. `transactional-mailer-job` **không bao giờ** enqueue command của chính nó (§14 #14).
- **Một logical delivery, một generation hiện hành:** mọi retry/reconcile cho lần dispatch hiện tại dùng **cùng `delivery_id`** và **cùng `dispatch_generation`**. Chỉ redrive có authorize tăng generation, **đúng một lần** mỗi thao tác (`docs/applications/transactional-mail/01-architecture.md` §6.2.2).
- **Hai ngân sách bù nhau, không có counter xuyên database:** `recovery_cycle_count` (D1 `mail`) là ngân sách **A** của control plane cho mọi đường **re-dispatch**; `mail_jobs.attempts` (D1 `mail-job`) là ngân sách **B** cho số execution của **một** generation (`maxExecutionAttempts`). Kiến trúc hai D1 không cho phép một counter bền vững mà cả hai service cùng ghi, nên tài liệu này **không** tuyên bố có guard dùng chung đó. Hai ngân sách bù nhau vì worker **không tạo được** Queue command mới: mọi vòng lặp phía worker chỉ tiêu **B**, và B reset khi và chỉ khi control plane authorize một generation mới (tức là đã tiêu đúng một slot A). Định nghĩa, bảng ngân sách, worst-case bound và ma trận chuyển tiếp canonical → `docs/applications/transactional-mail/01-architecture.md` §6.5. Không đường nào (publisher, reconciler, redrive, repair, DLQ replay) có bộ đếm riêng để tự nới bound.
- **DLQ replay không phải đường vòng.** Một entry DLQ nghĩa là **xử lý tự động đã dừng**, không phải business delivery đã chết (thư có thể chưa bao giờ được gửi). Operator **không** replay thô Queue command: replay phải đi qua **cùng** thao tác control-plane có guard đã áp dụng cho state hiện tại (reconcile cùng generation, redrive có authorize, hoặc repair có authorize), để generation và ngân sách A được áp dụng như mọi đường khác.
- **Validate trước khi replay:** trước khi publish lại, control plane xác nhận delivery **non-terminal** ở `mail_messages` (`accepted`/`queued`/`blocked`); delivery đã `sent` **không** bao giờ được gửi lại chỉ vì có entry DLQ. Incarnation cũ đã `sent` với outcome bền vững → đóng DLQ entry bằng audit + metric, không replay.
- **Recovery khi Queue item hết hạn trước khi job record tồn tại:** intent bền vững nằm ở control plane (`mail_messages` + `mail_outbox`). Control-plane reconciler phát hiện delivery còn non-terminal quá ngưỡng tuổi (nguồn guard `outbox.status IN ('pending','publishing','published')` — `published` cần cho case Queue-retention xoá message **sau** khi outbox đã commit, xem `docs/applications/transactional-mail/01-architecture.md` §6.2.2) và re-dispatch — **không** phụ thuộc `mail-job`. **Quét D1 `mail-job` một mình KHÔNG thể phát hiện message mất trước khi job record được tạo** (§7, `docs/applications/transactional-mail/03-operations.md` §5.3).
- **Sau khi hết `maxRecoveryCycles`:** dừng re-dispatch tự động, giữ nguyên delivery intent + bằng chứng vận hành, alert operator, và **chỉ** một hành động recovery có authorize tường minh **kèm cờ override** mới tiếp tục được (`recovery_cycle_count` vẫn tăng, nên đường tự động không mở lại).
- **Bất biến:** mọi đường recovery đều đọc/ghi qua conditional update có generation guard, nên không đường nào resurrection một delivery đã terminal. Mọi lần **provider được gọi lại** đều bị chặn bởi một counter bền vững: gọi lại **cùng** generation tiêu một slot **B** (`attempts`, trong chính UPDATE claim), còn tạo **generation mới** đòi một lần control-plane redrive và tiêu một slot **A**. Không có đường nào gửi lại mà không tiêu một slot của một trong hai ngân sách.

## 10. Retry model

Retry điều khiển bởi **error matrix** — bảng phân loại canonical ở [`03-operations.md`](./03-operations.md) §3. Quy tắc thiết kế:

- Ba loại failure không retry: **permanent** (payload/policy), **credential** (`401/403`) và **contract** (command không canonical). Credential fail là provider-level issue; xử lý ở delivery worker (rotate `MAIL_PROVIDER_TOKEN`, deploy Worker version mới — [`03-operations.md`](./03-operations.md) §5), không retry delivery, không đổi provider.
- **Contract failure** (command không canonical) bị reject + ack + quarantine marker đã sanitize; **không** gọi provider, **không** đi vào DLQ, **không** mark business `failed` — đây là system-level/deployment-skew nên delivery được redrive cùng `delivery_id` sau khi sửa deployment ([`03-operations.md`](./03-operations.md) §3.1).
- Retry bounded theo `max_retries` của Queue consumer + backoff; hết retry mà không có DLQ thì message bị xoá (`docs/architecture/04-platform-facts.md` QU2/QU3) — DLQ `ecoma-mail-delivery-dlq` là bắt buộc (config → `03-operations.md` §2).
- **Per-message processing:** mỗi Queue message xử lý độc lập — một message fail KHÔNG force retry message khác trong cùng batch; dùng `ack()`/`retry()` per message, không `ackAll()`/`retryAll()`.
- D1 ghi lỗi hoặc runtime API lỗi tạm thời → `retry()`, không ack khi state chưa persist.
- **Timeout và concurrency:** external provider request có timeout hữu hạn (mặc định 10 s); timeout phân loại `retryable` (network) — không giữ Queue message processing vô hạn. Consumer xử lý tuần tự từng message trong batch; giới hạn batch/consumer duration → `docs/architecture/04-platform-facts.md` QU4/QU6. Mỗi execution độc lập theo `delivery_id`; concurrency không phá idempotency nhờ conditional UPDATE trên D1 `mail-job`.
- **Timeout hữu hạn, khớp với `leaseMs`:** runtime resolution, provider request và outcome report mỗi loại có timeout hữu hạn riêng; `leaseMs` (§9.2.1) phải **lớn hơn** tổng worst-case của chúng, nếu không lease sẽ hết hạn giữa provider call và tạo overlap. Bất kỳ thay đổi timeout nào cũng phải được đối chiếu lại với `leaseMs` và ngược lại. Timeout hữu hạn là **giảm thiểu** residual duplicate risk, **không** loại bỏ nó (§9.2.1).
- **Trách nhiệm recovery (một state machine, xem §9.7; ngân sách theo `docs/applications/transactional-mail/01-architecture.md` §6.5):**
  1. **Worker stale-lease reclaim** — job `processing` có `lease_expires_at` đã qua → execution kế tiếp claim lại (đường (a) §9.2.1). Bounded bởi `leaseMs` **và** bởi ngân sách **B** (`mail_jobs.attempts` / `maxExecutionAttempts`); tiêu một slot B mỗi lần reclaim. Chạm B → không reclaim nữa, job thành `blocked` với trigger `execution-budget-exhausted` (§9.4), alert.
  2. **Worker reconcile `pending` report** — chỉ báo nốt outcome, **không** gọi provider (§9.5). Bounded bởi **`report_attempts < maxReportAttempts`** (persisted, reset khi generation advance — §9.2.1 đường (b)); **không** tiêu A, **không** tiêu B (không claim lại job, không gọi provider).
  3. **Control-plane reconciler re-dispatch** — delivery còn non-terminal quá ngưỡng tuổi và outbox row còn trong nguồn claim `pending`/`publishing`/`published` (**không bao giờ** `failed` — `failed` chỉ reset bằng repair có authorize), **cùng generation**, tiêu một slot ngân sách **A** (`recovery_cycle_count`, `docs/applications/transactional-mail/01-architecture.md` §6.5). Đây là đường duy nhất cứu được message mất trước khi job record tồn tại (§9.7).
  4. **Authorized redrive** — hành động có authorize, tăng generation (§9.4), tiêu một slot A và **reset** B cho generation mới; dùng cho delivery `blocked`.
  5. **Repair có authorize một outbox row `failed`** — reset **chính** row đó (`status = 'pending'`, `publish_attempts = 0`, cùng `delivery_id`, **cùng** generation), tiêu một slot A; đây là đường **duy nhất** reset `failed` (`docs/applications/transactional-mail/03-operations.md` §5.4).
- **DLQ ≠ tín hiệu business failure.** Entry DLQ nghĩa là **xử lý tự động đã dừng**, không phải thư đã chết: có thể chưa bao giờ được gửi. Replay **không** phải một đường recovery riêng: một entry DLQ được xử lý bằng **đúng đường** mà state control-plane hiện tại đòi — đường 3 cho delivery non-terminal quá ngưỡng, đường 4 cho `blocked`, đường 5 cho outbox `failed` — sau pre-replay validation (§9.7, `03-operations.md` §11).

## 11. Provider Handling

Một relay/provider được cấu hình mỗi environment, thuộc **cấu hình của chính worker** (Worker Secret), không do control plane materialize và không đến từ runtime material. Worker không suy luận provider từ recipient hostname hay tham số nào khác, và v1 không có dynamic provider routing. **Provider thật đã chọn (implementation v1): Cloudflare Email Service** qua binding `send_email` in-process (`createCloudflareMailProvider`) — cùng Cloudflare account của worker nên không có HTTP endpoint hay bearer credential nào; rationale và trạng thái idempotency ở §9.3; lifecycle event của provider ở §11.3. Adapter Resend (`createResendMailProvider`) giữ lại làm adapter phụ (`MAIL_PROVIDER_KIND=resend`), không bị xoá; adapter phía sau provider port (§11.1) là chỗ duy nhất chứa chi tiết vendor, contract phía consumer giữ nguyên.

- Binding `send_email` chưa cấu hình → fail-closed ở loader lúc boot (`SEND_EMAIL binding khong ton tai hoac khong co send()`), KHÔNG fallback sang provider khác — một auto-fallback là đường gửi mail qua kênh không ai review.
- Sender ghim một địa chỉ (`no-reply@ecoma.io`) ở **hai lớp**: `allowed_sender_addresses` của binding (wrangler) và `MAIL_CF_SENDER` ở loader phải bằng đúng giá trị đó — hai lớp phải nói cùng một sự thật, lệch nhau là lỗi boot.
- Provider rate limit (`E_RATE_LIMIT_EXCEEDED`/`E_DAILY_LIMIT_EXCEEDED`) → `retryable`; KHÔNG có `Retry-After` từ binding — backoff là backoff mặc định của Queue retry (§2).
- Lỗi sender/account (`E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_ACCOUNT_SUSPENDED`) → `credential`-class → `blocked` (§9.4), không retry vô hạn.
- Phân loại đầy đủ theo **error matrix canonical** (`03-operations.md` §3). §11.1 chỉ **chiếu** ma trận đó lên seam của provider port, không định nghĩa lại bất kỳ giá trị nào.
- **Provider credential custody (v1):** với Cloudflare, "credential" là chính binding `send_email` — không có secret nào để rotate, ranh giới là `allowed_sender_addresses` của binding. Với adapter Resend, endpoint/token vẫn là Worker Secret của `transactional-mailer-job`, không bao giờ lưu trong Queue message, DLQ payload, log hay normal API response. Không automatic multi-provider failover hay dynamic provider routing trong v1; loader còn từ chối cả việc đặt credential Resend cạnh `MAIL_PROVIDER_KIND=cloudflare` (dấu hiệu môi trường nhầm lẫn).

### 11.1. Provider port nội bộ (seam duy nhất ra provider)

Provider port là **interface nội bộ của worker**, không phải SDK vendor và không phải giao thức HTTP của bất kỳ relay nào. Nó là seam duy nhất mà worker core dùng để giao một delivery, nên worker core, orchestration và test triển khai được với **fake provider** khi relay production chưa được chọn. Khối type dưới đây là canonical **cho tới khi** port được materialize trong worker; sau đó code là canonical, còn mục này giữ seam, boundary và bất biến.

**Đã materialize (W3):** port đã có trong code, nên từ đây **code là canonical** còn khối type dưới chỉ giữ vai trò mô tả seam, boundary và bất biến. Nguồn canonical:

- Port: `libs/transactional-mailer-job-application/src/mail-provider-port.ts` — package `@ecoma-io/transactional-mailer-job-application` (tag `type:application`, `scope:messaging`, `runtime:edge`).
- Fake adapter: `libs/transactional-mailer-job-infrastructure/src/fake-mail-provider.ts` — package `@ecoma-io/transactional-mailer-job-infrastructure`.

Hai adapter provider thật nằm cùng package infrastructure: `libs/transactional-mailer-job-infrastructure/src/cloudflare-mail-provider.ts` (provider mặc định, binding `send_email`) và `libs/transactional-mailer-job-infrastructure/src/resend-mail-provider.ts` (adapter phụ).

```ts
type MailProviderSendRequest = {
  readonly deliveryId: string; // định danh ổn định của logical delivery — ứng viên idempotency key (§9.3)
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly contentType: 'text/html'; // hằng v1 (docs/applications/transactional-mail/01-architecture.md §7.2)
  readonly deadlineMs: number; // epoch ms — trần cứng cho toàn bộ lần gọi này
};

type MailProviderSendResult =
  | {
      readonly kind: 'accepted';
      readonly providerMessageId: string | null;
      // token cảnh báo (vd `malformed-response`) — KHÔNG đổi outcome, không vào `last_error`
      readonly warningCode: string | null;
    }
  | {
      readonly kind: 'rejected';
      readonly errorClass: 'retryable' | 'permanent' | 'credential';
      readonly retryAfterMs: number | null;
      readonly errorCode: string;
    };

interface MailProviderPort {
  // resolve, không reject: mọi outcome của provider đều đi qua MailProviderSendResult
  send(request: MailProviderSendRequest): Promise<MailProviderSendResult>;
}
```

- **Request chỉ chứa đúng các field trên.** Port MUST NOT mang `app`, `message_id`, template metadata, `dispatch_generation`, endpoint, credential hay sender: fencing state và định danh nội bộ của control plane không đi ra provider. `deadlineMs` là **epoch ms tuyệt đối**, do **worker** resolve bằng `min(now + providerTimeoutMs (mặc định 10 s, SR-003), lease_expires_at)` với giá trị lease **sau** khi đã renew cho execution này (§9.2.1); adapter MUST bắt buộc deadline đó và MUST NOT kéo dài. Nếu `deadlineMs` đã ≤ `now` khi request tới port (claim vừa mất, lease vừa hết) thì adapter MUST trả ngay `rejected` / `retryable` (`errorCode = timeout`) **không** gọi provider — không side effect, không tiêu network. Deadline này chỉ cắt **lời chờ của worker**, nó không chứng minh request đã rời khỏi Worker: acceptance vẫn có thể xảy ra sau đó (§9.1, §9.2.2 hàng 18).
- `providerMessageId` là **nullable**: chỉ có giá trị khi adapter xác định được đáng tin cậy từ response; chuỗi rỗng/blank cũng tính là không có. Adapter MUST NOT bịa, MUST NOT suy ra từ dữ liệu khác, và worker MUST NOT dùng nó để kết luận thư đã tới inbox.
- `errorCode` là **token đã sanitize** (ví dụ lớp `http-429`, `http-3xx`, `http-408`, `timeout`, `network`, `malformed-response`) đi vào `last_error` và metric; MUST NOT chứa recipient, nội dung thư, endpoint, credential hay raw body của provider. `warningCode` dùng cùng quy tắc token, nhưng đi vào provider error metric chứ **không** vào `last_error`.
- `retryAfterMs` chỉ có khi response mang `Retry-After` (canonical nêu tường minh cho `429`; adapter đọc header ở mọi response `retryable`). Nó là **sàn** cho lần thử kế tiếp và MUST được clamp vào **cả hai** giới hạn: `delaySeconds` là số nguyên dương ≤ 24 giờ (`docs/architecture/04-platform-facts.md` QU8) — tức ms phải quy về **giây nguyên**, và `Retry-After` dạng HTTP-date phải đổi sang độ trễ tương đối — **cùng** retention của Queue (QU5, Free 24 giờ cố định): sàn vượt retention thì retry bị xoá trước khi chạy và delivery rơi vào đường reconciler tốn slot A. `retryAfterMs` MUST NOT được dùng để giữ Queue message ở trạng thái processing.

**Chiếu ma trận canonical lên seam** — cột cuối trỏ tới hàng của ma trận lease/outcome ở §9.2.2; bảng này **không** định nghĩa lại giá trị nào:

| Quan sát ở lần gọi provider                                                                  | Kết quả của provider port                                                | Class canonical              | Ma trận §9.2.2 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- | -------------- |
| `2xx`, body hợp lệ, xác định được provider message id                                        | `accepted` + `providerMessageId`                                         | — (success)                  | hàng 1         |
| `2xx`, body hợp lệ, provider không trả message id (contract không có field, hoặc field rỗng) | `accepted` + `providerMessageId = null`                                  | — (success)                  | hàng 1         |
| `2xx` nhưng body không parse được / sai contract response của provider                       | `accepted` + `providerMessageId = null` + `warningCode`                  | — (success)                  | hàng 1         |
| `2xx` nhưng contract của provider đã chọn định nghĩa body báo **không** chấp nhận            | `rejected` / theo semantics đã documented (`permanent` hoặc `retryable`) | `permanent` hoặc `retryable` | hàng 2 hoặc 6  |
| `429`                                                                                        | `rejected` / `retryable` (+`retryAfterMs` nếu có)                        | `retryable`                  | hàng 6         |
| `5xx`, network error, response protocol bất thường (`1xx`), deadline vượt, request bị hủy    | `rejected` / `retryable` (+`retryAfterMs` nếu có)                        | `retryable`                  | hàng 6         |
| provider `401`/`403`, credential sai/hết hạn                                                 | `rejected` / `credential`                                                | `credential`                 | hàng 3         |
| `4xx` khác (kể cả `408`, và `409`/`422` idempotency conflict — xem §9.3)                     | `rejected` / `permanent`                                                 | `permanent`                  | hàng 2         |
| `3xx` — adapter MUST NOT follow                                                              | `rejected` / `credential` (`errorCode = http-3xx`)                       | `credential`                 | hàng 3         |
| endpoint/credential chưa cấu hình                                                            | **không tới port** — `provider-not-configured`                           | `credential`                 | hàng 4         |

- **Không kết quả nào của port tương ứng class `contract` hay `internal-auth`**, vì hai class đó không bao giờ phát sinh từ provider. Đây là cách loại lỗi auth của private API ra khỏi nhóm provider credential bằng **cấu trúc**, không bằng quy ước: `401`/`403` của private API là lỗi authn/authz của **chính worker** (§9.2.2 hàng 19), nó **không phải** input của port này nên không thể trở thành `blocked` hay `failed`.
- **`2xx` là bằng chứng provider đã chấp nhận**, không hơn: hậu quả là persist `sent` + report `pending` (hàng 1), không phải kết luận thư tới inbox (§9.3). Ba nhánh `2xx` phải phân biệt: body **không parse được** thì KHÔNG hạ acceptance xuống thành lỗi — retry sau khi đã accept chỉ có thể gửi trùng (hàng 9) — nên đường đúng là `sent` với `provider_message_id = NULL` và `warningCode = malformed-response`; body hợp lệ **thiếu message id** thì bình thường nếu contract của provider không có field đó (**không** warning); body **tự báo thất bại** thì là `rejected` theo semantics đã documented của provider, **không bao giờ** là `sent` im lặng. `warningCode` đi vào **provider error metric** (`03-operations.md` §8 — `Provider: errors`) và audit đã sanitize, **không** vào `last_error` vì outcome vẫn `sent` — đó là tín hiệu duy nhất để một endpoint sai mà vẫn trả `200` không biến mất im lặng.
- **Bảng chiếu theo HTTP status là đường mặc định, không phải toàn bộ contract.** Khi provider thật được chọn, adapter MUST map theo **toàn bộ** semantics của provider (bao gồm failure payload nằm trong `2xx` và mã lỗi riêng của họ), và phân loại đó phải **giống nhau** giữa adapter relay thật và fake adapter (§11.2). Adapter MUST NOT tự thêm ngoại lệ cho `4xx`: `408` nằm trong "`4xx` khác" ⇒ `permanent` (canonical không có nhóm transient cho HTTP status phía provider; `429`/`5xx` đã có nhóm riêng), và `409`/`422` của idempotency conflict cũng rơi vào đó — đó là hazard đã ghi nhận tường minh ở §9.3, không phải lý do để đổi mapping.
- **Adapter resolve, không reject.** Mọi outcome của provider đều đi qua `MailProviderSendResult`; exception chỉ dành cho bug nội bộ của worker/adapter. Khi exception lọt ra ngoài, worker MUST xử lý như một trường hợp chưa persist được state bền vững (§9.2.2 hàng 8): release lease nếu release được, `retry()`, **không** ack khi chưa persist, và **không** mark `failed`.
- **Sender identity thuộc trusted config.** Port MUST NOT mang `from`/sender (và đã không mang `app`): địa chỉ người gửi, envelope và mọi header cố định của relay nằm trong Worker Secret / cấu hình của adapter (§7, §13). Cần sender theo từng app là một contract mới phải sửa port, không được adapter tự suy ra từ `delivery_id` hay `recipient`.

### 11.2. Trách nhiệm của adapter

- Dịch request của port sang wire protocol của provider — **đây là chỗ duy nhất** chứa chi tiết vendor; không chi tiết vendor nào rò lên trên port.
- Phân loại kết quả transport vào đúng ba `errorClass` ở §11.1, và phân loại này phải **giống nhau** giữa adapter relay thật và fake adapter.
- **Không retry bên trong một lần gọi.** Một lần gọi port là một attempt của **một** execution đã claim; slot ngân sách **B** đã được tiêu ngay ở claim (§9.2.1 đường (a) — `attempts` chỉ tăng ở UPDATE claim/reclaim), nên retry bên trong adapter đồng nghĩa gửi **nhiều** lần cho **một** slot B, và việc tăng `attempts` ở call boundary sẽ phá guard nguyên tử của claim. Retry bounded thuộc Queue consumer (§10).
- Giữ endpoint và credential trong trusted config của chính worker: MUST NOT nhận endpoint/URL từ request, runtime material hay Queue, và MUST NOT follow redirect — một redirect sẽ mang credential và nội dung thư tới host không nằm trong trusted config. Adapter MUST tắt redirect-following **và** mọi retry nội tại của HTTP client/SDK bằng cấu hình (không dựa vào mặc định), vì cả hai đều tiêu credential ngoài seam. `3xx` là lỗi cấu hình (`credential`-class, `errorCode = http-3xx`, cùng hành động hàng 3 — §11.1), không bao giờ là `accepted`.
- `delivery_id` là **ứng viên** idempotency key, không phải guarantee: adapter gửi nó khi provider hỗ trợ cơ chế, nhưng worker MUST NOT tuyên bố dedupe trừ khi trạng thái provider idempotency là `verified` (§9.3). Key **không đổi xuyên generation** (`delivery_id` giữ nguyên khi redrive tăng `dispatch_generation` — §9.4), nên hazard "provider dedupe cả một attempt chưa được chấp nhận" (gửi hợp lệ bị chặn oan, redrive bị dedupe, hoặc `409`/`422` idempotency conflict rơi vào `permanent`) **đã được ghi nhận tường minh ở §9.3**; MUST NOT tự workaround bằng cách đổi key.
- **Redaction:** adapter MUST NOT log hay phát ra endpoint, credential, recipient, subject/body, raw provider response body; chỉ `errorClass` + `errorCode` đã sanitize cùng các field trong whitelist ở §13. Exception message và stack trace của HTTP client/SDK là bề mặt rò rỉ tiếp theo (URL đầy đủ kèm query, header, đôi khi cả credential theo định dạng request) — chúng MUST NOT được log nguyên văn; chỉ `errorCode` đã sanitize được phát ra ngoài.
- **Fake provider:** một adapter giả cùng port, tạo được các kết quả một cách xác định, là cách worker core, orchestration và test triển khai trước khi provider thật được chọn. Test inject port, không mock network của vendor. Kết quả được chọn theo **nội dung request** (`recipient` hoặc `subject` chứa token test), ưu tiên theo thứ tự trong bảng token, với các token đặc biệt `fake:retryable-after` (chứa `retryAfterMs = 30000`), `fake:malformed-response` (`accepted` + `providerMessageId = null` + `warningCode = 'malformed-response'`), `fake:no-message-id` (`accepted` + `providerMessageId = null` + `warningCode = null`); các trường hợp khác tạo kết quả canonical. `deadlineMs` được kiểm **trước** bảng token: `deadlineMs` hoặc `now` không hữu hạn (`NaN`, `±Infinity`) → `rejected` / `permanent` / `errorCode = invalid-deadline` (token riêng của fake) và `deadlineMs <= now` → `rejected` / `retryable` / `errorCode = timeout`, cả hai nhánh đều không sleep, không side effect. Cả **hai** phía của phép so sánh đều phải hữu hạn: nếu chỉ kiểm `deadlineMs`, một `now` không hữu hạn làm `deadlineMs <= now` luôn `false` và request đã quá hạn rơi xuống `accepted` — trần cứng deadline bị vô hiệu hoá im lặng. **Nguồn canonical:** `libs/transactional-mailer-job-infrastructure/src/fake-mail-provider.ts`.
- **Tính xác định của fake có điều kiện.** Fake xác định theo **một đồng hồ**: outcome chỉ phụ thuộc bảng token và `now`. Vì `deadlineMs` là epoch ms **tuyệt đối** (§11.1), cùng một request gửi ở thời điểm muộn hơn có thể chuyển từ `accepted` sang `timeout` — đó là hành vi đúng của deadline, không phải mất tính xác định. Test và orchestration phải inject đồng hồ (tham số `now` của constructor) hoặc dùng `deadlineMs` xa, thay vì dựa vào `Date.now` mặc định.

**Giới hạn còn lại (port không xoá được).** Crash sau khi provider accept nhưng trước khi persist vẫn có thể sinh duplicate mail, và deadline/hủy request **không** hoàn tác một acceptance đã xảy ra — fencing bảo vệ durable state, nó **không** huỷ được một request đã rời khỏi Worker (§9.1; §9.2.2 hàng 9 và 18). Vì vậy port này **không** chứng minh exactly-once; lựa chọn duy nhất còn lại là idempotency phía provider, ở trạng thái `verified` (§9.3).

### 11.3. Lifecycle event của provider — lớp quan sát riêng (ingest-only)

Provider Email Service của Cloudflare publish lifecycle event (`message.delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained` — `docs/architecture/04-platform-facts.md` §2.19) vào Queue qua Event Subscriptions. Worker consume Queue `ecoma-mail-lifecycle-events` (consumer thứ hai cùng handler; route theo `batch.queue`) và **chỉ làm ingest**: chuẩn hoá envelope về model trung tính, dedupe theo `event_id`, correlate `message_id` → `provider_message_id` rồi persist vào D1 `mail_lifecycle_events` (migration `0004`). Nguồn canonical: `libs/transactional-mailer-job-application/src/lifecycle-events.ts` (model + ingest), `libs/transactional-mailer-job-infrastructure/src/d1-lifecycle-event-store.ts` (D1).

- **Lớp quan sát, không tham gia state machine.** Event KHÔNG đè `mail_jobs.status`, `last_error` hay outcome báo control plane; mọi transition của §9.2.2 không đọc bảng này. `deferred` là quan sát thuần — provider tự retry delivery của nó, worker KHÔNG phát sinh thư mới từ event nào. Đường này không claim lease, không gọi provider.
- **Persist trước ack.** Outcome `stored` chỉ trả sau khi D1 xác nhận ghi; ack sau `stored` không bao giờ mất event. Dedupe nằm ở PRIMARY KEY `event_id` + `ON CONFLICT DO NOTHING` (không read-before-write); replay/redelivery trả `duplicate` và **vẫn ack** — duplicate là dedupe hoạt động đúng, không phải lỗi.
- **Correlate là best-effort sau persist.** Event tra `delivery_id` qua `provider_message_id` trong một `db.batch()` ngay sau INSERT; không match (event tới trước persist của Mail Command, messageId lạ) → event vẫn sống với `delivery_id` NULL — việc bù correlation là truy vấn, không phải điều kiện ghi.
- **Payload hỏng đi quarantine, không retry.** JSON không parse được, thiếu field bắt buộc, sai kiểu, type lạ ngoài enum đóng — tất cả là `quarantined` với reason `lifecycle-event-invalid` (migration `0005`): retry bao nhiêu lần payload cũng không hợp lệ hơn. Raw payload KHÔNG được lưu — mọi field provider ngoài bộ chuẩn hoá (smtpResponse, subject, sender, recipient, reason free-form…) bị normalizer bỏ trước khi tới storage; model chỉ giữ token lý do đóng (`bounce-soft`, `bounce-hard`, `delivery-failed`, `policy-rejected`, `spam-complaint`).
- **KHÔNG provision Event Subscriptions trong implementation này.** Consumer + table + test là toàn bộ phạm vi; queue chưa tồn tại ở môi trường thật thì consumer chỉ không nhận message, mọi path khác vô hại. Việc bật subscription là một quyết định vận hành sau, kèm quyết định alert trên dữ liệu bảng.
- **Giới hạn §9.3 bullet cuối được xử lý một phần:** bounce/complaint trả về muộn sau khi provider accept **có** kênh ingest từ PR này, nhưng chưa có đường nào biến nó thành hành động (alert/redrive/thông báo người dùng) — bảng chỉ là bằng chứng vận hành. Kết nối dữ liệu này với pipeline chính vẫn là work chưa làm, không được coi là đã có.

---

## 12. Failure Isolation

Failure của một delivery không fail cả batch (per-message ack/retry). Failure của provider không mất các delivery khác. Failure tạm thời của runtime API → retry theo policy, không tìm alternate route.

---

## 13. Security và observability boundary

Worker là trusted delivery component — có quyền: đọc runtime material, dùng provider credential (từ Worker Secret của chính worker), báo outcome. Không có quyền: tạo message, thay đổi template, đổi recipient, truy cập D1 khác, truy cập admin configuration.

Credential phải: không xuất hiện trong Queue/DLQ/log/error message; credential là Worker Secret của `transactional-mailer-job`, không phải từ control plane. Control plane **không** decrypt, không truyền credential.

**Authentication của caller (release gate, §5).** Worker phải authenticated với control plane theo canonical internal auth contract (**đã merge** — PR #197 → `97b85b9`) cho mọi call private interface; gate còn lại là receiver chưa implement registry + kho nonce + middleware **và worker chưa có code ký** (`../transactional-mail/01-architecture.md` §7.4). Khoá dùng để ký là credential **riêng của worker**, là một entry trong credential registry của receiver, tách khỏi provider credential và tách khỏi khoá HMAC của quarantine record (`03-operations.md` §3.1) — ba secret khác nhau, không tái sử dụng lẫn nhau. Header principal do caller kiểm soát **không** phải authentication.

Log chỉ qua whitelist field (`delivery_id`, `message_id`, `app`, template name/version, job status, attempts, outcome, error class/code). **Recipient, subject/body render, endpoint, credential không bao giờ được log.** Raw error body từ provider là **untrusted** — chỉ lưu error class/code đã sanitize, không lưu nguyên văn. Metric và alert → `03-operations.md` §8.

---

## 14. Architectural Invariants

1. Worker chỉ xử lý `Mail Command` version hiện tại; version khác bị reject `unsupported-version`.
2. Worker không render lại, không reroute, không đổi recipient.
3. `delivery_id` là idempotency key ở logical state; external exactly-once không được guarantee (§9.1).
4. Queue command **chỉ** chứa `version` + `delivery_id`; không chứa secret/recipient/credential/subject/body/template metadata.
5. Worker không truy cập D1 `mail` hay D1 service khác — chỉ dùng D1 `mail-job`.
6. Runtime data resolve từ private interface; interface là delivery lookup, không phải routing API.
7. Retry theo error matrix (`03-operations.md` §3); `401/403` là credential-class, không retry.
8. D1 ghi lỗi → `retry()`, không ack.
9. Duplicate Queue message không tạo duplicate logical delivery; job terminal → không gửi lại.
10. Per-message ack/retry; một message fail không retry cả batch.
11. Secret không xuất hiện trong Queue/DLQ/log; command không canonical không bao giờ đi vào DLQ và raw payload của nó không bao giờ được ghi vào DLQ/log (chỉ quarantine record đã sanitize).
12. Worker có timeout hữu hạn cho external request.
13. Provider credential là Worker Secret của chính worker, đến từ trusted configuration — không từ runtime material, không từ Queue.
14. `blocked` là non-terminal cho điều kiện system-level; nó **không** bao giờ thay thế `failed` cho lỗi per-message, và redrive chỉ đi qua re-enqueue có authorize của control plane (worker không send vào Queue, không tự xoá marker `blocked`, không tự bump generation).
15. Worker chỉ ghi `mail_jobs` bằng conditional write theo trạng thái đã đọc — không có read-then-write không guard (§9.2.1).
16. **Generation-advance claim là transition duy nhất** đưa một job row sang `dispatch_generation` mới. Worker chỉ thử lại một delivery đã `blocked` khi generation authority (đọc từ private interface, **không** từ Queue payload) **lớn hơn** `mail_jobs.dispatch_generation`; generation bằng hoặc nhỏ hơn là duplicate/stale → không claim, **không** reset row về generation cũ, ack (§9.2.1 đường (b), §9.4).
17. **Chỉ một bên tăng `dispatch_generation`:** control plane, qua redrive có authorize. Worker không tăng, không suy ra generation từ Queue payload, và không tự tạo redrive (§9.4, §14 #14).
18. **Báo outcome là state machine bounded:** chỉ lỗi transient mới retry tự động; `applied`/`duplicate` → hoàn tất; `stale` → `superseded`; `404` → `orphaned`. `stale`/`404` không bao giờ giữ ở `pending` (§9.5).
19. **Recovery bị chặn bởi hai ngân sách bù nhau, không bởi một counter xuyên database** (`../transactional-mail/01-architecture.md` §6.5). Ngân sách **A** = `recovery_cycle_count` / `maxRecoveryCycles` (D1 `mail`, control plane) chặn **mọi lần re-dispatch** một logical delivery: reconciler re-dispatch, repair outbox `failed`, redrive, DLQ replay. Đường **tự động** (reconciler) bị từ chối cứng ở ngưỡng; thao tác **có authorize** (repair, redrive) chỉ vượt ngưỡng bằng cờ override, và khi đó A **vẫn tăng** nên đường tự động không mở lại. **DLQ replay không tự nới bound**: nó đi qua **đúng** hàng áp dụng cho state hiện tại (hàng 9 của ma trận `../transactional-mail/01-architecture.md` §6.5) và thừa hưởng ngân sách + guard của hàng đó — chỉ redrive/repair có authorize mới kèm override. Ngân sách **B** = `mail_jobs.attempts` / `maxExecutionAttempts` (D1 `mail-job`) chặn số execution cho **một** generation ở worker: claim, stale-lease reclaim, redelivery. Không đường nào (publisher, reconciler, redrive, repair, DLQ replay) có bộ đếm riêng để tự nới bound; `mail_outbox.publish_attempts` là bộ đếm của chu kỳ publish hiện tại và **không** thay thế A. Kiến trúc hai D1 **không** cho phép một guard dùng chung, nên tài liệu này **không** tuyên bố có nó (§9.7).
20. **DLQ replay không phải một đường recovery riêng.** Replay đi qua **đúng** đường mà state control-plane hiện tại đòi (reconcile cùng generation, redrive có authorize, hoặc repair có authorize), sau khi validate control plane state; delivery đã `sent` **không bao giờ** được gửi lại chỉ vì có entry DLQ. Bảng quyết định đầy đủ theo trạng thái → `03-operations.md` §11. Quét D1 `mail-job` một mình không thể phát hiện message mất trước khi job record tồn tại (§9.7).
21. **Lease release là conditional write có guard owner + `execution_generation`; không có đường nào "release luôn thành công".** Khi D1 lỗi và lease không release được, lease không bị coi là đã release và tự hết hạn; reclaim là đường (a) §9.2.1 — nhưng nó chỉ chạy khi **có một command tới** (`03-operations.md` §10 hàng 1 chỉ alert, không claim), nên khi command đã bị ack mất thì recovery cuối cùng là control-plane reconcile re-enqueue (tiêu một slot A). Điều không đổi là: ack không làm mất intent — intent bền vững nằm ở `mail_messages`.
22. **Provider chỉ được gọi qua provider port (§11.1).** Adapter không retry bên trong một lần gọi (mỗi execution đã claim tiêu **đúng một** slot B; `attempts` chỉ tăng ở claim — §9.2.1), không nhận endpoint/URL ngoài trusted config, không follow redirect, và không log nguyên văn exception/stack của HTTP client; lỗi authn/authz của private API không bao giờ đi vào nhóm provider (`credential`/`blocked`/`failed`) vì nó không phải input của port; và `provider_message_id` nullable **không** phải bằng chứng thư đã được gửi.
