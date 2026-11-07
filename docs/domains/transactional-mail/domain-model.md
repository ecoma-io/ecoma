# Domain Model — Transactional Mail

## 1. Mục đích và phạm vi

`transactional-mail` là bounded context điều khiển việc gửi email giao dịch của Ecoma. Context này chịu trách nhiệm:

- Quản lý `Mail Template` (mẫu email), `Mail Message` (đồng điệp đã render) và `Mail Outbox` (bản ghi bàn giao một delivery cho delivery plane).
- Nhận yêu cầu gửi mail từ consumer (`account`, `auth`, `payment`) qua contract, render template và ghi domain state của message.

Context này **không** thực hiện mail delivery thực sự — đó là trách nhiệm của delivery plane (`transactional-mailer-job`). Control plane không gọi provider trên request path và không giữ provider credential; cơ chế lưu trữ, hàng đợi, trigger và custody credential → [`docs/applications/transactional-mail/`](../../applications/transactional-mail/README.md) và [`docs/applications/transactional-mailer-job/`](../../applications/transactional-mailer-job/README.md).

## 2. Ngôn ngữ dùng chung (ubiquitous language)

| Thuật ngữ             | Nghĩa trong Ecoma                                                                                                    | Ghi chú                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Mail Template`       | Mẫu email có version, mỗi version có `subject_template`, `body_template`, `variables_schema_json`, locale            | Template là versioned (name + locale + version); chọn deterministic theo `(name, locale)` |
| `Mail Message`        | Đồng điệp giao dịch đã render từ template; `message_id` là định danh                                                 | Consumer tạo qua contract của context, không qua dữ liệu nội bộ                           |
| `Message intent`      | Ý định gửi mail của consumer (template, recipient, variables, locale, correlation_id)                                | `app` và `principal_id` lấy từ authenticated principal, không từ body                     |
| `Mail Outbox`         | Bản ghi bàn giao một delivery cho delivery plane                                                                     | Trạng thái publish là **execution state**, không phải trạng thái delivery (§5.3)          |
| `Delivery`            | Một lần gửi mail thực sự; `delivery_id` là định danh logical                                                         | `delivery_id` không phải API idempotency key                                              |
| `Idempotency-Key`     | Khóa do caller cấp để deduplicate request                                                                            | Scope là `(principal_id, idempotency_key)`; principal do server kiểm soát                 |
| `Request fingerprint` | Dấu vân tay một chiều của canonical request (template, locale chuẩn hoá, recipient chuẩn hoá, variables đã validate) | Một chiều, không phải bản sao raw của variables; cơ chế tính → application layer          |
| `blocked`             | Trạng thái non-terminal cho điều kiện system-level (credential/cấu hình provider, hoặc ngân sách execution đã kiệt)  | Không bao giờ đồng nghĩa thất bại vĩnh viễn; không thay thế `failed` cho lỗi per-message  |

## 3. Khái niệm và quan hệ

- `Mail Template` là versioned (tên + locale + version); mỗi version có schema biến riêng (`variables_schema_json`).
- Mỗi `Mail Message` tham chiếu một template version đã chọn; nội dung render được persist cùng message.
- Một message có một `delivery_id` duy nhất; `delivery_id` là định danh logical của việc giao.
- Outbox record liên kết với message qua `delivery_id`; mỗi outbox item được claim bởi đúng một publisher.
- `account`, `auth`, `payment` là consumer tạo message qua contract; chúng không truy cập dữ liệu nội bộ hay hàng đợi của context này.

## 4. Entity, aggregate và value object

- **`Mail Template`** — aggregate root: `template` (tên logical), `locale`, `version`, `subject_template`, `body_template`, `variables_schema_json`, status (`active`/`disabled`).
- **`Mail Message`** — aggregate root: `message_id`, `delivery_id`, `app`, `template` (tên logical), `template_version`, `status` (`accepted`/`queued`/`sent`/`failed`/`blocked`), `subject_rendered`, `body_rendered`, `request_fingerprint`, `created_at`.
- **`Mail Outbox`** — entity: bản ghi bàn giao một `Mail Command` cho delivery plane; mang trạng thái publish và số lần publish đã thử (§5.2).

## 5. Lifecycle và state transition

### 5.1 Mail Message business lifecycle

```text
accepted ──> queued ──> sent
                 │        └──> failed (terminal, per-message)
                 └──> blocked (non-terminal, system-level)
```

- `accepted` = request đã được chấp nhận bền vững và generation khởi tạo đã ghi; publisher chưa ghi nhận bàn giao thành công cho generation này.
- `queued` = generation hiện tại đã được authorize và đang in-flight. `queued` **không** có nghĩa "lần bàn giao đã thành công" — đó là trạng thái của outbox layer — mà nghĩa là generation hiện tại đang eligible cho dispatch.
- `sent` = provider đã chấp nhận việc gửi (không phải bằng chứng thư tới inbox hay được đọc).
- `failed` = terminal per-message.
- `blocked` = non-terminal cho điều kiện system-level (credential/cấu hình provider, hoặc ngân sách execution của generation đã kiệt). Redrive được.

### 5.2 Outbox publish lifecycle (execution state)

- Bản ghi outbox chuyển từ "chờ bàn giao" sang "đang bàn giao" rồi "đã bàn giao"; một lần bàn giao lặp lại vượt ngưỡng chuyển sang "bỏ cuộc tự động nhưng còn phục hồi được".
- Với mỗi `delivery_id`, tối đa một outbox record đang chờ bàn giao được tồn tại (ràng buộc chống dồn intent).
- Tên state cụ thể, cách claim và ngưỡng publish → [`docs/applications/transactional-mail/01-architecture.md`](../../applications/transactional-mail/01-architecture.md) §6.

### 5.3 Hai layer trạng thái là độc lập

- Outbox state là **việc đã bàn giao delivery cho delivery plane hay chưa**; message state là **trạng thái của delivery**, do control plane cập nhật từ outcome callback của worker. Hai layer có thể lệch nhau và **không bao giờ ghi lên nhau**.
- Outbox "đã bàn giao" chỉ có nghĩa delivery đã được chuyển đi thành công — message vẫn `queued` cho đến khi worker báo outcome. Outbox "bỏ cuộc tự động" **không** phải mất delivery intent: outbox record và message vẫn còn, recovery là repair + replay có kiểm soát.
- Worker của delivery plane có thể báo outcome **trước khi** outbox ghi nhận bàn giao thành công (crash giữa hai bước); ngược lại outbox có thể đã bàn giao trong khi message còn `queued` lâu.
- Publish state **không bao giờ** ghi lên delivery outcome: publisher chỉ ghi outbox + message `queued`, không bao giờ ghi `sent`/`failed`/`blocked`. Chỉ outcome callback ghi các trạng thái terminal, và callback lặp **cùng** outcome trên trạng thái đã bằng outcome đó là `duplicate` — không lùi trạng thái, không phụ thuộc thứ tự callback đến.

## 6. Business policy, rule và invariant

### 6.1 Tạo message

- Thứ tự kiểm tra cố định: **Authenticate → Authorize → Validate shape → Authorize theo template → Rate limit → Đọc row idempotent → Chọn template version + validate variables → Persist**.
- `app` và `principal_id` lấy từ authenticated principal; `app` trong body bị bỏ qua; body hoặc unverified header không thể thay đổi principal.
- `Idempotency-Key` bắt buộc và có giới hạn độ dài. Scope uniqueness là `(principal_id, idempotency_key)`; giá trị giới hạn cụ thể → [`docs/applications/transactional-mail/02-requirements.md`](../../applications/transactional-mail/02-requirements.md).
- Canonical request fingerprint là dấu vân tay một chiều của: tên template logic, locale đã chuẩn hoá, recipient chuẩn hoá, variables đã validate. Canonical profile dùng để tính → [`docs/applications/transactional-mail/02-requirements.md`](../../applications/transactional-mail/02-requirements.md) FR-002.
- Fingerprint dùng chuỗi locale đã chuẩn hoá (sau các bước chuẩn hoá), không phải giá trị nguyên văn từ request.
- Không đưa vào fingerprint: template version do server chọn, `correlation_id` (trừ khi API contract cho nó ý nghĩa nghiệp vụ), metadata tracing khác.
- Replay cùng principal + cùng key + cùng fingerprint → trả kết quả gốc, không tạo message hay outbox mới. Cùng key + fingerprint khác → từ chối là xung đột.
- Template không active/không tồn tại → từ chối là không tìm thấy. Replay của request đã tạo thành công không bao giờ gặp kết quả "không tìm thấy" dù template đã bị disable/delete sau đó.
- HTTP surface, status code và shape lỗi → [`docs/applications/transactional-mail/02-requirements.md`](../../applications/transactional-mail/02-requirements.md).

### 6.2 Render từ template

- Chọn template `active` theo `(name, locale)`; nhiều version active cùng `(name, locale)` → version cao nhất thắng (deterministic).
- Template chỉ do principal đã authorize được dùng; template là versioned, chọn deterministic.
- `variables` validate theo `variables_schema_json` của template version đã chọn; không tự ép kiểu (`1` khác `"1"`).
- Render một lượt; giá trị biến chứa `{{ ... }}` không được render lại lần hai; HTML escape đúng một lần theo output context.
- Biến vào vị trí URL (`href`/`src`/`action`) phải khai báo `format: "url"`, là absolute URL scheme `https`, hostname khớp allowlist theo ranh giới nhãn.
- Biến subject chứa CR/LF hoặc control character → từ chối là request không hợp lệ.
- Render vượt ngưỡng kích thước payload → từ chối vì payload quá lớn trước khi ghi; ngưỡng số/độ dài biến vượt giới hạn → từ chối là request không hợp lệ.

### 6.3 Idempotency (nghiệp vụ)

- Scope idempotency là `(principal_id, idempotency_key)` — principal do server kiểm soát trực tiếp, không dựa trên caller-supplied `app`.
- Fingerprint là **có khoá** (không phải hash trần) và **fail-closed** khi thiếu khoá. Cơ chế khoá, keyring và định danh profile → [`docs/applications/transactional-mail/02-requirements.md`](../../applications/transactional-mail/02-requirements.md) FR-002.
- Xoay khoá fingerprint không được phá replay: message tạo bằng khoá cũ vẫn replay được bằng đúng request đó sau khi khoá mới được thêm vào keyring; request mới dùng khoá hiện hành.
- `variables` không bao giờ được persist dạng raw; `request_fingerprint` là một chiều, không chứa raw variables, nội dung render, token hay credential.
- Rate limit theo `(principal_id, idempotency_key)` cho các lần thử bị từ chối vì xung đột (không chỉ theo principal); security alert khi cùng key sinh chuỗi fingerprint-mismatch lặp lại.
- **Replay hợp lệ không bao giờ bị rate limit cắt:** khi `(principal_id, idempotency_key)` đã có row, service so fingerprint và trả kết quả gốc hoặc từ chối xung đột **trước** khi áp rate limit — replay là không ghi gì nên không được trả về "bị giới hạn tần suất".
- `{}` và "không truyền `variables`" là **cùng một** request nghiệp vụ "không có biến" → cùng fingerprint; không tồn tại ba trạng thái cho cùng một ngữ nghĩa.
- Chuẩn hoá `recipient` và `locale` là **một hàm duy nhất** dùng cho cả fingerprint lẫn lưu trữ/chọn template — không tồn tại hai chuẩn hoá khác nhau cho cùng một giá trị. Recipient: trim, từ chối chuỗi rỗng/không có đúng một `@`/chứa control character, lowercase **domain** (IDN về A-label trước), giữ nguyên và phân biệt hoa/thường **local-part**; **không** strip dot, **không** strip plus-tag, **không** áp rule riêng của provider — service không sở hữu semantics đó. Hệ quả được chấp nhận có chủ đích: nếu provider coi hai mailbox khác hoa/thường là một, hậu quả tệ nhất là gửi dư, không phải dedupe sai hai request khác nhau.

### 6.4 Rate limit

- Rate limit theo authenticated principal và một system-wide sending limit. Vượt limit → từ chối kèm chỉ dẫn thời điểm thử lại.
- Enforcement phải durable, không node-local; trạng thái giới hạn bền vững là authority.

### 6.5 Content retention và deletion (v1)

- Không persist `variables`; chỉ persist `template_version` đã chọn + `subject_rendered`/`body_rendered`.
- Recipient + nội dung render là dữ liệu nhạy cảm; operational metadata (status, timestamps, `delivery_id`, template version, error class) có retention tách riêng.
- Đề xuất ban đầu (cần validate): giữ recipient + nội dung render 7 ngày sau khi message đạt trạng thái terminal (`sent`/`failed`), rồi xoá/redact; operational metadata giữ lâu hơn.
- Delivery non-terminal tồn đọng quá ngưỡng → sinh alert (không im lặng giữ content quá hạn).

### 6.6 Invariants (kinh doanh)

1. Trạng thái nghiệp vụ bền vững là source of truth của domain state; delivery plane không bao giờ là authority.
2. Mỗi outbox item được claim bởi đúng một publisher.
3. `(principal_id, idempotency_key)` là duy nhất và bảo vệ replay: cùng key trả message cũ, không tạo outbox mới. Scope là authenticated principal + key — không dùng caller-supplied `app`.
4. Principal do server kiểm soát; `app` trong body bị bỏ qua (không bao giờ tin body).
5. `blocked` là trạng thái non-terminal cho điều kiện system-level; không bao giờ đồng nghĩa thất bại vĩnh viễn và không bao giờ thay thế `failed` cho lỗi per-message.
6. Recipient, rendered subject/body, variables, verification/reset token và provider credential không bao giờ nằm trong delivery command, dead-letter queue hay log. Delivery command chỉ chứa định danh đủ để delivery plane nhận việc.
7. Delivery command là wake-up signal, không phải authorization token. Envelope không mang generation của delivery.
8. Control plane không gọi provider trên request path; bàn giao chỉ xảy ra qua outbox sau commit.
9. Không state node-local cho correctness write.
10. Không transaction tương tác — chỉ batch nguyên tử.
11. Outbox claim và publish luôn sau commit; không network call nào nằm trong batch nguyên tử.
12. Không đọc/ghi dữ liệu của context khác; không có path tới storage của context khác.
13. Secret của service không vào Git/PR build/Preview runtime production.
14. Chỉ một đường làm tăng generation của delivery: redrive có authorize. Re-dispatch tự động và retry của publisher không bao giờ tăng generation.
15. Publisher không bao giờ ghi `queued` đè `sent`/`failed`/`blocked`, và outcome callback không bao giờ lùi trạng thái hay ghi đè outcome của generation mới hơn.
16. Recovery bị chặn bởi hai ngân sách bù nhau: ngân sách phục hồi chu kỳ chặn mọi lần re-dispatch, và ngân sách execution chặn số lần thử cho một generation ở delivery plane. Giá trị cấu hình cụ thể → [`docs/applications/transactional-mail/03-operations.md`](../../applications/transactional-mail/03-operations.md).
17. `variables` không bao giờ được persist; `request_fingerprint` là dấu vân tay một chiều có khoá, không phải hash trần.

## 7. Actor, authority và business permission

- Consumer `account`, `auth`, `payment` có quyền tạo message chỉ cho logical template đã approve cho principal đó (allowlist per principal trong credential registry).
- `transactional-mailer-job` có quyền đọc runtime material của một delivery và báo outcome; không có quyền publish outbox, không có quyền redrive, không tạo được message.
- Caller của `delivery.redrive` và `outbox.publish` chưa được định nghĩa — implementation gate, chờ backoffice định nghĩa permission catalog.
- Message của principal khác → không tìm thấy (cô lập giữa consumer).

## 8. Domain events và semantic contracts

- `Message accepted` — tạo `Mail Message`, phân biệt tạo mới với replay idempotent.
- Error envelope canonical: `{ "error": { "code": "...", "message": "..." } }`; tập `code` là enum đóng và tập đó chỉ được mở rộng khi có quyết định ở canonical contract. Danh sách code → [`docs/applications/transactional-mail/02-requirements.md`](../../applications/transactional-mail/02-requirements.md).
- `Mail Command` bàn giao cho delivery plane chỉ chứa `version` + `delivery_id`; không chứa secret/recipient/credential/subject/body/template metadata.
- Private delivery interface: đọc runtime material của một delivery (không provider credential) và báo outcome `sent`/`failed`/`blocked` kèm `error_class`. Hình dạng request/response → [`docs/applications/transactional-mail/02-requirements.md`](../../applications/transactional-mail/02-requirements.md) FR-005.
- Kết quả của outcome callback được phân biệt tường minh: `applied` / `duplicate` / `stale` / không tìm thấy / request không hợp lệ. **`stale` không phải success** — generation lệch hoặc trái trạng thái terminal hiện tại thì callback ghi `stale` và **không ghi gì**; hai callback của hai generation đến lệch thứ tự thì giữ kết quả của generation hiện tại.
- Message mới khởi tạo ở generation 1 và ở mức tiêu thụ ngân sách phục hồi bằng 0; bộ đếm ngân sách phục hồi chỉ tăng (monotonic), không reset.

## 9. Business exceptions, correction và compensation

- **Redrive** (`blocked → queued`): `blocked` là non-terminal nhưng **không bao giờ tự gửi lại chỉ vì hết thời gian** — redrive là thao tác control-plane có authorize tường minh, không phải việc xoá marker một cách ngầm hiểu. Redrive mở một generation mới đúng một bước, đặt lại outbox record trong cùng một thao tác, và không tạo delivery mới. Chỉ áp dụng khi `status = blocked`; `sent`/`failed` → từ chối. Ở ngưỡng ngân sách: không kèm override → từ chối + alert; có authorize kèm override → đi tiếp, bộ đếm ngân sách phục hồi vẫn tăng (monotonic, không reset).
- **Ghi nhận kiểm toán của redrive:** actor, thời điểm, lý do, `delivery_id`, generation cũ và mới — để phân biệt redrive có chủ đích với re-dispatch tự động. Bản ghi kiểm toán **không** chứa recipient, nội dung render, token hay credential.
- **Repair** (outbox record bỏ cuộc → bàn giao lại): reset chính record đó (cùng `delivery_id`, cùng generation), tiêu một slot của ngân sách phục hồi chu kỳ; đây là đường duy nhất reset trạng thái bỏ cuộc.
- **DLQ replay**: không phải đường recovery riêng; phải đi qua cùng thao tác control-plane có guard đã áp dụng cho state hiện tại (reconcile cùng generation, redrive có authorize, hoặc repair có authorize). Delivery đã `sent` không bao giờ được gửi lại chỉ vì có entry DLQ.

## 10. Điểm nghiệp vụ chưa chốt

- CRUD template (Admin API) — chưa có admin surface; hiện template seed.
- Contract đọc một message theo `message_id` — chưa chốt; phạm vi implementation v1: không implement.
- Contract của thao tác publish outbox — chưa chốt; implementation gate.
- Redrive caller & permission — chưa chốt; chờ backoffice định nghĩa permission catalog.
- Repair caller & permission — chưa chốt; cùng trạng thái với redrive.
- Quyền cho quyết định phá huỷ ở DLQ — chưa chốt; fail-closed (không xoá, không quarantine).
- Giá trị retention cụ thể cho content (recipient/render) — đề xuất 7 ngày, cần validate trước production.
- Khoá fingerprint theo từng environment và chu kỳ rotation cụ thể — đặt ở bước deploy; cơ chế và ràng buộc → [`docs/applications/transactional-mail/03-operations.md`](../../applications/transactional-mail/03-operations.md).
