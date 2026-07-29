---
title: "Ecoma — North Star"
status: design-end-state
lang: vi
---

# Ecoma — North Star

> Tài liệu định hướng end state. Mọi quyết định thiết kế, roadmap, và scope đối chiếu vào đây. Đây là **trần**, không phải scope v1 — roadmap chia sau, với điều kiện: mọi lát cắt chỉ được thu hẹp giá trị/policy, không được vi phạm cơ chế.

## 1. Tuyên bố end state

**Ecoma là hệ điều hành lao động fair-code, self-host được, nơi con người, AI, và rule/code là cùng một loại tài nguyên lao động (Role/Filler); quy trình — cả deterministic lẫn reasoning — được người và AI cùng thiết kế trên chính engine; mọi output đi qua checkpoint có confidence hiệu chỉnh theo dữ liệu của từng tenant; và sự chú ý của con người là tài nguyên được đo và tối ưu.**

Ecoma phát triển trong **một monorepo, ba domain tách biệt**: **Ecoma Platform** (điều phối lao động — tài liệu này), **Ecoma RPA** (thực thi tương tác môi trường — [rpa](rpa.md)), và **Ecoma Hub** (phân phối nội dung tĩnh: registry/index/marketplace — [hub](hub.md)). Platform dùng RPA qua hai giao diện runtime (Filler + Session effect); cả Platform lẫn RPA nói với Hub qua một client interface duy nhất (`resolve/pull/verify`). **Hub không bao giờ chạm runtime** — rút phích Hub, mọi thứ đã cài chạy vĩnh viễn.

## 2. Bài toán cốt lõi & vì sao chưa ai giải

Nỗi đau không phải "thiếu automation" — là **hai lực lượng lao động chưa hợp nhất**: AI nhân sản lượng nhưng tạo nghẽn xác minh (mọi output cần duyệt, hàng chờ đọng ở sự chú ý con người); giữa người-người context nằm trong đầu; giữa các bước không có contract; không hệ thống nào cho người và AI hoán đổi trên cùng một vị trí.

Các hệ hiện tại đều **đi lên từ nghề** và gắn nửa còn lại như phần phụ: n8n từ iPaaS, UiPath từ screen-scraping, Camunda từ BPMN engine (spec trói: không rẽ nhánh phi định trước, không compensation tử tế, escalation là exception), Dify từ LLM app, Asana từ task list. BPMN thất bại ở lời hứa nền tảng "business vẽ được, máy chạy được" — trong khi ~20% phần tử của nó đã phủ ~90% quy trình thực. Ecoma thiết kế lại từ giả định gốc: **một loại tài nguyên lao động, một bộ nguyên thủy nhỏ, đối xứng tuyệt đối.**

**Luận điểm tăng trưởng (vì sao "One Person Company" là bong bóng và ecoma là lời giải):** AI khiến n=1 đau điều phối ngay từ đầu — sản lượng x3 nhưng nghẽn ở xác minh; song công ty không thể lớn mạnh nếu mãi 1 người, và không khách hàng nào từ chối mở rộng. Cơ chế trả lời: **cùng một bộ primitive từ n=1 đến n=N, không rewrite khi lớn lên** — ở n=1 Checkpoint gánh chính (tối ưu chú ý của người duy nhất), khi n tăng Handoff gánh chính (contract, ownership, context sống ngoài đầu người); Filler người mới được tuyển vào Role có sẵn, chạy shadow để học nghề. Tăng trưởng nhân lực là chuyện kéo theo — và hệ thống đã chờ sẵn.

## 3. Bốn nguyên tắc cơ chế

> **Đây là bản canonical.** Các spec chỉ tham chiếu, không chép lại; khi văn bản lệch nhau, mục này thắng.

1. **Engine đối xứng tuyệt đối** giữa người, AI, rule/code. Bất đối xứng chỉ sống ở tầng policy/template.
2. **Cái cần tích lũy học là entity hạng nhất có danh tính ổn định — và danh tính có lineage** (kế thừa calibration với decay; không bao giờ reset flywheel khi tiến hóa).
3. **Engine ép tham số tồn tại, template ép giá trị.**
4. **Độ phức tạp là quyền lựa chọn của user**: cơ chế đầy đủ, mặc định tối giản qua default cascade (tenant → template → process → role → task), nâng cao là opt-in.

## 4. Năm invariant

1. Người và AI lấp cùng một loại Role; đổi Filler không sửa flow.
2. Mọi output có đường qua Checkpoint; không có hành động không dấu vết (kể cả override — override là Judgment có chữ ký).
3. Sự chú ý của con người là tài nguyên được đo và tối ưu (triage, sampling, storm control, hàng đợi ưu tiên).
4. Dữ liệu học thuộc tenant; không học cross-tenant. (Cold-start bù bằng: thư viện Criterion/Contract dùng chung xuyên quy trình + identity lineage + template prior.)
5. Trạng thái quy trình durable, sống độc lập với trí nhớ con người; không tồn tại "kẹt im lặng" (terminal escalation handler bắt buộc); không bao giờ auto-pass vì timeout hay bế tắc.

## 5. Năm primitive + tầng composition

| Spec                                     | Ý chính                                                                                                                                                                                                                                                     | File                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Role**                                 | Slot năng lực tách khỏi Filler (người/agent/rule). Calibration theo (role, filler, task_type, criterion). Shadow mode 2 chiều. Trust tiers: shadow → gated → sampled → autonomous, tự động hai chiều — cơ chế của hành trình dịch chuyển lực lượng lao động | [role](../spec/role.md)                       |
| **Task**                                 | Instance việc, Attempt hạng nhất (retry luôn mang feedback), durable nhiều tuần. **Dynamic spawning** = điểm hợp nhất deterministic (đồ thị khai trước) và reasoning (đồ thị mọc runtime trong rails); agent đẻ task gán cho người = AI điều phối người     | [task](../spec/task.md)                       |
| **Checkpoint**                           | Gate (blocking) tách Judgment (append-only, thêm được sau done). Criterion là entity thư viện tenant. Confidence 3 lớp, calibration là flywheel per-tenant. Triage tối ưu chú ý                                                                             | [checkpoint](../spec/checkpoint.md)           |
| **Handoff**                              | Contract 3 lớp (schema/semantic/context). Envelope tự tích lũy, giao theo projection. Effect + reversibility 3 lớp + Session effect (giao diện RPA). Compensation là Task của Role. Outcome lan ngược provenance                                            | [handoff](../spec/handoff.md)                 |
| **Escalation**                           | Công dân hạng nhất; escalation là Task → chain tự cascade. `assistance_request` được thưởng trong calibration. Escalation log = nguồn dữ liệu "ML đề xuất tối ưu quy trình"                                                                                 | [escalation](../spec/escalation.md)           |
| **Composition**                          | Process = Artifact tuân contract `process-definition`, pin + migration tường minh. Static analysis. Pair-design là workflow ecoma. Ranh giới Platform/RPA                                                                                                   | [composition](../spec/composition.md)         |
| **Block (Hub)**                          | Đơn vị đóng gói–phân phối mọi entity. **Template = Block curate theo vertical; mức template trong cascade = tập block tenant đã cài.** Trust do re-analysis + scope disclosure + trust tiers gánh                                                           | [block](../spec/block.md)                     |
| **Trigger & Channel**                    | Cửa vào/ra của process: auth bắt buộc tại biên, payload = Handoff có contract, correlation hội thoại; **end-user = Filler `external` của một Role** — chatbot là use case hạng nhất, không cần cơ chế riêng                                                 | [trigger-channel](../spec/trigger-channel.md) |
| **Knowledge (module opt-in)**            | Tri thức = tài sản nghiệp vụ: Collection có Curator Role, grant theo Role, classification lattice + egress 2 lớp, live-resolve ghi version vào provenance, knowledge calibration                                                                            | [knowledge](../spec/knowledge.md)             |
| **Artifact Store (subsystem tầng 1)**    | Event log giữ sự thật vĩnh viễn, blob có vòng đời ("hash vĩnh viễn, bytes theo policy"); GC theo tham chiếu; dedup chỉ trong tenant; storage policy theo classification                                                                                     | [artifact-store](../spec/artifact-store.md)   |
| **Event Log (subsystem tầng 1)**         | Nguồn sự thật duy nhất, append-only per-tenant; metering/audit/search/notification/calibration-input đều là **projection** rebuild được; timer là entry; crypto-shredding hòa giải append-only với quyền được quên                                          | [event-log](../spec/event-log.md)             |
| **Working Data (module + Lease tầng 1)** | DataTable = writable projection ("SQL để hỏi, event để ghi") — join/time-travel/audit/mật đầy đủ; **Lease là primitive khóa duy nhất** (TTL bắt buộc); Labor Analytics = dataset lao động độc quyền + BYO-export                                            | [working-data](../spec/working-data.md)       |
| **Memory (module opt-in)**               | Hồi ức thuộc **tổ chức theo subject** (không thuộc filler — đổi model/người không mất trí nhớ); provenance bắt buộc chống bịa; Gate chống poisoning; distill lên Knowledge; **cấm memory về filler** (đã có calibration)                                    | [memory](../spec/memory.md)                   |
| **Tenant & Identity (core)**             | Một hệ phân quyền duy nhất (Role+capability+grant — admin/process-owner là Role được lấp); tenant = biên cứng, workspace = vách mềm + chiều calibration; **Party** merge-qua-Gate; pseudonymous actor-id + PII shreddable — audit sống, người được quên     | [tenant-identity](../spec/tenant-identity.md) |

Mẫu số chung: mọi thao tác hệ thống (coerce, merge, distill, arbitrate, adapt, compensate, migrate, design) đều là **Task của một Role** — không có node ma thuật, mọi lao động đi qua một cơ chế.

## 6. Bốn câu litmus (định nghĩa "đã hợp nhất")

1. Đổi một bước người → AI **không sửa flow**? → Role/Filler.
2. Chạy **shadow mode** với bảng đối chiếu tự sinh? → Role §4.
3. **Một thang tin cậy** cho cả người lẫn AI? → Calibration trên hệ Judgment.
4. Nhìn thấy **cost + quality theo Role** bất kể ai lấp? → Filler cost function + calibration profile.

Chưa hệ thống nào trên thị trường đạt cả bốn. Đây là spec đo được của sản phẩm.

## 7. Non-goals

- Không theo đuổi BPMN 2.0 compliance — bộ nguyên thủy riêng thay thế.
- Ecoma Platform không chứa công nghệ RPA (selector/vision/driver) — đó là domain của Ecoma RPA, cắm qua Filler + Session effect.
- Engine không bao giờ tự sửa artifact, tự merge, tự migrate — mọi can thiệp là Task của Role có dấu vết.
- Không shared mutable state giữa các bước — mọi trao đổi qua Handoff.
- Ecoma-sản-phẩm không phải một chat assistant — nhưng **user xây chatbot trên ecoma là use case hạng nhất** (Trigger & Channel spec). **Self-serve-first**: sản phẩm dùng được không cần đội triển khai; enterprise là tầng deployment/EE, không phải kênh bán quyết định thiết kế.
- Runtime không bao giờ kiểm entitlement, không license key, không phone-home — thương mại hóa nội dung dừng ở tầng phân phối (Hub).
- Không xây general-purpose warehouse hay vector/ANN engine — Labor Analytics là projection + BYO-export; vector là adapter (Working Data & Knowledge specs). Moat là _dataset lao động_, không phải SQL engine.
- Không học cross-tenant; không "ML đề xuất tối ưu" trước khi flywheel Judgment/Escalation có dữ liệu — và khi có, nguồn đã định danh sẵn: Judgment (checkpoint & prompting), Escalation log (process smell), Conflict, outcome propagation.

## 8. Kiến trúc sản phẩm & mô hình OSS

**Các tầng của Platform, thứ tự xây:**

| #   | Tầng          | Ghi chú                                                                                                 |
| --- | ------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Core engine   | 5 primitive + composition + event log + **artifact store** + durable execution + static analysis        |
| 2   | Agent runtime | Chạy agent filler nội bộ; RPA và runtime ngoài cắm qua giao diện chuẩn                                  |
| 3   | Human surface | Inbox tự xây (quyết định đã chốt): triage, batch review, diff, mobile                                   |
| 4   | Pair-design   | Workflow thiết kế trên chính engine + canvas                                                            |
| 5   | Intelligence  | Học per-tenant từ Judgment/Escalation/Conflict/outcome; tối ưu prompt qua lineage + shadow + graduation |

**Mô hình phân phối (đã chốt):**

- **Fair-code / source-available** — không dùng nhãn "open source" (không đạt chuẩn OSI, trung thực về nhãn là bắt buộc).
- **Ecoma là FAIR-CODE, KHÔNG phải open source — và đó là cố ý** _(nói dứt khoát ở, sau khi chính chỗ này gây nhầm)_:

|                               | Được gì                                                                                                        | Mất gì                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Open source (OSI)**         |                                                                                                                | Freedom 0 buộc cho phép **mọi mục đích**, gồm cả bán lại ecoma thành SaaS cạnh tranh. Không điều khoản nào cấm được |
| **Fair-code / SUL** _(ecoma)_ | Mã **công khai, đọc được, tự cài thoải mái, sửa thoải mái** — mọi cơ chế cam kết với tenant đều nhìn thấy được | **Cấm bán ecoma thành dịch vụ**                                                                                     |

Đây là **source-available**, không phải _closed_. Ba từ này không thay thế nhau được, và dùng lẫn là tự bắn vào định vị: _"closed"_ làm mất người đọc mã, _"open source"_ làm mất quyền cấm resell. Tiền lệ: **n8n** dùng đúng SUL và luôn tự gọi là _fair-code_, không bao giờ gọi là open source.

- **License — LUẬT PHÂN LOẠI (canonical), không phải danh sách**: một câu hỏi duy nhất — _"bên thứ ba cần cái này để **CẮM VÀO** hệ, hay để **CHẠY** hệ?"_

| Trả lời                                                                 | License                       | Ví dụ (minh họa, **không** phải danh sách đóng)                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cắm vào** — interface · schema · protocol · client · SDK · vocabulary | **Apache 2.0**                | Filler interface, Session effect, contract chuẩn, Hub `resolve/pull/verify` + manifest schema + client library, Action vocabulary, Driver interface, App Profile schema, Channel adapter interface |
| **Chạy** — mọi implementation server/node/service trong 6 area sản phẩm | **SUL (fair-code)**           | engine, hub service, node runtime, website, deploy                                                                                                                                                 |
| Module cắm qua extension point                                          | **Enterprise License**        | **`<area>/enterprise/`** — tag `license:ee`                                                                                                                                                        |
| Control plane của nhà vận hành                                          | **Proprietary, không public** | `cloud/` — xem bảng 3 lớp dưới                                                                                                                                                                     |

Nội dung block (không phải mã): catalog free = Apache/CC0, block trả phí = EULA publisher. **Án văn**: 5 vòng trước khai Apache-2.0 rải ở 5 file (Hub §5/§10, RPA §10, Driver §1, Trigger §4) trong khi bảng-theo-area khai cả 6 area = SUL — bảng không biểu diễn được license dưới mức area ⇒ **danh sách trôi, luật thì không**. License cắt theo **đơn vị**, không theo area.

- **Bốn dòng doanh thu**: SaaS, enterprise self-host license, OEM/embedding license, **marketplace revenue share** (Hub).
- **Kiến trúc phân phối = 3 domain dọc + 2 lớp ngang — một codebase**: (1) Self-host fair-code; (2) **Cloud/SaaS** = _hình thái vận hành_ — chính bản đó chạy với tenant cardinality = N, cộng một **control plane nội bộ của nhà vận hành** (provisioning, billing integration, quota, fleet ops — không ship, không thuộc North Star sản phẩm; provisioning tenant chính là một workflow ecoma). **Litmus ranh giới**: mọi thứ control plane cần (tenant isolation, metering hook, quota hook) phải là cơ chế core — control plane chỉ được _gọi_, không được _vá_; (3) **EE = lớp license cắt ngang, không phải domain**: tập module cắm qua **extension point do engine khai báo** (engine ép điểm cắm tồn tại, EE cấp implementation) — cắm lên cả self-host lẫn Cloud, không bao giờ là fork. Ranh giới core/paid cắt theo tầng: engine + runtime + inbox cơ bản là core; SSO/SCIM, RBAC & audit nâng cao, multi-workspace, Intelligence là EE.
- **Tenant là khái niệm core với cardinality ≥ 1** (không phải khái niệm của SaaS): invariant 4, thư viện entity, cascade, lockfile đều cần ranh giới sở hữu dữ liệu kể cả khi self-host một công ty. SaaS chỉ đổi hai thứ: cardinality = N và "người lạ chia sẻ hạ tầng" (isolation, residency).
- **Metering là cơ chế, pricing là policy**: metering = projection trên Event Log ([event-log](../spec/event-log.md)) từ cost function theo (role, filler, task) — đơn vị tính tiền SaaS (seat / task / run / % chi phí AI) là quyết định kinh doanh đặt trên projection sẵn có, không cần cơ chế mới.
- Bắt buộc từ ngày 0: **CLA** mọi contributor, **trademark "Ecoma"**, review luật sư một lần cho SUL + CLA + EULA marketplace.
- **Monorepo topology (convention area-first)**: thư mục gốc = subsystem area — `platform/ · rpa/ · hub/ · shared/ · website/ · deploy/` (+ **`<area>/enterprise/`** commercial như đã khai). **`cloud/` control plane theo cùng convention thư mục NHƯNG khác lớp license — xem "3 lớp license" ngay dưới**. **Mỗi area chia `apps/ libs/ packages/`; riêng `shared/` có thêm `tools/`** (dev tooling nội bộ: `eslint-local-rules`, `dev-cli`, `repo-care`, `nx-polyglot-graph`).

**Ba tầng đó khác nhau ở CHỖ NÀO — định nghĩa còn thiếu tới ** _(trước đây `packages/` được đặt tên mà chưa bao giờ được định nghĩa)_:

| Tầng            | `private`   | Version                                   | Ai tiêu dùng                                                  |
| --------------- | ----------- | ----------------------------------------- | ------------------------------------------------------------- |
| `apps/`         |             | đóng dấu train                            | artifact triển khai được (server, node runtime, console, e2e) |
| `libs/`         | **`true`**  | không có                                  | **chỉ trong workspace**                                       |
| **`packages/`** | **`false`** | **= train version** (Release & Compat §9) | **bên thứ ba** — SDK, protocol, schema, vocabulary, client    |

Hệ quả đẹp: **biên license = biên publish = biên thư mục**. Luật phân loại license ở trên nói _"cắm vào → Apache 2.0"_; những đơn vị đó chính là thứ nằm trong `packages/`. Một quyết định, ba chỗ tự khớp — thay vì ba danh sách phải đồng bộ tay.

- **Không có area `connectors/`** _(chốt, sau khi đối kháng chính đề xuất tạo nó)_: driver RPA và channel adapter chính chủ sống trong **`rpa/libs/` và `platform/libs/`** với tag `layer:adapter`. Án văn: chúng **implement một port của chính area đó**, không phải một domain thứ bảy; tách ra thành area riêng làm đứt liên hệ giữa adapter và port nó phục vụ, để đổi lấy đúng một thứ — cảm giác gọn. Giao diện cho **bên thứ ba** viết driver/adapter vẫn công khai qua `packages/` (Apache 2.0), và đó mới là thứ ranh giới cần bảo vệ.

- **Trục `layer:` — hexagonal, ép bằng lint** _(nạp vào trần; repo đã thi hành từ trước mà trần không biết)_: mỗi lib mang tối đa một `layer:` trong `util · domain · port · adapter · view · app`, và `@nx/enforce-module-boundaries` ép chiều phụ thuộc. Hai luật đắt nhất:

| Luật                                                                                        | Nó bảo vệ cái gì                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`layer:app` được dùng `port`, `domain`, `util` — KHÔNG BAO GIỜ chạm `adapter` trực tiếp** | Đây là **ADR-0002 (5 storage port) được thi hành bằng máy**: chạm engine phải đi qua port, nên engine luôn thay được. Không có luật này thì "port" là một thư mục, không phải một biên |
| **`layer:view` không chạm runtime của desktop host**                                        | View phát intent, shell đấu dây — giữ đúng biên của ADR-0005 (lớp UI attended không phải một đường ghi)                                                                                |

Trần chỉ chốt **rằng có trục này và hai luật trên**; danh sách đầy đủ + cấu hình là việc của repo (`eslint.config.mjs` là nguồn thi hành, không chép lại — E5). Ví dụ nội dung `shared/`: **ui design system** (components/tokens — tiêu dùng bởi console, hub frontend, website) + `shared/apps/storybook` (mount `ecoma.io/design`). `deploy/` = Docker/K8s/IaC dùng chung. `website/` = mặt tiền thương mại + growth — hệ vận hành của operator, tài liệu class **System Charter** (playbook funnel (không công bố), dogfooding chạy trên chính ecoma), deployment độc lập với product. Litmus phân loại hệ mới: _"có định nghĩa cơ chế sản phẩm cam kết với tenant?"_ — Có → domain dọc + North Star; Không → System Charter.

- **Self-host là SINGLE-TENANT; đa-tenant là control plane của `cloud/`**. Án văn **không phải** "cloud là đặc biệt" mà là **invariant 4**:

> **Multi-tenant KHÔNG BAO GIỜ cấp thêm một năng lực nào cho người dùng. Nó chỉ tiết kiệm chi phí vận hành.**

Vì invariant 4 cấm học chéo tenant, hai tenant trên một cài đặt **tương đương hai cài đặt riêng về mọi mặt sản phẩm** — không chung calibration, không chung memory, không chung knowledge. Khác biệt duy nhất là **một cụm hạ tầng thay vì hai** — mà "tiết kiệm vận hành ở quy mô" chính là thứ **một nhà cung cấp SaaS bán**. Ngược lại, đặt đa-tenant vào Enterprise nghĩa là **ship code rủi ro nhất (tạo tenant, gốc cây khoá) ra rộng nhất để đổi lấy 0 năng lực mới** — một giao dịch tồi.

Hai vế cơ chế đi kèm, không tách rời:

| Vế                                                          | Luật                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Engine luôn tenant-aware**                                | Cây khoá root→tenant-DEK→subject, log per-tenant, RBAC scope, dedup chỉ trong tenant, metering per-tenant. **Tầng tenant tồn tại VẬT LÝ kể cả khi N=1** — bỏ nó "cho gọn" biến mọi lần chuyển sang đa-tenant thành một cuộc migrate toàn bộ khoá |
| **Cap 1 tenant là BIÊN SẢN PHẨM, không phải license check** | Self-host không có tenant thứ hai vì **workflow tạo tenant chỉ ship trong `cloud/`** — không phải vì runtime kiểm quyền. §7 non-goal cấm thẳng: _runtime không bao giờ kiểm entitlement, không license key, không phone-home_                    |

**Invariant 4 áp cho CẢ operator Cloud**: operator được **gộp metering** xuyên tenant; operator **KHÔNG BAO GIỜ** được định tuyến knowledge/memory/calibration xuyên tenant. Ranh giới này phải khai công khai và có litmus — vì code thi hành nó nằm trong repo private mà người ngoài không audit được.

- **3 lớp license theo area**:

| Area                                           | License                                                                                      | Mã công khai?                  | Án văn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform/ rpa/ hub/ shared/ website/ deploy/` | **SUL (fair-code)** — _trừ_ các đơn vị "cắm-vào" theo luật phân loại ở trên (**Apache 2.0**) | ✅                             | Cơ chế sản phẩm — minh bạch là lợi thế cạnh tranh, cấm resell bằng điều khoản. **License cắt theo đơn vị, không theo area**                                                                                                                                                                                                                                                                                                                                                                                                          |
| **`<area>/enterprise/`**                       | **Enterprise License** — tag `license:ee`                                                    | ✅ hiện diện, dùng cần license | Tiền lệ n8n `.ee.` — module cắm qua extension point, không bao giờ fork. **Đổi sang theo-area vì cohesion**: một tính năng EE của RPA nằm ở `ee/` là xa nhà nó. **Biên license thi hành bằng Nx tag `license:sul \| license:ee \| license:apache \| license:proprietary`** + `@nx/enforce-module-boundaries` ép **chiều phụ thuộc**: `ee` import được `sul`, **`sul` KHÔNG BAO GIỜ import được `ee`**. Đây là thứ làm luật (_license cắt theo **đơn vị**, không theo area_) trở nên **executable** thay vì chỉ là một câu trong trần |
| **`cloud/`**                                   | **Proprietary — KHÔNG công khai**                                                            | ❌                             | **Cùng litmus phân loại ở trên trả lời**: control plane không định nghĩa cơ chế cam kết với tenant → không phải domain sản phẩm, mà là _hạ tầng vận hành của operator_. SUL cấm được **hành vi** bán SaaS, nhưng công khai `cloud/` là tự phát bản thiết kế phần khó nhất (provisioning, metering-billing, fleet ops, quota) cho đối thủ ở khu vực pháp lý khó cưỡng chế. Tiền lệ ngành: n8n public repo **không chứa** control plane của n8n.cloud                                                                                  |

**Litmus "control plane chỉ _gọi_, không _vá_" giữ nguyên hiệu lực và mạnh hơn** khi `cloud/` private: mọi hook nó cần (tenant isolation, metering, quota) vẫn phải là cơ chế **core public** — không hook thì không có đường vá kín đáo. **Cách thực thi — CHỐT LẠI **: **hai repo, `cloud/` là git submodule.** `ecoma-io/ecoma` **public** (mọi area SUL + Apache + `<area>/enterprise/`); `ecoma-io/ecoma-cloud` **private** chứa `cloud/` + doctrine lớp kín, **mount tại `cloud/`**. Owner clone `--recursive` → làm việc trong **một cây**; contributor clone thường → `cloud/` vắng mặt, mọi gate vẫn xanh. Biên kín là **quyền repo**, không phải `.gitignore` hay tên thư mục.

**Litmus bắt buộc kèm theo**: _mọi gate phải xanh ở **cả hai** trạng thái — có `cloud/` và không có `cloud/`._ Thiếu litmus này thì một hôm CI của contributor đỏ vì thiếu thư mục họ không được phép nhìn thấy.

*Vì sao bỏ phương án mirror-một-chiều đã chốt ở *: nó giả định **repo public chưa tồn tại** và private là gốc. Thực tế `ecoma-io/ecoma` **đã public**. Án văn cũ bác phương án mount vì _"hai nguồn ghi cho cùng một cây"_ — án văn đó **sai với submodule**: submodule là **hai repo có ranh giới commit riêng**, mỗi repo vẫn đúng một trunk, không có cây nào bị hai bên ghi. Bản chất phản đối cũ là _bind-mount thư mục_, không phải submodule.

- **Versioning & Release (chốt cơ chế — spec chi tiết: ledger)**: **unified release train X.Y.Z** cho mọi artifact (server platform/rpa/hub, node binary, helm, SDK) — compat sập về một chiều; **protocol-version riêng** cho các giao diện (Filler API, Session effect, hub resolve/pull/verify, manifest schema) + negotiation lúc handshake; **skew: server hỗ trợ node N-1 minor**, ngoài cửa sổ node từ chối claim + escalation; **breaking chỉ ở major**, deprecation ≥1 minor trước; **upgrade engine**: log không bao giờ rewrite (schema-version/reader-tolerant), projection rebuild vì derived, **mỗi bước migration là một entry trong log** (upgrade có provenance), major tuần tự không skip; **rollback = migration nghịch tường minh** (trả ô `rollback` của vòng đời entity): mọi migration major khai **đường nghịch (down-migration)** hoặc khai `irreversible_migration: true` — không khai = coi như **chưa có đường về** (bảo thủ), static analysis cảnh báo và engine đòi Gate + bản sao trước khi chạy. "Pin lại version cũ" chỉ là rollback khi dữ liệu **chưa đổi hình**; đã đổi hình thì rollback là một migration đầy đủ — Task của Role có Gate, có entry, không phải nút bấm.
- Deploy qua Docker/K8s. **Storage: 5 port, default THEO HÌNH THÁI cài đặt** (ADR-0002,): đơn-binary/1-container → small-stack **SQLite+DuckDB+sqlite-vec**; compose-production/helm/cloud → **Postgres + pgvector + TimescaleDB** (một database gánh Event Log store, DataTable, vector, metrics); **reference backend cho contract-suite = Postgres**; nâng cấp = replay log, không auto. **Default ≠ coupling** — mọi backend chỉ là adapter qua port. Dữ liệu học thuộc tenant, learning per-tenant — cam kết sản phẩm lẫn ranh giới kỹ thuật.
- **Tenant & Identity: ĐÃ CHỐT** ([tenant-identity](../spec/tenant-identity.md),) — mọi danh xưng nợ (process owner, admin, workspace, end-user/party, data-subject) đã có định nghĩa; một hệ phân quyền duy nhất; SSO/SCIM/PII-vault là extension point EE.
- **Sổ khoảng trống bổ sung (quét chủ động,)** — đã có hình dạng, chờ spec riêng: (1) **Calibration data model — ✅ ĐÃ CHỐT: [calibration](../spec/calibration.md)** (CalKey 7 chiều gồm workspace, lineage+time-decay, estimator identity — đúng yêu cầu gốc, không thuật toán ML); (2) **Human Surface — ✅ ĐÃ CHỐT: [human-surface](../spec/human-surface.md)** (re-framing owner: **Work Surface** — 1 object model Work Item/Action Item, 2 view My-Work/Org-Work; "inbox" chỉ là một view); (3) **Vault & Key Lifecycle — ✅ ĐÃ CHỐT: [vault-key](../spec/vault-key.md)** (cây khóa 3 tầng, root theo hình thái + luôn ngoài backup, rotate≠shred; RPA Sandbox là consumer đầu tiên). **Sổ khoảng trống NS §8 nay ĐÃ ĐÓNG cả 3 mục.**
- **Sổ khoảng trống (quét mở rộng)**: (4) **Quota & scheduling fairness** — "quota hook" đã hứa trong litmus control plane nhưng chưa có cơ chế: tham số cascade + scheduler đọc từ Event Log projection, điều kiện của SaaS multi-tenant; (5) **Runtime sandbox cho code filler** (tầng 2) — code từ block chạy ở đâu, cách ly gì; anh em của RPA Sandbox; (6) **Process test harness** — chạy thử process với effect được mock: tổng quát hóa dry-run của RPA (Session §6) lên effect Platform, bổ khuyết cho bộ shadow/sampling/static-analysis.

---

_Mục ICP & vertical đầu tiên: để trống theo quyết định — bổ sung khi chốt kinh doanh. Ràng buộc đã ghi nhận: vertical đầu tiên quyết định **block bundle chính chủ đầu tiên trên Hub** (nguồn giá trị mặc định của default cascade). Tenant & Identity đã chốt ([tenant-identity](../spec/tenant-identity.md)). Ghi chép ICP/phỏng vấn sống ở **sổ thị trường (không công bố)** (ngoài bộ trần)._
