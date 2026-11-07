# Bounded context `llm-inference` — Domain Model

`llm-inference` là bounded context sở hữu **logical request lifecycle, provider attempts, retry semantics, streaming, execution evidence**. `llm-api` là runtime host và storage owner của `db-llm-gateway` (PostgreSQL); business ownership thuộc `llm-inference`.

> Mục đích: cung cấp tầng domain thuần quyết định: một logical request đang ở đâu trong vòng đời, một provider attempt có bằng chứng gì, và **execution có được tiếp tục hay không**. Thuần khiết: không I/O, không đồng hồ, không randomness, không persistence, không provider SDK.

## 1. Domain entities

### LogicalRequest (aggregate root)

- `requestId`: định danh opaque do caller sinh.
- `admittedAt`: epoch millis tại admission.
- `policy`: `ExecutionPolicy` — snapshot bất biến tại admission (`{ maxAttempts: number; deadlineAt: number }`).
- `status`: `open` | `reconciling` | `completed` | `failed` | `cancelled`.
- `attempts`: danh sách `ProviderAttempt` theo `sequence` tăng dần.
- `delivery`: `ClientDelivery` — dữ kiện đã gửi byte cho client và client đã ngắt.
- `completion`: `RequestCompletion | null` — chỉ khác `null` khi terminal.

Trạng thái terminal: `completed` / `failed` / `cancelled`. Sau terminal, không attempt mới.

### ProviderAttempt (entity con)

- `attemptId`: do caller sinh, duy nhất trong một logical request.
- `sequence`: `number` (1-based), do domain gán, không do caller.
- `candidateRef`: tham chiếu opaque tới candidate routing đã chọn.
- `endpointRef`: tham chiếu opaque tới endpoint, nếu có.
- `recordedAt`: thời điểm ghi dispatch intent.
- `evidence`: `ExecutionEvidence` — bằng chứng hiện tại.
- `evidenceRecordedAt`: thời điểm evidence hiện tại được ghi; `null` khi chưa có báo cáo.
- `endedAt`: `number | null` — `null` khi provider vẫn có thể trả kết quả.

### Value objects phụ

- `ExecutionPolicy` — `{ maxAttempts: number; deadlineAt: number }`, bất biến, validate tại admission.
- `ClientDelivery` — `{ state: 'not_committed' | 'committed'; committedAt: number | null; disconnectedAt: number | null }`.
- `RequestCompletion` — `{ status: 'completed' | 'failed' | 'cancelled'; closedAt: number; reason: RequestCancellationReason | null }`.
- `RetryDecision` — `{ admissible: true; nextSequence: number }` hoặc `{ admissible: false; reason: RetryRejectionReason }`.
- `AttemptOutcome` — `'in_progress' | 'succeeded' | 'not_executed' | 'uncertain'`, **suy ra** từ `evidence` + `endedAt`, không phải field lưu trữ. `AttemptOutcome` là view, không phải nguồn sự thật thứ hai: `may_have_executed` + attempt còn mở → `in_progress`; cùng evidence + attempt đã đóng → `uncertain`.

## 2. Execution evidence

### Bốn giá trị canonical

| Evidence                 | Nghĩa                                                 | Chặn retry? |
| ------------------------ | ----------------------------------------------------- | ----------- |
| `not_sent`               | Chưa gửi tới provider; không thể có side effect.      | Không       |
| `may_have_executed`      | Có thể provider đã nhận/thực thi nhưng chưa xác nhận. | **Có**      |
| `confirmed_not_executed` | Provider xác nhận **đã không** thực thi.              | Không       |
| `confirmed_completed`    | Provider xác nhận đã hoàn tất.                        | **Có**      |

Chỉ hai giá trị `confirmed_*` là **authoritative** — khẳng định cuối cùng của provider. `not_sent` và `may_have_executed` không phải khẳng định.

Domain không thêm giá trị thứ năm. "Không chắc" luôn được biểu diễn bằng `may_have_executed`; caller không đủ căn cứ phải truyền giá trị này (fail-safe), kể cả khi quan sát được lỗi trông giống "chưa thực thi".

**HTTP status không phải evidence.** Adapter không được suy `confirmed_not_executed` chỉ từ status code, thông điệp lỗi hay kết nối bị đóng. Chỉ khi semantics của provider chứng minh chắc chắn không có thực thi thì mới truyền `confirmed_not_executed`; mọi trường hợp còn lại là `may_have_executed`.

### Ma trận chuyển đổi (cho cùng một attempt)

| from \ to                | `not_sent` | `may_have_executed` | `confirmed_not_executed` | `confirmed_completed` |
| ------------------------ | ---------- | ------------------- | ------------------------ | --------------------- |
| `not_sent`               | ✓          | ✓                   | ✓                        | ✓                     |
| `may_have_executed`      | ✗          | ✓                   | ✓                        | ✓                     |
| `confirmed_not_executed` | ✗          | ✗                   | ✓                        | ✗                     |
| `confirmed_completed`    | ✗          | ✗                   | ✗                        | ✓                     |

Quy tắc:

1. **Không hạ cấp.** `may_have_executed → not_sent` bị từ chối: nó xoá mất khả năng provider đã thực thi.
2. **Hai khẳng định authoritative loại trừ nhau.** Không chuyển qua lại giữa `confirmed_not_executed` và `confirmed_completed`. Một correction như vậy cần quy trình riêng.
3. **Bằng chứng authoritative đến muộn được phép.** `not_sent → confirmed_*` hợp lệ vì nó mạnh hơn kết luận trước đó.
4. **Ghi lại chính nó là idempotent** nhưng vẫn kiểm tra timestamp lùi (`timestamp_regression`).
5. `confirmed_*` là absorbing; `not_sent` không bao giờ quay lại sau lần dispatch đầu.

## 3. Vòng đời logical request

```
open ──dispatch intent──▶ open (attempt mới, evidence not_sent)
  │
  ├─ attempt confirmed_completed ─▶ completed
  ├─ hết budget/deadline, không bất định ─▶ failed
  ├─ huỷ tường minh, không bất định ─▶ cancelled
  └─ còn may_have_executed chưa reconcile ─▶ reconciling
                                               │
                        confirmed_completed ────┴──▶ completed
                        confirmed_not_executed ─────▶ open
```

- `open` — còn có thể append attempt.
- `reconciling` — còn attempt `may_have_executed` chưa được xác nhận. **Không** append attempt, **không** terminal, **không** fail/cancel. Đây là trạng thái giữ "chưa xác định" tách khỏi "đã thất bại".
- `completed` / `failed` / `cancelled` — terminal, không attempt mới, không chuyển trạng thái.

### Bất định không phải thất bại

`failRequest` và `cancelRequest` từ chối khi còn attempt `may_have_executed` (`uncertain_execution_unresolved`). Muốn kết thúc, caller phải đưa evidence authoritative qua `reconcileUncertainAttempt`. Không có đường tắt nào biến bất định thành `failed`.

`completeRequest` yêu cầu evidence `confirmed_completed` (`completion_requires_completed_attempt`).

### Client disconnect không phải provider stop

Client disconnect chỉ ghi fact vào `delivery`: không đổi `status`, không đóng attempt, không đặt evidence, không tự cancel. Provider có thể vẫn đang thực thi. Caller (application) quyết định request có tiếp tục tới completion hay bị cancel sau khi đã xử lý bất định; quyết định đó đi qua `cancelRequest` với reason tường minh. Policy "tiếp tục hay cancel" sau disconnect **chưa được chốt** — domain không tự cancel.

## 4. Retry admissibility

### Một luật duy nhất

`evaluateRetryAdmissibility(request, { now })` là **cơ quan duy nhất** trong domain trả lời "có được append attempt mới không". `recordDispatchIntent` không tự kiểm tra lại — nó gọi luật này và ánh xạ lý do từ chối thành domain error cùng tên. Nhờ vậy không tồn tại nhánh code nào cho phép retry bằng đường khác.

Thứ tự đánh giá là **contract ổn định**; lý do trả về là lý do **đầu tiên** khớp:

| #   | Điều kiện                                      | `reason`                     |
| --- | ---------------------------------------------- | ---------------------------- |
| 1   | Request terminal                               | `request_closed`             |
| 2   | Request đang `reconciling`                     | `requires_reconciliation`    |
| 3   | Có attempt đang mở                             | `attempt_in_flight`          |
| 4   | Đã có byte tới client                          | `client_output_committed`    |
| 5   | `now >= policy.deadlineAt`                     | `deadline_exhausted`         |
| 6   | `attempts.length >= policy.maxAttempts`        | `attempts_exhausted`         |
| 7   | Còn attempt `may_have_executed` chưa reconcile | `previous_attempt_uncertain` |
| 8   | Attempt gần nhất `confirmed_completed`         | `previous_attempt_completed` |
| —   | Không điều kiện nào khớp                       | admissible, `nextSequence`   |

Bất biến:

- `may_have_executed` **luôn** chặn retry, kể cả khi budget còn và deadline chưa tới.
- Byte đã tới client chặn retry vĩnh viễn cho request đó (không transparent provider switch sau khi stream).
- Không admissible khi request đã terminal — không có ngoại lệ "thử thêm một lần".
- `nextSequence` do domain gán bằng `attempts.length + 1`; caller không được tự đặt.

### Limit do caller cung cấp

`ExecutionPolicy` được truyền vào tại admission và đóng băng trong aggregate. Domain **không** có default `maxAttempts`, **không** có default độ dài deadline, **không** tự suy ra từ số candidate, số endpoint hay cấu hình provider.

Validate tại admission: `maxAttempts` là số nguyên dương (`invalid_attempt_limit`); `deadlineAt` phải **sau** `admittedAt` (`invalid_deadline`). Policy không đổi sau admission.

## 5. Delivery và streaming facts

Domain chỉ giữ hai fact, không giữ khái niệm stream protocol:

| Fact             | Ý nghĩa                                 | Hệ quả                                   |
| ---------------- | --------------------------------------- | ---------------------------------------- |
| `committedAt`    | Ít nhất một byte response đã tới client | Chặn retry vĩnh viễn; absorbing          |
| `disconnectedAt` | Client đã ngắt kết nối (lần đầu)        | Không đổi trạng thái, không đổi evidence |

Bất biến:

1. Commit là **absorbing**: commit lặp lại giữ nguyên thời điểm commit đầu tiên, trả cùng object.
2. Commit **sau** disconnect bị từ chối (`invalid_delivery_transition`) — không còn kênh để gửi byte.
3. Disconnect **sau** commit hợp lệ — client có thể ngắt giữa stream.
4. Disconnect lặp lại là idempotent; timestamp lùi bị từ chối (`timestamp_regression`) để trạng thái durable không phụ thuộc thứ tự giao message.
5. Không có thuật ngữ SSE/HTTP/timer/chunk trong module này. Keepalive, framing và cách phát hiện disconnect là việc của `llm-api`.
6. Disconnect **không** phải cancellation và **không** phải bằng chứng provider đã dừng.

## 6. Domain operations

Mọi operation là hàm thuần nhận state hiện tại và trả state kế tiếp hoặc domain error.

```text
createLogicalRequest(input: { requestId, admittedAt, policy }) → LogicalRequest

recordDispatchIntent(request, { attemptId, candidateRef, endpointRef, recordedAt })
  → LogicalRequest
  // idempotent với cùng attemptId + cùng dữ kiện; khác dữ kiện → duplicate_attempt_id
  // quyền append do evaluateRetryAdmissibility quyết định

recordAttemptEvidence(request, { attemptId, evidence, recordedAt }) → LogicalRequest
closeAttempt(request, { attemptId, evidence, endedAt }) → LogicalRequest

recordClientOutputCommitted(request, { committedAt }) → LogicalRequest
recordClientDisconnectEvent(request, { disconnectedAt }) → LogicalRequest

evaluateRetryAdmissibility(request, { now }) → RetryDecision

awaitReconciliation(request) → LogicalRequest
reconcileUncertainAttempt(request, { attemptId, evidence, recordedAt }) → LogicalRequest

completeRequest(request, { completedAt }) → LogicalRequest
failRequest(request, { failedAt }) → LogicalRequest
cancelRequest(request, { cancelledAt, reason }) → LogicalRequest

describeRequestProgress(request) → RequestProgress  // view, không phải state
```

Quy ước chung:

- Input là `unknown` đối với dữ liệu đến từ boundary; operation validate và trả domain error thay vì ném exception.
- Mọi operation ghi một fact đều **idempotent** khi lặp với cùng dữ kiện: trả lại đúng object state hiện tại.
- Mọi operation ghi fact đều từ chối timestamp lùi (`timestamp_regression`).
- Operation không nhận "now" cho những việc không cần thời gian; chỉ `evaluateRetryAdmissibility` cần `now` để so deadline.

## 7. Failure, duplicate và concurrency semantics

Domain là **semantic-only**: nó mô tả state hợp lệ và phép chuyển hợp lệ, không bảo đảm durability, không giữ lock, không chạy retry.

**Cửa sổ crash (thuộc `llm-api`, domain cung cấp semantics):**

| Cửa sổ                                       | Evidence đúng         | Hành vi domain                                                        |
| -------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| Trước dispatch intent                        | không có attempt      | Không có gì để reconcile; retry an toàn ở tầng application.           |
| Sau dispatch intent, trước phản hồi provider | `may_have_executed`   | Chặn retry; phải `awaitReconciliation` → `reconcileUncertainAttempt`. |
| Provider đã hoàn tất, chưa ghi completion    | `confirmed_completed` | `completeRequest` idempotent; không dispatch thêm.                    |
| Sau terminal, command lặp lại                | terminal              | Replay cùng tham số → no-op; khác tham số → `request_closed`.         |

**Duplicate / out-of-order command:**

- Ghi lặp cùng dữ kiện là no-op. Ghi lặp khác dữ kiện bị từ chối, không "last write wins".
- Command đến muộn sau khi attempt đã đóng bị từ chối (`attempt_not_in_flight`) trừ khi đúng dữ kiện đã đóng.
- Commit sau disconnect bị từ chối; disconnect ghi lùi thời gian bị từ chối. Nhờ vậy hai thứ tự giao message khác nhau hội tụ về cùng state.
- Evidence đến muộn nhưng mạnh hơn được áp dụng; evidence yếu hơn bị từ chối.

**Concurrency:**

- Domain không có transaction, không có optimistic concurrency token. Application chịu trách nhiệm serialize command trên cùng aggregate (row lock / version check / idempotency key bền).
- Domain chỉ bảo đảm: với **cùng** state đầu vào và **cùng** command, kết quả là duy nhất. Không có global mutable state, không có thứ tự ngầm.
- Nếu hai caller cùng reconcile một attempt, chỉ kết quả áp dụng đầu tiên là hợp lệ; kết quả thứ hai phải bị từ chối bằng state đã đổi (application kiểm tra bằng version của nó).

## 8. Error model

- Domain error là value object `{ code, message }`, không mang dữ liệu call site, không mang prompt/response/secret.
- Factory duy nhất `inferenceDomainError(code)`; `code` ngoài taxonomy hoặc nằm ở prototype chain → `TypeError`.
- Message là **English** (runtime string theo language policy của repo).
- Tám mã `request_closed`, `requires_reconciliation`, `attempt_in_flight`, `client_output_committed`, `deadline_exhausted`, `attempts_exhausted`, `previous_attempt_uncertain`, `previous_attempt_completed` trùng tên với `RetryRejectionReason`: cùng một lý do, một vocabulary.

| Nhóm                | Mã                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input invalid       | `invalid_request_id`, `invalid_attempt_id`, `invalid_candidate_ref`, `invalid_timestamp`, `invalid_attempt_limit`, `invalid_deadline`, `invalid_evidence`, `invalid_cancellation_reason`                     |
| Chuyển không hợp lệ | `invalid_evidence_transition`, `invalid_delivery_transition`, `timestamp_regression`, `inconsistent_execution_state`, `duplicate_attempt_id`, `attempt_not_found`, `attempt_not_in_flight`, `request_closed` |
| Retry bị chặn       | `requires_reconciliation`, `attempt_in_flight`, `client_output_committed`, `deadline_exhausted`, `attempts_exhausted`, `previous_attempt_uncertain`, `previous_attempt_completed`                            |
| Reconciliation      | `no_uncertainty_to_reconcile`, `uncertain_execution_unresolved`, `reconciliation_not_pending`, `attempt_not_uncertain`, `reconciliation_requires_confirmation`, `completion_requires_completed_attempt`      |

## 9. Immutability, determinism và test specification

- Mọi object trả ra đều frozen; operation không sửa input; không có cache ẩn.
- Cùng input → cùng output. Không đồng hồ, không randomness, không environment.
- Type guard dùng khi rehydrate (`isLogicalRequest`, `isProviderAttempt`, `isClientDelivery`) từ chối state vi phạm invariant của chính aggregate: sequence không liên tục hoặc trùng, attempt ghi lùi thời gian, deadline không sau admission, delivery fact trước admission, `reconciling` mà không còn bất định, terminal còn attempt mở/bất định, `completed` không có evidence `confirmed_completed`. Operation không tin vào guard của caller — chúng kiểm tra lại mọi điều kiện.
- Test phải phủ: ma trận evidence 4×4 đầy đủ, không hạ cấp, không đổi authoritative; phân loại `AttemptOutcome`; tám lý do retry theo đúng thứ tự; budget và deadline; commit absorbing + disconnect idempotent + disconnect ≠ cancellation; recovery từ `may_have_executed`; chặn blind retry; chặn retry sau khi có byte tới client; chặn thao tác trên request terminal; validate input; duplicate/out-of-order command; determinism và không mutate input; guard rehydrate.
- Test title viết English; test hành vi, không test chi tiết implementation.

## 10. Exclusions và unresolved decisions

### 10.1 Explicit exclusions

- Candidate selection, strategy, fallback ordering, routing snapshot → `llm-consumer-routing`.
- Offer/endpoint/credential catalog → `llm-marketplace`.
- Quota, reservation, settlement, charge, balance, ledger → `llm-financial` / `llm-api` (A7).
- Usage measurement và normalization → `llm-usage`.
- Persistence, durable idempotency, transaction, alerting, event dispatch → application / infrastructure.
- Provider SDK, HTTP/SSE, adapter, error mapping, timeout timer → `llm-api`.
- Cross-BC implementation imports.

### 10.2 Unresolved decisions

| ID  | Quyết định còn mở                                                                        | Ảnh hưởng                                              | Nếu không chốt                                                                                             |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| U-1 | Giá trị và nguồn của `maxAttempts` / độ dài deadline (theo tier? theo tenant? cố định?). | `ExecutionPolicy` đầu vào                              | Domain không đặt default; `llm-api` phải truyền giá trị đã được duyệt. Không tự phát minh trong code.      |
| U-2 | Client disconnect: tiếp tục tới completion hay cancel request?                           | `recordClientDisconnectEvent` → chính sách application | Domain chỉ ghi fact; không tự cancel. Policy phải được chốt trước khi hành vi này thành contract ra ngoài. |
| U-3 | Correction khi hai evidence authoritative mâu thuẫn (provider đính chính).               | Ma trận chuyển đổi                                     | Hiện từ chối mọi chuyển đổi giữa `confirmed_*`. Cần quy trình correction riêng nếu phát sinh.              |
| U-4 | Escalation khi bất định không thể reconcile (provider không bao giờ trả lời).            | `reconciling` có thể kéo dài vô hạn                    | Domain không có timeout/escalation; cần SLA và hành vi vận hành do `llm-api` quyết định.                   |
| U-5 | Cancellation của request còn bất định: ai được phép, với điều kiện gì?                   | `cancelRequest` từ chối khi còn uncertainty            | Hiện không có đường huỷ; cần chốt trước khi triển khai force-cancel.                                       |

**Quy tắc:** không một quyết định nào ở trên được âm thầm chốt trong code.

### 10.3 Decisions đã chốt (không mở lại)

- Bốn evidence canonical, không thêm giá trị thứ năm; `may_have_executed` là fail-safe.
- Không blind retry sau possible execution; không transparent provider switch sau khi stream bytes.
- `reconciling` là trạng thái không terminal; bất định không bao giờ đọc thành thất bại.
- Client disconnect là fact, không phải cancellation và không phải bằng chứng provider dừng.
- Một logical request được settle/charge một lần theo `reservation_id` (A7) — domain không tạo attempt thứ hai sau khi đã có thể thực thi.
- Routing sở hữu _which candidate_; inference sở hữu _whether execution continues_.

## 11. Ranh giới: routing vs inference

Hai câu hỏi khác nhau, hai owner khác nhau:

| Câu hỏi                                          | Owner                  | Operation                                       |
| ------------------------------------------------ | ---------------------- | ----------------------------------------------- |
| Candidate nào kế tiếp, theo thứ tự fallback nào? | `llm-consumer-routing` | `decideFallback`, strategy selection            |
| Execution có được tiếp tục hay không?            | `llm-inference`        | `evaluateRetryAdmissibility`, attempt lifecycle |

- Routing trả lời **which** và giữ alias, eligibility, strategy, thứ tự fallback, routing snapshot.
- Inference trả lời **whether** và giữ trạng thái thực thi, evidence, delivery, completion.
- Inference nhận `candidateRef` / `endpointRef` là tham chiếu opaque do caller truyền vào; domain này không diễn giải nội dung, không xếp hạng, không tự chọn.
- Hai domain không import lẫn nhau. Vocabulary `ExecutionEvidence` được khai báo lại ở biên của từng domain; semantics của nó do `llm-inference` sở hữu. Phía routing giữ một compile-time assertion để hai khai báo không lệch nhau.
- `decideFallback` của routing **không** phải nguồn sự thật về quyền retry: nó chỉ mô tả routing có candidate kế tiếp hay không. Quyền append attempt luôn do `evaluateRetryAdmissibility` quyết định.

## 12. Tài liệu

| Document                               | Nội dung                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Domain model, evidence matrix, retry admissibility, delivery facts, completion, error model, unresolved decisions |
| [`README.md`](./README.md)             | Tóm tắt bounded context, boundary, documents                                                                      |
