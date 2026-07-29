---
title: "Ecoma RPA — North Star"
status: design-end-state
lang: vi
---

# Ecoma RPA — North Star

## 1. Tuyên bố end state

**Ecoma RPA là engine tự động hóa tương tác môi trường thế hệ computer-use: mọi hành động là entity có danh tính, phân lớp reversibility, và bằng chứng; mọi phiên durable, replay được, người takeover được giữa chừng; kịch bản deterministic và agent vision là hai đầu của cùng một trục chi phí–độ bền với self-healing hai chiều — dùng độc lập hoặc làm nguồn lao động cho Ecoma Platform qua đúng hai giao diện chuẩn.**

## 2. Bài toán & định vị

- RPA selector-based là hố đen bảo trì: UI đổi là vỡ. Computer-use agent bền hơn nhưng **không dám cho chạy thật**: không reversibility, không action log chuẩn, không phân biệt xem/ghi, secret lọt vào context model.
- Khoảng trống: **runtime tự động hóa mà mọi hành động đều accountable** — DNA của ecoma áp xuống tầng thực thi.

## 3. Năm nguyên tắc cơ chế (kế thừa canonical North Star §3, chuyên biệt hóa)

1. **Đối xứng tuyệt đối**: hành động của người (takeover, demonstration) và của máy (script, agent) vào **cùng một action log**, cùng schema, khác actor identity.
2. **Danh tính ổn định + lineage** cho mọi thứ cần tích lũy: Action definition, Script, Driver, App Profile — script vá bởi self-healing là version mới kế thừa cha.
3. **Engine ép tồn tại, template ép giá trị** — với quy tắc bảo thủ đặc thù: **reversibility không khai = coi là irreversible**.
4. **Độ phức tạp là lựa chọn của user**: script trần chạy được không cần khai gì; guard, masking, scope, confirmation là opt-in qua cascade.
5. **Integration-first**: RPA _luôn_ phát Session effect và nói Filler interface — kể cả standalone (một consumer nội bộ tối giản thay Platform). Không tồn tại hai đường chạy → không bao giờ drift giữa hai chế độ.

## 4. Kiến trúc domain & bộ spec con

| Lớp | Nội dung | Spec | |---|---|---| | Action | Vocabulary chuẩn hóa, reversibility, evidence, action log | ecoma-rpa-spec-action.md | | Session | Vòng đời durable, takeover, record, replay, interruption | ecoma-rpa-spec-session.md | | Driver & Perception | Contract driver, scene hợp nhất, **semantic locator** | ecoma-rpa-spec-driver-perception.md | | Self-healing | Script ↔ agent hai chiều, patch lineage, UI drift smell | ecoma-rpa-spec-selfhealing.md | | Sandbox & Credential | Cách ly phiên, vault, masking, permission scope | ecoma-rpa-spec-sandbox-credential.md |

**Topology triển khai — Node:**

- **Node** = app RPA cài trên một máy (máy nhân sự = _attended_, server = _unattended_ — cùng một binary). Node là **host**, không phải Filler: Filler (script@version, agent config) đăng ký _qua_ node; một node host nhiều filler, một filler chạy được trên nhiều node.
- Node khai **placement attributes**: app đã cài, persistent profile sẵn có, network zone, capacity, sự hiện diện của người (attended), **và engine-version + protocol-version** — handshake negotiation: server hỗ trợ **node N-1 minor** (unified train, North Star §8); node ngoài cửa sổ → **từ chối claim** (an toàn hơn chạy sai) + escalation. Gán task resolve theo chuỗi: role → filler pool → node đủ điều kiện (gồm điều kiện version).
- **Pull model, outbound-only**: node claim Task từ server — Platform không bao giờ đẩy lệnh điều khiển từ xa vào node; session chạy cục bộ, Session effect stream ngược về. Transport (long-poll/websocket) là chi tiết; cơ chế bắt buộc là outbound-only + **stream có cursor resume**: đứt mạng → session durable cục bộ, log buffer, nối lại phát tiếp từ offset (entry content-addressed, at-least-once tự dedupe); node chết → `session_interrupted` với trạng thái chính xác theo evidence.
- **Claim = lease có TTL heartbeat**: node chết → lease hết → **không silent re-run**: log đã có action ghi (nhất là qua commit point) → đi đường `session_interrupted` + on_fail, không tự gán lại. Session **pin vào node** — không migrate (state cục bộ).
- **Node enrollment bắt buộc**: identity mật mã (device keypair), admin duyệt tường minh khi gia nhập; task mang credential scope X chỉ định tuyến tới node được cấp X tường minh; vault chỉ giao secret short-lived cho node identity đã enroll, theo scope từng session, tại tầng driver. **Decommission chủ động = graceful drain**: node ngừng claim mới, phiên đang chạy kết thúc tự nhiên (hoặc reassign theo lease), rồi thu hồi key — mọi bước là event; khác thu-hồi-khẩn (node bị chiếm: cắt tức thì).
- **Takeover có kênh nhưng không có quyền thường trực**: không tồn tại năng lực remote-control ambient; kênh xem/điều khiển chỉ mở **theo-từng-session, do node chủ động mở (outbound)** khi assistance_request được chấp nhận + policy node cho phép; mọi input của người đi qua driver thành Action có actor — vào cùng log. Attended node: takeover định tuyến tới chính người tại máy — người đó cũng là một Filler.
- **Attended = consent-first** (chạy khi idle / user-trigger / virtual desktop tách biệt — policy cascade); **unattended = isolation-first** (sandbox/VM).
- **Lớp UI attended cục bộ — không phải giao diện thứ ba**: node runtime là **một binary headless** chạy cả hai chế độ; máy attended cài thêm một **lớp UI cục bộ** nói với runtime qua **kênh nội-máy có auth theo node identity**. Ba biên cứng: (1) kênh nội-máy **chỉ mang điều khiển phiên cục bộ** (mở/đóng/pause/takeover) — **không** mang effect stream, **không** mang ngữ nghĩa lao động ⇒ hai giao diện của hệ vẫn đúng là hai (D1); (2) **mọi hành động lao động của UI attended (approve / Judgment / claim / release) đi THẲNG engine API** như mọi client khác — không tồn tại đường ghi riêng của UI (Human Surface §0); (3) UI attended **không lưu frame**: thứ vào log luôn là **Scene đã masking** (Sandbox §3). Công nghệ cụ thể là việc của ADR, không của trần.
- **Đường lùi của node update**: cập nhật node qua Hub là hành động tường minh; **hạ về digest N-1 cũng là hành động tường minh có event**, hợp lệ trong đúng cửa sổ skew N-1 minor đã khai ở trên. Không có đường lùi = "update" là thao tác một chiều trên thành phần an ninh nhạy nhất của hệ.
- Evidence: **hash stream ngay, blob upload lười** — log integrity tức thì, băng thông không nghẽn. Node cập nhật qua chính **Hub** (code artifact, verify chữ ký) — là **hành động tường minh theo policy, không auto-update trong mọi cấu hình mặc định** (nhất quán Block §7); không có kênh update riêng.

## 5. Bảng ánh xạ tích hợp (ưu tiên số một của sản phẩm)

| Khái niệm RPA | Khi cắm vào Platform trở thành | |---|---| | Session | Session effect của một Task | | Human takeover | `assistance_request` (Escalation) — người xử lý chính là một Filler | | Script version (healed) | Filler identity mới có lineage → đi qua trust tiers (shadow → … → autonomous) | | Healing confirmation | Gate (Checkpoint) với criteria từ reversibility | | Action log + evidence | Provenance của Artifact | | App Profile | Block type trên **Ecoma Hub**; cài vào tenant thì trở thành nguồn giá trị default cascade (mức template = tập block đã cài) | | UI drift smell | Tín hiệu Escalation/Intelligence (process smell tầng thực thi) | | Session read-only scope | Rail của spawn_policy khi agent tự đẻ task RPA | | **Automation** (script@version + healing policy, hoặc agent config) | **Chính là Filler đăng ký** — chuyển giao nội bộ script⇄agent⇄người theo từng action là hành vi _bên trong_ filler, ghi sub-actor trong log; calibration Platform bám filler, ML chi tiết dùng sub-actor | | Learning signals (healing, tầng-thắng, takeover diff, patch gate) | Dẫn xuất từ Session effect + entry `proposal` trong cùng stream — **không phải giao diện thứ ba**; về đích là Judgment / Escalation / calibration per-tenant của lõi ML duy nhất (§7) |

## 6. Duality — deterministic và reasoning trong RPA (tường minh)

Cùng một trục, dial theo **từng action**, không phải hai hệ:

| Tầng | Deterministic | Reasoning | |---|---|---| | Executor | Script (locator tầng 1–2) | Agent vision (tầng 3–4) | | Nguồn script | Record demonstration của người | Distillation từ agent | | Resolve target | Structural anchor | Semantic intent | | Kiểm | Precondition assert | Reconcile + healing | | Chuyển giao | Script → agent khi fail | Agent → script khi ổn định |

## 7. Học máy — một lõi ML duy nhất, RPA là nhà sản xuất tín hiệu

- **RPA không có lõi ML riêng** — lõi duy nhất là tầng Intelligence của Platform. Learning signal **không phải kênh thứ ba**: phần lớn dẫn xuất từ chính action log (tức Session effect); các _đề xuất_ (vá App Profile, distillation, đổi model routing) là **entry có kiểu `proposal` trong cùng stream**, Platform materialize thành Task. Standalone → micro-consumer nội bộ chỉ làm thống kê deterministic (đếm, ngưỡng, promote anchor **trong script riêng** theo cửa reversibility — không đụng tri thức dùng chung) — không tồn tại bộ não thứ hai để drift.
- Ánh xạ tín hiệu: healing/tầng-thắng → drift smell (tối ưu quy trình); **takeover diff** → Judgment kiểu approve-with-edit (tối ưu config agent); kết quả cửa duyệt patch → Judgment trên Gate (tối ưu checkpoint); độ chính xác masking, hiệu năng model theo app → calibration + routing.
- Mọi đề xuất từ ML áp dụng **qua vòng duyệt/pair-design**, không tự sửa runtime. Tín hiệu thuộc tenant; catalog cộng đồng chỉ nhận opt-in qua review.

## 8. Litmus của RPA

1. Cùng một automation chạy bằng script **và** agent vision, không đổi định nghĩa?
2. Script vỡ vì UI đổi → agent tiếp quản, tự sinh version vá có lineage, không cần người sửa tay?
3. Replay bất kỳ phiên nào từ log + evidence: "ai/cái gì làm gì, lúc nào, màn hình trông ra sao"?
4. Người takeover giữa phiên, hành động của họ nằm cùng log với máy?
5. Secret không bao giờ xuất hiện trong log, screenshot đưa cho model, hay context agent?
6. Chạy standalone và chạy trong Platform là **cùng một binary, cùng một đường phát effect**?
7. Node đứt mạng giữa phiên — session tiếp tục cục bộ, log buffer, nối lại resume từ cursor không mất/không trùng entry?
8. Node chưa enrollment không thể claim task hay nhận secret — kể cả khi khai placement attributes hoàn hảo?
9. Không tồn tại kênh điều khiển thường trực vào node — takeover chỉ mở theo phiên, do node khởi tạo, từng input đều thành Action có actor trong log?
10. **Tắt kênh nội-máy của lớp UI attended**: node runtime vẫn chạy đủ (chỉ mất UI), và mọi hành động lao động vốn đã đi thẳng engine API nên **không mất một đường ghi nào** — kênh nội-máy có phải là giao diện thứ ba của hệ không?

## 9. Non-goals

- Không orchestrate đa bước/role/checkpoint — việc của Platform.
- Không phải iPaaS: có API thì gọi API (rule filler bên Platform); RPA dành cho nơi **không có** API.
- Không xây vision model riêng — model qua adapter, taxonomy mở.
- Không lưu secret ngoài vault; không có đường tắt tích hợp riêng dù cùng monorepo.

## 10. Phân phối

- Trong monorepo ecoma, area `rpa/`. **License: theo luật phân loại canonical tại North Star §8** — "cắm vào → Apache 2.0" (Action vocabulary, Driver interface, App Profile schema: bên thứ ba viết driver/profile tự do) / "chạy → SUL" (core RPA, node runtime). Spec này **không khai lại** (E5,).
- App Profile / Macro / Script / Driver phân phối dưới dạng **Block qua Ecoma Hub** — RPA (kể cả standalone) nói với Hub trực tiếp qua client interface `resolve/pull/verify`, không đi vòng qua Platform. Driver là artifact **code** (trust class riêng của Hub: cần publisher verified + opt-in admin).
- Standalone: CLI + SDK + self-host — là wedge adoption: đến vì automation, ở lại vì Platform.

## FMEA (theo F8)

| Hỏng | Phát hiện | Phục hồi | |---|---|---| | Node mất mạng giữa phiên | Heartbeat/lease TTL | Session durable cục bộ, resume cursor; chết hẳn → interrupted chính xác theo evidence | | Node bị chiếm | Enrollment identity + thu hồi key | Mọi claim/secret từ chối tức thì | | Buffer evidence đầy trên node | Hash đã stream, blob lười | Cảnh báo dung lượng; log integrity không đổi |
