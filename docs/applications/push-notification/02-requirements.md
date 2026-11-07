# Yêu cầu dịch vụ Push Notification

> **Phạm vi:** functional/non-functional/security requirements, API capabilities, scope và non-goals của `push-notification`. Design/boundary/invariants → [`01-architecture.md`](./01-architecture.md) · vận hành → [`03-operations.md`](./03-operations.md). Viết tắt: MUST/MUST NOT là yêu cầu bắt buộc.

---

## 1. Mục đích

Định nghĩa yêu cầu của `push-notification`: quản lý `Device`, `Push Subscription`, `Push Provider`; tiếp nhận notification intent; thực hiện `Push Routing`; tạo `Push Delivery`; đưa delivery vào Cloudflare Queue; cung cấp internal API cho application và `Admin API` cho `Backoffice`. Kiến trúc phải cho phép bổ sung `App Push` mà không phá vỡ notification contract hiện tại (NFR-010).

---

## 2. Scope và non-goals

### 2.1. Phạm vi phiên bản đầu

```text
Apps        backoffice · llm-seller · llm-console
Transport   web
Provider    web-push
Delivery    web-push-notification-job
```

### 2.2. Non-goals

Phiên bản đầu **chưa bắt buộc** triển khai: `Transport = app`; `Provider = fcm`/`apns`; `app-push-notification-job` — nhưng data model/API contract/routing model **MUST NOT** ngăn cản việc bổ sung (NFR-010).

Ngoài scope (không triển khai): email notification, SMS, in-app notification inbox, notification template engine, campaign management, scheduled notification, marketing analytics, multi-channel orchestration.

---

## 3. Functional Requirements

### FR-001 — Application Isolation

Service **MUST** hỗ trợ nhiều `App`. Mọi `Push Subscription` **MUST** thuộc về đúng một `App`; mọi `Push Notification Request` **MUST** xác định `App`; application không được truy cập namespace của application khác nếu không có authorization phù hợp.

### FR-002 — Device Management

Service **MUST** quản lý `Device` dưới một `User`; `Device` **MUST** có unique identifier; một `Device` có thể có nhiều `Push Subscription`. Device identity **MUST NOT** suy luận bằng IP hoặc User-Agent.

### FR-003 — Push Subscription Registration

Service **MUST** cung cấp API để đăng ký `Push Subscription`. Với `Web Push`, subscription **MUST** lưu đủ dữ liệu để delivery worker thực hiện `Web Push`. Register/update/disable subscription hoạt động; tránh tạo subscription trùng không cần thiết.

**Endpoint validation (canonical).** Service **MUST** validate `endpoint` của subscription khi đăng ký/update, để chống SSRF và chống delivery tới host không hợp lệ:

- **MUST** là `https://`.
- **MUST NOT** là URL malformed.
- **MUST NOT** chứa userinfo (`user:pass@`).
- **MUST NOT** là IP literal, hay host thuộc dải private / reserved / link-local / loopback.
- **MUST** khớp host allowlist của `Browser Push Service` đã biết, **theo ranh giới nhãn** (host khớp chính xác, hoặc suffix có boundary `.`), **MUST NOT** dùng so khớp substring — ví dụ phản diện: allowlist `example.com` **KHÔNG** được khớp bởi `evil-example.com`.
- **Lúc đăng ký/update:** redirect tới host không nằm trong allowlist → **MUST** từ chối; **MUST NOT** follow redirect sang host ngoài allowlist. Lúc **delivery**, worker **không** đi theo **bất kỳ** redirect nào (paragraph dưới) — nghiêm hơn quy tắc allowlist này.

Validation chạy ở control plane khi đăng ký subscription; delivery worker **không** re-validate allowlist (endpoint đã bất biến theo routing decision) và **MUST NOT** đi theo **bất kỳ** redirect nào — mọi response `3xx` là permanent failure của attempt (canonical → `03-operations.md` §5), nên worker **không** cần load allowlist để quyết định: nó không bao giờ đi tiếp sang một host khác, kể cả host trong allowlist.

**Re-validate endpoint đã lưu (canonical).** Control plane **MUST** re-validate `endpoint` đã lưu khi allowlist/policy thay đổi và **theo định kỳ**; endpoint không còn hợp lệ → subscription chuyển `disabled` (không tạo delivery mới). Validation lúc đăng ký **KHÔNG** được coi là an toàn vĩnh viễn (`03-operations.md` §13).

- **Không log full endpoint**; **không** dùng `endpoint` làm label metric (high-cardinality) — dùng `provider_id`/`transport`/`app` (`03-operations.md` §10.2).
- **Rủi ro còn lại:** host trong allowlist vẫn có thể resolve về địa chỉ private (**DNS rebinding**) — allowlist do operator kiểm soát và việc không đi theo redirect ngoài allowlist là **giảm thiểu**, **không** triệt để. **KHÔNG** mô tả là đã chống SSRF hoàn hảo.

Chi tiết security boundary (ba loại secret, SSRF residual risk) → `01-architecture.md` §9.

### FR-004 — Subscription Lifecycle

Subscription **MUST** có lifecycle `active`, `disabled`, `expired`. Chỉ `active` đủ điều kiện tạo `Push Delivery`. Service **MUST** hỗ trợ disable khi: user unregister, administrator disable, delivery worker xác định subscription không còn hợp lệ.

### FR-005 — Push Provider Management

Service **MUST** quản lý `Push Provider` (`id`, `type`, `name`, `status`, `configuration`, `credential reference`, `app scope`; status `enabled`/`disabled`). Với mỗi `App` + `Transport`, **chỉ có đúng một active primary provider**. Nếu nhiều provider cùng `App`+`Transport` mà không xác định được primary, routing **MUST** fail safely — **MUST NOT** chọn random, **MUST NOT** chọn theo thứ tự database. Provider **MUST** active và thuộc scope hợp lệ trước khi tạo delivery. `disabled` chỉ dừng **routing delivery mới** — delivery đã materialize giữ nguyên `provider_id` và **tiếp tục** được xử lý; chỉ **emergency hold/revoke** mới làm delivery không eligible (`03-operations.md` §6.3, §6.5).

### FR-006 — Provider Credential Management

Credential **MUST** được bảo vệ khi lưu trữ, **không lưu plaintext trong Cloudflare D1**; **MUST NOT** xuất hiện trong API response, Queue message, application log, audit log không được bảo vệ. **MUST** ghi `credential_encryption_version` khi lưu; hỗ trợ encryption key rotation; hỗ trợ credential rotation. Rotation không yêu cầu thay đổi `Push Subscription`.

**Ba loại secret MUST được phân biệt** (boundary → `01-architecture.md` §9):

1. **Provider credential** (VAPID private key của `web-push`; `fcm`/`apns` key tương lai) — provider credential **theo `App`**, mã hoá at rest bằng root key, có `credential_encryption_version`.
2. **Subscription delivery secret** (`auth`, `p256dh`) — dữ liệu protocol của **một** subscription, **không** phải provider credential, nhưng **MUST NOT** vào log/Queue dưới dạng thô ngoài payload cần thiết.
3. **Root encryption key** — `Cloudflare Worker Secret`, **không** nằm trong D1 `push`/Git/`wrangler` `vars`.

Ba secret có **vòng đời TÁCH BIỆT**, không đánh đồng: VAPID key pair gắn định danh `vapid_key_id`, xoay theo **key version** (procedure → `03-operations.md` §7.2); `auth`/`p256dh` chỉ chấm dứt khi subscription bị invalidate (provider chứng minh) hoặc client đăng ký lại; root key xoay multi-key **`K1 → K2`** (procedure → `03-operations.md` §7.3). **VAPID rotation KHÔNG phải root-key rotation** — xoay root key reencrypt credential at rest nhưng **không** đổi key pair VAPID. `Push Subscription` **MUST** lưu `vapid_key_id` dùng lúc tạo; worker ký bằng key theo `vapid_key_id` **của subscription**, **không** phải "key hiện tại của `App`" (`docs/architecture/04-platform-facts.md` §2.15).

**Multi-key rotation `K1 → K2`** (procedure canonical → `03-operations.md` §7.3): root key rotation dùng nhiều key cùng lúc (read `K1`+`K2`, write `K2`, reencrypt background idempotent), **MUST NOT** retire `K1` khi còn record `credential_encryption_version = K1`.

### FR-007 — Provider Scope per App

Provider configuration **MUST** hỗ trợ scope theo `App`. Thay đổi provider của một `App` không ảnh hưởng `App` khác. Không có ambiguity giữa hai provider cho cùng `App` + `Transport` trong v1.

### FR-008 — Notification Creation

Service **MUST** cung cấp API tạo `Push Notification`. Request tối thiểu: `app`, `recipient` (`user_id` hoặc nhiều `user_id`), `notification` (`title`, `body`, `url`, `data`). Caller **MUST NOT** cần biết `transport`/`provider`/`subscription`. `app` **MUST** derive từ authenticated principal; không khớp → từ chối.

**API idempotency (canonical).** `POST /v1/notifications` **MUST** nhận `Idempotency-Key` do caller cấp; key **bắt buộc**, **MUST** ≤ 128 ký tự. Scope là **`(app, principal_id, idempotency_key)`** — `app` + authenticated principal + key; `principal_id` là **định danh ổn định của caller đã xác thực**, **không** phải giá trị header tự khai (precedent cho `Idempotency-Key` bắt buộc và replay semantics: `docs/applications/transactional-mail/02-requirements.md` FR-002; scope ở đây **rộng hơn** precedent, vì thêm `principal_id`):

- Thiếu `Idempotency-Key`, hoặc vượt 128 ký tự → `400`.
- Tạo mới → `201`.
- Replay cùng key **và cùng canonical request hash** → `200`, trả về **cùng** `notification_id`, **MUST NOT** tạo `Push Notification`/`Push Delivery` mới.
- Cùng key **và request hash khác** → `409 Conflict` (không trả `notification_id` của lần trước).
- Ràng buộc ở database: `UNIQUE (app, principal_id, idempotency_key)` trên bảng idempotency record (`notification_idempotency` — inventory D1 `push` ở `03-operations.md` §8) — hai caller khác nhau dùng cùng key **không** dedupe lẫn nhau, và một caller **không** chiếm được key của caller khác.
- **Đua đồng thời:** hai request cùng key tới đồng thời → unique constraint bảo đảm **chỉ một** `Push Notification` được tạo; request còn lại trả kết quả idempotent (hoặc `409` nếu hash khác). Idempotency record **MUST** được ghi trong **cùng** `db.batch()` với `Notification`/`Delivery`/outbox (FR-013) — **không** có cửa sổ tạo notification mà thiếu record idempotency.
- **Retention của idempotency record (canonical — F4).**

  **Owner.** Giá trị retention do **service owner của `push-notification`** chốt, cùng **business owner của API contract** (vì nó là cam kết công bố cho caller); giá trị số cụ thể là **launch gate production** (`docs/architecture/03-operations.md` §10), **KHÔNG** phải một lựa chọn của implementation. Implementation **MUST NOT** tự chọn/khởi tạo một giá trị retention tuỳ ý — tham số có tên **bắt buộc** là `idempotency_retention`, và nếu chưa được cấu hình thì service **MUST** fail closed (từ chối khởi động hoặc từ chối `POST /v1/notifications`) thay vì mặc định ngầm.

  **Chặn dưới suy ra được (không phải con số tự nghĩ).** Retention **MUST** ≥ **cả hai** đại lượng sau, và vì vậy nó bị chặn dưới bởi cấu hình đã có khác, không phải bởi phán đoán:

  1. **`caller_retry_window`** — cửa sổ retry mà contract **công bố** cho caller. Đây là cam kết với caller: trong cửa sổ đó, replay **MUST** trả kết quả idempotent. Giá trị này là **launch gate** cùng chỗ với `idempotency_retention`.
  2. **`max_notification_ttl` + `queue_retention` + `delivery_reconciliation_age`** — chặn trên thời điểm delivery **cuối cùng** của một notification trở thành terminal: mỗi notification có `expires_at` (FR-008 **Expiry**), nên mọi delivery của nó bị chặn trên bởi `expires_at`; cộng thêm thời gian message có thể còn nằm trong Queue (`queue_retention` — `docs/architecture/04-platform-facts.md` QU5) và thời gian logical delivery reconciliation phát hiện + đánh dấu `expired` (`03-operations.md` §4.2 (c)). Sau mốc đó **không** delivery nào còn non-terminal, nên không còn lý do correctness nào để giữ record.

  **Điều kiện xoá an toàn (MUST đủ cả ba).** Cleanup **CHỈ** được xoá một idempotency record khi đồng thời: (i) **mọi** `Push Delivery` của notification đó đã **terminal** (`delivered`/`failed`/`expired`/`cancelled`); (ii) **không** còn outbox record `pending`/`publishing` nào cho **bất kỳ** delivery nào của notification đó; (iii) `now > created_at + idempotency_retention`. Thiếu bất kỳ điều kiện nào → **giữ**. Xoá sớm biến replay hợp lệ của caller thành tạo notification **trùng** — đây là ràng buộc correctness, không phải dọn dẹp (`03-operations.md` §13). Record của notification có nhiều delivery chỉ được xoá khi **tất cả** delivery terminal (không xoá theo từng delivery).

  **Quan hệ với Queue retention và job reconciliation.** Retention của Queue **ngắn hơn** retention của idempotency record là đúng và mong đợi: message có thể biến mất sau `queue_retention` trong khi việc gửi vẫn còn đường phục hồi qua reconciliation (outbox re-dispatch hoặc (c) — `03-operations.md` §4.2). Vì vậy **MUST NOT** dùng `queue_retention` làm retention của idempotency record, và **MUST NOT** coi "message đã hết retention" là lý do xoá sớm record. Job record trong D1 `push-job` **cũng không** phải điều kiện: một delivery có thể chưa từng được consume nên **không** có job record (điều kiện (ii) nói về outbox record, không phải job record).

  **Cùng key trong cửa sổ (bao gồm khi notification đã terminal).** Replay cùng key + cùng canonical request hash **MUST** trả `200` cùng `notification_id`, **kể cả** khi notification/delivery đã **terminal** hoặc `expired`: replay là truy vấn kết quả của một request đã được accept, **không** phải một lần gửi mới — **MUST NOT** tạo notification/delivery mới và **MUST NOT** hồi sinh một delivery terminal. Cùng key + hash khác trong cửa sổ → `409 Conflict` (không trả `notification_id`) như trên. **Không** có ngoại lệ nào cho phép replay "gửi lại" một notification đã terminal; muốn gửi lại thì caller tạo notification mới với key mới (hoặc administrative recovery ở tầng delivery — `03-operations.md` §4.3).

  **Xử lý duplicate nghiệp vụ sau khi xoá record.** Khi record đã bị xoá hợp lệ (`now > created_at + idempotency_retention`), cùng key được coi là **key mới** → `201` và một `notification_id` **mới**. Hệ quả đã chấp nhận: nếu caller retry **sau** khi record đã bị xoá hợp lệ cho một request **đã** được gửi thành công, hệ thống tạo notification **thứ hai** — đây là duplicate thật ở tầng nghiệp vụ (khác với duplicate Queue message, vốn vô hại vì bị atomic claim chặn). `caller_retry_window` **MUST** ≥ khoảng thời gian mà caller thực sự có thể retry; chọn nhỏ hơn là lỗi contract, không phải lỗi vận hành. `idempotency_retention` **MUST** đủ lớn để bao phủ tối thiểu khoảng retry hợp lý của caller cộng với thời gian phục hồi trước khi có thể xoá record hợp lệ.

- `delivery_id` **MUST NOT** được dùng làm API idempotency key — nó là logical delivery identity ở tầng Queue (`01-architecture.md` §7).

**Expiry.** Mỗi notification **MUST** có `expires_at` — hạn **nghiệp vụ** của ecoma, **phân biệt** với Web Push transport `TTL` (khoảng push service giữ message hộ — fact → `docs/architecture/04-platform-facts.md` §2.15). Delivery `pending`/`queued`/`processing` vượt `expires_at` chuyển `expired` (terminal, **không** gửi) — `01-architecture.md` §5.6, FR-015.

**Payload budget.** Web Push giới hạn **body đã mã hoá** ở mức **4096 octets** (push service **không bắt buộc** hỗ trợ hơn — fact → `docs/architecture/04-platform-facts.md` §2.15 WP5). Vì AES128GCM thêm overhead cố định (86 octets header + ≥ 1 octet padding + 16 octets AEAD tag = **103 octets**), trần **plaintext** thực tế là **3993 octets**.

- Ngân sách **MUST** được áp trên **serialized plaintext của `payload`** mà delivery worker sẽ gửi (canonical serialization do contract `version` quy định — FR-013), và **MUST** ≤ **3993 octets** để body mã hoá luôn ≤ 4096 octets.
- Request vượt ngân sách **MUST** bị reject ở API (trong `validate → persist → route → enqueue`), **MUST NOT** cắt payload âm thầm, **MUST NOT** persist rồi mới fail ở delivery time.
- Ngưỡng khuyến nghị: giữ `payload` ≤ **3 KB** plaintext để chừa biên an toàn và tránh mọi khác biệt encoding giữa các runtime.
- Trần 4096 octets của Web Push nhỏ hơn rất nhiều trần message **128 KB** của Queue (`docs/architecture/04-platform-facts.md` QU6) — envelope Queue **không** phải nơi giới hạn payload; giới hạn thật nằm ở Web Push.
- Payload **MUST NOT** chứa credential, token hay PII ngoài phạm vi hiển thị; `data` là opaque với worker (FR-013).

**Fan-out limit.** Request fan-out tới nhiều `user_id` **MUST** có trần số recipient mỗi request; vượt trần → reject kèm lý do, **MUST NOT** cắt recipient âm thầm.

### FR-009 — Routing

Routing **MUST** hoàn tất trước khi enqueue delivery (resolve → filter → policy → transport → provider → create → enqueue). Delivery worker **MUST NOT** thực hiện lại routing. Mọi delivery trong Queue **MUST** trỏ tới một subscription cụ thể và chứa `transport`, `provider_id`, `subscription_id`.

### FR-010 — Transport Priority

Mặc định `app > web`: `Device` có cả subscription hợp lệ thì chỉ tạo delivery cho `App Push`; nếu `App Push` không tồn tại/không eligible thì dùng `Web Push`. Priority **chỉ** áp dụng giữa subscriptions thuộc cùng một logical `Device`; **MUST NOT** áp dụng giữa hai `Device` khác nhau của cùng `User`.

### FR-011 — Device Association

Service **MUST** chỉ áp dụng priority giữa các subscription thuộc cùng một logical `Device`. **MUST NOT** coi hai subscription cùng `User` là cùng `Device`. **MUST NOT** dùng IP, User-Agent, network, browser name để xác định device equality.

### FR-012 — Push Delivery Creation

Mỗi delivery **MUST** có unique `delivery_id`. Delivery **MUST** lưu tối thiểu: `delivery_id`, `notification_id`, `user_id`, `device_id`, `subscription_id`, `app`, `transport`, `provider_id`, `status`, `created_at`. Một notification có zero, one hoặc nhiều deliveries.

Delivery **MUST** được tạo với `status = 'pending'` — routing xảy ra trước khi enqueue, nên lúc commit **chưa** có message nào trong Queue. Delivery chỉ trở thành `queued` khi `Outbox Publisher` publish thành công (`Queue.send()` trả về), trong **cùng** thao tác ghi với việc mark outbox record `published` (`01-architecture.md` §6.2 — actor duy nhất của `pending → queued`).

### FR-013 — Queue Publishing và Outbox

`Notification`, `Delivery`, `Outbox Entry` (và idempotency record — FR-008) **MUST** persist trong cùng một D1 transaction — cụ thể là cùng một `db.batch()` (`docs/architecture/04-platform-facts.md` DB2); **MUST NOT** dựa vào `BEGIN`/`COMMIT`/isolation level vì chưa xác minh (`docs/architecture/01-architecture.md` §10). D1 commit và Queue publish **MUST NOT** coi là atomic — publish bởi `Outbox Publisher` sau commit; duplicate publish phải được chấp nhận.

**Queue envelope — nguồn sự thật duy nhất.** Payload **MUST** được materialize tại control plane trong transaction đã commit và là **nguồn sự thật duy nhất** của nội dung gửi; payload **immutable trong Queue**. Envelope **MUST** chứa đúng 7 field: `version` · `delivery_id` · `notification_id` · `subscription_id` · `provider_id` · `transport` · `payload`. Envelope **MUST NOT** chứa `auth`, `p256dh`, VAPID private key, provider secret, authorization header hay bất kỳ protocol credential nào. `payload` **chỉ** chứa nội dung hiển thị của ứng dụng (`title`, `body`, `url`, `data`); `data` là opaque với worker. `version` bao phủ **cả** schema payload → đường nâng cấp payload.

**Kiểu và giá trị của `version` (canonical — machine-readable, để cả hai plane dùng chung một định nghĩa).** `version` là **số nguyên** biểu diễn schema version của envelope, **không** phải chuỗi, **không** mang tiền tố. Envelope hiện tại là **`version = 1`** — giá trị duy nhất hợp lệ trong v1; mọi giá trị khác (kể cả `"1"`, `"v1"`, `2`, `0`, `1.5`) là **envelope sai contract** và consumer **MUST** từ chối an toàn (không gọi provider, không ACK mù). Lưu ý wire format: sau `JSON.parse`, số `1.0` **không phân biệt được** với `1` (cùng một số IEEE 754), nên validator **không thể** từ chối `1.0` — nó là `version = 1`, không phải một giá trị khác. Tài liệu này ghi rõ để không có test/caller nào cố chứng minh điều không thể đạt được. Hằng số chuẩn: `DELIVERY_COMMAND_VERSION = 1`. Bổ sung version mới là quyết định phase sau (cần schema, consumer support và migration riêng) — **KHÔNG** suy ra từ tài liệu này rằng version > 1 đã tồn tại.

**Trường bắt buộc / được phép của `payload` (canonical — đóng).** `payload` là object JSON với **đúng bốn khoá được phép**: `title`, `body`, `url`, `data`; **khoá ngoài bốn khoá này MUST NOT** có mặt trong payload. `title` và `body` là **bắt buộc** (nội dung hiển thị cốt lõi: một notification không có `title`/`body` không có gì để hiển thị và **MUST** bị reject). `url` và `data` là **tuỳ chọn**. `title`/`body`/`url` là **string**; `url` khi có mặt **MUST** là string (giá trị deep link do application cấp — control plane **không** phải nơi validate scheme ở v1, nhưng **MUST NOT** suy diễn/ghép URL). `data` khi có mặt **MUST** là **object JSON không phải mảng** (opaque với worker: worker **MUST NOT** đọc, sửa hay diễn giải nội dung `data`; validator chỉ kiểm nó là object). Payload **MUST NOT** là mảng, chuỗi, số hay `null`.

**Mọi giá trị trong `payload` (kể cả lồng bên trong `data`) MUST tương thích JSON (canonical — đóng).** Vì canonical serialization bên dưới là nguồn duy nhất để tính ngân sách byte (FR-008), một giá trị mà JSON không biểu diễn được **MUST** bị reject chứ **MUST NOT** được chuẩn hoá âm thầm: `undefined`, `function`, `symbol`, `BigInt`, số không hữu hạn (`NaN`/`Infinity`), tham chiếu vòng (circular reference), object có prototype không phải JSON (`Date`, `Map`, `Set`, class instance, object có prototype tuỳ biến), getter/setter, field non-enumerable và mảng sparse đều **MUST** bị từ chối. Lý do: `JSON.stringify` bỏ qua `undefined`/function/symbol và biến `Date` thành string một cách **im lặng** — chấp nhận chúng nghĩa là ngân sách byte và nội dung gửi đi khác với thứ control plane đã validate. Object JSON với prototype `null` được chấp nhận (JSON data không cần `Object.prototype`); tham chiếu chia sẻ tới cùng một object không-vòng là hợp lệ (chỉ vòng mới bị từ chối). "Opaque với worker" chỉ nói worker **không diễn giải nội dung** `data`, **không** miễn cho `data` khỏi các luật JSON này.

Envelope là **closed schema**: consumer **MUST NOT** bỏ qua âm thầm một field lạ. Policy unknown-field (canonical, áp cho **cả** envelope lẫn `payload`): **reject** — một envelope mang field ngoài bảy field, hay một payload mang khoá ngoài bốn khoá, là **sai contract** và consumer **MUST** từ chối (không gọi provider). Lý do chọn reject thay vì bỏ qua: một field lạ trên envelope có thể là bằng chứng một plane khác đang hiểu contract khác → lỗi im lặng ở đây làm hỏng đúng lớp bảo vệ mà contract tồn tại để cung cấp.

**Policy object JSON (canonical — thống nhất cho mọi object của contract).** Mọi object mà contract định nghĩa (envelope, `payload`, `subscription`, `provider`, request/response body) **MUST** là **plain object JSON**: prototype là `Object.prototype` hoặc `null`. Field **MUST** là **own data property, enumerable**: field kế thừa từ prototype, getter/setter, field non-enumerable và symbol key **MUST** bị từ chối. Field bị cấm (secret/runtime material) **MUST** được kiểm **trước** field thiếu, và field ngoài contract **MUST** được kiểm **trước** field thiếu — một field sai không bao giờ được báo nhầm thành "thiếu". `detail` của lỗi **MUST** chỉ nêu **tên** field (đã lọc ký tự điều khiển và giới hạn độ dài) hoặc hằng số; **MUST NOT** nối **giá trị** của field vào thông báo, vì `detail` có thể bị log.

Delivery worker **MUST NOT** đọc lại payload từ private runtime API để thay thế payload của message (chỉ dùng để xác thực/đối chiếu). Private delivery runtime API **MUST NOT** trả routing decision mới (`01-architecture.md` §6.3, §8.1).

**Canonical serialization của `payload`** — nguồn duy nhất để tính ngân sách byte (FR-008): `payload` được serialize thành **UTF-8 JSON object** của chính bốn field `title`, `body`, `url`, `data`, không thêm whitespace không cần thiết. Worker **MAY** thêm framing do protocol yêu cầu (ví dụ padding của AES128GCM) nhưng **MUST NOT** thêm business data hay field mới vào payload (FR-005 phía delivery plane). Nhờ vậy kích thước body mã hoá là hàm xác định của serialized plaintext: `body ≤ plaintext + 103 octets`.

### FR-014 — Idempotency

Mỗi `delivery_id` đảm bảo **logical delivery identity**, **MUST NOT** diễn giải là exactly-once external provider side effect (`01-architecture.md` §7). Queue consumer **MUST** xử lý duplicate message; duplicate Queue message **MUST NOT** tạo thêm logical delivery. Duplicate external notification trong crash window được chấp nhận.

### FR-015 — Delivery State

Delivery state **MUST** là `pending`, `queued`, `processing`, `delivered`, `failed`, `expired`, `cancelled`. Transition hợp lệ: `pending→queued` (**Outbox Publisher** sau khi `Queue.send()` thành công — `01-architecture.md` §6.2), `queued→processing` (**claim**), `processing→delivered`, `processing→failed`, `pending|queued|processing→expired` (**mọi** state non-terminal), và `processing→queued` (**release lease** — `01-architecture.md` §8.1; đường duy nhất đưa delivery non-terminal trở lại `queued`, không phải kết cục delivery và không phải lần gửi đã hoàn tất). `delivered`, `failed`, `expired`, `cancelled` là **terminal state** — không transition ngược/ra theo đường bình thường; ngoại lệ **duy nhất** là `failed → queued` qua **administrative recovery** (`POST /admin/v1/deliveries/:id/retry` — bullet bên dưới, `01-architecture.md` §5.6.1), không xảy ra trên đường tự động.

**`cancelled` — khai báo nhưng KHÔNG có actor trong v1.** v1 **KHÔNG** có API, permission hay runbook nào đưa một delivery vào `cancelled` (không có cancel ở `Application API` §4.1, `Admin API` §4.2, hay FR-017). State được khai báo để state machine không đóng cứng tương lai, **không** phải hành vi hiện có: delivery v1 kết thúc ở `delivered`, `failed` hoặc `expired`. Delivery plane **MUST NOT** tạo `cancelled`. Thêm cancel là quyết định phase sau (cần operation, authorization và audit riêng) — **KHÔNG** suy ra từ tài liệu này rằng cancel đã tồn tại.

- **Atomic claim.** Transition `queued → processing` là một **atomic claim** (một guarded update trong `db.batch()`, không read-then-write) cấp kèm execution lease (`lease_expires_at`) và fencing token `dispatch_generation` tăng **đơn điệu**. Chỉ **một** execution thắng claim. `outcome`/`release` **MUST** ghi kèm `dispatch_generation`; generation không khớp → **stale write** bị từ chối (`409 stale_write`), state không đổi. Lease hết hạn → delivery **claimable lại** cho Queue redelivery (takeover, generation mới); lease expiry **không** tự chuyển state (**không** có reaper quét lease), và việc đánh dấu `expired` do control plane làm qua reconciliation. Claim bị từ chối trả `409` kèm `reason`; tập `reason` **đóng** và canonical → `01-architecture.md` §8.1 (delivery plane **MUST** xử lý đủ mọi giá trị, không định nghĩa lại). Semantics đầy đủ → `01-architecture.md` §5.6.
- **Giới hạn của fencing.** Fencing **KHÔNG** loại bỏ duplicate ở **phía provider**: provider đã nhận request rồi worker crash trước khi persist outcome → gửi lại có thể tạo duplicate bên ngoài — **crash window đã chấp nhận** (`01-architecture.md` §7).
- **Administrative recovery (authorized exception).** `failed → queued` **chỉ** đi qua `POST /admin/v1/deliveries/:id/retry` — **không** phải transition bình thường, và `failed` vẫn terminal theo state machine: Queue redelivery **MUST NOT** hồi sinh delivery terminal. Giữ nguyên `delivery_id` (**MUST NOT** tạo notification/delivery mới), outbox intent mới, **generation mới** (execution cũ không ghi đè được); yêu cầu administrative authorization + `reason` + `actor` + audit `delivery_retried` (FR-017, FR-020). **Tiền điều kiện** (không thoả → từ chối kèm lý do): delivery `failed`; subscription `active`; provider không **emergency hold**; notification chưa quá `expires_at`. Recovery **có thể** tạo duplicate bên ngoài khi provider đã nhận request mà outcome cũ không xác định — **KHÔNG** mô tả là an toàn tuyệt đối (`03-operations.md` §4.3, §15).
- **Release lease.** `processing → queued` qua operation `release` của private delivery runtime API (`01-architecture.md` §8.1) — worker gọi **trước** khi trả `retry()` cho Queue (`docs/applications/web-push-notification-job/01-architecture.md` §12): `status := 'queued'`, lease xoá, `dispatch_generation` **không đổi** (generation mới chỉ sinh ở lần claim kế tiếp). `release` **KHÔNG** phải kết cục delivery và **KHÔNG** ghi `failed`; delivery vẫn phải được gửi lại.
- `pending|queued|processing → expired` áp dụng khi delivery vượt `expires_at` (`expires_at` → FR-008); `expired` là terminal, delivery **không** được gửi. **Control plane** là bên thực hiện transition này, qua **logical delivery reconciliation** (`03-operations.md` §4.2 (c) — điều kiện a1); claim từ chối bằng `409 expired` **không** đổi state, và execution đang giữ lease vẫn ghi được outcome (`01-architecture.md` §5.6). Guard: chỉ khi delivery **vẫn** non-terminal. Không có đường `expired → queued` — muốn gửi lại thì tạo notification mới.

### FR-016 — Invalid Subscription Handling

Khi delivery worker xác định subscription không còn hợp lệ, subscription **MUST** disable/expire. Service **MUST NOT** tạo delivery mới cho subscription đã xác định không hợp lệ.

### FR-017 — Admin API

Service **MUST** cung cấp `Admin API` cho `Backoffice`, hỗ trợ quản lý: `Provider`, `Provider Credential`, `App Provider Mapping`, `Subscription`, `Device`, `Delivery`. Administrator **MUST** có thể: xem configuration, enable/disable provider, rotate credential, emergency hold/revoke provider, inspect/disable subscription, inspect delivery, test delivery. `credential rotation`, `provider enable/disable`, `provider test`, **emergency hold/revoke provider**, **`delivery retry`** (administrative recovery cho delivery terminal `failed` — **không** phải retry tự động, `03-operations.md` §4.3), **`delivery republish`** (operator recovery cho delivery **non-terminal** kẹt ở `pending` — `03-operations.md` §4.3, `01-architecture.md` §5.6.3), và mọi bulk operation yêu cầu **administrative authorization**. `DELETE` là **logical revoke/disable**; physical deletion chỉ theo retention/cleanup policy.

### FR-018 — Provider Test

Test **MUST** gồm configuration test + actual delivery tới target đã authorization. Test result **MUST** phân biệt: `configuration invalid`, `authentication failed`, `provider rejected request`, `subscription invalid`, `delivery accepted`. Test phải có audit record; payload không chứa dữ liệu nhạy cảm không cần thiết.

### FR-019 — Authentication và Authorization

Internal application API và `Admin API` **MUST** có authorization boundary riêng; service không có public API. `app` identity **MUST** derive từ authenticated principal — đối chiếu với body; không khớp → từ chối. Application chỉ được quản lý subscription thuộc scope mình và gửi notification trong scope được cấp quyền. Private delivery runtime API (cho `web-push-notification-job`) xác thực caller theo contract riêng (shared secret + `X-ECOMA-PRINCIPAL`; **bỏ `X-ECOMA-APP`**, header tự khai không phải bằng chứng danh tính; sai → `401` trước lookup) — details → SR-006, `01-architecture.md` §8.1.

### FR-020 — Audit

Thao tác quản trị quan trọng **MUST** được audit — tối thiểu: `provider_created`, `provider_updated`, `provider_enabled`, `provider_disabled`, `provider_held`, `provider_released`, `credential_rotated`, `subscription_disabled`, `subscription_removed`, `notification_created`, `delivery_retried`, `delivery_republished`. Audit record chứa actor và timestamp; secret **MUST NOT** ghi vào audit. Provider test (`POST /admin/v1/providers/:id/test`) ghi audit `provider_updated` với `detail.test_result` (cùng `subscription_id`, `duration_ms` khi có). Administrative recovery (`retry`, `republish`), key rotation, emergency hold/revoke, và bulk operation **MUST** có administrative authorization (FR-017/SR-004) kèm audit record.

### FR-021 — Rate Limiting và Abuse Prevention

API tạo notification **MUST** áp rate limit theo `app` để chống lạm dụng và bảo vệ provider/Queue phía sau. Trần số recipient mỗi request và fan-out limit → FR-008.

- Rate limit **MUST** scope theo `app` (từ authenticated principal), không chỉ theo IP.
- Vượt rate limit → response reject rõ ràng (ví dụ `429`), **MUST NOT** drop âm thầm.
- Bulk operation quản trị (disable nhiều subscription, replay nhiều DLQ message) **MUST** yêu cầu explicit confirmation + audit record đầy đủ — vận hành → `03-operations.md` §14.
- Audit event bắt buộc giữ nguyên danh sách ở FR-020.

---

## 4. API capabilities

### 4.1. Application API

```text
POST   /v1/devices          GET/DELETE /v1/devices/:id
POST   /v1/subscriptions    PATCH/DELETE /v1/subscriptions/:id
POST   /v1/notifications
```

`POST /v1/notifications` **MUST** có header `Idempotency-Key` **bắt buộc** (≤ 128 ký tự, thiếu → `400`; semantics → FR-008) và **MUST** áp rate limit theo `app` (FR-021).

### 4.2. Admin API

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

`POST .../hold` và `POST .../release` là **emergency hold/revoke** (FR-017) — không phải alias của `PATCH .../:id` với `status: disabled`; `hold`/`release` ghi audit `provider_held`/`provider_released` (FR-020) và yêu cầu administrative authorization. Semantics và runbook → `03-operations.md` §6.5, §15.7.

`POST /admin/v1/deliveries/:id/republish` là **operator recovery cho delivery non-terminal** (chủ yếu `pending`) khi đường tự động đã cạn — **không** đổi state, **không** cấp generation, chỉ tạo một outbox intent mới cho cùng `delivery_id`. Khác `retry` ở chỗ `retry` đòi delivery **terminal `failed`**. Semantics → `03-operations.md` §4.3 · `01-architecture.md` §5.6.3.

### 4.3. Delete semantics

`DELETE subscription` và `DELETE provider` là **logical revoke/disable**. Physical deletion chỉ theo retention/cleanup policy; historical references cần cho audit/delivery history **MUST NOT** xóa trước retention policy cho phép.

---

## 5. Non-Functional Requirements

### NFR-001 — Availability

Failure của một `Push Provider` **MUST NOT** làm unavailable toàn bộ service; failure của một `App` **MUST NOT** làm unavailable các `App` khác; failure của delivery worker **MUST NOT** làm mất notification request đã persist.

### NFR-002 — Asynchronous Delivery

API request **MUST NOT** chờ hoàn thành network delivery tới external provider. Success chỉ xác nhận notification đã accept và delivery đã persist/enqueue theo contract.

### NFR-003 — Retry Safety

Cloudflare Queue at-least-once (`docs/architecture/04-platform-facts.md` QU1) → toàn bộ path **MUST** an toàn với duplicate execution; retry **MUST NOT** tạo duplicate logical delivery.

### NFR-004 — Failure Isolation

Failure của `App`, `Device`, `Subscription`, `Provider`, `Transport`, `Delivery Worker` phải cô lập; failure của một entity **MUST NOT** làm hỏng entity độc lập.

### NFR-005 — Performance

API đồng bộ **MUST** chỉ thực hiện: validate → persist → route → enqueue. **MUST NOT** thực hiện blocking network delivery tới external provider.

### NFR-006 — Scalability

Control plane, queue consumer và database scale độc lập; delivery throughput **MUST NOT** yêu cầu scale API theo cùng tỷ lệ.

### NFR-007 — Observability

Mọi notification và delivery **MUST** có correlation identifiers: `request_id → notification_id → delivery_id → subscription_id → provider_id`. Log **MUST** truy vết được lifecycle, **MUST NOT** chứa secret.

### NFR-008 — Security

Service **MUST** bảo vệ provider credential, Push Subscription credential, authorization boundary, application data, audit data. Secret **MUST** encrypted at rest, **MUST NOT** xuất hiện trong log/Queue/API response.

### NFR-009 — Data Integrity

Quan hệ giữa entities **MUST** được enforce; **MUST NOT** tạo cross-app resource trái phép hoặc invalid references.

### NFR-010 — Evolution (App Push)

Schema và API **MUST** cho phép bổ sung `Transport = app`, `Provider = fcm`/`apns`, `app-push-notification-job` mà không đổi core notification request contract; thêm provider mới **MUST NOT** yêu cầu đổi business service đang tạo notification. `Chrome`/`Firefox`/`Edge` là `Browser Push Service` dưới `web-push` protocol — không phải Provider abstraction.

---

## 6. Security Requirements

### SR-001 — Credential Encryption

Provider credential **MUST** được encrypted at rest.

### SR-002 — Credential Isolation

Credential **MUST** chỉ giải mã được bởi **control plane**; delivery worker **KHÔNG** giữ root key. Credential đã giải mã **MUST** chỉ được trả cho execution **đang giữ lease**, qua kênh private đã xác thực (`01-architecture.md` §8.1).

### SR-003 — Queue Isolation

Queue message **MUST NOT** chứa private credential (`auth`, `p256dh`, VAPID private key, provider secret, authorization header, private key, access token, auth key, subscription secret) hay bất kỳ protocol credential nào (FR-013).

### SR-004 — Administrative Access

`credential rotation`, `provider modification`, `provider deletion`, `emergency hold/revoke provider`, `delivery retry` (administrative recovery), `subscription administration`, và mọi bulk operation **MUST** yêu cầu administrative authorization.

### SR-005 — Secret Redaction

Logging layer **MUST** redact `private key`, `secret`, `access token`, `auth key`, `subscription secret`.

### SR-006 — Private Delivery Runtime API Authorization

Private delivery runtime API **MUST** xác thực caller ở tầng ứng dụng bằng **shared secret** (gửi trong `Authorization`, cấp qua `Cloudflare Worker Secret`) xác thực **server-side**, **trước** mọi lookup/claim. Giữ principal header `X-ECOMA-PRINCIPAL` (giá trị `svc.web-push-notification-job`); **bỏ `X-ECOMA-APP`** — header principal tự khai **KHÔNG** phải bằng chứng danh tính: chỉ được tin sau khi credential đã xác thực, và principal header không khớp credential → `401`. Sai/thiếu credential → `401` **trước** lookup, response **MUST NOT** tiết lộ delivery có tồn tại hay không. Service **MUST NOT** dựa vào "chỉ Service Binding mới gọi được" — **Service Binding KHÔNG phải authorization boundary** — design → `01-architecture.md` §8.1.
