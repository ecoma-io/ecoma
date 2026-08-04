---
title: "RPA: Sandbox & Credential"
status: design-end-state
canonical-sha: f88e5cf3ec53
---

# RPA: Sandbox & Credential

## 1. Sandbox — mỗi session một chuồng

| Môi trường | Cơ chế cách ly                                                         |
| ---------- | ---------------------------------------------------------------------- |
| Browser    | Profile/container riêng mỗi session: cookie, storage, extension cô lập |
| Desktop    | VM / user-session chuyên dụng; taxonomy mở theo driver                 |

- Mức cách ly là tham số cascade (engine ép tồn tại; template cấp: chặt cho production, lỏng cho dev).
- Sandbox chết cùng session trừ khi khai `persistent_profile` (đăng nhập giữ phiên dài) — profile bền là tài nguyên có id, gắn credential scope riêng.
- **Một giới hạn được nêu rõ, vì nội dung của profile không phải thứ vault thu hồi được**: thứ thu hồi được là credential scope phía ecoma của profile; cookie/token phiên **bên trong** profile là trạng thái đã đăng nhập của _hệ đích_, nằm trên đĩa của node. Trên node attended đĩa đó là laptop nhân sự người ta cầm trong tay, nên khi node bị decommission hoặc thu hồi khẩn cấp (RPA North Star §4), cắt khóa của nó chặn việc tương lai nhưng **không với tới các login đã nằm trong profile** — chẳng gì với tới được, giả vờ ngược lại là cách đọc nguy hiểm. Cơ chế thực sự với tới chúng được nêu rõ chứ không để ngầm: decommission một node giữ `persistent_profile` **đi kèm một compensation Task** xoay/thu hồi credential hệ-đích trong credential scope của profile đó. Không khai thì credential bị coi là vẫn còn sống — cách đọc bảo thủ, nhất quán với reversibility-không-khai-là-irreversible.
- **Network egress policy** thuộc sandbox: allowlist domain — session không đi lang thang được ra ngoài scope.

## 2. Credential vault

- Secret sống duy nhất trong vault (standalone: vault nội bộ; tích hợp/enterprise: adapter sang vault ngoài — taxonomy mở). Action chỉ tham chiếu **credential handle** (Action spec §3).
- **Injection tại tầng driver**: runtime tự gõ/điền giá trị vào field đích ở tầng thấp nhất — executor (script _và_ agent) chỉ ra lệnh "điền credential X vào field Y", **không bao giờ chạm giá trị**.
- Mỗi lần dùng handle ghi audit entry (handle, action, session, actor) — không bao giờ ghi giá trị.
- Handle cấp theo session scope (Session §7): session không được cấp thì không thể yêu cầu.

## 3. Masking tại nguồn — một chốt chặn duy nhất

- Tầng perception đánh dấu vùng nhạy cảm **trước khi Scene rời perception** (Driver spec §2): field type từ structural tree (password, card…), vùng do App Profile tag, pattern detector (số thẻ, token) — ba nguồn, taxonomy mở.
- Hệ quả: agent context, action log, evidence, replay, screenshot cho người xem — **tất cả chỉ từng thấy scene sạch**. Không tồn tại bước "redact hậu kỳ" (hậu kỳ = đã rò).
- **Input masking đối xứng với perception masking**: không chỉ scene — mọi input được _capture_ (human takeover, record mode) gõ vào field được tag nhạy cảm đều bị redact thành `[masked:field-type]` **ngay tại tầng capture**, trước khi trở thành Action params trong log. Người gõ mật khẩu của chính họ khi takeover: hành động được ghi, giá trị không bao giờ được ghi — cùng ba nguồn tag (field type / App Profile / pattern detector).
- **Kênh live-view khi takeover cũng chỉ thấy Scene sạch**: luồng xem/điều khiển mở theo từng phiên (RPA North Star §4) là **projection của Scene đã masking**, **không bao giờ** là framebuffer/screencast thô — nếu không, người trợ giúp từ xa trở thành consumer thứ tư đứng ngoài chốt chặn duy nhất. Driver không cấp được live-view đã masking → takeover chỉ hợp lệ ở dạng **attended** (người ngồi tại chính máy đó, vốn đã thấy màn hình thật của mình), **không mở kênh xem từ xa**: thiếu năng lực thì chặt hơn, không lỏng hơn (K5).
- Đánh đổi công khai: masking sót là rủi ro thật → pattern detector có version + calibration (đo bằng hậu kiểm mẫu), và App Profile là nơi vá vĩnh viễn vùng sót.

## 4. Permission scope — quyền là khai báo

Session scope (engine ép tồn tại, cascade cấp giá trị):

| Chiều              | Ví dụ                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| App/domain         | Chỉ `*.salesforce.com`                                                  |
| Lớp action tối đa  | `read` (session chỉ-đọc — rail chuẩn cho spawn_policy), `reversible`, … |
| Credential handles | Danh sách tường minh                                                    |
| Giới hạn phiên     | Trần thời gian, trần số action, trần chi phí model                      |

- Vượt scope = action bị chặn tại engine **trước khi chạm driver** + phát escalation — không phải lỗi của executor mà là biên cứng.
- Khi tích hợp: scope là phần khai báo trong Session effect — Platform nhìn thấy và static analysis kiểm được ("task này cấp quyền irreversible mà Gate trước nó chưa có sàn" — Composition §4 mở rộng tự nhiên xuống tầng RPA).

**Scope cũng là lằn giữa hai năng lực trông giống nhau nhưng không phải một.** Giải một access challenge — một CAPTCHA trình ra cho một session trong domain mà tenant giữ credential đã khai — là một action **trong scope**: actor vẫn là máy, action vẫn là một entry trong log, và nếu tenant là người dùng được ủy quyền thì log của chính đích đến cũng trung thực. **Kỹ nghệ hóa không-bị-phát-hiện** — spoof fingerprint, xoay residential proxy, giả nhịp gõ để đánh bại detector — **không** phải cùng một act và **không** được engine tự viết, vì chức năng duy nhất của nó là làm đích đến misattribute máy thành người, đúng thứ mà action log tồn tại để ngăn (RPA North Star non-goals). Tenant cần nó thì nó tới dưới dạng driver class `code`, opt-in, tenant tự gánh ToS + phơi nhiễm pháp lý. Một đích đến **chặn im lặng, không trình thử thách nào** vì thế nằm ở phía bên kia của lằn: ca được-ủy-quyền bị **từ chối tại engine** thay vì phục vụ bằng cách vượt sang né tránh — cách đọc bảo thủ, nhất quán với reversibility-không-khai-là-irreversible.

## 5. Non-goals

- Không lưu secret ngoài vault; không có chế độ "trần không sandbox" (mức lỏng nhất vẫn là profile cô lập).
- Executor không bao giờ nhận giá trị secret — kể cả khi user cố truyền trực tiếp (engine từ chối, đề nghị tạo handle).

## 6. Nhật ký quyết định

| Vấn đề                       | Chốt                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cách ly                      | Mỗi session một sandbox; persistent profile là tài nguyên có id + scope riêng                                                                                                                                          |
| Secret                       | Handle-only; injection tại driver; executor mù giá trị tuyệt đối                                                                                                                                                       |
| Masking                      | Tại tầng perception, một chốt duy nhất; detector có calibration; App Profile vá sót                                                                                                                                    |
| Quyền                        | Scope khai báo 4 chiều, chặn tại engine, static analysis kiểm được khi tích hợp                                                                                                                                        |
| Live-view                    | Là projection của Scene đã masking; driver không hỗ trợ → takeover attended-only, không có kênh xem từ xa                                                                                                              |
| Access challenge vs né tránh | Giải thử thách trình ra trên domain được-ủy-quyền có credential đã khai = Action in-scope; kỹ-nghệ-không-bị-phát-hiện không tự viết — driver `code` opt-in, tenant tự gánh; đích chặn im lặng thì từ chối chứ không né |

## Litmus (spec-level, theo L5)

1. Executor (script _và_ agent) có bất kỳ đường nào nhận **giá trị** secret thay vì handle?
2. Người takeover gõ mật khẩu: hành động vào log, giá trị không bao giờ vào log/evidence/context?
3. Người xem từ xa trong lúc takeover có đường nào thấy vùng đã masking (framebuffer thô, ảnh trước masking)?
4. Session giải một CAPTCHA trên domain nó giữ credential đã khai — action đó có phải một Action bình thường được ghi kèm actor không? Và có bất kỳ năng lực first-party nào mà chức năng là làm đích đến misattribute máy thành người không?
