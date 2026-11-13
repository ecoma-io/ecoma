# Yêu cầu kỹ thuật — Transactional Mail (control plane)

> **Phạm vi:** yêu cầu giao thức, interface, runtime constraint, hiệu năng, khả dụng/recovery và non-goals của `transactional-mail`.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · vận hành → [`03-operations.md`](./03-operations.md) · constraint toàn hệ thống → `docs/architecture/` · business semantics → `docs/domains/transactional-mail/domain-model.md` · delivery plane → `docs/applications/transactional-mailer-job/`.

> **Ghi chú đánh số và trạng thái.** Dãy FR/NFR/SR/CR giữ nguyên cách đánh số đã được tham chiếu từ code và từ tài liệu khác (FR-001–FR-007, NFR-001, NFR-003, SR-001, CR-001, CR-002); renumber sẽ phá các tham chiếu đó. Trạng thái release gate (merged contract → implement → xác minh runtime) được ghi canonical duy nhất ở [`01-architecture.md`](./01-architecture.md) §7.4; các câu trạng thái trong tài liệu này giữ nghĩa **điều kiện** của gate, không phải bản ghi trạng thái mới nhất.

Tài liệu này định nghĩa yêu cầu chức năng/phi chức năng, security requirement, constraint và non-goals của `transactional-mail` — control plane tiếp nhận yêu cầu gửi mail, render template, lưu domain state vào D1 `mail` và enqueue delivery qua transactional outbox. Boundary đầy đủ → [`01-architecture.md`](./01-architecture.md) §2.

**Nguồn sự thật của contract là code:** Mail Command `{ version, delivery_id }` ở `@ecoma-io/transactional-mail-contracts` (`libs/transactional-mail-contracts`, `src/mail-command.ts`), shape public `POST /v1/messages` ở `src/public-messages.ts`, shape private delivery interface ở `src/delivery-interface.ts`.

## 1. Functional requirements

### FR-001 — Tạo Mail Message

Service MUST cung cấp `POST /v1/messages` để consumer tạo message. Consumer là ba service `account`, `auth`, `payment` — chúng request mail qua control plane contract, không truy cập D1 `mail` hay Queue trực tiếp.

Request cần: `template`, `recipient`, `locale` (optional), `variables` (optional), `correlation_id` (optional). `app` và `principal_id` lấy từ authenticated principal — **không bao giờ từ body**.

Service MUST trả `201` khi tạo mới, `200` khi replay idempotent (cùng authenticated principal + `Idempotency-Key` + cùng fingerprint).

**Thứ tự kiểm tra là cố định (MUST)** — hai implementation khác nhau ở thứ tự này sẽ trả status khác nhau cho cùng một request, và idempotency sẽ không còn là idempotency:

1. **Authenticate** → thiếu/sai → `401`.
2. **Authorize** principal + permission template/operation → `403`.
3. **Validate shape** của body (`Idempotency-Key` có mặt và ≤ 128 ký tự, `template`/`recipient` có mặt, số/độ dài biến, locale hợp lệ, recipient qua chuẩn hoá ở FR-002) → `400`.
4. **Authorize theo template (SR-001)** — template trong body phải nằm trong allowlist của principal đó → `403` (một message hằng, không phân biệt "template của principal khác" với "chưa approve" — sự phân biệt đó là oracle liệt kê catalog). Bước đứng trước mọi persistence lẫn idempotency lookup: một principal bị revoke template không được tiếp tục nhận `200` replay của request cũ — authorization là điều kiện của từng request.
5. **Rate limit** → `429` + `Retry-After`.
6. **Đọc row idempotent** theo `(principal_id, idempotency_key)`; so fingerprint theo FR-002 → `200` (khớp) hoặc `409` (lệch).
7. **Chọn template version** → không active/không tồn tại → `404`. **Validate `variables` theo `variables_schema_json` của version vừa chọn** (FR-003) → sai → `400`; version đó có schema hỏng → `500`, allowlist host của `format: "url"` chưa cấu hình → `503` (hai cái sau là lỗi server, không phải lỗi request — FR-003). Render vượt ngưỡng → `413`.
8. **Persist** message + outbox trong một `db.batch()`.

Hai điểm phải nói rõ vì chúng dễ bị implement sai:

- **Replay không bao giờ bị rate limit cắt.** Bước 6 đứng **sau** bước 5 ở đây chỉ vì rate limit phải bảo vệ D1 trước khi ghi; nhưng một replay hợp lệ là **không** ghi gì, nên nó **không** được trả `429`: khi `(principal_id, idempotency_key)` đã có row, service phải so fingerprint và trả `200`/`409` **trước** khi áp rate limit. Rate limit chỉ chặn **request tạo mới** (chưa có row) và các probe lệch fingerprint (FR-002, rate limit theo key). Đây là hệ quả của việc idempotency key phải do caller giữ ổn định, không phải một ngoại lệ tuỳ ý.
- **`404` template không được biến thành `409` hay ngược lại.** Template lookup chỉ chạy ở bước 7 — sau khi đã kết luận idempotency — nên một replay của một request **đã tạo thành công** không bao giờ gặp `404` dù template đã bị `disable`/`delete` sau đó: nó trả `200` + kết quả gốc (template version cũ, nội dung render cũ). Ngược lại, một key mới + template không tồn tại trả `404` và **không** ghi gì.

#### Error envelope (canonical)

Mọi lỗi của `POST /v1/messages` trả cùng một shape, kể cả `4xx` không kèm body nghiệp vụ:

```json
{ "error": { "code": "<machine-readable code>", "message": "<human-readable, không chứa PII>" } }
```

`code` là enum đóng, chữ thường, dấu gạch dưới; client **MUST** branch theo `code`, **không** parse `message`. `message` là thông tin cho người đọc log, **không** phải hợp đồng — không bao giờ chứa `recipient`, `variables`, rendered content hay tên template của caller.

| `code`                     | HTTP | Khi nào                                                                                                                                                                                                                                             |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized`             | 401  | Thiếu/sai/malformed authentication (kể cả signature hỏng, timestamp/nonce ngoài cửa sổ freshness).                                                                                                                                                  |
| `forbidden`                | 403  | Đã authenticate nhưng principal không được authorize cho operation/template.                                                                                                                                                                        |
| `invalid_request`          | 400  | Body sai shape: thiếu `Idempotency-Key`, thiếu `template`/`recipient`, quá 128 ký tự, quá ngưỡng biến; hoặc `variables` không hợp lệ với `variables_schema_json` của version đã chọn (FR-003).                                                      |
| `invalid_recipient`        | 400  | `recipient` không qua chuẩn hoá (FR-002): rỗng, control character, không đúng một `@`, phía `@` rỗng.                                                                                                                                               |
| `invalid_locale`           | 400  | `locale` không khớp pattern BCP-47 ngắn sau khi trim/lowercase (FR-002).                                                                                                                                                                            |
| `idempotency_key_conflict` | 409  | Cùng `(principal_id, idempotency_key)` nhưng fingerprint khác — không bao giờ phải `409` vì lý do khác.                                                                                                                                             |
| `rate_limited`             | 429  | Vượt rate limit; kèm header `Retry-After`.                                                                                                                                                                                                          |
| `template_not_found`       | 404  | Template không tồn tại, không có version `active`, hoặc `disabled`.                                                                                                                                                                                 |
| `payload_too_large`        | 413  | Render hoặc request vượt ngưỡng kích thước trước khi ghi.                                                                                                                                                                                           |
| `internal_error`           | 500  | Lỗi nội bộ đã được log/alerts; body không tiết lộ chi tiết.                                                                                                                                                                                         |
| `service_unavailable`      | 503  | Fail-closed: thiếu `k_fingerprint`, key version/profile tag không có trong keyring, D1 không sẵn sàng, hoặc allowlist host của `format: "url"` chưa cấu hình (FR-003), hoặc kho nonce nội bộ không gọi được khi verify (`01-architecture.md` §7.4). |

`401`/`403`/`429`/`503` dùng chung shape này với các endpoint private của service (`01-architecture.md` §7.4) — một client chỉ cần biết một kiểu body lỗi cho cả public lẫn internal API.

#### Ví dụ request/response (canonical)

Ví dụ dưới là **hợp đồng**, không phải minh hoạ: mọi field trong request và response là **bắt buộc** trừ field ghi `optional`. Tên field trong response là canonical; `template` trong response là **tên logical** của template (không phải version).

```text
POST /v1/messages
Headers:
  x-ecoma-internal-timestamp: <epoch giây — 01-architecture.md §7.4>
  x-ecoma-internal-nonce: <UUID v4>
  x-ecoma-internal-signature: v1=<64 hex chữ thường>
  # credential registry phía receiver chưa implement → release-blocked (01-architecture.md §7.4)
  Idempotency-Key: reset-password-u1-2026-10-11
  Content-Type: application/json
Body:
{
  "template": "reset-password",
  "recipient": "  User@Example.COM ",
  "locale": "en",
  "variables": { "otp": "123456", "name": "An" },
  "correlation_id": "01J9Z6Q2H7"
}

→ 201 Created
{
  "id": "msg_01J9Z6Q3AF",
  "delivery_id": "dlv_01J9Z6Q3AF",
  "app": "account",
  "template": "reset-password",
  "template_version": 3,
  "status": "accepted",
  "created": true,
  "created_at": "2026-10-11T08:14:02.117Z"
}

→ 200 OK (replay cùng principal + Idempotency-Key + fingerprint)
{ ...cùng shape..., "created": false }    # template_version và nội dung render là của lần tạo gốc

→ 404 Not Found
{ "error": { "code": "template_not_found", "message": "No active template version for the requested template" } }
```

`created` là boolean phân biệt lần tạo mới với replay; `created_at` là timestamp ISO-8601 UTC của lần tạo **gốc** (không đổi khi replay).

#### Acceptance Criteria

- Request hợp lệ trả `201` kèm `{ id, delivery_id, app, template, template_version, status, created, created_at }`, `created = true`.
- Replay cùng principal + key + fingerprint trả `200` kèm message cũ (`created = false`), không tạo outbox mới, `template_version` và `created_at` là của lần tạo gốc.
- `app` truyền trong body bị bỏ qua; `app`/`principal_id` luôn từ authenticated principal.
- Template không active/không tồn tại trả `404` với `code = template_not_found`.
- Thiếu credential caller → `401` + `code = unauthorized`; caller không có permission → `403` + `code = forbidden`.
- Mọi lỗi trả error envelope ở trên; không lỗi nào trả body rỗng hoặc shape khác.
- Thứ tự kiểm tra đúng như trên; replay của một request đã tạo không bao giờ bị rate limit cắt và không bao giờ gặp `404` template.
- `recipient` và `locale` sai → `400` với `code` tương ứng; response lỗi không chứa giá trị của `recipient`/`variables`/`template` mà caller gửi.

#### Trạng thái contract: đã có type + test, và cái gì còn chưa chốt

Shape của request/response ở FR-001 và error envelope ở trên **đã có code**: `@ecoma-io/transactional-mail-contracts` (`libs/transactional-mail-contracts`, entrypoint `@ecoma-io/transactional-mail-contracts`) — `src/public-messages.ts` với `validatePostMessagesRequest`, `validatePostMessagesResponse`, `isPostMessagesErrorBody` và tập `POST_MESSAGES_ERROR_CODE_VALUES` (đúng 11 code trong bảng trên).

| Phần                                                                                | Schema/type + unit test                                                                                                                       | Vẫn cần implement ở service                                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Shape request (`template`, `recipient`, `locale?`, `variables?`, `correlation_id?`) | ✅ có                                                                                                                                         | Chuẩn hoá `recipient`/`locale` (FR-002), ngưỡng kích thước, `Idempotency-Key` — validator contract **không** kiểm những luật này |
| `app` trong body bị bỏ qua                                                          | ✅ có (accept, **không** validate kiểu và **không** đưa vào request đã validate)                                                              | Resolve `app`/`principal_id` từ authenticated principal                                                                          |
| Shape response 8 trường, field lạ bị chặn                                           | ✅ có                                                                                                                                         | Chọn `template_version`, persist idempotency, phát `201`/`200`                                                                   |
| Error envelope + 11 `code`                                                          | ✅ có                                                                                                                                         | Áp dụng thứ tự kiểm tra ở FR-001 và mapping status code                                                                          |
| `GET /v1/messages/:id` response                                                     | ❌ **chưa có** — contract chưa chốt (`01-architecture.md` §10)                                                                                | Chưa implement; xem SR-002 "Provisional"                                                                                         |
| `POST .../redrive`, `POST /internal/outbox/publish`                                 | ❌ **chưa có** — request/response chưa chốt, quyền operator chưa định nghĩa                                                                   | Chưa implement                                                                                                                   |
| Template name (`template` trên wire)                                                | ✅ có — kiểu **tên logical khác rỗng**, cố ý **không** đóng kín danh sách (catalog là seed, chưa có admin surface — `01-architecture.md` §10) | Authorize principal theo template đã approve (SR-001); quản lý catalog/template version                                          |
| Template variable schema                                                            | ❌ **chưa có code** — format và chỗ đặt **đã chốt** ở FR-003 (`variables_schema_json`, gắn với mỗi template version)                          | `variables` giữ nguyên `Record<string, unknown>` ở tầng contract; validate theo schema là việc của service (FR-003)              |

⚠️ Contract library **không** phải và không nên là nơi chứa luật nghiệp vụ: thứ tự kiểm tra, idempotency fingerprint, rate limit, guard, cũng như **validation `variables` theo `variables_schema_json` của template version** (FR-003) đều thuộc service. Validator contract chỉ khẳng định điều tài liệu đã **chốt** và kiểm được bằng shape; nó không tự đặt luật mới.

---

### FR-002 — Caller Authentication và Idempotency

Service MUST xác thực caller trước khi resolve principal. Caller là Worker-to-Worker qua Service Binding; Service Binding chứng minh caller là Worker trong account, **không** chứng minh caller là service nào. Nếu dùng header `X-ECOMA-PRINCIPAL`/`X-ECOMA-APP` (pattern `svc.<name>`), chúng chỉ là **claim** cần được verify bởi lớp xác thực độc lập; **không được coi là authentication**. Cơ chế authentication là canonical internal HMAC contract **đã merge** (PR #197 → `97b85b9`); phía receiver chưa implement (`01-architecture.md` §7.4) nên vẫn release-blocked theo `01-architecture.md` §7.4/§7.5.

Service MUST phân quyền principal do server kiểm soát: mapping authenticated caller → principal và permissions; request body hoặc unverified header không thể thay đổi principal.

Service MUST dùng `Idempotency-Key` làm idempotency key. Key bắt buộc, ≤ 128 ký tự. Persisted uniqueness scope MUST là `UNIQUE (principal_id, idempotency_key)` — dùng principal do server kiểm soát trực tiếp, **không** dựa trên caller-supplied `app`. Chỉ dùng scope hẹp hơn (ví dụ `(app, idempotency_key)`) nếu canonical identity contract chứng minh được bất biến one-to-one giữa principal và `app`; hiện chưa có bất biến như vậy được xác nhận.

Service MUST persist canonical request fingerprint vào cột `mail_messages.request_fingerprint` (**HMAC-SHA-256 có khoá** — không phải hash trần — của: logical template name, normalized request locale, normalized recipient, validated variables) alongside logical result. **DO NOT** include server-selected template version or `correlation_id` in the fingerprint unless `correlation_id` is explicitly required by the API contract as business-meaningful. Server-selected template version MUST remain immutable for the original result on replay.

Idempotency behavior:

- Fingerprint MUST be computed and compared **before** selecting the current active template version. On replay, when fingerprint matches, the response MUST return the original result and preserve its original template version and rendered content (do not re-render with the currently active template version).
- Same principal + same key + same fingerprint → return original result, không tạo message hay outbox mới.
- Same principal + same key + different fingerprint → `409 Conflict`.
- New key = new logical request.

`account`, `auth`, `payment` MUST generate key stable cho business operation/event tương ứng.

**Chuẩn hoá request trước khi fingerprint (MUST):**

- `template`: tên template logic (không phải numeric id).
- `locale`: locale của request sau **chuẩn hoá `locale`** dưới đây (MUST); khi request không truyền `locale` thì dùng **hằng default locale của service** (một giá trị cấu hình, ví dụ `en`) — không phải giá trị rỗng/không truyền. Trường này được chốt **chỉ từ request + hằng default**, KHÔNG đọc template row; nhờ vậy fingerprint tính được **trước** khi chọn template version như FR-002 yêu cầu, và một replay vẫn chạy được khi template đã bị xoá.
- `recipient`: chuỗi sau hàm **chuẩn hoá recipient** dưới đây (MUST) — dùng **cùng một hàm** cho cả fingerprint và lưu trữ. **KHÔNG** lowercase toàn bộ địa chỉ (§ "Chuẩn hoá `recipient`").
- `variables`: object đã qua **request-shape validation** (FR-001 bước 3 — validate theo schema của template version là bước 7, nằm **sau** khi fingerprint được so), serialize theo **canonical serialization profile** dưới đây (§ "Canonical serialization") — không phải "sort key" chung chung: thứ tự key ở **mọi cấp**, biểu diễn số, `null` vs vắng mặt và encoding đều đã chốt. **Request không truyền `variables` được coi là `{}`** (canonical `2:{}`) — không truyền và `{}` là cùng một request nghiệp vụ "không có biến", giống cách `locale` dùng hằng default; không có ba trạng thái khác nhau cho cùng một ngữ nghĩa.
- **KHÔNG** đưa vào fingerprint: template version do server chọn, `correlation_id` (trừ khi API contract cho nó ý nghĩa nghiệp vụ), bất kỳ metadata tracing nào khác.
- Fingerprint là **HMAC-SHA-256 có khoá** (`k_fingerprint`) của canonical serialization các thành phần trên — **không** phải hash trần, và **không** phải bản sao raw của `variables`.

**Chuẩn hoá `recipient` (MUST) — một hàm duy nhất cho cả fingerprint và lưu trữ.** Hai implementation phải ra **cùng một chuỗi** cho cùng một địa chỉ; vì vậy các bước được chốt, không để tuỳ chọn:

1. **Trim** whitespace hai đầu (space, tab, CR, LF).
2. **Từ chối** (`400`) nếu cả local-part lẫn domain đều rỗng sau trim, hoặc chuỗi không có đúng một `@` (**mỗi phía của `@` phải khác rỗng** — `@example.com` và `user@` đều bị từ chối), hoặc chứa **ASCII control character** (U+0000–U+001F và U+007F).
3. **Domain** (phần sau `@` cuối cùng): DNS **không** phân biệt hoa/thường → lowercase. Domain quốc tế (IDN) MUST chuyển về dạng A-label (punycode) **trước** khi lowercase, rồi mới so/ghi.
4. **Local-part** (phần trước `@` cuối cùng): giữ **nguyên bản**, **phân biệt hoa/thường** theo RFC 5321 §2.3.11. **KHÔNG** lowercase toàn địa chỉ: `An@example.com` và `an@example.com` là **hai** giá trị recipient khác nhau. Đánh đổi được chọn có chủ đích: nếu provider coi hai mailbox đó là một, hậu quả tệ nhất là **gửi dư**, **không** phải dedupe sai hai request khác nhau thành một.
5. **KHÔNG** strip dot, **KHÔNG** strip plus-tag, **KHÔNG** áp rule riêng của provider (ví dụ Gmail dot/plus) — service không sở hữu semantics đó, và áp riêng cho provider sẽ khiến cùng một địa chỉ chuẩn hoá khác nhau ở hai nơi.

Chuỗi kết quả của hàm này là giá trị dùng cho **cả** fingerprint **và** cột `recipient` lưu trữ — để không tồn tại hai chuẩn hoá khác nhau cho cùng một địa chỉ.

**Chuẩn hoá `locale` (MUST).** Giống recipient, hàm này MUST là **một hàm duy nhất** cho cả fingerprint và việc chọn template, gồm đúng các bước (không thêm bước ngầm):

1. Không truyền `locale` (hoặc `locale` rỗng sau trim) → dùng **hằng default locale của service** (một giá trị cấu hình; FR-003 fallback dùng chính hằng này).
2. Trim whitespace hai đầu.
3. Lowercase toàn bộ chuỗi (`en-US` → `en-us`). Ngữ cảnh v1 chỉ tra template theo `(name, locale)` key chính xác lowercase, nên lowercase **không** mất match nào.
4. Từ chối (`400`) nếu kết quả không khớp pattern BCP-47 ngắn `^[a-z]{2,3}(-[a-z0-9]{2,8})*$`. Đây là **ràng buộc syntax**, không phải kiểm tra region subtag có tồn tại thật hay không — mục đích là chặn chuỗi bất thường vào canonical form.

Fingerprint dùng **chuỗi locale đã chuẩn hoá** (sau các bước trên), không phải giá trị nguyên văn từ request.

**Canonical serialization — profile chốt (MUST).** Canonical form **không** được để từng implementation tự chọn, nếu không hai implementation tuân thủ tài liệu vẫn sinh fingerprint khác nhau. Chốt hai tầng:

_Tầng 1 — chuỗi canonical request._ Ghép bốn trường theo **đúng thứ tự**, mỗi trường có **tiền tố độ dài byte UTF-8** để hai tổ hợp đầu vào khác nhau **không thể** trùng chuỗi (cùng kỹ thuật length-prefix đã dùng ở `01-architecture.md` §7.4):

```
canonical_request = "v1" "\n"
                  + byteLen(template)  ":" template  "\n"
                  + byteLen(locale)    ":" locale    "\n"
                  + byteLen(recipient) ":" recipient "\n"
                  + byteLen(jcs(variables)) ":" jcs(variables) "\n"
```

`byteLen(x)` = **số byte UTF-8** của `x`, viết dạng thập phân ASCII. Dấu `"v1"` là version của **profile canonical** (đổi profile phải đổi tag), tách biệt với version của **khoá** HMAC (`k1:`) trong giá trị fingerprint — và **cả hai tag đều được persist** (dạng `p1.k1:<64 hex>`, xem mục khoá keyring dưới đây), để một row cũ luôn xác định được cả profile lẫn khoá đã dùng, kể cả sau khi profile hoặc keyring đổi.

_Tầng 2 — serialization của `variables`:_ dùng **RFC 8785 — JSON Canonicalization Scheme (JCS)**, **không** tự chế profile. JCS đã chốt đúng những điểm dễ sai:

- **Thứ tự key:** sắp **đệ quy ở mọi cấp** object, so sánh theo **UTF-16 code unit** (không theo code point, không theo locale). Object lồng nhau cũng phải sorted.
- **Object vs array:** array **có thứ tự** (`[1,2]` ≠ `[2,1]`); object là **tập key** nên thứ tự key không đổi nghĩa.
- **Số:** biểu diễn theo ECMAScript (ECMA-262 §7.1.12.1), IEEE-754 double. `NaN`, `Infinity`, `-Infinity` **không** serialize được → validation MUST từ chối **trước** khi tính fingerprint; **không** fallback về `null`.
- **Chuỗi:** escape tối thiểu; control char U+0000–U+001F dùng `\uhhhh` chữ thường (trừ U+0008/0009/000A/000C/000D → `\b \t \n \f \r`); code point khác giữ nguyên, trừ `\` và `"`. Kết quả encode **UTF-8**; surrogate lẻ (invalid Unicode) MUST bị từ chối.
- **Không whitespace** giữa các token.

_`null`, trường vắng mặt, giá trị mặc định và object rỗng là **bốn** thứ khác nhau_ — không được tự ý đánh đồng:

- Trường **vắng mặt** khác trường có giá trị **`null`**: `{"t":"x"}` và `{"otp":null,"t":"x"}` cho canonical khác nhau → fingerprint khác.
- Validation **KHÔNG** được chèn default cho optional variable **trước** khi fingerprint: chèn default biến hai request vốn khác nhau thành một.
- Object rỗng `{}` khác `null`: `{}` là JSON object hợp lệ — đúng canonical của **không truyền `variables`** (FR-001), còn `null` không phải object và bị từ chối ở tầng shape.
- Kiểu của biến do **`variables_schema_json` của template version** chốt (FR-003): `1` (number) khác `"1"` (string); lệch kiểu MUST bị validation từ chối, **không** tự ép kiểu.

_Loại trừ khỏi canonical:_ template version do server chọn, `correlation_id`, mọi tracing metadata, và cả `principal_id`/`Idempotency-Key` — hai trường cuối là **scope/key** ở tầng uniqueness (`UNIQUE (principal_id, idempotency_key)`), **không** phải phần nội dung request; trộn chúng vào fingerprint là trộn identity scope với content.

**Golden vectors (test fixture).** Bảng dưới cho một tập vector để hai implementation kiểm chứng canonical bytes và fingerprint. `bytes` là `canonical_request` với `\n` viết thành hai ký tự `\` `n`. Digest được tính bằng **key fixture CHỈ dùng cho test**:

```
k_test = 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff   (32 byte, pattern, KHÔNG dùng ở Production)
```

| #   | Input (template, locale, recipient, variables)                                                      | `canonical_request` (bytes)                                                                                    | Fingerprint                                                              |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `reset-password`, `en`, `user@example.com`, `{"a":"1","b":"2"}`                                     | `v1\n14:reset-password\n2:en\n16:user@example.com\n17:{"a":"1","b":"2"}\n`                                     | `p1.k1:055e25b39fd486e9551a2c27d9d8e81d25aa04a8c3ac9b8464673799a22d5c4c` |
| 2   | như #1 nhưng `variables` = `{"b":"2","a":"1"}` (đổi thứ tự key)                                     | **giống hệt #1** (JCS sort key)                                                                                | **giống hệt #1**                                                         |
| 3   | `reset-password`, `en`, `user@example.com`, `{"user":{"id":"u1","name":"An"},"items":[1,"x",null]}` | `v1\n14:reset-password\n2:en\n16:user@example.com\n53:{"items":[1,"x",null],"user":{"id":"u1","name":"An"}}\n` | `p1.k1:fdc5f9abc382569544f2bd5f00c6ee2182f539fa850ef4ecd7431340efe8d75e` |
| 4   | `null` tường minh: `{"otp":null,"t":"reset"}`                                                       | `v1\n14:reset-password\n2:en\n16:user@example.com\n24:{"otp":null,"t":"reset"}\n`                              | `p1.k1:5d8e73654a5a9ec64442493065154164553472ad7e42e959cd182274a9d166fe` |
| 5   | trường **vắng mặt**: `{"t":"reset"}`                                                                | `v1\n14:reset-password\n2:en\n16:user@example.com\n13:{"t":"reset"}\n`                                         | `p1.k1:ccf26ff52ecc36396db61756cc065922334382dfb79bb66d0c0f0979a8602a7a` |
| 6   | `locale` khai báo tường minh `en` (bằng default), `{"otp":"123456"}`                                | `v1\n14:reset-password\n2:en\n16:user@example.com\n16:{"otp":"123456"}\n`                                      | `p1.k1:5e224c55734970878f5b06a9c4c2a2ecf1639b61f0c251154e91500877a96607` |
| 7   | `recipient` = `"  user@example.com  "` sau trim, `{"otp":"123456"}`                                 | **giống hệt #6** (trim trước khi canonical)                                                                    | **giống hệt #6**                                                         |
| 8   | Unicode: `{"name":"Nguyễn Văn An","city":"Hà Nội"}`                                                 | `v1\n14:reset-password\n2:en\n16:user@example.com\n46:{"city":"Hà Nội","name":"Nguyễn Văn An"}\n`              | `p1.k1:39025eb6c962dbb1387e05acd37358abe4cd70f232d518a94ce9478c2b795648` |
| 9   | cùng #6 nhưng `{"otp":"654321"}` (khác `variables`)                                                 | `v1\n14:reset-password\n2:en\n16:user@example.com\n16:{"otp":"654321"}\n`                                      | `p1.k1:5e584b18b3c57edd8df389141ce91d46fe33d9234558c5547b068b642fa8ec08` |
| 10  | cùng #6 nhưng `recipient` = `other@example.com`                                                     | `v1\n14:reset-password\n2:en\n17:other@example.com\n16:{"otp":"123456"}\n`                                     | `p1.k1:9861697b934ef29aeca33c94fa1a458a4fe65c49e963f4eb5ba5bd46a27051fb` |

Đọc bảng này: #1 = #2 (thứ tự key vô nghĩa) · #6 = #7 (trim là một phần chuẩn hoá) · #4 ≠ #5 (`null` ≠ vắng mặt) · #9 ≠ #6 (đổi `variables`) · #10 ≠ #6 (đổi `recipient`) — mỗi quan hệ là một assert bắt buộc trong test. Vector **correlation_id khác nhau → cùng fingerprint** và **key version cũ vẫn verify được** nằm ở mục Acceptance Criteria (không cần digest riêng vì assert là _bằng nhau_, không phải một digest cụ thể). Digest ở bảng **được tính từ key fixture ở trên**, không phải giá trị minh hoạ; khi key hoặc profile `v1` đổi, bảng MUST được tính lại.

**Vector #3 và #4 kiểm canonicalization, KHÔNG kiểm tính hợp lệ của request.** JCS canonical hoá được **mọi** giá trị JSON — object/array lồng nhau, `null`, object rỗng — đó là **khả năng của hàm canonical**, không phải bằng chứng một request nghiệp vụ hợp lệ. Tập giá trị mà service **chấp nhận ở v1** do FR-003 + `variables_schema_json` chốt: **chỉ primitive** (`string`/`number`/`boolean`, thêm `null` khi schema khai báo `nullable`) — object/array bị từ chối ở tầng request-shape **của service** (FR-001 bước 3), không phải ở contract library. Vì vậy:

- Vector #3 (object `user` + array `items`) là **fixture bắt buộc** của JCS (sort key đệ quy, giữ thứ tự array) nhưng request mang nguyên shape đó **bị từ chối** ở v1 (`400 invalid_request`) — digest của bảng giữ nguyên.
- Vector #4 (`null` tường minh) phân biệt `null` với vắng mặt **ở canonical bytes**; `null` chỉ được chấp nhận ở v1 khi schema của version đó khai báo `nullable: true` (FR-003) — mặc định là từ chối.
- Fingerprint tính trên canonical bytes của `variables` **sau bước validate shape** (FR-001 bước 3); validate theo schema ở FR-001 bước 7 **không** làm đổi canonical bytes, và một request bị từ chối ở bước 3 hoặc bước 7 không bao giờ sinh row. Replay của một row hợp lệ vẫn verify bằng đúng canonical bytes đã chốt ở trên.

**Canonical serialization — giới hạn phải nói rõ.** Profile `v1` **không** phải một chuẩn canonicalization tổng quát: nó chỉ định nghĩa canonical cho **đúng bốn** trường fingerprint của FR-002. Nó **không** ràng buộc shape của payload API khác, không bảo đảm canonical cho kiểu dữ liệu ngoài JSON (Date, binary, NaN), và **không** thay thế validation schema. JCS có thể được tái dùng ở chỗ khác, nhưng khi đó phải được tham chiếu như một quyết định độc lập — không được suy ra từ FR-002.

**Fingerprint dùng HMAC có khoá, KHÔNG dùng hash trần (MUST).** `variables` chứa giá trị entropy thấp (ví dụ OTP 6 chữ số, mã reset ngắn, `recipient` có thể đoán được nếu attacker biết `principal_id`). Với một hash trần, kẻ đọc được D1 `mail` (hoặc một bản backup rò rỉ) có thể **brute-force offline** đúng tập giá trị nhỏ đó, và `request_fingerprint` biến thành oracle xác nhận giá trị đoán. Vì vậy:

- `request_fingerprint` MUST là `HMAC-SHA-256(k_fingerprint, canonical_request)` dạng hex, **không** phải `SHA-256(canonical_request)` trần. **Không** được mô tả hash trần là đủ để bảo vệ mọi dữ liệu request nhạy cảm — nó chỉ là biểu diễn một chiều, không phải cơ chế bảo vệ.
- **Chủ sở hữu và cô lập khoá:** `k_fingerprint` là **Worker Secret của `transactional-mail`** (control plane — nơi duy nhất tính và so fingerprint). Nó **KHÔNG** được tái sử dụng: khác khoá HMAC của private-interface authentication (`01-architecture.md` §7.4, PR #197), khác provider credential của `transactional-mailer-job`, khác mọi secret khác. `transactional-mailer-job` **không** có khoá này và không thể tính fingerprint. Khoá tách theo environment: secret Preview **không** phải secret Production.
- **Khoá keyring có version + profile tag + replay tương thích:** giá trị lưu ở `request_fingerprint` mang **cả** profile tag và version của khoá, dạng `p1.k1:<64 hex>` (`p1` = profile canonical `v1` ở trên). Replay đọc row theo `(principal_id, idempotency_key)` **trước**, lấy hai tag từ tiền tố, rồi tính lại canonical request **bằng đúng profile và đúng khoá version đã đọc** và so — không tính bằng "khoá/profile hiện tại" để rồi kết luận sai, và không giả định profile có thể suy ra từ key version (chúng độc lập). Profile tag không nhận diện được (chưa từng defined) → `503` fail-closed, tương tự khoá thiếu. Rotation vì vậy **không** làm vô hiệu một replay hợp lệ: khoá cũ được **giữ lại trong keyring** cho mục đích verify (không dùng để tạo row mới) ít nhất bằng thời gian retention của `mail_messages`; request mới luôn dùng khoá current. Việc xoá khoá cũ phải đi kèm quyết định retention cho row đã dùng nó, để không tồn tại row không còn verify được. Đổi profile canonical tạo tag `p2` mới cho row mới; row `p1` cũ vẫn verify được bằng profile `v1` đã defined.
- **Hành vi khi lỗi (fail closed):** thiếu `k_fingerprint` trong runtime config, hoặc tiền tố version không có trong keyring → service MUST trả `503` và alert, **KHÔNG** fallback sang hash trần. Fallback im lặng sẽ hạ cấp bảo vệ mà không ai biết, và biến rotation lỗi thành một lỗi correctness.
- **Giới hạn phải nói rõ:** HMAC chỉ bảo vệ khi khoá **không** nằm cùng nơi với dữ liệu. Nó **không** bảo vệ trước kẻ có cả D1 `mail` **và** Worker Secret (insider hoặc compromise runtime); nó không làm `request_fingerprint` trở thành "an toàn tuyệt đối". Nó cũng không thay thế các biện pháp khác: `variables` vẫn không bao giờ được persist dạng raw, và `recipient`/`subject_rendered`/`body_rendered` vẫn có retention riêng (FR-007).
- **Phương án bị loại (ghi lại để đối chiếu):** loại hẳn các giá trị entropy thấp khỏi fingerprint (ví dụ bỏ `variables`, hoặc chỉ giữ `template` + `locale` + `recipient`) cũng chặn được brute-force, nhưng **phá vỡ semantics idempotency**: đổi `variables` — kể cả đổi OTP — trên cùng `Idempotency-Key` sẽ không còn sinh `409` mà trả nhầm kết quả cũ. Đánh đổi đó (im lặng trả kết quả sai) nghiêm trọng hơn rủi ro brute-force đã được HMAC xử lý, nên phương án này **không** được chọn.

**Rủi ro còn lại — kênh xác nhận online qua `200`/`409` (không xoá được bằng tài liệu).** Phân biệt `200` (khớp fingerprint) với `409` (lệch fingerprint) trên cùng `(principal_id, idempotency_key)` là **có chủ đích** và **bắt buộc** cho đúng semantics idempotency — nhưng nó cũng là một kênh xác nhận: caller đã authenticate có thể gửi một request với giá trị **đoán** cho một key đã dùng và đọc kết quả `200`/`409` để **xác nhận** giá trị đó có khớp request gốc hay không. Vì vậy HMAC bảo vệ `request_fingerprint` ở trạng thái **nghỉ** (at rest, chống brute-force offline trên D1/backup), nhưng **không** loại bỏ được kênh online này. Ranh giới thực tế: probe đòi một caller đã authenticate **và** có permission cho template/principal đó, nên nó chỉ mở cho người đã giữ credential hợp lệ của **chính principal** đó — rủi ro còn lại là leo thang từ một credential đã bị chiếm, không phải từ việc đoán được fingerprint. Giảm thiểu (MUST, ở tầng service): rate limit **theo `(principal_id, idempotency_key)`** cho các lần thử bị `409` (không chỉ theo principal) và một **security alert** khi cùng một key sinh chuỗi fingerprint-mismatch lặp lại. Không được "sửa" rủi ro này bằng cách trả `200` cho fingerprint lệch: làm vậy là chọn phương án đã bị loại ở trên (im lặng trả kết quả sai).

#### Acceptance Criteria

- Thiếu credential caller hoặc caller không authenticate được → `401`.
- Caller không có permission → `403`.
- Thiếu `Idempotency-Key` → `400`.
- Replay cùng principal + key + fingerprint → không duplicate domain row, không duplicate outbox row.
- Replay cùng principal + key + fingerprint khác → `409`, không tạo message.
- `app` trong body bị bỏ qua; principal luôn từ authenticated caller.
- Fingerprint được persist ở cột `request_fingerprint`; response không implying delivery đã hoàn tất (chỉ accept).
- `request_fingerprint` là **HMAC-SHA-256 có khoá** (một chiều), có tiền tố version khoá — schema MUST NOT có cột lưu raw `variables`, nội dung render, verification token hay credential.
- Uniqueness được enforce ở tầng DB bằng `UNIQUE (principal_id, idempotency_key)` (hoặc scope đã chứng minh one-to-one); caller-supplied `app` không thể mở rộng phạm vi dedupe.
- Replay khi template active đã **đổi** (version mới hơn) mà request fingerprint không đổi → trả **nguyên** kết quả cũ (template version cũ + nội dung render cũ), **không** re-render theo version mới, **không** tạo message mới.
- Fingerprint tính trên locale **đã chuẩn hoá** và `variables` theo **canonical profile `v1`** (JCS sort key ở mọi cấp): đổi thứ tự key trong JSON, hoặc bỏ `locale` khi default áp dụng, **không** làm đổi fingerprint.
- `correlation_id` khác nhau trên cùng key + cùng request nghiệp vụ → **không** sinh `409` (trừ khi API contract quy định khác).
- `request_fingerprint` là `HMAC-SHA-256` có tiền tố profile + version khoá (`p1.k1:<64 hex>`), **không** phải hash trần; test assert không nhánh nào fallback sang hash không khoá, và thiếu khoá → `503` fail-closed.
- Rotation: row tạo bằng profile `v1` + khoá `k1`, sau khi keyring thêm `k2` → replay **cùng** request vẫn trả `200` + kết quả gốc (verify bằng `k1` đọc từ tiền tố), request **mới** dùng `k2`; profile tag hoặc version khoá lạ ở tiền tố → `503`, không `409`.
- Probe `409` trên cùng `(principal_id, idempotency_key)` bị rate limit theo **key** (không chỉ theo principal) → `429` khi vượt ngưỡng + security alert; ngữ nghĩa `200` (khớp) / `409` (lệch) **không** đổi.

**Ca đối kháng (fingerprint/idempotency):**

- **Đổi recipient, cùng key:** cùng principal + cùng `Idempotency-Key`, `recipient` khác → fingerprint khác → `409`, không tạo message, **không** gửi tới recipient mới.
- **Đổi `variables`, cùng key:** `variables` khác (kể cả chỉ đổi một giá trị) → `409`.
- **Bỏ qua default vs khai báo tường minh:** `locale` không truyền và `locale` truyền đúng giá trị default đã chốt → **cùng** fingerprint (không `409`).
- **Không truyền `variables` vs `variables: {}`:** cùng một request nghiệp vụ "không có biến" → **cùng** fingerprint (canonical `2:{}`); khác `409` chỉ khi tập biến thật sự khác nhau.
- **Thứ tự key đổi:** cùng tập `variables`, thứ tự key trong JSON khác → **cùng** fingerprint (canonical profile `v1` sort key ở mọi cấp trước khi hash; golden vector #1 = #2).
- **Template active đổi version:** request replay đúng fingerprint trong khi template `active` đã lên version mới → trả **nguyên** kết quả cũ (template version cũ + nội dung render cũ), **không** re-render, **không** tạo message mới, **không** `409`.
- **Hai request đồng thời cùng `(principal_id, idempotency_key)`:** `UNIQUE (principal_id, idempotency_key)` cho đúng một INSERT thắng; request thua **đọc lại row đã commit** rồi mới so fingerprint — cùng fingerprint → `200` + kết quả của bên thắng; khác fingerprint → `409`. So fingerprint với giá trị đọc **trước** khi INSERT (stale read) là sai và bị loại. Chỉ một domain row và một outbox row tồn tại.

---

### FR-003 — Render từ Template

Service MUST chọn template `active` theo `(name, locale)` và render `{{ variable }}` từ `variables`. Template **chỉ** do principal đã authorize được dùng; template là versioned (name + locale + version), chọn deterministic.

Template không phải chương trình: renderer **không** thực thi template code, **không** đánh giá biểu thức tùy ý — chỉ thay biến theo schema.

#### `variables_schema_json` — schema theo từng template version

- **Nơi sống:** cột `variables_schema_json` trên đúng row `mail_templates` đang giữ `subject_template`/`body_template` — **mỗi template version một schema**; không có schema toàn cục, không suy schema từ tên template (mô hình → [`01-architecture.md`](./01-architecture.md) §4.1). Tài liệu này chỉ chốt định dạng. **Bảng `mail_templates` đã có migration** (`apps/transactional-mail/migrations/0001_mail_templates.sql`, PR C1) và file seed (`apps/transactional-mail/migrations/0009_mail_templates_seed.sql`) cho template `account.login-otp` locale `en`. Validate theo schema vẫn là việc của service khi PR render (C3) đến. **Mọi row `mail_templates` MUST có schema hợp lệ** — không tồn tại version không có schema.
- **Schema thuộc về version:** nội dung schema là một phần của chính version đó — **đổi schema = tạo version mới**. Version đã `active` không được sửa schema, nếu không cùng một request sẽ hợp lệ tùy thời điểm.
- **Subset JSON có version, không phải JSON Schema đầy đủ.** Không thêm dependency JSON Schema và **không** viết runtime validator trong contract library. Chỉ các field bên dưới hợp lệ; field lạ trong schema, field không áp dụng cho `type` khai báo, hay `schema_version` runtime chưa hỗ trợ → lỗi seed/template, **fail-closed `500 internal_error`, không gửi** (không phải lỗi của caller) và alert. Runtime MUST tự parse và kiểm schema khi đọc (có cache hay không là chuyện implementation); validation lúc seed **không** thay thế kiểm tra lúc runtime — cột `NULL`/rỗng/không parse được cũng vào đúng nhánh fail-closed này, không được coi là "không có biến".

```json
{
  "schema_version": 1,
  "variables": {
    "otp": { "type": "string", "required": true, "max_length": 8 },
    "name": { "type": "string", "required": true, "max_length": 200 },
    "cta_url": { "type": "string", "required": true, "max_length": 2048, "format": "url" },
    "org": { "type": "string", "required": false, "max_length": 200 },
    "ttl": { "type": "number", "required": false, "nullable": true }
  }
}
```

| Field                        | Bắt buộc | Giá trị hợp lệ                                                                          |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `schema_version`             | MUST     | số nguyên ≥ 1 — version của **format subset**, không phải version template              |
| `variables`                  | MUST     | object; ≤ 50 key; key khớp `^[a-zA-Z0-9_]{1,64}$`                                       |
| `variables.<tên>.type`       | MUST     | `string` \| `number` \| `boolean` — v1 **không** có `object`/`array`                    |
| `variables.<tên>.required`   | MUST     | boolean, khai báo tường minh — **không** có mặc định ngầm                               |
| `variables.<tên>.nullable`   | optional | boolean, mặc định `false`; `true` → biến nhận thêm giá trị `null`                       |
| `variables.<tên>.max_length` | optional | số nguyên 1..10000, **chỉ** khi `type = "string"`                                       |
| `variables.<tên>.format`     | optional | `url`, **chỉ** khi `type = "string"` — validate theo quy tắc URL ở mục "Render an toàn" |

**Đo thế nào.** `max_length` và ngưỡng chuỗi ≤ 10000 đếm **UTF-16 code unit** (`String#length`) trên **giá trị gốc**, **trước** khi HTML escape — độ dài để validate và độ dài sau escape là hai thứ khác nhau. Field **không** áp dụng cho `type` khai báo (ví dụ `max_length`/`format` trên `number`) là schema không hợp lệ, xử lý y hệt hàng cuối của bảng "Hành vi với từng trường hợp".

Schema khai báo **kiểu và giới hạn, không khai báo giá trị**: schema và mọi ví dụ trong tài liệu **không** được chứa dữ liệu nhạy cảm, và seed **không** được dùng token/credential thật làm giá trị mẫu. Ví dụ request/response ở FR-001 chỉ minh hoạ **shape trên wire**, không phải schema của một template cụ thể — mỗi template version có schema riêng khi seed (còn mở → `01-architecture.md` §10).

`type` quyết định kiểu JSON: `1` (number) khác `"1"` (string) và **không** tự ép kiểu. `null` do `nullable` quyết định (mặc định từ chối) — đúng nguyên tắc FR-002: kiểu của biến do **`variables_schema_json` của version** chốt, `null` không phải một luật ngầm ở tầng shape.

`type: "number"` nhận **mọi số hữu hạn IEEE-754 double** (âm, thập phân, exponent đều hợp lệ); `1e400` là JSON hợp lệ nhưng parse ra `Infinity` nên bị từ chối `400` ở bước 3 (cùng luật `NaN`/`Infinity` của FR-002), **không** serialize thành `null`. Render số theo ECMAScript `Number::toString`. `required` chỉ nói về **vắng mặt**: `null` trên biến `nullable: true` **thỏa** `required: true`; chỉ khi biến vắng hẳn mới bị từ chối.

#### Phân tầng validation — ai kiểm gì

| Tầng                                                                   | Nơi chạy                               | Kiểm                                                                                                                                                                                                                                                                                 | Biết schema version?                                   |
| ---------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Request-shape validator trong `@ecoma-io/transactional-mail-contracts` | Contract — phía cả consumer và service | Field có mặt/sai kiểu, `variables` là object, field lạ bị chặn                                                                                                                                                                                                                       | **Không** — giữ `variables: Record<string, unknown>`   |
| Request-shape validation của service (FR-001 bước 3)                   | Trước rate limit và idempotency        | Shape contract + ngưỡng toàn cục: ≤ 50 key, key khớp pattern, mỗi value là JSON **scalar** (`string`/`number`/`boolean`/`null`; **object/array → từ chối**), chuỗi ≤ 10000 ký tự (UTF-16 code unit), chuẩn hoá `recipient`/`locale`. `null` **đi qua** tầng này để schema quyết định | **Không** — độc lập template                           |
| Business validation theo template (FR-001 bước 7)                      | **Sau** khi chọn template version      | required/optional, `type`, `nullable`, `max_length`, key thừa, `format`                                                                                                                                                                                                              | **Có** — dùng `variables_schema_json` của version chọn |

Contract library **không** kiểm và **không nên** kiểm luật nghiệp vụ: nó không biết template nào active, version nào được chọn, schema nào sống ở đâu.

Thứ tự là hệ quả của việc schema nằm **trong** version: không thể kiểm ở bước 3, và replay (FR-001 bước 6) MUST trả `200`/`409` **trước** khi chạm schema — request **đã tạo thành công** không bao giờ bị `400` vì schema của version hiện tại, kể cả khi template đã lên version mới hay bị xoá; request mới thì được kiểm đầy đủ ở bước 7.

Ngưỡng toàn cục ở tầng shape (≤ 50 key, pattern, 10000 ký tự) là một phần của **public API contract do service enforce** — không phải `@ecoma-io/transactional-mail-contracts`: với row đã lưu, chúng **chỉ được nới lỏng, không được siết chặt** — siết chặt làm replay của row cũ bị `400` ở bước 3 thay vì `200`.

#### Hành vi với từng trường hợp

| Trường hợp                                                                                                          | Hành vi                                                           | Kết quả                   |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| Key **không được khai báo** trong schema                                                                            | Từ chối, không render                                             | `400 invalid_request`     |
| Biến **required bị thiếu** (vắng mặt)                                                                               | Từ chối, không render                                             | `400 invalid_request`     |
| Biến **optional bị thiếu** (vắng mặt)                                                                               | Hợp lệ; `{{ var }}` render thành **chuỗi rỗng**, không crash      | —                         |
| `null` trên biến `nullable: false` hoặc không khai báo `nullable`                                                   | Từ chối (sai kiểu)                                                | `400 invalid_request`     |
| `null` trên biến `nullable: true`                                                                                   | Hợp lệ; **khác** vắng mặt ở canonical (FR-002); render chuỗi rỗng | —                         |
| Sai kiểu: `1` vs `"1"`, boolean cho `type: "string"`, object/array                                                  | Từ chối, **không** tự ép kiểu                                     | `400 invalid_request`     |
| Vượt `max_length`, chuỗi > 10000 ký tự, > 50 key, key sai pattern                                                   | Từ chối                                                           | `400 invalid_request`     |
| `format: "url"` sai scheme/hostname                                                                                 | Từ chối, không render link sai                                    | `400 invalid_request`     |
| Thiếu / `null` trên biến optional `format: "url"`                                                                   | Hợp lệ; render chuỗi rỗng, **không** áp luật URL                  | —                         |
| Schema thiếu (`NULL`/rỗng/không parse được), field lạ, field không áp dụng cho `type`, `schema_version` chưa hỗ trợ | Fail-closed, không gửi, alert                                     | `500 internal_error`      |
| Allowlist host của `format: "url"` chưa cấu hình hoặc rỗng (lỗi cấu hình server, không phải lỗi request)            | Fail-closed, không gửi, alert                                     | `503 service_unavailable` |

Không đổi 11 mã lỗi public: mọi từ chối nghiệp vụ của `variables` dùng lại `invalid_request`, mọi lỗi schema đều là `internal_error`, lỗi cấu hình allowlist dùng `service_unavailable` — cả ba đã có trong bảng error envelope của FR-001 (dùng lại `service_unavailable` đúng như thiếu `request_fingerprint` ở FR-002).

**Ranh giới `400` vs `413`.** Ngưỡng về **số/độ dài biến** (≤ 50 key, pattern, ≤ 10000 ký tự, `max_length`) là luật shape → `400 invalid_request` (FR-001 bước 3/7). `413 payload_too_large` dành cho **kích thước request/render payload tổng** trước khi ghi (FR-001 bước 7). Hai ngưỡng khác nhau và không dùng chung một code.

**Template tham chiếu biến ngoài schema.** Seed MUST kiểm mọi `{{ biến }}` trong `subject_template`/`body_template` đều nằm trong `variables` của schema chính version đó; runtime gặp placeholder không khai báo (seed lỗi lọt ra ngoài) → fail-closed `500 internal_error`, không gửi, **không** im lặng thay bằng chuỗi rỗng — khác với optional bị thiếu hợp lệ ở bảng trên.

#### Render an toàn, ngưỡng, locale fallback

Render theo context an toàn:

- **Giá trị biến là dữ liệu, không bao giờ là template syntax:** thay biến **một lượt** lúc render; giá trị chứa `{{ ... }}` **không** được quét lại hay render như template, và không có partial/include nào nhận giá trị từ request.
- **HTML escape đúng một lần, theo output context**: context text escape `&`, `<`, `>`; context attribute escape thêm `"` và `'` (biến nằm trong dấu nháy); không nội suy raw HTML từ `variables`. Seed MUST để template dùng giá trị **chưa** escape — escape lần thứ hai là lỗi. Áp dụng cho **mọi** biến đã pass validation.
- **Context header (subject)** MUST từ chối control character `U+0000`–`U+001F`, `U+007F` (kể cả CR/LF — chặn header injection) với `400 invalid_request` ở bước 7: HTML escape **không** loại bỏ CR/LF, nên luật này phải đứng riêng.
- **Vị trí URL trong template (`href`, `src`, `action`) chỉ được nhận biến khai báo `format: "url"`, và đây là toàn giá trị của attribute** (v1 **không** cho ghép tĩnh + động trong một URL). Seed MUST từ chối template đặt `{{ biến }}` khác hoặc ghép chuỗi vào vị trí URL; lọt ra runtime → fail-closed `500 internal_error`. Đây là vế enforceable của luật **"mọi biến mang URL phải được validate theo scheme/host"** — HTML escape không vô hiệu hoá `javascript:` hay `https://evil.example`.
- Biến khai báo `format: "url"` MUST là absolute URL, scheme `https`, hostname khớp allowlist **theo ranh giới nhãn** (khớp chính xác host, hoặc suffix có boundary `.`: allowlist `example.com` khớp `a.example.com` nhưng **KHÔNG** khớp `evil-example.com` — **không** so khớp substring; cùng nguyên tắc như allowlist ở `docs/applications/push-notification/02-requirements.md`); host chuẩn hoá lowercase, IDN → A-label (cùng cách với `recipient` ở FR-002), **không** userinfo, parse theo WHATWG `URL`; sai → từ chối `400 invalid_request` ở bước 7. Kiểm `format` **chỉ** khi giá trị có mặt và khác `null`: biến optional `format: "url"` bị thiếu (hoặc `null` trên biến `nullable: true`) vẫn hợp lệ và render chuỗi rỗng như mọi biến optional khác — luật URL **không** áp lên giá trị rỗng. Giá trị allowlist là **cấu hình theo environment** — không hard-code trong contract library; allowlist **chưa cấu hình/rỗng** là lỗi cấu hình server → fail-closed `503 service_unavailable` + alert (cùng cách thiếu `request_fingerprint` ở FR-002), **không** phải `400`.

Locale fallback deterministic: `(name, locale)` không có → fallback về **hằng default locale của service** (FR-002; v1 dùng `en`); nếu vẫn không có → `404`. Validation theo schema của **version thực sự được dùng** (version của locale fallback), không phải version của locale yêu cầu.

**Quy tắc chọn version khi có nhiều version `active` cùng `(name, locale)` — đã chốt (implementation v1):** trong số các ứng viên `status = 'active'` cho đúng `(name, locale)` (hoặc `(name, locale)` fallback), version **cao nhất thắng** (`ORDER BY version DESC`, ứng viên đầu tiên). Quy tắc này là tổng quát hoá tự nhiên của lifecycle version (version mới hơn thay version cũ, bản khai báo cũ chỉ còn để replay trả nguyên kết quả gốc), deterministic, không phụ thuộc thứ tự trả về của query, và được test với ≥ 2 ứng viên active. Việc "mỗi `(name, locale)` chỉ một version `active`" vẫn **không** là ràng buộc schema — seed đa version active vẫn hợp lệ, service tự phân giải theo quy tắc trên.

Ngưỡng tường minh (trước khi ghi): request size, số biến, độ dài biến (kể cả `max_length` từng biến ≤ 10000), kích thước nội dung render, và validation recipient. Payload render nằm dưới giới hạn Queue message (`docs/architecture/04-platform-facts.md` QU6).

Service MUST persist **đúng template version + nội dung đã render** dùng cho delivery — retry không được render lại ra nội dung khác.

#### Acceptance Criteria

- **Biến required bị thiếu → `400 invalid_request`, không tạo message, không render. Chỉ biến optional bị thiếu mới hợp lệ và render thành chuỗi rỗng**.
- Key không khai báo trong schema → `400 invalid_request`.
- Sai kiểu (`1` vs `"1"`, object/array, `null` khi chưa `nullable`, boolean cho `type: "string"`) → `400 invalid_request`; không có ép kiểu.
- Giá trị biến được HTML-escape; `<`, `>`, `&` không đi qua nguyên trạng.
- Biến URL sai scheme/host → `400` với `code = invalid_request`, không render link sai.
- Biến xuất hiện trong vị trí URL (`href`/`src`/`action`) MUST khai báo `format: "url"` (toàn giá trị attribute, v1 không ghép tĩnh + động); template dùng biến khác vào vị trí URL → seed bị từ chối, lọt ra runtime → `500`; allowlist host chưa cấu hình/rỗng → `503 service_unavailable` + alert, không phải `400`.
- Giá trị biến là dữ liệu: chứa `{{ ... }}` không được render lại lần hai; HTML escape đúng **một lần** theo context (context attribute escape thêm `"` và `'`); biến vào subject chứa CR/LF hay control character → `400 invalid_request`.
- `(name, locale)` không tồn tại nhưng có `en` → dùng `en` **và validate theo schema của version `en`**; cả hai không có → `404`.
- Template `disabled` → `404`.
- Render vượt ngưỡng kích thước payload → `413` trước khi ghi; ngưỡng **số/độ dài biến** vượt giới hạn → `400 invalid_request` (không dùng `413`).
- `variables` ≤ 50 key, key khớp `^[a-zA-Z0-9_]{1,64}$`, chuỗi value ≤ 10000 ký tự (UTF-16 code unit); `max_length` khai báo trong schema ≤ 10000.
- Template version + rendered subject/body được persist cùng message; retry cùng `delivery_id` dùng lại nội dung đã persist, không render lại.
- Replay idempotent **không** chọn lại template version/schema, **không** validate lại theo schema hiện tại, **không** render lại message cũ (FR-001 bước 6, FR-002).
- Contract library vẫn chỉ validate shape (`variables` là `Record<string, unknown>`); không có validator nghiệp vụ nào trong `@ecoma-io/transactional-mail-contracts`.

**Test yêu cầu khi implement** (chưa có code — ít nhất cần đủ các nhóm sau):

- required bị thiếu / optional bị thiếu (render chuỗi rỗng);
- key thừa (không khai báo trong schema);
- sai kiểu: `1` vs `"1"`, object/array, boolean sai chỗ;
- `null` với `nullable: true` và với `nullable: false`;
- giới hạn: 51 key, key sai pattern, chuỗi > 10000 UTF-16 code unit, vượt `max_length`, và một ca biên có ký tự astral để chốt đơn vị đếm;
- `number`: âm/thập phân/exponent hợp lệ; `1e400` (parse ra `Infinity`) → `400`, không serialize thành `null`;
- URL sai scheme/hostname (ngoài allowlist); ranh giới nhãn: `evil-example.com` KHÔNG khớp allowlist `example.com`, `a.example.com` CÓ khớp (suffix boundary); allowlist chưa cấu hình/rỗng → `503` + alert;
- vị trí URL: biến không phải `format: "url"`, hoặc ghép tĩnh + động trong `href`/`src` → seed từ chối, runtime fail-closed;
- biến optional `format: "url"` bị thiếu hoặc `null` → hợp lệ, render chuỗi rỗng, **không** áp luật URL;
- giá trị chứa `{{ ... }}` không bị render lại lần hai; attribute context escape thêm `"`/`'` đúng một lần (không double-escape); subject chứa CR/LF → `400`;
- `required: true` + `nullable: true` với giá trị `null` → hợp lệ (chỉ vắng mặt mới bị từ chối);
- HTML escaping của `<`, `>`, `&`; `max_length` đo trên giá trị gốc, không phải sau escape;
- placeholder `{{ biến }}` không khai báo trong schema → seed bị từ chối, runtime fail-closed;
- schema thiếu (`NULL`/rỗng/không parse được), field lạ, field không áp dụng cho `type`, hoặc `schema_version` chưa hỗ trợ → `500`, không gửi, có alert;
- locale fallback → validate theo schema của version fallback;
- nhiều version `active` cùng `(name, locale)` → version cao nhất thắng, deterministic bất kể thứ tự trả về;
- version cũ: replay trả template version + nội dung gốc, không re-render theo version mới;
- replay idempotent: cùng fingerprint → `200`, lệch fingerprint → `409`, không duplicate message/outbox;
- không truyền `variables` và truyền `variables: {}` → cùng fingerprint, cùng kết quả validation.

---

### FR-004 — Outbox (transactional outbox)

Domain row và outbox row MUST được ghi trong **một** `db.batch()`.

Outbox state machine: `pending → publishing → published | failed`, có `publish_attempts` (**số lần publish trong chu kỳ outbox hiện tại** — reset khi row được re-enqueue), `available_at`, `claimed_at`, `claimed_by`, `last_error` (thiết kế → [`01-architecture.md`](./01-architecture.md) §6).

Publish state (`pending`/`publishing`/`published`/`failed`) là việc đã publish Queue command hay chưa; message state (`accepted`/`queued`/`sent`/`failed`/`blocked`) là trạng thái delivery. Hai layer này **không bao giờ ghi lên nhau**:

- Publish state chỉ được ghi bởi outbox publisher; delivery outcome chỉ được ghi bởi outcome callback.
- Publisher write `message → queued` khi outbox `published`, bằng **conditional write** với nguồn hợp lệ **chỉ** `accepted`/`queued`; nó **không bao giờ** viết `sent`/`failed`/`blocked`, và **không bao giờ** ghi `queued` đè lên message đã terminal. `blocked` **không** phải nguồn hợp lệ của publisher: một message `blocked` ở generation hiện tại là dữ liệu không nhất quán, publisher bỏ qua message row.
- `blocked → queued` là chuyển duy nhất được phép từ `blocked`, và nó **không** do publisher thực hiện: nó nằm trong **batch nguyên tử của redrive** (§6.4 của [`01-architecture.md`](./01-architecture.md)), cùng lúc với `dispatch_generation++`, `recovery_cycle_count++` và reset outbox row. Nhờ vậy một execution của generation mới luôn thấy `accepted`/`queued` và outcome hợp lệ của generation mới không bao giờ bị từ chối vì publisher chưa kịp ghi.

Outbox `failed` **không** đồng nghĩa mất delivery intent: row outbox và `mail_messages` vẫn còn, `failed` chỉ nghĩa là publish tự động đã hết `maxPublishAttempts` trong chu kỳ đó. Row `failed` MUST **không** bị xoá tự động; recovery là alert + repair có kiểm soát (`03-operations.md` §5.4).

- Outcome callback chỉ chuyển `accepted|queued → sent|failed|blocked`; callback đến sau khi message đã terminal (hoặc stale/out-of-order) phải trả `result = stale` và không lùi trạng thái. Thứ tự callback **không** được giả định.

#### Acceptance Criteria

- Domain + outbox nằm cùng batch — một statement fail → toàn bộ rollback; batch này đặt `dispatch_generation = 1` cho cả message row và outbox row.
- Claim dùng `WHERE status = 'pending'` — một publisher thắng mỗi item.
- Lease quá hạn (`claimed_at < now - leaseMs`) được reclaim.
- Publisher conditional write mang guard `dispatch_generation` khớp giữa outbox row và message row; lệch generation → không đổi message row.
- **Race dispatch/outcome (state cuối authoritative ở D1 `mail` + hành vi worker)** — chi tiết ở `01-architecture.md` §6.2.2:
  - Callback terminal đến **trước khi** publisher ghi `published` → `status = sent`, `dispatch_generation = 1`; outbox vẫn `pending`/`publishing`; publish sau đó không đổi message row.
  - Publisher commit **sau** callback terminal → message giữ `sent` (không bị kéo về `queued`).
  - Hai callback cho hai generation khác nhau, đến lệch thứ tự → giữ kết quả generation hiện tại; callback generation cũ nhận `result = stale` và **không** ghi gì (đặc biệt: một callback `blocked` cũ không được kéo delivery đã redrive trở lại `blocked`).
  - Callback trùng lặp sau `sent` → `status = sent`; callback thứ hai nhận `result = duplicate` → worker coi là đã báo, ack, không gửi lại.
- `QUEUE.send` thất bại → item về `pending`, `publish_attempts++`, `available_at` lùi theo backoff; hết `maxPublishAttempts` → `failed`.
- Publish thành công → outbox `published`, message `queued`, trong một batch — batch này không viết `sent`/`failed`/`blocked`.
- Message đã `sent`/`failed` (terminal) mà publisher ghi kết quả thành công → publisher chỉ cập nhật outbox; message row **không** bị đổi về `queued`.
- Outcome callback idempotent: duplicate/out-of-order callback không ghi overwrite terminal state.
- Redrive delivery `blocked`: trong **một** `db.batch()`, re-enqueue **tái sử dụng** outbox row hiện có (`delivery_id` là UNIQUE) — đặt `status = 'pending'`, `publish_attempts = 0`, `available_at = now` — đồng thời tăng `dispatch_generation` **đúng 1**, đặt `mail_messages.status = 'queued'`, và tăng `recovery_cycle_count`; **không** chèn outbox row thứ hai, **không** tạo `message_id` mới, **không** đổi `delivery_id`.
- Redrive là thao tác **có authorize tường minh** trên `POST /internal/deliveries/:delivery_id/redrive` (`01-architecture.md` §6.4), không phải việc xoá một marker trong DB một cách ngầm hiểu. Caller và permission boundary → §7.5 của [`01-architecture.md`](./01-architecture.md): **hiện chưa có operator/backoffice authorization mechanism được định nghĩa** nên đây là **implementation gate**, không phải tính năng đã sẵn sàng release.
- Guard redrive được enforce trong `WHERE`: `status = blocked`, chưa vượt số chu kỳ tối đa **hoặc** request kèm override có authorize, và đã qua backoff tối thiểu. Ở ngưỡng ngân sách: request không kèm override → từ chối (`409`) + alert `Page`, chuyển xử lý tay; thao tác **có authorize tường minh** kèm cờ override mới đi tiếp được, khi đó `recovery_cycle_count` **vẫn ++** và audit ghi rõ override (`01-architecture.md` §6.4/§6.5 hàng 10).
- Redrive ghi audit: actor, timestamp, lý do, `delivery_id`, generation cũ/mới — **không** ghi recipient, nội dung render, token hay credential. Audit này phân biệt redrive với re-enqueue tự động của reconciler; cả hai đường dùng **chung** một lease/backoff/cycle guard.
- Worker chỉ thử lại một delivery đã `blocked` khi **authority đọc từ private interface** cho generation **lớn hơn** generation đã lưu ở `mail_jobs` — đó là tín hiệu eligibility duy nhất, và nó đến qua private interface, **không** qua Queue. Queue envelope **không** mang `dispatch_generation` (envelope chỉ có `version` + `delivery_id`), nên **không** được mô tả command là "mang generation lớn hơn": command chỉ là wake-up để worker resolve lại authority.
- Redrive một delivery `blocked` → `dispatch_generation` tăng **đúng 1** và outbox row cũ được reset trong **cùng** batch; **không** có outbox row thứ hai, **không** có `message_id` mới.
- Redrive một delivery `sent`/`failed` → bị từ chối (`409`), không ghi gì.
- Vượt ngưỡng chu kỳ (`maxRecoveryCycles`) → mọi **re-dispatch không kèm override** (reconciler tự động, repair, redrive, DLQ replay) bị chặn + alert `Page`; chỉ còn đường xử lý **có authorize tường minh kèm override**, và ngân sách A **vẫn tăng** (monotonic) nên đường tự động không mở lại.
- `recovery_cycle_count` là ngân sách **A** — chỉ tăng, không bao giờ reset — cho mọi đường **re-dispatch** (reconciler re-dispatch, repair outbox `failed`, redrive, DLQ replay); `publish_attempts` reset mỗi chu kỳ publish và **không** thay thế nó — không có đường nào tự nới bound bằng cách reset một bộ đếm. Một lần publish lỗi, một Queue redelivery và một lease reclaim **không** tiêu một chu kỳ A.
- Ngân sách **B** ở worker (`mail_jobs.attempts`, bounded bởi `maxExecutionAttempts`, per `(delivery_id, dispatch_generation)`) chặn số execution cho một generation và reset khi generation đổi. B không tạo Queue command mới nên **không** bypass được A; composition của hai ngân sách cho worst case bound và tính được (`01-architecture.md` §6.5).
- Caller thiếu/invalid authentication → `401`; caller không có permission `delivery.redrive` → `403`.
- Không có đường nào khác ngoài endpoint redrive (hoặc tooling tương đương đã document) làm tăng `dispatch_generation` — đặc biệt, không có marker nào bị xoá ngầm để "mở khoá" một delivery.
- Outbox `failed` không bị xoá; alert khi `failed > 0` và có đường repair/replay tay (`03-operations.md` §5.4).
- Reconciler **tự động** không bao giờ re-enqueue một outbox row `failed` (nguồn guard của nó là `pending`/`publishing`/`published` — `published` chỉ phục vụ nhánh dispatch-incomplete `queued` + không có job, xem `01-architecture.md` §6.2.2 — và **không bao giờ** là `failed`); chỉ đường repair có authorize mới reset `failed`, nên không có đường tự động nào lách qua cổng authorize của repair.
- `POST /internal/outbox/publish` (**manual backup trigger — thiết kế, chưa implement**: contract là **implementation gate** ở `01-architecture.md` §10) đòi caller đã authenticate **và** permission `outbox.publish`: thiếu authentication → `401`, có authentication nhưng thiếu permission → `403`; endpoint không public và không nằm trong scope của `svc.transactional-mailer-job`.

---

### FR-005 — Private Delivery Interface

Service MUST cung cấp cho `transactional-mailer-job`:

`GET /internal/deliveries/:delivery_id` → runtime material: message (`delivery_id`, `message_id`, `app`, `status`, `recipient`, `subject`, `body`, `content_type`) và `dispatch_generation` — **không** provider credential.
`POST /internal/deliveries/:delivery_id/outcome` → `{ outcome: 'sent' | 'failed' | 'blocked', error_class?, dispatch_generation }`. `dispatch_generation` là **bắt buộc**.
`POST /internal/deliveries/:delivery_id/redrive` → thao tác có authorize để redrive delivery `blocked` (`01-architecture.md` §6.4); tăng `dispatch_generation` và reset outbox row.

`sent` = provider **đã chấp nhận** việc gửi, không phải bằng chứng thư tới inbox hay được đọc. `failed` = terminal **per-message**. `blocked` = điều kiện **system-level** (credential/cấu hình provider, **hoặc** ngân sách **B** của generation ở worker đã kiệt — `execution-budget-exhausted`), non-terminal, redrive được.

Interface là delivery lookup, không phải routing API; caller không authenticated (thiếu/invalid authentication) → `401`, caller đã authenticated nhưng không phải delivery worker → `403`.

Provider credential là Worker Secret của `transactional-mailer-job`; control plane **không** trả credential qua private interface, không giữ credential.

**`error_class` là input không tin cậy — phải validate, không bao giờ log nguyên văn.** Đây là field do caller gửi lên, và whitelist log của service cho phép error code, nên nếu ghi thẳng giá trị nhận được thì một worker lỗi (hoặc bị compromise) có thể đẩy recipient, nội dung thư hay tên template vào log của control plane — vi phạm bất biến "recipient/rendered content MUST NOT xuất hiện trong log". Vì vậy: control plane MUST validate `error_class` theo **đúng bộ phân loại đã định nghĩa** ở `docs/applications/transactional-mailer-job/03-operations.md` §3 — đúng năm class `retryable`/`permanent`/`credential`/`contract`/`internal-auth`, **không** chấp nhận chuỗi tự do; giá trị ngoài bộ đó → `400`, không ghi state. Khi log, chỉ ghi **giá trị đã validate** (đã là enum), không ghi nguyên văn rồi mới sanitize. Quy tắc này áp dụng cho cả error code ở các endpoint private khác. Giá trị `error_class` **đã validate** là thứ được persist vào `mail_messages.failure_reason` — đây là ánh xạ duy nhất, nên `failure_reason` không bao giờ chứa chuỗi tự do của caller.

Hai giá trị mà worker/control plane dùng **nội bộ** nhưng **không** phải là `error_class` hợp lệ trên outcome callback: `execution-budget-exhausted` (ngân sách **B** kiệt — worker chốt `blocked` nội bộ ở `docs/applications/transactional-mailer-job/01-architecture.md` §9.2.1 đường (c), control plane đã biết điều này qua durable state nên không cần field này trong outcome) và `delivery-not-found` (lookup `404` — một status, không phải outcome). Worker **không** gửi hai giá trị này qua `POST .../outcome`; control plane từ chối chúng (`400`) như mọi giá trị ngoài bộ.

#### Acceptance Criteria

- Caller đã authenticated và là `svc.transactional-mailer-job` được đọc runtime/ghi outcome.
- Caller không authenticated (thiếu hoặc invalid authentication) → `401`.
- Caller đã authenticated nhưng không phải `svc.transactional-mailer-job` → `403`.
- Delivery tồn tại → runtime material đúng; không tồn tại → `404`.
- Response không chứa provider credential, endpoint secret, hay token.
- Outcome không hợp lệ (thiếu `dispatch_generation`, `outcome` sai, hoặc `error_class` ngoài bộ phân loại canonical `docs/applications/transactional-mailer-job/03-operations.md` §3) → `400`.
- `error_class` ngoài bộ phân loại đã định nghĩa → `400`; log chỉ chứa giá trị enum đã validate, không chứa chuỗi tự do của caller (test bằng sentinel recipient trong `error_class`).
- Outcome lặp cùng generation cùng outcome → `{ result: 'duplicate' }`; outcome với generation lệch → `{ result: 'stale' }` — **stale không phải success** và không ghi gì.
- Outcome ghi bằng conditional write theo `dispatch_generation` + `status IN (accepted, queued)` — không read-then-write, không ghi đè outcome đến sau.
- Outcome chỉ chuyển `accepted|queued → sent|failed|blocked`; không lùi từ terminal về state khác; `blocked` không bao giờ tự chuyển thành terminal mà không qua redrive.

**Liên hệ đến contract library.** Shape của private interface (`GET /internal/deliveries/:delivery_id`, `POST .../outcome`) — bao gồm envelope, request, response, `error_class` trong tập canonical — **đã có code** trong `@ecoma-io/transactional-mail-contracts` (`libs/transactional-mail-contracts`, `src/delivery-interface.ts`). Validator đảm bảo kiểu và field lạ; phần còn lại (thứ tự phân loại, conditional write, behavior) là lớp dịch vụ (hiện chưa triển khai). Các giao thức công khai (redrive/outbox-publish) đều chưa chốt contract — không thêm vào library.

- Redrive chỉ nhận với delivery `blocked` có authorize; gọi cho delivery `sent`/`failed` → `409`; caller thiếu permission `delivery.redrive` → `403`.
- Callback cho delivery không tồn tại → `404`.

---

### FR-006 — Rate limit

Service MUST áp rate limit theo **authenticated principal** và một **system-wide sending limit** (tổng số mail gửi ra toàn hệ thống trong cửa sổ). Vượt limit → `429` kèm `Retry-After`.

**Enforcement phải durable, không node-local.** Bộ đếm/state của rate limit **MUST NOT** nằm trong memory của một isolate: một Worker nhiều isolate với state node-local sẽ vừa cho qua vượt ngưỡng vừa mất đếm khi isolate bị recycle (vi phạm invariant "không node-local application state"). Vì vậy enforcement phải dựa trên state dùng chung bền vững — D1 `mail` (đếm theo cửa sổ, ghi qua batch) hoặc một cơ chế platform có state dùng chung — và D1 `mail` phải là **authority**: ngưỡng/limit không được suy ra từ số liệu cục bộ.

**Ngưỡng và cửa sổ là giá trị vận hành chốt ở deploy**, cùng nhóm với `maxRecoveryCycles`/`maxExecutionAttempts`/`maxPublishAttempts`/backoff (`01-architecture.md` §6.5) — chốt ở runtime configuration (`03-operations.md` §3), **không** phải một quyết định kiến trúc còn mở. Cơ chế (durable, authoritative) là phần đã chốt; con số cụ thể không.

#### Acceptance Criteria

- Vượt rate limit theo principal → `429`, không tạo message.
- Vượt system-wide sending limit → `429` cho mọi principal.
- Response `429` kèm `Retry-After`; không tạo outbox row.

---

### FR-007 — Content retention và deletion

**v1 — không persist `variables`.** Worker render **một lần** tại request time: validate `variables` trong bộ nhớ, render an toàn, rồi chỉ persist `template_version` đã chọn + `subject_rendered`/`body_rendered`. `variables` **không** được ghi vào D1 `mail`, không vào log, không vào fingerprint dạng raw. Fingerprint idempotency là **HMAC canonical có khoá** của request (template name, locale đã chuẩn hoá, recipient chuẩn hoá, `variables` đã validate) — nó là một chiều và không phải bản sao raw của `variables`; vì sao phải có khoá, chủ sở hữu/rotation khoá và hành vi fail-closed → FR-002.

Recipient + nội dung đã render (`subject_rendered`, `body_rendered`) là dữ liệu nhạy cảm **khác** với operational metadata (status, timestamps, `delivery_id`, template version, error class). Hai loại có retention **tách biệt**.

**Đề xuất ban đầu (giá trị policy, CẦN VALIDATE — không phải chính sách đã được duyệt):** giữ recipient + nội dung render **7 ngày** sau khi message đạt trạng thái terminal (`sent`/`failed`), rồi xoá/redact; operational metadata giữ lâu hơn. Đây là **starting point đề xuất**, phải đối chiếu yêu cầu privacy/business của Ecoma trước khi chốt.

Cần chốt trước production: thời hạn cuối cùng cho content retention, cơ chế xoá/redact, và tuổi tối đa cho delivery đang dở (`queued`/`processing`/`blocked`) kèm alert.

**Delivery non-terminal tồn đọng:** nếu một delivery non-terminal (kể cả `blocked`) tồn đọng quá ngưỡng tới mức không thể xoá content mà vẫn bảo toàn khả năng recovery, phải sinh **alert** kèm remediation path rõ (điều tra vì sao kẹt, chốt trạng thái, rồi xoá/redact theo retention). Không được im lặng giữ content quá hạn.

Nếu sau này cần persist `variables` vì một use case vận hành cụ thể, phải phân loại `variables` là **sensitive content** kèm protection policy và retention policy riêng — không được coi là metadata thông thường.

#### Acceptance Criteria

- Có cấu hình retention riêng cho content (recipient/render) và operational metadata.
- Message terminal quá hạn retention → content bị xoá/redact, metadata còn.
- Delivery dở quá tuổi tối đa → sinh alert (không im lặng).
- Delivery non-terminal tồn đọng không thể xoá content an toàn → alert + remediation path, không im lặng giữ content quá hạn.
- Giá trị retention được ghi rõ là **đề xuất cần validate**, không phải cam kết compliance.
- Schema D1 `mail` **không** có cột `variables_json` (hoặc bất kỳ cột nào lưu raw `variables`), và `request_fingerprint` là `HMAC-SHA-256` có khoá (tiền tố `p1.k1:`), không phải hash trần; storage schema test assert điều này. **Phạm vi của lệnh cấm là raw _giá trị_ biến**, không phải mọi cột có tiền tố `variables_`: `mail_templates.variables_schema_json` (FR-003) là **metadata** khai báo tên/kiểu/giới hạn biến, **không** chứa giá trị biến nào, nên không thuộc lệnh cấm này — test phải phân biệt hai thứ, không so khớp tên theo substring.

---

## 2. Non-functional requirements

### NFR-001 — Không secret trong Queue/log

Recipient, rendered subject/body, variables, verification/reset tokens, provider credential và bearer tokens MUST NOT xuất hiện trong: Mail Command trên Queue, DLQ, log, error response.

Canonical Queue command chứa **chỉ** `version` + `delivery_id` (`01-architecture.md` §5). Delivery worker resolve recipient/subject/body **và `dispatch_generation`** từ control plane qua private interface — chúng không cần có trong Queue. Envelope **không** mang `dispatch_generation`: command là wake-up signal cho một `delivery_id`, không phải authorization token cho một generation.

Log chỉ chứa whitelisted fields.

#### Acceptance Criteria

- Contract test serialize command: assert chỉ có `version` + `delivery_id`, không có key cấm, không có recipient/credential/token/subject/body.
- Log chỉ chứa whitelisted fields; không trường nào chứa recipient/subject/credential/token.

---

### NFR-002 — At-least-once và idempotency

Mail Command trên Queue được giao **at-least-once** (`docs/architecture/04-platform-facts.md` QU1). Consumer idempotent theo `delivery_id`; replay cùng delivery không tạo logical delivery mới.

#### Acceptance Criteria

- Duplicate publish (cùng delivery_id) tới Queue an toàn.
- Duplicate message tới worker không gửi lại (kiểm tra ở `docs/applications/transactional-mailer-job/`).
- Crash window (worker nhận được nhưng chưa ack) được chấp nhận trong design.

---

### NFR-003 — Transaction qua `db.batch()`

Không dùng transaction tương tác. Mọi thao tác ghi đi qua `db.batch()` (transaction tương tác D1 chưa xác minh — `docs/architecture/01-architecture.md` §10).

#### Acceptance Criteria

- Mọi thao tác ghi của service đều nằm trong `batch()` — không có ghi ngoài batch.
- Batch fail → rollback toàn bộ, không ghi nửa batch.
- Không state node-local; không `ctx.waitUntil()` cho correctness write; không có `BEGIN`/`COMMIT` ngoài `db.batch()`.

---

## 3. Security requirements

### SR-001 — Principal không tới từ body

`app` và `principal_id` MUST đến từ authenticated principal. Body chỉ mang nghiệp vụ (`template`, `recipient`, `variables`...).

Caller được authenticate **trước** khi resolve principal; Service Binding chứng minh caller là Worker trong account, không chứng minh caller là service nào. Header principal là claim cần verify, không phải authentication.

**Cơ chế authentication canonical (đã merge; quyết định receiver đã chốt):** mechanism đầy đủ (chữ ký/credential, cách verify identity, integrity, freshness/replay) thuộc **canonical internal service authentication contract** — PR #197 (`fix(identity-contracts): unify internal HMAC contract and durable replay protection`) **đã merge** vào `main` ở `97b85b9` (2026-10-15) và đã được đối chiếu các hằng ở `01-architecture.md` §7.4. Service này **không** định nghĩa protocol cạnh tranh, **không** coi header `X-ECOMA-PRINCIPAL` do caller kiểm soát là authentication. Cách phân biệt consumer phía receiver đã chốt ở `01-architecture.md` §7.4 (credential registry theo từng consumer, principal suy ra từ credential khớp); **private interface vẫn release-blocked** cho tới khi runtime implement xong (`01-architecture.md` §7.4/§7.5).

**Cảnh báo implementer (MUST, không phải MUST NOT):** kể từ khi PR #197 merge, `main` **chính là** bản canonical — `libs/internal-auth-contracts/src/internal-auth.ts` là bản cài đặt duy nhất; `account-contracts` và `auth-contracts` re-export lại từ đó nên mọi đường import (`@ecoma-io/internal-auth-contracts`, `@ecoma-io/account-contracts`, `@ecoma-io/auth-contracts`) là **cùng một** bản cài đặt. Consumer chéo BC (như `transactional-mail`) import thẳng `@ecoma-io/internal-auth-contracts`. Ba hằng phải đối chiếu trước khi release: `PROTOCOL_ID = 'ecoma-internal-v2'`, dòng `proto` trong chuỗi canonical, và đơn vị length-prefix là **byte UTF-8** (`01-architecture.md` §7.4). Cả hai package chỉ khai `exports["."]` — deep subpath bị từ chối (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Contract **không** mang caller/principal trong envelope, nên việc phân biệt consumer là việc của receiver (`01-architecture.md` §7.4), không phải việc bổ sung trường vào canonical string. Contract có thêm header tuỳ chọn `x-ecoma-internal-kid` (`SignRequestInput.kid`) là **chỉ dẫn chọn khoá**, **không** phải trường đã ký — nó **không** thay đổi canonical string và **không** mang principal.

**Yêu cầu authentication/integrity (áp dụng cho mọi API của service cần authentication — bao gồm cả `POST /v1/messages`/`GET /v1/messages/:id` vốn không nằm dưới `/internal`):**

- **Authenticate, không chỉ định danh.** Request phải được authenticate (identity + integrity), không chỉ dựa vào việc "đi qua Service Binding". Service Binding chứng minh caller là Worker trong account, **không** chứng minh caller là service nào.
- **Thành phần được bảo vệ toàn vẹn (MUST):** HTTP method, đường dẫn/`delivery_id`, body đã canonicalize, timestamp, và (với outcome) `dispatch_generation`. Đổi bất kỳ thành phần nào phải làm verification thất bại.
- **Freshness/replay:** request phải có timestamp + cơ chế chống replay (nonce/idempotency của request) với cửa sổ hạn dùng đủ ngắn; request ngoài cửa sổ bị từ chối. Điều này áp cho **mọi** API vừa liệt kê, không chỉ đường delivery: `POST /v1/messages`, `GET /v1/messages/:id`, `GET /internal/deliveries/:delivery_id`, `POST .../outcome`, `POST .../redrive`, và `POST /internal/outbox/publish`. Riêng `GET /v1/messages/:id` thì freshness cũng áp, nhưng **contract response của nó vẫn chưa chốt** (`01-architecture.md` §10) — không viết handler theo suy đoán. Không endpoint nào trong số này được public, và ở trong `/internal` **không** phải là một lớp bảo vệ.
- **Scope credential theo service + environment:** mỗi consumer có credential/service identity **riêng**, scoped theo service và environment; secret **không** kế thừa giữa environments (`docs/architecture/04-platform-facts.md` WS3); production secret không vào PR build hay Preview runtime.
- **Rotation/revocation:** rotation của credential nội bộ MUST khả thi mà không cần sửa logic nghiệp vụ của service này; revocation MUST loại được một consumer mà không ảnh hưởng các consumer khác.
- **`401` vs `403`:** thiếu hoặc invalid authentication → `401`; đã authenticate nhưng không được authorize cho operation/template → `403`. Response không tiết lộ chi tiết nội bộ giúp dò (không phân biệt "credential sai" vs "credential hết hạn" theo cách hữu ích cho attacker).

**Authorization theo caller (v1):**

| Caller                                                     | Operation                                                                  | Permission                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`, `auth`, `payment`                               | `POST /v1/messages`                                                        | Chỉ những logical template đã approve cho principal đó (allowlist per principal trong credential registry — đã implement, xem dưới); **không** redrive, **không** đọc private interface |
| `account`, `auth`, `payment`                               | `GET /v1/messages/:id` **(contract chưa chốt — `01-architecture.md` §10)** | Chỉ message thuộc chính principal đó (message của principal khác → `404`) — **mệnh đề bảo mật, không phải response contract**; shape/status code ngoài `404` chưa định nghĩa            |
| `transactional-mailer-job`                                 | `GET /internal/deliveries/:delivery_id`                                    | Chỉ resolve runtime material — không tạo message, không sửa template, không đổi recipient                                                                                               |
| `transactional-mailer-job`                                 | `POST /internal/deliveries/:delivery_id/outcome`                           | Chỉ báo outcome cho `delivery_id` của delivery được authorize                                                                                                                           |
| Caller có permission `delivery.redrive` (chưa chốt)        | `POST /internal/deliveries/:delivery_id/redrive`                           | Redrive delivery `blocked` — **không** dùng chung credential với consumer thường; caller/permission model là **implementation gate** (`01-architecture.md` §7.5)                        |
| Caller vận hành có permission `outbox.publish` (chưa chốt) | `POST /internal/outbox/publish`                                            | Chạy publish loop như manual backup trigger — **không** bump generation, **không** đưa delivery `blocked` về eligible; caller/mechanism là **implementation gate** như redrive          |

**Trạng thái implement của authorization theo template (hàng `POST /v1/messages`):** route enforce ở bước 4 của thứ tự FR-001 — sau validate shape, trước rate limit/idempotency/template lookup/persist. Allowlist per principal khai tường minh trong credential registry của service (`config.ts`), **evidence-based**: chỉ principal có bằng chứng dùng thật mới được grant (v1: `svc.account` → `account.login-otp`, chứng minh bởi `OTP_LOGIN_TEMPLATE` + seed migration `0009`; `svc.auth`/`svc.payment` → rỗng cho tới khi có template được approve). Principal không có trong allowlist (hoặc allowlist rỗng) nhận `403` với một message hằng — không phân biệt "template của principal khác" với "template chưa approve", vì sự phân biệt đó là oracle liệt kê catalog. Payload không có đường nào đổi verdict: allowlist là config boot-time server-controlled, body chỉ được so khớp.

#### Acceptance Criteria

- Body có chứa `app` khác → bị bỏ qua, không ảnh hưởng ghi nhận.
- Thiếu credential caller hoặc caller không authenticate được → `401`.
- Caller không có permission với template/operation → `403`.
- Template không nằm trong allowlist của principal (kể cả template tồn tại trong catalog, và kể cả replay trên key đã dùng) → `403` trước mọi persistence; allowlist rỗng nghĩa là mọi template đều `403` (fail-closed).
- Request body hoặc unverified header không thể thay đổi principal hay permissions.
- Request đã bị sửa (method/path/`delivery_id`/body/timestamp/`dispatch_generation`) → verification fail, `401`.
- Request phát lại (replay) ngoài cửa sổ freshness → bị từ chối.
- Revoke credential của một consumer → consumer đó `401`, các consumer còn lại không bị ảnh hưởng. **AC này đã có quyết định receiver phủ** (keyring per consumer — `01-architecture.md` §7.4) nhưng **chưa** có code chạy: vẫn là release gate cho tới khi registry + kho nonce được implement và danh sách test bắt buộc ở `01-architecture.md` §7.4 chạy xanh trong PR runtime. Chưa implement thì **không** coi SR-001 đạt.
- `transactional-mailer-job` không thể gọi `POST /v1/messages` hay `redrive` (`403`).

---

### SR-002 — Cô lập giữa các consumer

Message thuộc đúng authenticated principal. `GET /v1/messages/:id` của principal khác → `404`.

> **Provisional — chưa phải contract đã chốt.** Điều SR-002 cam kết ở đây là **tính chất cô lập** (không đọc được message của principal khác), chứ **không** phải response shape/status code của endpoint. Contract đầy đủ của `GET /v1/messages/:id` (response body, các status code khác, "thông tin tối thiểu" liệt kê dưới Acceptance Criteria) vẫn là **mục chưa chốt** ở `01-architecture.md` §10 — **không** viết handler theo suy đoán; hoặc bổ sung FR định nghĩa contract, hoặc bỏ endpoint khỏi phạm vi v1, quyết định trước khi implement.
>
> **Phạm vi implementation v1 (đã chốt):** `GET /v1/messages/:id` **không thuộc v1** — không có FR định nghĩa response shape và không có caller nào gọi nó trong repo, nên endpoint không được implement theo suy đoán. Hàng §10 "Contract của `GET /v1/messages/:id`" giữ nguyên trạng thái chờ; nếu sau này có nhu cầu thực tế, phải bổ sung FR trước rồi mới viết handler.

Mỗi consumer `account`, `auth`, `payment` phải có credential/service identity riêng — không dùng chung một generic consumer credential.

#### Acceptance Criteria

- Principal A không đọc được message của principal B.
- `GET` trả thông tin tối thiểu (không kèm recipient/payload khi không cần).
- Không có credential nào được dùng để authenticate cả ba consumer.

---

### SR-003 — Migration an toàn

Schema D1 `mail` thay đổi theo expand → compatible rollout → contract, không down-migrate (`docs/architecture/01-architecture.md` invariant 10; track D1 → `docs/architecture/02-delivery.md` §3). Không service khác truy cập D1 `mail` (`docs/architecture/01-architecture.md` invariant 7); service không có path tới PostgreSQL.

---

### SR-004 — Provider credential ownership

Provider credential và endpoint là Worker Secret của `transactional-mailer-job`, không phải của control plane. Control plane **không** giữ, không decrypt, không truyền credential.

Private interface response KHÔNG chứa provider credential, endpoint secret, token.

#### Acceptance Criteria

- Private interface response không có field credential/endpoint/token.
- Credential không xuất hiện trong Queue, DLQ, log, error response.
- Control plane không có binding secret nào tới relay provider.

---

## 4. Constraints

### CR-001 — Không thêm dependency

Service phải chạy với dependency hiện có của repo; không bổ sung runtime dependency mới.

#### Acceptance Criteria

- Không có thêm package nào trong dependencies của app.

---

### CR-002 — Giới hạn platform

- Render payload vượt ngưỡng service → `413` trước khi enqueue; ngưỡng dưới giới hạn Queue message (`docs/architecture/04-platform-facts.md` QU6).
- Message payload Queue giữ nhỏ — chỉ `version` + `delivery_id`; mỗi environment (`development`, `staging`, `production`) có D1 `mail`, Queue `ecoma-mail-delivery` và bộ secret riêng, không chia sẻ.
- Ghi D1 phải nằm trong giới hạn statement/bound parameter/row size và số query mỗi invocation (`docs/architecture/04-platform-facts.md` DB4) — ghi theo batch, không loop từng row.

---

## 5. Non-goals

- Không yêu cầu gọi provider, retry hay delivery quota — thuộc `docs/applications/transactional-mailer-job/`.
- Không yêu cầu template admin CRUD (hiện seed; chưa chốt → [`01-architecture.md`](./01-architecture.md) §10).
- Không yêu cầu chọn provider/relay (chưa chốt → [`01-architecture.md`](./01-architecture.md) §10).
- Không yêu cầu backup/restore D1 `mail` — chính sách → `docs/architecture/03-operations.md` §3.1.
- Không render lại template trên delivery path, không reroute provider, không đọc D1 `mail` từ delivery worker.
- Không thay đổi `dispatch_generation` ngoài redrive có authorize của control plane.
- Ranh giới trách nhiệm đầy đủ → [`01-architecture.md`](./01-architecture.md) §2.2.
