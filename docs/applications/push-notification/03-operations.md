# Vận hành Dịch vụ Push Notification

> **Phạm vi:** vận hành của `push-notification` (control plane): deployment/config, outbox và Queue publishing, provider và credential operations, monitoring/alerting, reconciliation, runbook, capacity, retention.
> Delivery-side runbook (retry, DLQ processing, worker operations) → `docs/applications/web-push-notification-job/03-operations.md`. System-wide policies (pipeline, observability, backup/DR, alert tổng thể) → `docs/architecture/02-delivery.md`, `docs/architecture/03-operations.md`. Platform facts → `docs/architecture/04-platform-facts.md`.
> Design của service (topology, domain model, routing, state machine, outbox model, idempotency) → [`01-architecture.md`](./01-architecture.md).

**Mục tiêu vận hành:** không mất `Push Notification` sau khi request accept theo contract · không tạo duplicate logical delivery · cô lập failure theo `App`/`Provider`/`Device`/`Subscription` · rotate credential không downtime · truy vết được theo `notification_id`, `delivery_id`, `provider_id`.

## 1. Operational topology

```text
Ecoma Apps ──► push-notification (API · Admin API · Routing · Persistence · Outbox Publisher)
                        │ produce
                        ▼
              Cloudflare Queue  ecoma-push-delivery ──► web-push-notification-job ──► Browser Push Service
```

- Hai service **deploy và scale độc lập**; state đúng của notification nằm ở D1 `push`, không nằm ở Queue (`docs/architecture/03-operations.md` §11.3).
- Queue semantics/retention → `docs/architecture/04-platform-facts.md` §2.8 · system Queue rules → `docs/architecture/03-operations.md` §11.3 · thiết kế topology → [`01-architecture.md`](./01-architecture.md) §3.

## 2. Environment và Cloudflare resources

Mỗi environment (`development`, `staging`, `production`) có resource độc lập: Queue · D1 · provider configuration · secrets · observability. Environment matrix → `docs/architecture/02-delivery.md` §4.

**Production tối thiểu:** Worker `push-notification` · Worker `web-push-notification-job` · D1 `push` (owner: push-notification) · D1 `push-job` (owner: web-push-notification-job) · Queue `ecoma-push-delivery` · DLQ `ecoma-push-delivery-dlq`.

- DLQ giữ message vượt retry limit; behavior → `docs/architecture/04-platform-facts.md` QU3. Mọi production consumer MUST có DLQ (`docs/architecture/01-architecture.md` invariant 9).
- **Preview safety:** Preview **produce được nhưng không consume được** (`docs/architecture/04-platform-facts.md` QU7) — một Preview producer đẩy message vào queue production có thể bị consumer production xử lý (`docs/architecture/02-delivery.md` §5.2). Vì vậy **Preview MUST NOT** được cấu hình produce vào queue production; khi cần một delivery path ở Preview thì dùng queue riêng/test, hoặc vô hiệu hoá đường produce. Đây là chặn bằng binding, không bằng quy ước (`docs/architecture/01-architecture.md` invariant 2).
- **Local:** mô phỏng tối thiểu `push-notification` + `web-push-notification-job` + Queue + database; provider thực tế không gọi mặc định từ local — dùng mock/test provider cho `success` · `429` · `5xx` · `timeout` · `invalid subscription` · `invalid credential`. Local secret qua `.dev.vars`/`.env`, không commit Git.
- **Staging:** resource độc lập (Queue, database, provider configuration, secrets); cùng schema và Queue contract với production; **không** dùng production provider credential.
- **Launch gate — private endpoint không được expose hostname công khai:** mọi môi trường chỉ dùng Service Binding (gồm production) **MUST** đặt `workers_dev: false` trước khi chạy — xác thực caller ở tầng ứng dụng vẫn là bắt buộc (`01-architecture.md` §8.1 · `02-requirements.md` SR-006) vì Cloudflare không cung cấp header phân biệt Service Binding với request Internet. **Trạng thái:** đã đóng trong implementation — `apps/push-notification/wrangler.jsonc` và `apps/web-push-notification-job/wrangler.jsonc` đều đặt `workers_dev: false` và không có `routes`/hostname công khai nào; vẫn còn như một điều kiện kiểm tra khi thêm environment mới.

## 3. Queue configuration

Queue chính: `ecoma-push-delivery` · DLQ: `ecoma-push-delivery-dlq`. Consumer: `web-push-notification-job` (consumer config → `docs/applications/web-push-notification-job/03-operations.md` §4).

**Fan-out nhiều `App` dùng chung một queue `ecoma-push-delivery`.** Delivery của các `App` khác nhau đi trên cùng một queue và phân biệt bằng `transport` + `provider_id` trong envelope; `app` **không** nằm trong envelope mà lấy từ delivery material (`01-architecture.md` §6.3 · `02-requirements.md` FR-013). v1 **MUST NOT** tạo queue riêng cho từng `App` — chỉ tách queue khi có requirement mới chứng minh cần isolation ở mức queue. Mỗi queue chỉ có **một** consumer Worker (`docs/architecture/04-platform-facts.md` QU7).

```text
batch size · batch timeout · message retries · retry delay · max concurrency · dead letter queue
```

- `batch size`/`batch timeout` điều chỉnh theo provider rate limit, request latency, memory usage, expected volume (platform batch semantics → `docs/architecture/04-platform-facts.md` QU4).
- `max concurrency` **bounded** theo trần platform **250** invocation (`docs/architecture/04-platform-facts.md` QU6) — cùng trần với phía worker (§16).
- **Per-message ACK/retry là bắt buộc** (FR-013): message fail permanent MUST không retry lại các message khác trong cùng batch — áp dụng cả khi troubleshooting (§15). Duplicate Queue message là expected, không phải lỗi — consumer idempotent theo `delivery_id` (`01-architecture.md` §7).

## 4. Outbox Operations

Tham số vận hành (design → `01-architecture.md` §6):

```text
poll interval · batch size · claim lease timeout
max publish attempts · retry backoff (available_at) · published retention (cleanup)
```

### 4.1. Record operations

| Record       | Trạng thái                       | Thao tác operator                                                                                                                  |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pending`    | chờ claim, `available_at <= now` | backlog quá hạn tuổi → §4.2, runbook §15.2                                                                                         |
| `publishing` | giữ lease hạn định               | quá `claim lease timeout` → lease hết hạn, claim lại; lặp liên tục → kiểm tra publisher errors · Queue publish errors · D1 (§10.3) |
| `published`  | `Queue.send()` thành công        | xóa theo retention — không cần thao tác                                                                                            |
| `failed`     | vượt `max publish attempts`      | **không** xóa tự động → §4.2; thử lại publish qua `republish` (§4.3) sau khi sửa nguyên nhân, **giữ** record cũ để điều tra        |

- `Queue.send()` thành công trước khi mark `published` → publish lại là expected: chấp nhận duplicate, không chấp nhận mất message. Publisher crash → lease hết hạn → claim lại; **không** network call tới Queue hay provider bên trong D1 transaction (`01-architecture.md` §6.2).

### 4.2. Reconciliation

Chạy khi: alert record `pending`/`publishing` quá hạn tuổi (§11) · alert `failed` tích tụ (§11) · sau incident Queue publish failure · nghi ngờ notification đã accept nhưng không thấy delivery trong Queue.

Ba cơ chế reconciliation **phân biệt** — không dùng chung một job và **không** ghi chéo state của nhau:

- **(a) Outbox reconciliation** — thuộc control plane; quét D1 `push` cho outbox record `pending`/`publishing`/`failed` (publish chưa xong). Canonical ở mục này.
- **(b) Job reconciliation** — thuộc delivery worker; worker quét D1 `push-job` cho job kẹt (đã nhận nhưng quá ngưỡng chưa kết thúc, hoặc đã persist outcome nhưng chưa ack). **Định nghĩa canonical → `docs/applications/web-push-notification-job/02-requirements.md` FR-022** — mục này chỉ tham chiếu, không định nghĩa lại; cơ chế này **không** ghi logical delivery state.
- **(c) Logical delivery reconciliation** — thuộc control plane; quét D1 `push` tìm `Push Delivery` vẫn **non-terminal** — `pending`, `queued`, hoặc `processing` với `lease_expires_at <= now` — quá ngưỡng tuổi, **kể cả khi không có job record và không có outbox record nào đang chờ**. Canonical ở mục này.

`pending` là non-terminal (`02-requirements.md` FR-015) nên **thuộc** phạm vi (c): một delivery chưa publish được **không** được phép ở `pending` vĩnh viễn.

Outbox reconciliation **không** ghi state của `push-job`; job reconciliation **không** ghi trạng thái outbox/notification/delivery của control plane; logical delivery reconciliation **không** ghi state của worker; job reconciliation **không** ghi logical delivery state.

**Vì sao cần (c).** **`outbox.status = 'published'` KHÔNG chứng minh message đã được consumer xử lý** — publish thành công chỉ chứng minh `Queue.send()` đã trả về. Vì vậy **D1 `push-job` KHÔNG phải nguồn phát hiện duy nhất**: message chưa từng được consume thì **không có** job record nào để (b) tìm thấy. (c) quét D1 `push` và re-dispatch **cùng `delivery_id`**.

**Phát hiện và hành động của (c) — decision table (canonical cho recovery của delivery non-terminal):**

| #   | Nguồn sự thật (điều kiện phát hiện)                                                                               | Hành động                                                                                                                      | State transition                                                                                                                                    | Guard / idempotency                                                                                                                                                        | Khi thất bại                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| a1  | Delivery non-terminal **và** `expires_at <= now`                                                                  | Control plane đánh dấu `expired` (**không** gửi, **không** tạo intent, **không** re-dispatch)                                  | `pending`/`queued`/`processing` → `expired`                                                                                                         | Guard: chỉ áp dụng khi state **vẫn** non-terminal; terminal state không bị đụng                                                                                            | Alert nhóm Delivery §11                                             |
| a2  | Delivery `pending` **và** còn outbox record `pending`/`publishing` cùng `delivery_id`                             | **Không** làm gì — thuộc **(a) outbox reconciliation**                                                                         | không đổi                                                                                                                                           | Chống dồn intent: (c) **MUST NOT** tạo intent khi đã có record đang chờ                                                                                                    | (a) xử lý; alert nếu quá hạn tuổi §11                               |
| a3  | Delivery `pending` **và** outbox record `failed` **hoặc** không còn record nào                                    | **Alert + operator** → `POST /admin/v1/deliveries/:id/republish` (§4.3); **không** tự động                                     | `pending` (không đổi cho tới khi publisher publish)                                                                                                 | (c) **MUST NOT** tự chuyển `pending → queued` và **MUST NOT** tự tạo intent; `republish` có precondition riêng (§4.3)                                                      | Nếu operator không xử lý được → `expired` ở a1 khi quá `expires_at` |
| a4  | Delivery `queued` (chưa quá `expires_at`) **và** không có outbox record `pending`/`publishing` cùng `delivery_id` | Tạo **một** outbox intent mới cho **đúng** `delivery_id` → publisher publish lại                                               | không đổi (giữ `queued`; publisher chỉ ghi `outbox.status := 'published'` vì guard `status = 'pending'` không còn khớp — `01-architecture.md` §6.2) | **MUST NOT** tạo `notification_id`/`delivery_id` mới; **MUST NOT** tạo intent nếu đã có record đang chờ; partial unique index chống dồn intent (`01-architecture.md` §6.1) | Intent tạo được nhưng publish lỗi → record tăng `attempts` → a3     |
| a5  | Delivery `processing` **và** `lease_expires_at <= now` (chưa quá `expires_at`)                                    | **Không** làm gì ngay — lease hết hạn đã làm delivery claimable lại; re-dispatch chỉ khi cần (không có outbox record đang chờ) | không đổi (delivery vẫn `processing`, claimable lại)                                                                                                | Claim bằng guarded conditional write cấp generation mới (`01-architecture.md` §5.6)                                                                                        | Nếu redelivery không tới → sau ngưỡng tuổi, xử lý như a4            |
| a6  | Delivery đã **terminal** (`delivered`/`failed`/`expired`/`cancelled`)                                             | **Không** đụng vào                                                                                                             | không đổi                                                                                                                                           | **MUST NOT** hồi sinh terminal → non-terminal bằng reconciliation                                                                                                          | không áp dụng                                                       |

- **Mọi hành động đều có owner:** a1/a2/a4/a6 thuộc control plane (logical delivery reconciliation); a3 thuộc **operator** (có authorization + audit) — reconciliation chỉ **alert**, **không** tự làm. Publisher là actor của `pending → queued` trong mọi trường hợp (`01-architecture.md` §6.2).
- **Không có hành động nào tạo `queued` từ `pending`.** Một delivery chỉ trở thành `queued` khi `Queue.send()` **thật sự** thành công — nên không có "intent ma": mọi outbox intent đều dẫn tới một lần gọi `Queue.send()` thật, và record `published` là bằng chứng duy nhất cho `queued`.
- **Retry outbox record `failed` (§4.1) là `republish`, không phải gì khác.** Khi operator sửa xong nguyên nhân publish, đường hợp lệ để thử lại việc publish cho một delivery **non-terminal** là `POST /admin/v1/deliveries/:id/republish` (§4.3) — **không** có "retry outbox record" nào là một operation riêng, và `POST /admin/v1/deliveries/:id/retry` **MUST NOT** được dùng ở đây vì tiền điều kiện của nó đòi delivery `failed` (terminal).
- **Ba trường hợp phải xử lý đúng:** (1) message cũ **vẫn còn trong Queue** (chưa hết retention) → hai message cùng `delivery_id`; **atomic claim** (FR-015, `01-architecture.md` §5.6) chỉ cho một execution thắng, execution còn lại nhận `409 lease_held`/`409 terminal` và ACK an toàn, **không** gọi provider. (2) consumer chạy **đồng thời** với reconciliation → cùng hàng atomic claim quyết định; không có hai execution cùng gọi provider cho một generation. (3) `expires_at` trôi qua **giữa** lúc quét và lúc claim → claim trả `409 expired`; worker ACK an toàn, **không** gọi provider, và lượt quét (c) sau đó đánh dấu `expired` (claim **không** ghi state).
- **Hai reconciler chạy đồng thời không tạo intent trùng.** Ràng buộc **tầng database** — tối đa một outbox record `pending`/`publishing` cho mỗi `delivery_id` (partial unique index, `01-architecture.md` §6.1, §8 dưới đây) — là thứ chặn hai lượt quét cùng tạo intent. Reconciler **MUST NOT** dựa vào "đọc thấy chưa có record rồi tạo": hai reconciler đồng thời có thể cùng đọc kết quả đó; index mới là guard, và reconciler thua ghi intent nhận lỗi unique-constraint và bỏ qua (không phải lỗi cần alert). Reconciliation **MUST** là idempotent: chạy lại cùng một lượt quét trên cùng state **không** tạo thêm intent nào.
- **Delivery rời `pending` trong lúc publish:** vì thao tác ghi của publisher có guard (`01-architecture.md` §6.2 — chỉ ghi `delivery.status := 'queued'` khi delivery **vẫn** `pending`), một delivery đã bị (c) đánh dấu `expired` hoặc đã terminal **KHÔNG** bị hồi sinh thành `queued` khi record `failed`/`pending` được publish lại. Khi đó publisher chỉ ghi `outbox.status := 'published'` và message vừa publish bị worker từ chối an toàn (`409 expired`/`409 terminal` → ACK, không gọi provider). Lệch state giữa delivery và outbox record là bất thường cần điều tra, không phải đường hồi phục — đối chiếu theo §4.1 và alert nhóm Outbox/Delivery §11; **KHÔNG** dùng administrative recovery (§4.3) để "đẩy" một delivery terminal về `queued` ngoài tiền điều kiện của nó.
- **Hai nghĩa của `failed` — không lẫn.** Delivery terminal `failed` **chỉ** hồi phục qua `retry` (§4.3, tiền điều kiện đòi delivery `failed`). Outbox record `failed` **chỉ** được xử lý qua `republish` (§4.3, dành cho delivery **non-terminal**) — **không** có operation "retry outbox record". **SLA cho a3 (bắt buộc):** delivery `pending` không có outbox record khả dụng **MUST** được phát hiện và alert trong vòng `outbox_recovery_sla` kể từ khi vượt ngưỡng tuổi (giá trị cấu hình — §11); **không** có delivery nào ở `pending` vô thời hạn mà không có alert. Ngưỡng tuổi/tần suất quét/batch là operational item chưa chốt → `docs/architecture/03-operations.md` §10. Runbook → §15.8.

**Outbox reconciliation — phát hiện và hành động:**

| Phát hiện                                   | Hành động                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishing` kẹt quá lease                  | lease tự hết hạn và claim lại; lặp lại → sửa nguyên nhân ở publisher/Queue/D1 trước                                                                                                                                                                                                                  |
| `pending` backlog                           | sửa nguyên nhân (Queue publish errors · D1 · publisher health) → publisher tự catch up → monitor backlog về 0                                                                                                                                                                                        |
| `failed` record                             | xem `last_error` → sửa nguyên nhân (config/Queue/D1) → thử lại publish qua `POST /admin/v1/deliveries/:id/republish` (§4.3) khi delivery **non-terminal**, hoặc `POST /admin/v1/deliveries/:id/retry` (§4.3) khi delivery **`failed`**; không xác định được → **manual investigation**, giữ `failed` |
| Outbox khớp nhưng delivery không tiến triển | đối chiếu delivery state với outbox trong D1 `push`; không ghi đè state ngoài Admin API (§4.3)                                                                                                                                                                                                       |

- **Retry** chỉ sau khi nguyên nhân đã sửa; delivery permanent failure → **mark failed** theo §5. Record `failed` do publisher đánh dấu khi vượt attempts — operator giữ, **không xóa**, khi chưa rõ nguyên nhân. Outbox record không được mất trước khi publish thành công (§17).
- **Không có "retry outbox record" như một operation riêng.** Thử lại publish cho một delivery **non-terminal** = tạo một intent mới qua `republish` (§4.3), chịu đúng ràng buộc chống dồn intent; record `failed` cũ giữ nguyên để điều tra (`last_error`, `attempts`).
- Delivery-side reconciliation → `docs/applications/web-push-notification-job/02-requirements.md` FR-022 · `docs/architecture/03-operations.md` §10.

### 4.3. Retry authority

Hai thẩm quyền retry **tách biệt** — không được lẫn:

- **Retry external** (network/provider): thuộc **delivery worker** + Cloudflare Queue (`max_retries`, DLQ). Control plane **không** retry delivery.
- **Retry publish** (outbox → Queue): thuộc **control plane** (`max publish attempts` + backoff `available_at`, tham số ở §4). Worker **không** retry publish.
- Canonical của retry external → `docs/applications/web-push-notification-job/03-operations.md` §5.

**`POST /admin/v1/deliveries/:id/retry`** là **administrative recovery có uỷ quyền** cho delivery terminal `failed` → transition `failed → queued` (**authorized exception**, **không** phải transition bình thường — `failed` vẫn terminal theo state machine, Queue redelivery **MUST NOT** hồi sinh nó):

- Tạo **outbox entry mới** cho delivery đó → publisher publish lại `Delivery Command` qua Queue; **giữ nguyên `delivery_id`** (logical idempotency không đổi — `01-architecture.md` §7); **không** tạo notification/delivery mới.
- Cấp **generation mới** → execution cũ (`dispatch_generation` cũ) không ghi đè được outcome.
- **Tiền điều kiện** (không thoả → từ chối kèm lý do): delivery `failed`; subscription `active`; provider không **emergency hold**; notification chưa quá `expires_at`.
- Ghi audit `delivery_retried` + `reason` + `actor` (`02-requirements.md` FR-020); yêu cầu administrative authorization (FR-017/SR-004).
- ⚠️ Nếu provider đã nhận request mà outcome cũ **không xác định**, recovery **có thể tạo duplicate bên ngoài** (crash window đã chấp nhận) — **không** an toàn tuyệt đối; operator quyết định có chủ đích và ghi `reason`.
- Không dùng endpoint này thay cho retry external: delivery transient **đang** trong retry loop của worker **không** cần admin retry.

**`POST /admin/v1/deliveries/:id/republish`** là **operator recovery cho delivery non-terminal kẹt ở `pending`** (decision a3 ở §4.2; design → `01-architecture.md` §5.6.3) — **không** đổi state, **không** cấp generation, **không** phải là retry của delivery:

- Tạo **một** outbox intent mới cho **cùng** `delivery_id` → publisher là actor duy nhất đưa `pending → queued` khi `Queue.send()` thành công. Không tạo `notification_id`/`delivery_id` mới; delivery giữ `pending` cho tới lúc publish thành công.
- **Tiền điều kiện** (không thoả → từ chối kèm lý do): delivery **non-terminal** (`pending`/`queued`/`processing` — mục đích chính là `pending`); chưa quá `expires_at`; subscription `active`; provider không **emergency hold**; **không** có outbox record `pending`/`publishing` cùng `delivery_id` (ràng buộc chống dồn intent — partial unique index, §8).
- **Không có external duplicate:** delivery `pending` chưa từng được claim → chưa có request nào tới provider; `republish` chỉ dẫn tới một lần publish Queue và một claim sau đó.
- Ghi audit `delivery_republished` + `reason` + `actor` (FR-020); yêu cầu administrative authorization (FR-017/SR-004).
- Không dùng endpoint này khi delivery đã `failed` (terminal) — đó là `retry` (§4.3 trên); không dùng nó khi còn record `pending`/`publishing` — đó là việc của outbox reconciliation (§4.2 a2).

Hai operation **phân biệt theo state của delivery** và không thay thế nhau:

| Operation                                 | Tiền điều kiện state delivery        | Hiệu ứng state                       | Dùng khi                                                            |
| ----------------------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| `POST /admin/v1/deliveries/:id/retry`     | `failed` (terminal)                  | `failed → queued` + generation mới   | Publisher đã mất khả năng xử lý và delivery đã kết luận fail        |
| `POST /admin/v1/deliveries/:id/republish` | **non-terminal** (chủ yếu `pending`) | **không đổi state** (chỉ tạo intent) | Publisher đã mất khả năng xử lý nhưng delivery chưa từng được claim |

Lặp lại hoặc gọi đồng thời từng operation là an toàn: `retry`/`republish` đều thụt lùi về precondition sau mỗi lần thành công (`republish` không thể gọi lại khi đã có record `pending`/`publishing`; `retry` không thể gọi lại khi delivery đã `queued`), và việc hai lời gọi đồng thời cùng tạo intent bị chặn bởi partial unique index (§8) — lời gọi thứ hai bị từ chối, không tạo record trùng.

## 5. Delivery failure classification (Web Push Error Classification)

**Error matrix canonical** dùng thống nhất cho control plane và delivery plane (`docs/applications/web-push-notification-job/03-operations.md` tham chiếu về đây):

| HTTP        | Class                                     | Action                                                     |
| ----------- | ----------------------------------------- | ---------------------------------------------------------- |
| `2xx`       | success                                   | mark delivered, ACK                                        |
| `429`       | transient / retry                         | backoff, tôn trọng `Retry-After`                           |
| `5xx`       | transient / retry                         | retry                                                      |
| `404`       | subscription invalidation                 | mark failed, invalidate subscription, ACK                  |
| `410`       | subscription invalidation (endpoint gone) | mark failed, invalidate subscription, ACK                  |
| `401`/`403` | provider credential/configuration failure | provider-level failure path — xem dưới                     |
| `413`       | permanent payload failure                 | mark failed, ACK, không retry                              |
| `3xx`       | permanent (redirect không được đi theo)   | mark failed, ACK, **không** invalidate subscription, alert |

- **Transient** (timeout, connection reset, 5xx, 429, DNS tạm): retry. **Permanent** (subscription invalid, endpoint expired, provider-level credential invalid — **không** invalidate subscription, malformed payload): mark failed, ACK. **Unknown:** retry → vượt limit → DLQ. Subscription invalidation **chỉ** khi provider chứng minh endpoint không còn hợp lệ (`404` hoặc `410`).
- **`410` — class `endpoint_invalid`, giống hệt `404` về hành vi:** RFC 8030 §7.3 quy định `404` cho subscription hết hạn trên **send path**; `410` là hành vi **ngoài spec** cho send path (spec chỉ dùng `410` cho receipt channel §6.2/§6.3). Push service sản phẩm — Mozilla autopush — dùng `410` cho "endpoint không còn dùng được vĩnh viễn" (`ApiErrorKind::NoUser | NoSubscription` → `StatusCode::GONE`, `autoendpoint/src/error.rs`; errno 103/105/106, `docs/src/errors.md`). Vì vậy `410` cùng lớp ngữ nghĩa với `404`: `endpoint_invalid` → mark failed → invalidate subscription → ACK, **không** retry. `http_status` giữ **410** (không gộp vào `404`) trong metrics/log để operator phân biệt spike 404 với spike 410.
- **`401`/`403`:** mark failed, ACK, ghi nhận theo `provider_id` và alert; **không retry**, **không** invalidate subscription, không disable hàng loạt — remediation ở §6/§7 cho các delivery tiếp theo.
- **429:** tôn trọng `Retry-After`, tránh tight retry loop; backlog do 429 → giảm effective concurrency, không tăng concurrency vô hạn (§16).
- Không tự động reroute sang provider khác nếu routing policy không cho phép (`01-architecture.md` §5.3).

### 5.1. Retry transient MUST release lease

Phân loại ba nhóm outcome, operation `release`, và thứ tự **release trước `retry()`** là **canonical ở delivery plane** — `docs/applications/web-push-notification-job/01-architecture.md` §12. Mục này chỉ ghi hệ quả phía control plane, vì control plane sở hữu claim predicate (`01-architecture.md` §5.6).

- **Lý do release là bắt buộc:** claim predicate là `status = 'queued'` **hoặc** (`status = 'processing'` **và** `lease_expires_at <= now`). Nếu worker trả `retry()` mà **không** release, message được Queue giao lại nhưng delivery vẫn `processing` với lease còn hiệu lực → claim trả `409 lease_held` → **retry của Queue không thực sự retry provider**. Đây là lỗi correctness trung tâm, không phải tối ưu.
- `release` là operation **riêng** trên private delivery runtime API (`01-architecture.md` §8.1), kèm `dispatch_generation`; generation không khớp → `409 stale_write`, state không đổi. Hiệu ứng state của `release` (`processing → queued`, xoá lease, generation **không đổi**) là canonical ở `01-architecture.md` §8.1 — mục này không định nghĩa lại.
- **TTL/expiry:** retry chỉ có nghĩa khi delivery **chưa vượt** `expires_at`; delivery đã `expired` không claimable — `retry()` trên delivery đã `expired` là no-op và worker phải `ack()` message (case 3 của (c) ở §4.2; `01-architecture.md` §5.6).
- Control plane theo dõi tần suất `409` theo `reason`: `lease_held` tăng bất thường nghĩa là worker đang quên release; `terminal` tăng nghĩa là duplicate message/redelivery bình thường. Tập `reason` canonical → `01-architecture.md` §8.1.

## 6. Provider operations

### 6.1. Configuration management

Provider quản lý qua `Admin API`: `create` · `update` · `enable` · `disable` · `test` · `rotate credential`. Mọi thay đổi production provider phải có audit record (§14). Validation trước production enable — `Admin API` chỉ cho `disabled → enabled` sau khi pass ba precondition fail-closed: `configuration schema` · `credential availability` · `credential validity`. `provider connectivity` · `test delivery` là **bước runbook của operator** (§6.4), chạy qua `POST /admin/v1/providers/:id/test` với kết quả phân loại theo FR-018 (`02-requirements.md`) — không phải gate fail-closed phía API. Operational rule: `one active primary provider per App + Transport` — `Admin API` MUST từ chối cấu hình tạo ambiguity, không bao giờ chọn provider random/thứ tự database (`01-architecture.md` §5.3).

### 6.2. Provider health

Theo dõi health theo `provider_id`, `app`, `transport` — không chỉ theo provider type (ví dụ `backoffice / web / provider-a` và `llm-seller / web / provider-b` quan sát độc lập). Metrics/dashboard → §10.

### 6.3. Provider disable procedure

`Admin API → disable provider → dừng routing delivery mới`

- Delivery đã materialize — kể cả trong Queue — tiếp tục theo `provider_id` đã ghi; disable **không** implicit cancel, **không** tự động reroute (`01-architecture.md` §5.3).
- `disable` **chỉ** dừng **routing delivery mới**; nó **KHÔNG** làm delivery đã materialize trở nên ineligible — worker **tiếp tục** xử lý. Điều kiện ineligible chỉ đến từ **emergency hold/revoke** (§6.5).
- Không tự ý đổi queued delivery từ provider A sang B — routing mutation, có thể gây duplicate. **Administrative reroute** là operation riêng, chủ đích, có audit — theo dõi queued deliveries trước khi quyết định.

### 6.4. Provider test runbook

Select provider (`provider_id`) → select target subscription đã authorization (`subscription_id`) → execute test delivery → inspect `delivery_id` và provider response. Test result phân loại theo `02-requirements.md` FR-018; test có audit record `provider_updated` với `detail.test_result` (và `subscription_id`, `duration_ms` khi có), payload không chứa dữ liệu nhạy cảm không cần thiết.

### 6.5. Emergency hold / revoke provider

Operation **riêng**, tách biệt với `disable` (§6.3): dùng khi cần chặn delivery **ngay** (compromise credential, provider bị xâm phạm, sự cố bảo mật).

- **Nghĩa:** chặn delivery **chưa bắt đầu** ở mức có thể làm được, thu hồi/giữ credential khi cần, xử lý request **đang in-flight** trong giới hạn thực tế. Delivery plane: **`provider under emergency hold` LÀ điều kiện ineligible** → claim trả `409 ineligible_provider_hold`; worker **không** gọi provider, **không** tự reroute.
- ⚠️ **KHÔNG** khẳng định recall được một request provider **đã accept** — hold chỉ chặn được phần chưa gửi đi.
- **Audit:** `provider_held` khi hold, `provider_released` khi bỏ hold (`02-requirements.md` FR-020); yêu cầu administrative authorization + explicit confirmation (§14) và theo runbook khẩn cấp (§15.7).
- **Khác `disable` (§6.3):** `disable` chỉ dừng routing mới và **không** làm delivery đã materialize ineligible; `emergency hold` chặn delivery đã materialize nhưng **chưa bắt đầu**.

## 7. Credential và secret operations

### 7.1. Storage boundary

Credential lưu **encrypted at root key**; root key/runtime secret dùng `Cloudflare Worker Secret` — plaintext `vars` không dùng để lưu secret. Credential không nằm trong wrangler configuration, Git, Queue, application log, audit log, API response. Ba loại secret phân biệt (provider credential · subscription delivery secret · root encryption key) → `01-architecture.md` §9, `02-requirements.md` FR-006.

### 7.2. Provider credential rotation

```text
tạo credential mới → lưu → validate → activate → gửi test notification
→ monitor delivery → revoke credential cũ → audit rotation
```

**Không revoke credential cũ trước khi credential mới validate thành công.** Cấm đảo thứ tự (`revoke old → deploy new` khi deployment mới chưa xác nhận). Rotation không yêu cầu restart toàn bộ application.

**VAPID key pair** là provider credential của `web-push` theo từng `App`, gắn định danh `vapid_key_id`; private key **không** vào Queue, log hay API response; public key phục vụ client ở tầng application, không qua Queue (`01-architecture.md` §9). Web Push ràng buộc subscription với application server key dùng lúc tạo — push service từ chối message ký bằng key khác (`docs/architecture/04-platform-facts.md` §2.15).

**VAPID rotation theo key version.** Subscription **MUST** lưu `vapid_key_id` dùng lúc tạo; worker ký theo `vapid_key_id` của subscription, **không** phải "key hiện tại của `App`". **Key mới phục vụ subscription MỚI**; **subscription cũ GIỮ** `vapid_key_id` cũ và **tiếp tục** được phục vụ bằng key cũ. **Retire key cũ CHỈ khi** không còn subscription nào tham chiếu `vapid_key_id` cũ (đo bằng số subscription theo từng `vapid_key_id` — metric/dashboard). **Trong thời gian rotation, runtime resolution MUST trả credential cho `vapid_key_id` đang được retire** để tránh mất khả năng gửi tới subscription cũ (`01-architecture.md` §7; `docs/applications/web-push-notification-job/01-architecture.md` §7). Compromise: đánh dấu key bị compromise, không tạo subscription mới dùng key đó, tiếp tục phục vụ subscription cũ theo policy, retire theo tiến trình trên, và alert. **VAPID rotation KHÔNG phải root-key rotation** (§7.3).

**Đường re-subscribe khi buộc thu hồi key sớm (compromise).** Subscription trỏ key bị thu hồi **không còn gửi được** — invalidate các subscription đó và client đăng ký lại. **KHÔNG** mô tả là migration trong suốt: mất khả năng gửi tới các subscription đó **cho tới khi** client đăng ký lại. Flow: thu hồi key → invalidate subscription theo `vapid_key_id` bị thu hồi → client nhận và đăng ký lại → verify test delivery → monitor. Rollback: không trong suốt (key đã thu hồi → client phải re-register).

**Điều kiện/verification:** trước retire, số subscription theo `vapid_key_id` về 0; sau rotate, test delivery cho subscription mới (key mới) và subscription cũ (key cũ) đều thành công. Tổng quan rotation:

```text
sinh key pair mới (vapid_key_id mới) → đăng ký làm key đang phục vụ subscription MỚI
→ subscription cũ GIỮ vapid_key_id cũ và tiếp tục được phục vụ bằng key cũ
→ retire key cũ CHỈ khi không còn subscription nào tham chiếu vapid_key_id cũ
→ audit credential_rotated
```

### 7.3. Credential encryption-key rotation

Không rotate root key kiểu replace đột ngột — dùng multi-key: `K1 active → K2 introduced (read K1+K2, ghi mới dùng K2) → reencrypt records bằng K2 (background job, batch, idempotent) → verify không còn record nào cần K1 → retire K1`. Không retire `K1` khi còn record chưa reencrypt (`credential_encryption_version` còn trỏ `K1`); quan sát metric số record theo key version — tương ứng `02-requirements.md` FR-006.

### 7.4. Infrastructure secrets

Secret cấp infrastructure (database credential, encryption key, application auth secret, Cloudflare API credential) rotate theo policy chung — `docs/architecture/03-operations.md` §8 (quarterly, native Worker Secrets). Local secret qua `.dev.vars`/`.env`, không commit Git.

## 8. Database operations

D1 `push` chứa (inventory): `devices` · `push_subscriptions` · `push_providers` · `push_provider_credentials` · `push_app_provider_mappings` · `push_notifications` · `push_deliveries` · `push_outbox` · `notification_idempotency` · `push_routing_policy` · `audit_records` · `push_rate_limits`.

- `push_rate_limits` (bổ sung inventory khi implement FR-021): counter rate limit fixed window theo `app` của `POST /v1/notifications` — một `App` đúng một dòng counter đang mở, UPSERT atomic (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), không có read-then-write. `limit`/`window_duration` là tham số cấu hình, không phải cột — đổi ngưỡng không cần migration. Counter phải bền trong D1 vì counter in-memory là node-local state (nhiều isolate vừa cho qua vừa mất đếm). Migration: `0003_push_rate_limits.sql`.

- Ownership và transaction model (`db.batch()` gộp write; không network call trong D1 transaction) → `01-architecture.md` §6, §12 · `docs/architecture/04-platform-facts.md` DB2.
- **Không service khác truy cập trực tiếp D1 `push`** — `web-push-notification-job` resolve runtime data qua private interface, sở hữu D1 `push-job` riêng (`docs/architecture/01-architecture.md` §4).
- **Index bắt buộc (structural, không phải tuning):**
  - `push_outbox (status, available_at)` cho outbox claim predicate.
  - **Partial unique index trên `push_outbox (delivery_id) WHERE status IN ('pending','publishing')`** — thực thi ràng buộc "tối đa một intent đang chờ publish cho mỗi `delivery_id`" (`01-architecture.md` §6.1). Đây là **guard chống dồn intent** cho reconciler và cho `republish` (§4.2, §4.3): hai reconciler (hoặc hai lời gọi admin) chạy đồng thời không thể cùng tạo record, vì D1 từ chối record thứ hai bằng unique constraint — **không** dựa vào kiểm tra đọc-rồi-ghi ở application. Record `published`/`failed` **không** nằm trong index, nên một intent mới vẫn hợp lệ sau khi record cũ terminal.
  - `push_deliveries (expires_at)` hoặc tương đương để logical delivery reconciliation (§4.2 (c)) quét được theo `expires_at`/tuổi mà không full-scan.
- **Claim dùng guarded conditional write**, không phải `SELECT` rồi `UPDATE` (`01-architecture.md` §5.6): correctness dựa trên predicate nằm trong chính statement ghi và số dòng **thực sự** bị thay đổi (`04-platform-facts.md` DB3), **không** dựa vào row-level locking hay isolation level — D1 **không** tài liệu hoá hai thứ đó (DB11). Vì vậy bảng nào có claim (`push_deliveries`, `push_outbox`) **MUST** có đủ cột cho predicate (`status`, `lease_expires_at`, `expires_at`, `available_at`).
- Write latency tăng khi transaction lớn.

**Migration:** track D1 canonical ở `docs/architecture/02-delivery.md` §3 (expand → compatible rollout → contract, không down-migrate). Yêu cầu đặc thù: migration idempotent hoặc có guard chống apply hai lần · backward-compatible với Worker version đang chạy · Queue message schema có `version` · theo dõi D1 schema version.

**Backup/DR scope:** D1 `push` **không** thuộc Backup/DR scope — không backup strategy, không restore runbook, không đưa vào RPO/RTO matrix (`docs/architecture/03-operations.md` §3.1); Time Travel (`04` DB5) là capability destructive của platform, **không** phải cam kết phục hồi. Hệ quả data-loss của D1 `push` đã được chấp nhận (mất device/subscription/notification/delivery/outbox state) — recovery theo §12.

## 9. Deployment, rollout và rollback

### 9.1. Deployment boundary

Hai service deploy độc lập — một service deploy được mà không cần service còn lại nếu contract không đổi. **Launch gate trước deploy:** môi trường chỉ dùng Service Binding (gồm production) **MUST** đặt `workers_dev: false` (hoặc cấu hình tương đương) để private delivery runtime API không bị expose qua hostname công khai `*.workers.dev` (§2). Pipeline/preview/promotion gate → `docs/architecture/02-delivery.md`.

### 9.2. Queue contract rollout

Thay đổi Queue contract theo hướng backward compatible: `deploy consumer hỗ trợ old + new → deploy producer dùng new format → monitor → remove old support`.

**MUST NOT** deploy producer new format khi old consumer chưa hiểu message mới. Breaking contract → dùng **new queue / version**, không inplace breaking change. Ba loại version phải quản lý: `API version` · `Queue message version` · `Database schema version`.

### 9.3. Post-deployment verification

`API health · Queue publish · Queue consume · provider test · delivery success · error rate · queue backlog · private endpoint không có hostname công khai (workers_dev disabled)`

### 9.4. Rollback

Phân biệt: `code rollback` · `queue contract rollback` · `provider configuration rollback`. **Không có** hạng mục "schema rollback": không rollback D1 migration — cùng quy tắc PostgreSQL (`docs/architecture/02-delivery.md` §3): chỉ expand → contract + forward-fix. Rollback Worker theo version đã publish → `docs/architecture/02-delivery.md` §8.

## 10. Observability

### 10.1. Correlation và structured logging

Correlation chain: `request_id → notification_id → delivery_id → subscription_id → provider_id` — log phải cho phép tìm toàn bộ lifecycle từ `request_id` hoặc `delivery_id`. Mỗi log entry nên có: `timestamp` · `level` · `service` · `environment` · các id trên · `app` · `transport` · `event` · `error_code` · `duration_ms`. **Không log:** private key, access token, subscription secret, provider credential; payload notification redacted khi chứa sensitive data. Policy chung → `docs/architecture/03-operations.md` §4.

### 10.2. Metrics

```text
notifications_created_total · notifications_rejected_total · notifications_idempotent_replay_total
deliveries_created_total · deliveries_queued_total · deliveries_delivered_total · deliveries_failed_total · deliveries_expired_total
deliveries_non_terminal_aged · claim_rejected_total (theo `reason` — §4.2 (c), §5.1)
subscriptions_active · subscriptions_disabled · subscriptions_expired
queue_publish_failures_total · queue_backlog · queue_oldest_message_age · queue_retry_rate · queue_processing_failures_total
outbox_pending · outbox_publishing_aged · outbox_failed
provider_requests_total · provider_success_total · provider_failures_total
provider_429_total · provider_5xx_total · provider_auth_failures_total · provider_latency_ms · provider_invalid_subscription_total
dlq_messages
```

- `deliveries_non_terminal_aged` là tín hiệu phát hiện của (c) (§4.2); `claim_rejected_total` theo `reason` là tín hiệu phát hiện **retry không thực sự retry provider** (§5.1) — `lease_held` tăng bất thường nghĩa là worker quên release. Cả hai là metric **bắt buộc**, không phải tuỳ chọn.
- **Metric bắt buộc cho recovery (F1):** `deliveries_pending_unrecoverable` (delivery `pending` không có outbox record khả dụng — nhánh a3) · `deliveries_expired_total` (a1) · `reconciliation_republish_total` (a4/a5) · `reconciliation_intent_conflict_total` (lượt tạo intent bị partial unique index từ chối — kỳ vọng > 0 dưới tải đồng thời, **không** phải lỗi) · `delivery_republished_total` · `delivery_retried_total` · `outbox_records_aged_pending` (tuổi record `pending`/`publishing` — tín hiệu publisher không chạy, kể cả khi trigger chưa cấu hình). Alert `deliveries_pending_unrecoverable > 0` là **bắt buộc** (§11).
- Dimension tối thiểu theo `provider_id`, `app`, `transport`. **Không** dùng `user_id`, `notification_id`, `delivery_id`, `endpoint` làm high-cardinality label — chỉ dùng trong log/tracing.

### 10.3. Dashboard

| Nhóm     | Nội dung                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Queue    | backlog · tuổi message lớn nhất · processing rate · retry rate · failure rate · DLQ                                                     |
| Outbox   | `pending` · `publishing` quá tuổi (stale lease) · `failed` · queue publish errors                                                       |
| Delivery | success rate · failure rate · latency · invalid subscription · non-terminal quá tuổi · `expired` · `claim_rejected_total` theo `reason` |
| Provider | success · error rate · 429 · 5xx · authentication failure (401/403) · latency                                                           |
| Service  | request rate · API latency/error · Worker errors · D1 errors · queue publish errors                                                     |

Filter theo `app`, `transport`, `provider`.

### 10.4. Health checks

- **Liveness:** chỉ kiểm tra process/runtime hoạt động — không phụ thuộc provider, database, Queue. **Readiness:** phản ánh trạng thái dependency cần thiết để nhận request an toàn.

## 11. Alerts

Alert system-level (DLQ không rỗng, backup,…) → `docs/architecture/03-operations.md` §5; dưới đây là điều kiện riêng của service (ưu tiên rate/anomaly, không alert theo một failure đơn lẻ):

| Nhóm         | Điều kiện                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue        | backlog tăng liên tục · tuổi message lớn nhất tăng · retry rate tăng · processing failure tăng · `DLQ > 0`                                                                                                                                                                                                                     |
| Outbox       | record `pending`/`publishing` quá hạn tuổi (kể cả khi trigger của publisher chưa được cấu hình — `01-architecture.md` §6.2) · `failed` tích tụ (§4)                                                                                                                                                                            |
| Delivery     | delivery failure rate tăng · delivery latency tăng · delivery non-terminal quá tuổi không giảm (reconciliation (c) không theo kịp) · `claim_rejected_total{reason="lease_held"}` tăng bất thường (worker quên release) — **không** alert theo `reason="terminal"` (duplicate/redelivery là bình thường) hay `reason="pending"` |
| Recovery     | **`deliveries_pending_unrecoverable > 0`** — delivery `pending` không còn outbox record khả dụng, nhánh **a3**, cần operator (§4.2, §15.8); SLA phát hiện = `outbox_recovery_sla` — **alert bắt buộc** (đây là cách duy nhất bảo đảm không có delivery `pending` treo im lặng)                                                 |
| Provider     | 429 rate tăng · 5xx rate tăng · provider authentication failure (`401/403`) · latency tăng                                                                                                                                                                                                                                     |
| Subscription | invalid subscription tăng bất thường                                                                                                                                                                                                                                                                                           |
| Service      | API error rate tăng · Worker invocation failure tăng · D1 error tăng · queue publish errors tăng                                                                                                                                                                                                                               |

**SLA/ngưỡng cấu hình (giá trị số là operational item chưa chốt → `docs/architecture/03-operations.md` §10):** `outbox_recovery_sla` (thời gian tối đa trước khi record `pending`/`publishing` đến hạn hoặc delivery `pending` không có record khả dụng phải được phát hiện + alert) · `delivery_reconciliation_age` (tuổi để (c) coi một delivery non-terminal là "quá hạn") · `idempotency_retention` (§13, FR-008) · `caller_retry_window` (cửa sổ retry mà contract **công bố** cho caller — FR-008; cùng launch gate với `idempotency_retention`, và là **chặn dưới** của nó) · `max_notification_ttl` (TTL nghiệp vụ tối đa của một notification — **chặn trên** để FR-008 suy ra `idempotency_retention`; mọi `expires_at` đều ≤ giá trị này). Tên các ngưỡng này là **chốt**; giá trị số chưa chốt và **MUST NOT** được implementation tự chọn.

## 12. Backup và recovery

- **D1 `push` ngoài Backup/DR scope** — policy system → `docs/architecture/03-operations.md` §3.1. **Time Travel** (`04` DB5) là capability destructive của platform, **không** phải cam kết phục hồi — không dùng làm runbook của ecoma.
- **Hệ quả mất D1 `push` (đã chấp nhận):** mất device/subscription/notification/delivery/outbox state. Recovery ở **mức service** (không restore data): re-seed provider configuration → client re-subscribe / rebuild state → reconciliation để xử lý job state còn đọc được. History notification/delivery mất là **chấp nhận được** vì không business-critical (business-critical nằm trên PostgreSQL — `docs/architecture/03-operations.md` §11.4).
- **Rebuild flow:** re-seed provider configuration → restore service → verify queue connectivity → verify routing → client re-subscribe / rebuild state → send test notification. Không restore đè.
- **Mất delivery worker:** restore worker → reconnect consumer → process Queue backlog. Message mất sau retention: (b) chỉ tìm được việc **đã có job record**; việc **chưa từng được consume** (**không** có job record) do (c) logical delivery reconciliation của control plane phát hiện trên D1 `push` và re-dispatch **cùng `delivery_id`** (§4.2 → `docs/applications/web-push-notification-job/03-operations.md` §14.10).
- **Backup duy nhất của service này là credential** (không nằm trong D1).

## 13. Data retention và cleanup

Retention định nghĩa độc lập cho từng loại: `Push Notification` (ngắn) · `Push Delivery` (dài hơn — metadata cho history) · `Audit Record` (dài nhất) · `Log` · `Metrics` · `DLQ`. Không giữ payload lâu hơn mức cần thiết; retention thực tế tuân regulatory requirement. Retention/quota của D1 `push` là operational item chưa chốt → `docs/architecture/03-operations.md` §10.

- Retention ở đây chỉ là **cleanup policy**, không phải recovery mechanism: D1 `push` ngoài Backup/DR scope (§8, §12) — mất dữ liệu quá retention là **chấp nhận được**, không có restore path (không RPO/RTO).

- `DELETE` subscription/provider trong Admin API là **logical revoke/disable** (`02-requirements.md` §4.3); physical cleanup chỉ thuộc retention/cleanup process.
- **Periodic cleanup:** expired subscriptions · disabled subscriptions · orphan devices · stale provider configuration. Không xóa ngay subscription chỉ vì không có delivery gần đây — `last_seen_at` chỉ dùng cho cleanup policy khi đã chốt threshold.
- **Idempotency record KHÔNG** thuộc danh sách cleanup tự do: điều kiện xoá an toàn **canonical ở `02-requirements.md` FR-008** — **không** định nghĩa lại ở đây (điều kiện (ii) nói về **outbox record**, **không** phải job record: một delivery chưa từng được consume thì không có job record nào, và việc thiếu job record **MUST NOT** được coi là "đã an toàn để xoá"). Xoá sớm một record biến replay hợp lệ của caller thành tạo notification **trùng** — đây là correctness, không phải dọn dẹp. `idempotency_retention` **MUST NOT** được implementation tự chọn; giá trị là launch gate (§11, `docs/architecture/03-operations.md` §10), và `queue_retention` (`04-platform-facts.md` QU5) **không** thay thế được nó vì đường recovery có thể sống lâu hơn Queue.
- **Re-validate endpoint đã lưu:** control plane **MUST** re-validate `endpoint` đã lưu khi allowlist/policy thay đổi và **theo định kỳ**; endpoint không còn hợp lệ → subscription chuyển `disabled` (không tạo delivery mới). Validation lúc đăng ký **KHÔNG** phải an toàn vĩnh viễn (`02-requirements.md` FR-003).

## 14. Admin operations

- Operation nguy hiểm yêu cầu explicit confirmation tại `Backoffice`: `disable provider` · `delete provider` · `revoke credential` · **`emergency hold/revoke provider`** · `disable many subscriptions` · `replay many DLQ messages` · **`deliveries/:id/republish`** (tạo publish intent cho một delivery non-terminal).
- Bulk operation phải ghi: `operator` · `timestamp` · `reason` · `scope` · `result`.
- Hai administrative recovery **phân biệt theo state của delivery** (§4.3): `POST /admin/v1/deliveries/:id/retry` cho delivery terminal `failed` (`failed → queued` + generation mới, audit `delivery_retried`); `POST /admin/v1/deliveries/:id/republish` cho delivery **non-terminal** chưa từng claim (không đổi state, chỉ tạo một outbox intent, audit `delivery_republished`); **không** phải retry tự động.
- Audit event bắt buộc → `02-requirements.md` FR-020; audit record không chứa secret. Rate limit/fan-out limit theo `app` → FR-021.
- DLQ replay là administrative operation: giữ nguyên `delivery_id` · không tạo notification/delivery mới · không bỏ qua idempotency · ghi audit · không replay nếu subscription đã permanent invalid.

## 15. Incident runbooks

### 15.1. Incident: Queue backlog

```text
provider health → 429/5xx · provider latency → consumer health · Worker errors → concurrency · per-message ACK/retry
→ transient retry phải release lease trước `retry()` (§5.1), nếu không redelivery gặp lease còn hiệu lực và bị skip
→ outbox backlog (§4) · database latency → provider outage (§15.4)
→ giảm pressure nếu provider throttling (§16) → monitor backlog recovery
```

### 15.2. Incident: Outbox backlog

```text
Queue publish errors · publisher Worker errors → D1 error/latency
→ stale lease (`publishing` quá claim lease timeout — §4.1)
→ reconcile `pending`/`failed` (§4.2) → monitor backlog
```

### 15.3. Incident: Invalid credential

```text
xác nhận spike 401/403 theo `provider_id` · `app` → disable provider nếu systemic
→ rotate credential (§7.2) → verify configuration → test delivery (§6.4) → monitor recovery
```

Không ghi credential mới vào log. Sau khi credential mới active, delivery đang failed vì `401/403` không tự replay (§5).

### 15.4. Incident: Provider outage

```text
xác nhận outage · `provider_id` · affected `app`/`transport` → queue backlog · delivery failure rate · 429/5xx · consumer errors
→ không tăng concurrency vô hạn — bounded retry (§16) → monitor backlog
→ verify outage đã hết → test delivery (§6.4) → enable lại provider nếu đã disable → monitor recovery
```

Không replay toàn bộ DLQ nếu root cause chưa sửa.

### 15.5. Incident: DLQ growth

```text
lấy sample message · kiểm tra failure type → provider · subscription state → phân loại systemic / per-message
→ sửa root cause → test một message → replay theo batch nhỏ → monitor
```

Không replay toàn bộ DLQ khi chưa biết nguyên nhân (§14).

### 15.6. Incident: Duplicate delivery

```text
tìm `notification_id` · `delivery_id` → Queue delivery count · idempotency state → worker acknowledgement · retry behavior
```

Duplicate do Queue redelivery + missing idempotency → sửa ở **consumer**; không giảm Queue retry để "chữa" duplicate mà bỏ qua idempotency.

### 15.7. Incident: Emergency provider hold/revoke (khẩn cấp)

```text
xác nhận sự cố (credential compromise · provider bị xâm phạm) · `provider_id` · affected `app`/`transport`
→ emergency hold provider (§6.5) → audit `provider_held` → kiểm tra delivery đã materialize chưa bắt đầu (claim trả `ineligible_provider_hold`)
→ revoke/rotate credential (§7.2) → kiểm tra request đang in-flight (giới hạn thực tế)
→ bỏ hold khi an toàn → audit `provider_released` → test delivery (§6.4) → monitor
```

- Hold **chặn delivery chưa bắt đầu**; **KHÔNG** recall được request provider đã accept. Yêu cầu explicit confirmation (§14).
- Không tự động reroute sang provider khác (`01-architecture.md` §5.3).

### 15.8. Incident: Delivery non-terminal quá hạn (logical delivery reconciliation)

```text
delivery ở `pending`/`queued`/`processing` lâu hơn ngưỡng (`processing` chỉ khi `lease_expires_at <= now`)
→ tra decision table §4.2 để chọn đúng nhánh (a1–a6); không suy diễn hành động từ state một mình
→ kiểm tra outbox record cùng `delivery_id` · job record trong D1 `push-job` · Queue còn message không
→ a1: đã vượt `expires_at` → đánh dấu `expired` (terminal, KHÔNG re-dispatch, KHÔNG tạo intent)
→ a2/a3: còn `pending` → KHÔNG re-dispatch; còn outbox `pending`/`publishing` → việc của (a);
   outbox `failed`/không còn record → alert (§11) + operator `POST /admin/v1/deliveries/:id/republish` (§4.3)
→ a4/a5: `queued`/`processing` chưa vượt `expires_at` → (c) tạo outbox intent MỚI cùng `delivery_id` → publish lại (§4.2) → monitor
→ a6: delivery terminal → không đụng vào
```

- **`pending` không có outbox record khả dụng (a3) là nhánh duy nhất cần operator, và nó có SLA.** Delivery đó **MUST** được phát hiện và alert trong vòng SLA cấu hình (§11, `outbox_recovery_sla`) kể từ khi vượt ngưỡng tuổi; **không** có delivery nào nằm ở `pending` vô thời hạn mà không có alert. Nếu operator không hành động, delivery vẫn bị chặn trên bởi `expires_at` và (a1) sẽ đánh dấu `expired` — hệ thống **không** im lặng để delivery treo vĩnh viễn, nhưng cái giá là notification **không** được gửi; vì vậy alert a3 phải hành động được trong cửa sổ trước `expires_at`.
- Đánh dấu `expired` là việc **của control plane**, không có reaper nào khác làm (`01-architecture.md` §5.6); worker chỉ nhận `409 expired` từ claim và ACK an toàn, **không** ghi state.

- Nhắc lại: **`outbox.status='published'` KHÔNG chứng minh consumer đã xử lý**, và **D1 `push-job` KHÔNG phải nguồn phát hiện duy nhất** — message chưa từng consume thì không có job record. Đó là lý do (c) quét D1 `push` (§4.2).
- **MUST NOT** tạo notification/delivery/`delivery_id` mới; **không** tạo intent mới nếu đã có outbox record `pending`/`publishing` cùng `delivery_id`.
- Delivery terminal → **không** đụng vào; `failed` chỉ hồi phục qua administrative recovery (§4.3).
- Hai lượt quét (c) chạy **đồng thời** là an toàn và **MUST** được giả định là xảy ra: ràng buộc partial unique index (§8) làm lời gọi tạo intent thứ hai bị từ chối; reconciler thua bỏ qua, **không** alert. Reconciliation **MUST** idempotent theo `delivery_id`.

## 16. Backpressure và capacity

Khi downstream provider chậm: `provider latency ↑ → worker processing time ↑ → queue backlog ↑`. **`max concurrency` là bounded**, không phải "tăng tới khi hết backlog". Thứ tự xử lý backpressure:

```text
1. xác định bottleneck: provider rate limit · provider latency · database latency · network · Worker CPU/memory
2. tôn trọng `Retry-After` khi provider trả 429
3. chỉ tăng concurrency khi bottleneck KHÔNG phải provider
```

Provider throttling → **giảm** effective concurrency, **không** tăng. Trần concurrency theo platform limit là **250** invocation (`docs/architecture/04-platform-facts.md` QU6) — **cùng một trần** với phía consumer (`docs/applications/web-push-notification-job/03-operations.md` §18), **không** hai số khác nhau; policy capacity phía consumer → §18 (và §14.8 cho 429).

**Capacity** đánh giá theo: `notifications/second` · `deliveries/second` · average payload size · provider latency · provider rate limit · queue backlog. **Không** lấy `notifications/second` làm throughput duy nhất — metric quan trọng hơn là `deliveries/second`.

## 17. Operational invariants

1. Không có delivery tới `disabled` subscription; không có delivery qua `disabled` provider cho routing mới.
2. Không có Queue message, log, audit record hay DLQ payload chứa secret/credential.
3. Một `delivery_id` chỉ đại diện cho một logical delivery; duplicate Queue message không tạo duplicate logical delivery.
4. Provider failure không làm mất delivery metadata; outbox record recoverable tới khi publish thành công; record `failed` không xóa tự động.
5. DLQ luôn được cấu hình trong production; không replay DLQ trước khi xác định nguyên nhân failure.
6. Không tăng consumer concurrency vô hạn để xử lý provider throttling.
7. Credential rotation không yêu cầu downtime; production và staging không dùng chung Queue hoặc provider credential; môi trường chỉ dùng Service Binding (gồm production) đặt `workers_dev: false` để private delivery runtime API không reachable từ Internet (§2, §9.1).
8. Mọi administrative mutation quan trọng đều được audit.
9. Worker (delivery plane) không thực hiện rerouting; disable provider không implicit cancel/reroute delivery đã materialize.
10. Queue contract có version và migrate theo backward-compatible strategy (§9.2).
11. `App` và `Transport` phải có trong mọi operational metric và trace cần thiết.
12. Preview **MUST NOT** produce vào queue production; nhiều `App` dùng chung queue `ecoma-push-delivery`, phân biệt bằng `transport` + `provider_id` trong envelope — `app` lấy từ delivery material (§2, §3 · `01-architecture.md` §6.3).
13. Payload materialize tại control plane và **immutable trong Queue**; private delivery runtime API **không** trả routing decision mới (`01-architecture.md` §6.3, §8.1).
14. D1 `push` ngoài Backup/DR scope; mất D1 đã được chấp nhận — recovery ở mức service, không restore data (§8, §12).
15. API idempotency của `POST /v1/notifications` scope theo `(app, principal_id, idempotency_key)` với `Idempotency-Key` **bắt buộc**; `delivery_id` không phải API idempotency key (`02-requirements.md` FR-008).
16. `disable` provider **chỉ** dừng routing delivery mới và **không** làm delivery đã materialize trở nên ineligible; điều kiện ineligible **duy nhất** ở mức provider là **emergency hold/revoke**, có audit `provider_held`/`provider_released` và yêu cầu administrative authorization (§6.3, §6.5).
17. **Mọi `Push Notification` đã accept có đường recovery xác định.** Với mỗi delivery non-terminal, tồn tại **đúng một** hành động theo decision table §4.2 (a1–a6) hoặc một failure mode **được phát hiện + alert** trong SLA (§11) — **không** có delivery treo vô thời hạn không alert, không runbook. `expires_at` là chặn trên đảm bảo điều này.
18. **`outbox.status = 'published'` KHÔNG phải bằng chứng consumer đã xử lý** — vì vậy (c) quét D1 `push`, và recovery **MUST NOT** đòi hỏi một job record nào tồn tại (§4.2).
19. **Reconciliation MUST NOT** chuyển một delivery terminal → non-terminal; recovery chỉ tạo publish intent hoặc đánh dấu `expired`, và mọi transition của nó có guard + owner (§4.2, `01-architecture.md` §5.6.3).
20. **Tối đa một outbox record đang chờ publish cho mỗi `delivery_id`**, enforce bằng partial unique index ở D1 (§8) — guard chống hai reconciler/operator đồng thời tạo intent trùng.
21. **`claim` là operation duy nhất cấp quyền thực thi**, và là operation duy nhất trả delivery material/credential; không có `GET` (`01-architecture.md` §8.1).
22. **Claim là guarded conditional write**, correctness dựa trên predicate trong statement và số dòng thực sự thay đổi — **không** dựa vào row-level locking hay isolation level (D1 không tài liệu hoá; `04-platform-facts.md` DB11).
