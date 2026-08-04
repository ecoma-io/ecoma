---
title: "Ecoma Platform — North Star"
status: design-end-state
canonical-sha: 5931fa1bf284
---

# Ecoma Platform — North Star

Tài liệu này là nguồn canonical của bốn nguyên tắc cơ chế và năm invariant. Mọi
tài liệu khác trong cây tham chiếu tới chúng; không tài liệu nào chép lại. Khi
hai văn bản bất đồng, văn bản này thắng.

Nó mô tả một cái trần, không phải một bản phát hành đầu tiên. Một lát cắt giao
hàng được phép thu hẹp giá trị hoặc policy; nó không được vi phạm một cơ chế viết
ở đây.

## Trạng thái đích

**Ecoma là hệ điều hành lao động fair-code, tự cài đặt được, nơi con người, AI,
và rule/code là cùng một loại tài nguyên lao động (Role/Filler); quy trình — cả
deterministic lẫn reasoning — được người và AI cùng thiết kế trên chính engine;
mọi output đều có đường đi qua một checkpoint với confidence hiệu chỉnh theo dữ
liệu của riêng từng tenant; và sự chú ý của con người là tài nguyên được đo và
tối ưu.**

Nó được xây trong một monorepo với ba domain tách biệt: **Platform** (điều phối
lao động — tài liệu này), **[RPA](rpa.md)** (thực thi trên những môi trường hệ
thống không kiểm soát), và **[Hub](hub.md)** (phân phối nội dung tĩnh: registry,
index, marketplace). Platform tiêu dùng RPA qua đúng hai giao diện runtime — một
Filler và một Session effect. Cả Platform lẫn RPA nói với Hub qua đúng một client
interface: `resolve` / `pull` / `verify`. **Hub không bao giờ chạm runtime**: rút
phích nó ra thì mọi thứ đã cài vẫn chạy vĩnh viễn.

## Bài toán, và vì sao các hệ hiện có không giải được

Nỗi đau không phải là thiếu automation. Nó là **hai lực lượng lao động chưa bao
giờ được hợp nhất**. AI nhân sản lượng lên và tạo ra nghẽn xác minh trong cùng
một động tác — mọi output đều cần duyệt, và hàng chờ đọng lại ở sự chú ý của con
người. Giữa người với người, context nằm trong đầu ai đó. Giữa các bước, không có
contract nào. Và không hệ thống nào cho phép một người và một AI hoán đổi vào
cùng một vị trí.

Mọi hệ hiện có đều **đi lên từ một nghề** rồi gắn nửa còn lại vào như phần phụ:
nền tảng tích hợp đi lên từ iPaaS, tự động hóa robot đi lên từ screen-scraping,
engine BPMN đi lên từ một đặc tả cấm rẽ nhánh không khai trước, và nơi
compensation cùng escalation chỉ tồn tại ở chỗ người mô hình hóa tự tay vẽ chúng
— không cái nào bị engine ép tồn tại, không cái nào mang một confidence đã hiệu
chỉnh. BPMN thất bại ở chính lời hứa nền tảng của nó — rằng business vẽ được và
máy chạy được — dù chỉ khoảng một phần năm số phần tử của nó đã phủ phần áp đảo
các quy trình thực.

Ecoma khởi động lại từ giả định gốc: **một loại tài nguyên lao động, một bộ
primitive nhỏ, đối xứng tuyệt đối.**

**Vì sao tăng trưởng không bắt phải viết lại.** Một người làm một mình cảm nhận
nỗi đau điều phối ngay lập tức — sản lượng gấp ba và nút thắt dời sang xác minh —
nhưng không công ty nào ở mãi một người, và không khách hàng nào từ chối lớn lên.
Câu trả lời mang tính cơ chế: **cùng một bộ primitive từ một người tới N người.**
Ở một người, Checkpoint gánh phần chính, tối ưu sự chú ý của người duyệt duy nhất
đang có. Khi nhân sự tăng, Handoff gánh phần chính — contract, quyền sở hữu, và
context sống bên ngoài đầu bất kỳ ai. Người mới tuyển là một Filler bước vào một
Role đã tồn tại, và chạy được ở chế độ shadow để học nghề từ chính bản ghi. Tăng
trưởng là hệ quả, và hệ thống đã có sẵn hình dạng cho nó.

## Bốn nguyên tắc cơ chế

**Đây là bản canonical.** Các spec tham chiếu tới nó và không bao giờ chép lại.

1. **Engine đối xứng tuyệt đối** giữa người, AI, và rule/code. Bất đối xứng chỉ
   được phép tồn tại ở tầng policy và template.
2. **Bất cứ thứ gì cần tích lũy học đều là entity hạng nhất có danh tính ổn định
   — và danh tính đó có lineage.** Calibration được kế thừa kèm decay, nên tiến
   hóa một filler không bao giờ reset flywheel của nó.
3. **Engine ép tham số tồn tại; template ép giá trị của tham số.**
4. **Độ phức tạp là quyền lựa chọn của user**: cơ chế thì đầy đủ, mặc định thì
   tối giản qua một cascade (tenant → template → process → role → task), và mọi
   thứ nâng cao đều là opt-in.

## Năm invariant

1. Người và AI lấp cùng một loại Role. Đổi Filler không đổi flow.
2. Mọi output đều có đường đi qua một Checkpoint, và không hành động nào không để
   lại dấu vết — kể cả override, vốn là một Judgment có chữ ký chứ không phải một
   đường vòng qua Checkpoint.
3. Sự chú ý của con người là tài nguyên được đo và tối ưu: triage, sampling, storm
   control, hàng đợi ưu tiên.
4. Dữ liệu học thuộc về tenant. **Không có học chéo tenant.** Cold start được trả
   lời bằng thư viện Criterion và Contract dùng chung, bằng identity lineage, và
   bằng template prior.
5. Trạng thái quy trình là durable và sống độc lập với trí nhớ của bất kỳ ai.
   Không có kẹt im lặng — terminal escalation handler là bắt buộc — và không bao
   giờ có chuyện tự động pass vì timeout hay bế tắc.

## Các primitive, và tầng composition bên trên chúng

| Spec                                                 | Cơ chế nó sở hữu                                                                                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Role](../spec/role.md)                              | Một slot năng lực tách khỏi người lấp vào. Calibration khóa theo role, filler, task type và criterion. Shadow mode hai chiều. Trust tier dịch chuyển hai chiều tự động                                                        |
| [Task](../spec/task.md)                              | Một instance của việc với Attempt hạng nhất, durable hàng tuần. **Dynamic spawning** là nơi đồ thị deterministic và đồ thị reasoning gặp nhau: một agent có thể tạo task giao cho một người                                   |
| [Checkpoint](../spec/checkpoint.md)                  | Một Gate chặn, tách khỏi một Judgment append-only. Criterion là entity thư viện của tenant. Confidence ba lớp, hiệu chỉnh theo từng tenant                                                                                    |
| [Handoff](../spec/handoff.md)                        | Contract ba lớp — schema, semantic, context. Một Envelope tự tích lũy, giao đi dưới dạng projection. Effect với ba lớp reversibility. Compensation là một Task của một Role                                                   |
| [Escalation](../spec/escalation.md)                  | Công dân hạng nhất: một escalation là một Task, và chuỗi tự cascade. Xin trợ giúp được **thưởng** trong calibration chứ không bị phạt                                                                                         |
| [Composition](../spec/composition.md)                | Một Process là một Artifact tuân contract, pin kèm migration tường minh. Static analysis. Pair-design tự nó là một workflow Ecoma                                                                                             |
| [Trigger & Channel](../spec/trigger-channel.md)      | Cửa vào và cửa ra: auth tại biên, payload là một Handoff có contract, correlation hội thoại. Một end user là một Filler `external` của một Role                                                                               |
| [Knowledge](../spec/knowledge.md)                    | Tri thức là tài sản nghiệp vụ: một Collection có Curator Role, grant theo Role, một classification lattice với egress gate hai lớp                                                                                            |
| [Artifact Store](../spec/artifact-store.md)          | "Hash vĩnh viễn, bytes theo policy" — sự thật vĩnh viễn nằm ở log, blob có vòng đời, GC theo tham chiếu, dedup chỉ trong phạm vi một tenant                                                                                   |
| [Event Log](../spec/event-log.md)                    | Nguồn sự thật duy nhất, append-only theo từng tenant. Metering, audit, search, notification và đầu vào calibration đều là **projection** rebuild được. Crypto-shredding hòa giải append-only với quyền được quên              |
| [Working Data](../spec/working-data.md)              | "SQL để hỏi, event để ghi" — DataTable là một projection ghi được; **Lease là primitive khóa duy nhất**, TTL bắt buộc                                                                                                         |
| [Memory](../spec/memory.md)                          | Hồi ức thuộc về **tổ chức, khóa theo subject** — không bao giờ thuộc về một filler, nên đổi model hay đổi người không mất gì. Provenance bắt buộc để chống bịa                                                                |
| [Tenant & Identity](../spec/tenant-identity.md)      | Một hệ phân quyền duy nhất, không phải hai: admin và process owner là những Role có người lấp. Tenant là biên cứng, workspace là vách mềm. Actor id pseudonymous với dữ liệu cá nhân shred được — audit sống, người được quên |
| [Calibration](../spec/calibration.md)                | Data model đằng sau confidence: một khóa nhiều chiều, lineage kèm time decay, và một estimator identity tường minh                                                                                                            |
| [Human Surface](../spec/human-surface.md)            | Work Surface: một object model gồm Work Item và Action Item, hai view. "Inbox" là một view, không phải là model                                                                                                               |
| [Vault & Key](../spec/vault-key.md)                  | Cây khóa ba tầng, rotate ≠ shred, các nghĩa vụ khôi phục thảm họa và luật quy định loại bản sao nào được giữ key material                                                                                                     |
| [Release & Compatibility](../spec/release-compat.md) | Ba trục version, negotiation, upgrade và rollback, cửa sổ end-of-life                                                                                                                                                         |
| [Test Harness](../spec/test-harness.md)              | Một mode của engine chứ không phải một công cụ đứng cạnh nó: test run scope, fixture, mock, assertion, và các conformance suite                                                                                               |

Có một tính chất chạy xuyên tất cả: mọi thao tác hệ thống — coerce, merge,
distill, arbitrate, adapt, compensate, migrate, design — đều là **một Task của
một Role**. Không có node ma thuật. Mọi lao động đi qua một cơ chế, và đó chính
là thứ khiến mọi lao động quan sát được qua một cơ chế.

## Bốn câu litmus

Chúng định nghĩa "đã hợp nhất" nghĩa là gì, và chúng đo được chứ không phải nói
cho hay:

1. Một bước có chuyển từ người sang AI **mà không sửa flow** được không?
2. Nó có chạy được ở shadow mode với một bảng đối chiếu tự sinh không?
3. Có **một thang tin cậy duy nhất** phủ cả người lẫn AI không?
4. Có nhìn thấy được chi phí và chất lượng **theo từng Role**, bất kể ai lấp
   không?

## Non-goals

- **Không tuân thủ BPMN 2.0.** Bộ primitive ở đây thay thế nó chứ không hiện thực
  nó.
- **Platform không chứa công nghệ tự động hóa robot** — không selector, không
  vision, không driver. Đó là domain của RPA, tiếp cận qua giao diện Filler và
  Session effect. Nếu không thì đổi một trình duyệt sẽ đổi luôn một workflow.
- **Engine không bao giờ tự sửa artifact, tự merge, hay tự migrate.** Mọi can
  thiệp là một Task của một Role và để lại dấu vết.
- **Không có shared mutable state giữa các bước.** Mọi thứ di chuyển qua một
  Handoff.
- **Ecoma không phải một chat assistant** — nhưng một user xây chatbot trên Ecoma
  là use case hạng nhất. Sản phẩm là **self-serve trước hết**: dùng được mà không
  cần đội triển khai. Enterprise là một tầng deployment, không phải một kênh bán
  được quyền quyết định thiết kế.
- **Runtime không bao giờ kiểm entitlement.** Không license key, không
  phone-home. Thương mại hóa nội dung dừng ở tầng phân phối.
- **Không xây warehouse đa dụng và không xây vector engine riêng.** Labor
  analytics là một projection cộng một đường export bạn sở hữu; vector đến qua
  một adapter. Moat là dataset lao động, không phải một SQL engine.
- **Không học chéo tenant, và không có chuyện "ML đề xuất tối ưu"** trước khi
  flywheel Judgment và Escalation có dữ liệu. Khi chúng có, nguồn đã được định
  danh sẵn: Judgment, log escalation, conflict, và outcome propagation.

## Kiến trúc sản phẩm và mô hình phân phối

**Các tầng, theo thứ tự xây.** Mỗi tầng đứng trên tầng trước, và đó là thứ khiến
thứ tự này là một quan hệ phụ thuộc chứ không phải một sở thích:

| Tầng | Là gì         | Nội dung                                                                                  |
| ---- | ------------- | ----------------------------------------------------------------------------------------- |
| 1    | Core engine   | Các primitive, composition, event log, artifact store, durable execution, static analysis |
| 2    | Agent runtime | Chạy agent filler nội bộ; RPA và runtime ngoài cắm vào qua giao diện chuẩn                |
| 3    | Human surface | Work Surface: triage, batch review, diff, mobile                                          |
| 4    | Pair-design   | Workflow thiết kế, chạy trên chính engine, cộng một canvas                                |
| 5    | Intelligence  | Học theo từng tenant từ Judgment, escalation, conflict và outcome                         |

### Fair-code, và vì sao cái nhãn quan trọng

Ecoma là **fair-code / source-available**. Nó cố ý không được gọi là open source,
và ba từ này không thay thế nhau được:

|                   | Được gì                                                                                                    | Mất gì                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Open source (OSI) | Mọi thứ ở dòng dưới, cộng cái nhãn                                                                         | Freedom zero buộc phải cho phép **mọi mục đích**, gồm cả bán lại Ecoma thành một dịch vụ cạnh tranh. Không điều khoản nào cấm được |
| Fair-code (Ecoma) | Mã công khai, đọc được, tự cài thoải mái, sửa thoải mái — mọi cơ chế cam kết với tenant đều nhìn thấy được | Cấm bán lại Ecoma thành một dịch vụ                                                                                                |

Gọi nó là "closed" thì mất những người sẽ đọc mã; gọi nó là "open source" thì từ
bỏ quyền cấm resell. Chính xác về cái nhãn không phải là chẻ sợi tóc — đó là cách
duy nhất để cả hai tính chất cùng sống sót.

### Cấp phép là một luật phân loại, không phải một danh sách

Một câu hỏi duy nhất quyết định mọi đơn vị: **bên thứ ba cần cái này để _cắm
vào_ hệ, hay để _chạy_ hệ?**

| Trả lời                                                                             | License                    |
| ----------------------------------------------------------------------------------- | -------------------------- |
| **Cắm vào** — interface, schema, protocol, client, SDK, vocabulary                  | Apache 2.0                 |
| **Chạy** — mọi implementation server, node hay service trong một area sản phẩm      | License nguồn fair-code    |
| **Không cả hai** — control plane, và các module trả tiền lấp extension point của nó | Proprietary, không công bố |

Luật này tồn tại vì một danh sách thì trôi còn một luật thì không. Một lần thử
trước đó đã khai license permissive ở năm spec riêng lẻ trong khi một bảng theo
area lại khai mọi area đều dùng license fair-code — cái bảng đơn giản là không
biểu diễn được một license ở mức nhỏ hơn area. **License cắt theo đơn vị, không
bao giờ theo area.**

Từng có một câu trả lời thứ tư nằm giữa hai hàng cuối: một module trả tiền,
source-available dưới những điều khoản không cấp gì cả, trong một thư mục
`<area>/enterprise/` của riêng nó. Tầng đó đã nghỉ, và chưa từng chứa một dòng
mã. Công bố những module ấy là trao mã nguồn cho mọi đối thủ trong khi không cấp
quyền nào cho chính những người mua dễ đòi audit thứ đang chạy trên hạ tầng của
họ nhất — cái giá lớn nhất có thể trả, đổi lấy lớp bảo vệ yếu nhất. Thứ thay thế
nó là một biên repository chứ không phải một license nữa: các module trả tiền
sống không công bố, cạnh control plane, dưới điều khoản của chính cây đó — nên
hàng ở trên phủ cả hai. Bản thân luật không đổi; nó chỉ ra ba câu trả lời thay
vì bốn.

### Topology repo, và vì sao các biên trùng nhau

Thư mục gốc là area. Mỗi area chia thành `apps/`, `libs/` và `packages/`, và ba
tầng đó khác nhau ở chỗ quyết định ai được phép phụ thuộc vào chúng:

| Tầng        | `private` | Có version          | Ai tiêu dùng                                   |
| ----------- | --------- | ------------------- | ---------------------------------------------- |
| `apps/`     | —         | đóng dấu theo train | Một artifact triển khai được                   |
| `libs/`     | `true`    | không có version    | **Chỉ trong workspace**                        |
| `packages/` | `false`   | version của train   | **Bên thứ ba** — SDK, protocol, schema, client |

Hệ quả mới là điểm mấu chốt: **biên license, biên publish và biên thư mục là cùng
một biên.** Luật phân loại ở trên nói "cắm vào → Apache 2.0", và những đơn vị cắm
vào chính là những đơn vị nằm trong `packages/`. Một quyết định, ba chỗ tự khớp
theo cấu trúc chứ không phải bằng tay.

Cố ý **không có area `connectors/`**. Driver và channel adapter chính chủ sống
trong `libs/` của chính domain chúng, mang tag adapter, bởi chúng hiện thực một
port thuộc về domain đó chứ không tạo thành một domain thứ bảy. Tách chúng ra sẽ
cắt đứt mỗi adapter khỏi cái port nó phục vụ, để đổi lấy sự gọn gàng. Giao diện mà
**bên thứ ba** cần để viết một adapter vẫn công khai trong `packages/`, và đó mới
là cái biên thực sự đáng bảo vệ.

**Một trục layer hexagonal, ép bằng lint.** Mỗi library mang tối đa một layer —
util, domain, port, adapter, view, app — và chiều phụ thuộc được ép bằng máy. Hai
luật trong số đó tự trả giá cho mình:

| Luật                                                                               | Nó bảo vệ cái gì                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tầng app được dùng port, domain và util — **không bao giờ chạm adapter trực tiếp** | Đây là quyết định storage-port được làm thành executable. Chạm engine phải đi qua port, nên engine luôn thay được. Không có luật này thì "port" là một thư mục chứ không phải một biên |
| Tầng view không bao giờ chạm runtime của desktop host                              | View phát intent và shell đấu dây, nên lớp UI attended không phải một đường ghi thứ hai                                                                                                |

Trần chỉ chốt rằng trục này tồn tại và rằng hai luật trên đúng. Cấu hình đầy đủ
là việc của repo, và không được chép lại ở đây.

### Self-host là single-tenant, và lý do là invariant 4

> **Đa tenant không bao giờ cấp thêm một năng lực nào cho người dùng. Nó chỉ tiết
> kiệm chi phí vận hành.**

Vì invariant 4 cấm học chéo tenant, hai tenant trên một cài đặt **tương đương với
hai cài đặt riêng biệt về mọi mặt thuộc về sản phẩm**: không chung calibration,
không chung memory, không chung knowledge. Khác biệt duy nhất là một cụm hạ tầng
thay vì hai — và "tiết kiệm vận hành ở quy mô" chính xác là thứ một nhà cung cấp
dịch vụ bán. Ngược lại, đặt đa tenant vào tầng enterprise nghĩa là ship đoạn mã
rủi ro nhất đang có — tạo tenant và gốc của cây khóa — ra rộng nhất, để đổi lấy
đúng không năng lực mới nào.

Hai hệ quả cơ chế đi kèm, và không hệ quả nào là tùy chọn:

| Hệ quả                                  | Luật                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Engine luôn tenant-aware**            | Cây khóa, log theo từng tenant, phân quyền có scope, dedup giới hạn trong một tenant, metering theo từng tenant. **Tầng tenant tồn tại về mặt vật lý kể cả ở cardinality bằng một** — bỏ nó "cho gọn" sẽ biến mọi lần chuyển sang đa tenant về sau thành một cuộc migrate toàn bộ khóa |
| **Cap một tenant là một biên sản phẩm** | Một cài đặt self-host không có tenant thứ hai bởi workflow tạo tenant chỉ ship trong control plane của nhà vận hành — không phải vì runtime kiểm một entitlement. Phần non-goals ở trên cấm thẳng điều đó                                                                              |

Invariant 4 ràng buộc cả nhà vận hành. Nhà vận hành được **gộp metering** xuyên
tenant; nhà vận hành **không bao giờ** được định tuyến knowledge, memory hay
calibration xuyên tenant. Cái biên đó phải được khai công khai và phải có litmus,
chính bởi đoạn mã thi hành nó nằm ở nơi người ngoài không audit được.

### Versioning và release

- **Một release train `X.Y.Z` cho mọi artifact** — server, node binary, chart,
  SDK — nên tính tương thích sập về một trục duy nhất.
- **Một protocol version riêng cho từng giao diện**, negotiate lúc handshake.
- **Skew**: server hỗ trợ lùi một minor version. Ra ngoài cửa sổ đó, một node từ
  chối claim việc và escalate — an toàn hơn là chạy sai.
- **Breaking change chỉ ở major**, với ít nhất một minor deprecation trước đó.
- **Log không bao giờ bị rewrite** khi upgrade — reader dung thứ schema version
  cũ, và projection được rebuild vì chúng là dẫn xuất. **Mỗi bước migration là
  một entry trong log**, nên một lần upgrade có provenance. Các major chạy tuần
  tự và không được nhảy cóc.
- **Rollback là một migration nghịch tường minh.** Mọi migration major phải khai
  một đường nghịch hoặc tự khai là không đảo được; không khai gì cả thì được coi
  là không có đường về, và engine đòi một gate cùng một bản sao trước khi chạy.
  Pin lại một version cũ chỉ là rollback khi dữ liệu chưa đổi hình. Khi nó đã đổi
  hình, rollback là một migration đầy đủ: một Task của một Role, có gate, có
  entry trong log, không phải một cái nút.

### Triển khai và lưu trữ

Triển khai qua container và orchestration. Lưu trữ nằm sau **năm port với default
đi theo hình thái triển khai** ([ADR-0002](../method/adr-ledger.md)): đơn-binary
hoặc một-container nhận small-stack; một cụm production nhận một database gánh
event log, các projection ghi được, vector và metric. **Reference backend cho
conformance suite là Postgres**, và đó không phải là cùng một phát biểu với
default của một cài đặt. **Một default không phải một coupling** — mọi backend
đều là một adapter sau một port. Nâng cấp một backend là một lần replay log,
không bao giờ là một cuộc chuyển đổi tự động.
