---
title: "Review Rubric & Method"
status: design-end-state
canonical-sha: 4659be6547d2
---

# Review Rubric & Method

---

## PHẦN I — PHÁN XÉT, THEO CÁCH HỒ SƠ NÀY INSTANTIATE

Bản thân các luật phán xét — biên object, luật một-bản-sao, các luật verdict,
hình dạng finding, miễn dịch, tension, câu hỏi của chủ object, không gì được
review âm thầm — nằm ở [review-constitution](review-constitution.md) và không
được chép lại ở đây. Phần dưới chỉ là thứ hồ sơ này lấp vào các luật đó: lỗi nào
là nặng đối với một cây tài liệu, canon nào đứng trên canon nào, một lỗ trong
_hồ sơ này_ được miễn với lý do gì, và một tài liệu mới nợ những gì.

**Các số đã nghỉ.** R1, R4, R6, R8 và R9 từng đặt tên cho những luật nay thuộc
hiến pháp; số của chúng nghỉ vĩnh viễn: không tái sử dụng, không alias. Câu nào
trước đây trích một trong các số ấy thì nay trích luật hiến pháp **bằng tên**, vì
tên mới là thứ sống sót với người đọc chỉ cầm file này. R2, R3, R5, R7 và R10–R12
vẫn là của riêng rubric này.

### R7. Thứ tự ưu tiên khi tiêu chí va nhau

`Invariant (5) > nguyên tắc canonical (4, North Star §3) > nguyên tắc domain (RPA/Hub §3) > policy hoặc template`

Một va chạm không bao giờ được giải quyết âm thầm. Nó được ghi thành một finding
loại `tension`.

### R5. Severity — một test khách quan

Bảng này instantiate luật severity của hiến pháp cho một cây tài liệu: ba mức và
yêu cầu mỗi mức phải là một test khách quan đến từ đó; phần dưới chỉ nói lỗi nào
của _object này_ rơi vào mức nào.

| Mức       | Test                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| `blocker` | Vi phạm invariant/nguyên tắc canonical, HOẶC mặc định không an toàn (đơn giản = lỏng hơn) |
| `major`   | Hai kỹ sư đọc sẽ implement khác nhau; hoặc khái niệm chịu lực không định nghĩa            |
| `minor`   | Câu chữ, tham chiếu, nhãn thiếu                                                           |

### KNOWN-GAP trong hồ sơ này

Luật PASS-phải-falsifiable, luật FAIL-kèm-tái-hiện và luật known-gap là của hiến
pháp. Thứ hồ sơ này thêm vào luật cuối là một căn cứ miễn thứ hai và một verdict
đóng:

**KNOWN-GAP** hợp lệ ở đây khi điều kiện của hiến pháp thoả — đã tự khai trong
docs **trước** lượt chạy — **hoặc** khi lỗ thuộc **miền kinh doanh**, thứ cây
published này cố ý không mang. Lỗ không đạt căn cứ nào = FAIL; chỉ đóng bằng fix
hoặc bằng verdict `accepted-by-owner` có lý do + xác nhận của owner.

### Hình dạng finding trong hồ sơ này

Hình dạng finding là của hiến pháp. Hồ sơ này lấp trường cuối bằng
`án-văn-hoặc-fix-ref` và gọi trường thứ hai là `file`:

`(criterion, file, trích dẫn/kịch bản, verdict, severity, án-văn-hoặc-fix-ref)`

Sổ là append-only.

### R10. Kênh owner

Qua mọi lượt review hồ sơ này đến nay, người bắt lỗ hiệu quả nhất là **owner,
bằng câu hỏi ngây thơ** ("X là gì?", "sao không có Y?"). Chính quan sát đó làm
cho luật "câu hỏi của chủ object" trong hiến pháp chịu lực ở đây chứ không phải
nghi thức: một câu hỏi của owner mà docs không trả lời được bằng đúng một trích
dẫn là finding chính thức, severity theo R5.

### R11. Owner-fact sync

Mọi convention, quyết định hay thông tin owner nêu ra đều **được ghi vào docs
trong cùng lượt**. Thứ còn sót lại chỉ trong hội thoại tự động là một finding.

Trước mỗi lần đóng băng, bắt buộc có một **owner debrief 5 câu**: có convention
hay quyết định nào anh từng nói mà chưa có trong docs không? Phần nào anh _cảm
thấy_ mỏng? Gần đây anh đọc hay thấy gì ở đối thủ? Có ai hỏi anh câu gì mà docs
không trả lời được không? Điều gì anh đang đánh cược mà chưa ghi xuống?

### R12. Không tài liệu nào bị review âm thầm

Mục này instantiate luật "không gì được review âm thầm" của hiến pháp — đặt tên
cho unit, cho mức, và cho cái nhãn nó để lại. Một file hay section mới — thuộc
bất kỳ class nào: trần, charter, sống — phải qua một **cluster run trong cùng
lượt đã tạo ra nó**, hoặc mang nhãn `chưa-review` trong index cho tới khi qua.
`cluster` chứ không phải `incremental`: mức per-patch là thứ một thay đổi trên
tài liệu sẵn có phải trả, và một tài liệu mới không phải một patch.

Coverage matrix khai tường minh **doc class × nhóm áp dụng**. Một charter chịu đủ
J/G/K/G9 đúng như trần chịu; tiền lệ là một lỗi lọt qua vì charter bị đối xử nhẹ.

### R2, R3. Điều kiện đóng băng

Không còn blocker mở và không còn major mở; mọi KNOWN-GAP có tên trong một North
Star hoặc trong index; **coverage matrix kín** (mọi file × mọi nhóm, mỗi ô đánh
dấu scanned hoặc không-áp-dụng kèm bằng chứng); và danh mục litmus **full-pass
toàn bộ** bằng desk simulation chứ không phải chỉ bằng mirror.

---

## PHẦN II — BỘ TIÊU CHÍ A–P

> Mỗi nhóm mang một **câu hỏi tinh thần** đứng trên các tiêu chí của nó — chốt
> chống Goodhart của hiến pháp, instantiate cho hồ sơ này.

### A — Trung thành với quan điểm sáng lập

_Tinh thần: hồ sơ có còn phục vụ đúng người đã khởi ra nó không?_

- **A0, chạy đầu tiên**: dựng lại **inventory quan điểm từ nguồn** và diff nó với
  nhóm A hiện hành. Nhóm A chỉ chấm được thứ nó nhớ, và nó đã được chứng minh là
  bỏ sót hơn một lần.
- A1 hai lực lượng lao động được hợp nhất bằng một _cơ chế_ — Role/Filler, trust
  tier, một thang Judgment — chứ không bằng khẩu hiệu.
- A2 luận điểm tăng trưởng từ n=1 lên N có cơ chế và không đòi viết lại.
- A3 không một dòng `if deterministic` nào trong engine; duality nổi lên từ thứ
  đã được khai báo.
- A4 cả ba tham vọng ML đều có nguồn dữ liệu định danh và không cái nào đi trước
  flywheel.
- A5 pair-design có chỗ đứng cơ chế.
- A6 các quyết định đã chốt vẫn còn nguyên: inbox tự xây, runtime tự xây, Docker
  và Kubernetes, không BPMN, SUL, fair-code không bao giờ dán nhãn "open source",
  một lõi ML, memory thuộc về tổ chức.
- A7 RPA là integration-first; standalone là phép chiếu của nó.

### B — Bốn nguyên tắc cơ chế, dưới dạng đòn tấn công

_Tinh thần: engine có đang lặng lẽ làm policy không?_

- B1 mọi câu chứa "người", "human" hay "AI" — câu nào là _luật engine_ chứ không
  phải _mặc định template_?
- B2 mọi thứ được calibrate — cái nào thiếu identity ổn định hoặc lineage?
- B3 mọi con số cứng — con số nào nằm trong engine thay vì trong một template?

### C — Năm invariant, dưới dạng đòn tấn công

_Tinh thần: năm lời hứa nền có còn không thể vi phạm không?_

- C1 có kịch bản nào đổi Filler mà buộc phải sửa process không?
- C2 có hành động nào không để lại dấu vết không — một override không có
  Judgment, engine tự sửa thứ gì đó, một can thiệp không phải là Task của một
  Role?
- C3 mọi điểm tiêu thụ chú ý có triage, ưu tiên và storm control không?
- C4 vẽ đường đi của một byte dữ liệu học từ lúc sinh ra tới lúc dùng — nó rời
  khỏi tenant mà không có opt-in ở đâu?
- C5 có trạng thái kẹt âm thầm nào, hay timeout hoặc bế tắc nào biến thành
  auto-pass không?
- **C6 — vách mềm workspace**: mọi cơ chế _tổng hợp, khái quát hóa hoặc gộp
  chung_ — distillation, gộp calibration, tổng hợp analytics, cài block,
  collection, projection dùng chung — phải khai **chiều workspace** của nó; không
  khai thì mặc định là **hẹp nhất**. C4 chỉ canh biên cứng của tenant, còn vách
  mềm mới là nơi một khách hàng thật — một agency nhiều client — chảy máu.

### D — Ranh giới kiến trúc

_Tinh thần: các domain có còn không thể nhòe vào nhau không?_

- D1 có kênh thứ ba nào tuồn ra ngoài (Filler + Session effect) và
  (`resolve/pull/verify`) không — kể cả tín hiệu học, proposal, update,
  telemetry?
- D2 rút phích Hub rồi liệt kê thứ gì ngừng: có gì trong đó là runtime không? Có
  entitlement, license key hay phone-home nào bên trong engine không?
- D3 có tính năng enterprise nào đi vòng qua extension point không — một bản fork
  trá hình?
- D4 control plane có _vá_ thay vì _gọi_ không?
- D5 có cơ chế nào chỉ đứng vững trên SaaS không — tenant cardinality phải ≥ 1?
- D6 platform có biết về selector hay vision không? RPA có biết về Gate hay
  calibration không?
- D7 có shared mutable state nào nằm ngoài một Handoff hay một sự kiện DataTable
  không?
- D8 có module opt-in nào khi tắt lại **không** zero-overhead không?

### E — Danh tính, versioning, flywheel

_Tinh thần: hệ có tự đốt dữ liệu học của chính nó không?_

- E1 pinning đã kín chưa — có một chỗ nào mà một lần upgrade âm thầm phá vỡ
  instance đang chạy không?
- E2 mọi version mới có mang parent và decay factor không — verifier, filler,
  contract, criterion, script, profile, driver, table, metric?
- E3 cold start theo từng tenant có đủ cả ba thuốc chữa không, và có chỗ nào âm
  thầm dựa vào dữ liệu cross-tenant không?
- E4 có bộ não ML thứ hai không — một micro-consumer vượt quá thống kê, một index
  ML chạm vào calibration của tenant?
- **E5 — một sự thật, một nhà**: liệt kê mọi _loại sự thật_ rồi hỏi loại nào có
  từ hai nơi ghi trở lên. Các tiền lệ đã bị chặn: memory-về-một-filler đối đầu
  với calibration; một bảng tự ghi đối đầu với event log; **và một _nhãn hay
  trường_ mới cũng là một loại sự thật — `run_kind` đã được khai hệ quả cho bốn
  consumer mà không có nhà của riêng nó, nên một projection viết sau sẽ quên
  lọc.** Về mặt thao tác: patch nào khai "hệ quả của X ở nhiều nơi" thì trước hết
  phải nói **X sống ở đâu**.

### F — An toàn và trách nhiệm

_Tinh thần: kết cục tồi tệ nhất bị chặn bằng cấu trúc hay bằng lời dặn?_

- F1 có effect nào chạy được mà không có class không? "Không khai thì là
  irreversible" có nhất quán giữa Platform action và RPA action không?
- F2 có đường unwind nào vượt qua commit point không?
- F3 vẽ đường đi của một credential hay secret — giá trị của nó chạm tới
  executor, log, evidence hay prompt ở đâu? Masking có phải một chốt duy nhất tại
  perception, **tại input capture**, **và trên mọi kênh replay hay live-view**
  không?
- F4 một node chưa enroll có claim được việc hay nhận được secret không? Có kênh
  điều khiển thường trực nào không? Có input takeover nào không trở thành một
  Action có actor không?
- F5 chuỗi cung ứng block: manifest bất đồng với analysis → reject? Filler của
  một block → gated hay shadow? Code → verified cộng opt-in?
- F6 lease và claim: có kịch bản re-run âm thầm nào sau khi một action đã được
  ghi không?
- F7 egress hai lớp theo classification, tĩnh và runtime — một nhánh spawn động
  có lách qua được không? Leakage gate có đứng đúng chỗ không?
- **F8 — FMEA subsystem**: mọi subsystem tầng 1 (Event Log, Artifact Store,
  Lease, Node, Channel, vector adapter) có mang bảng _failure mode × phát hiện ×
  phục hồi_ không? Thiếu bảng là một finding.

### G — Taxonomy lỗi văn bản và lỗi thiết kế

Nhóm này là la bàn để phân loại mọi finding.

- G1 ngôn ngữ staging trong một tài liệu trần ("v1", "giai đoạn đầu", "tạm
  thời").
- G2 policy đội lốt cơ chế — với mọi mệnh lệnh tuyệt đối, hỏi nó là luật engine
  hay mặc định template.
- G3 một khái niệm chịu lực không được định nghĩa: một danh từ mà từ ba tài liệu
  trở lên dựa vào nhưng không có nhà. Tiền lệ: template, tenant, trigger,
  storage, event log.
- G4 một vòng tối ưu tự phá calibration của chính nó.
- G5 tuyệt đối hóa quá tay giết một use case hợp lệ. Tiền lệ: "không remote
  control" đối đầu với takeover.
- G6 duplicate lệch nhau — nội dung ở từ hai nơi trở lên mà không có canonical.
- G7 đặc quyền trá hình — một loại filler hay một sản phẩm có đường riêng không
  được dữ liệu hay khai báo biện minh.
- G8 danh tính mơ hồ khi ủy quyền — calibration bám vào cái gì, và cái gì là
  sub-actor?
- **G9 — lỗi giao thoa**: hai cơ chế đúng khi đứng riêng nhưng ghép lại thì sinh
  lỗi. _Chỉ desk simulation bắt được lớp này_; đọc từng spec riêng lẻ thì không
  bao giờ. Tiền lệ: masking scene đối đầu với input capture; floor propagation
  đối đầu với một chatbot cần tri thức nội bộ.

### H — Litmus

Mỗi câu trả lời là một **transcript desk simulation** — dắt kịch bản qua từng cơ
chế, trích dẫn từng bước. Trỏ vào một section chỉ chứng minh có thứ gì đó _được
viết_, không bao giờ chứng minh nó _chạy_.

### I — Versioning và migration

- I1 phủ kín: mọi entity tiến hóa được có mang id và version không?
- I2 semver có ngữ nghĩa được khai báo, áp nhất quán từ Contract tới Block không?
- I3 không upgrade ngầm ở bất kỳ tầng nào — auto-migration, node update, block,
  cascade snapshot.
- I4 mọi migration là một Task của một Role có Gate.
- I5 hai version của cùng một entity có chạy song song được không, pin theo từng
  entity?
- I6 lineage cộng một semantic diff cho từng entity có kiểu.
- I7 rollback được định nghĩa là một migration tường minh hai chiều.

### J — Cơ chế trần, bất chấp phức tạp

_Tinh thần: đích đến luôn là cơ chế MẠNH NHẤT. Phức tạp không bao giờ là lý do
dừng, và "đủ tốt" không bao giờ là đích. Mọi quyết định phải thắng một cuộc đối
kháng với mọi phương án mạnh hơn được nêu ra._

- J1 dấu vết chiết trung — "đủ dùng", "để cho nhẹ", "khó quá nên thôi".
- J2 mọi cắt giảm mang **án văn cơ chế** trong nhật ký quyết định.
- J3 "phương án lý tưởng hơn là gì, và vì sao không chọn nó?" — trả lời bằng
  effort là fail; trả lời bằng một cơ chế kém rõ hơn hoặc một vi phạm nguyên tắc
  là pass.
- J4 phức tạp dồn về engine, một lần; đơn giản dành cho user, mọi lần.
- J5 trần vẫn executable — mọi cơ chế có ít nhất một công nghệ hoặc tiền lệ đã
  được chứng minh.
- **J6 — kinh tế vận hành**: "bất chấp phức tạp" nói về effort _thiết kế_, không
  bao giờ nói về chi phí _runtime của user_. Mọi cơ chế có write amplification,
  tăng trưởng lưu trữ hay chi phí token — event-per-write, evidence, calibration,
  extraction — phải khai _hình dạng chi phí_ và _van điều tiết_ của nó: sampling,
  retention, batching, cascade.

### K — Phức tạp là quyền lựa chọn của user

- K1 zero-config test: một bản cài tối thiểu phải khai gì để chạy được? Dài quá
  vài dòng nghĩa là mặc định tối giản chỉ là giả.
- K2 cascade phủ kín mọi tham số mà engine ép phải tồn tại.
- K3 năng lực nâng cao là opt-in, không bao giờ opt-out.
- K4 tăng trưởng diễn ra dần dần, không có vách đá cấu hình.
- K5 **đơn giản nghĩa là bảo thủ hơn, không bao giờ là lỏng hơn** — không khai
  reversibility thì là irreversible, không khai classification thì là
  confidential, một timeout không phải một pass.
- K6 mọi escape hatch đều được phép nhưng phải dán nhãn và ghi vết.

### L — Cấu trúc spec chuẩn

Mỗi spec đều mang: L1 định nghĩa entity kèm danh tính · L2 tham chiếu canonical
thay vì chép nguyên tắc · L3 non-goals · L4 nhật ký quyết định có án văn cho mọi
lựa chọn · L5 litmus của riêng nó · **L6 glossary canonical** — một khái niệm,
một tên, lập bảng trong index; cùng một khái niệm dưới hai tên là một finding.

- **L7 — Danh tính tài liệu không mang số version.** Hồ sơ là một _entity tiến
  hóa được_, nên nó chịu đúng I1 mà nó áp lên sản phẩm — nhưng câu trả lời không
  phải một con số phải đồng bộ bằng tay ở hai nơi. Một tài liệu **không mang số
  version** ở tiêu đề, ở index, hay ở bất kỳ tham chiếu chéo nào: nói "spec X",
  không bao giờ nói "spec X v0.4". Version theo từng file là một nguồn sự thật
  thứ hai về danh tính tài liệu, và nó đã trôi ở cả chục file.

  **Git là lịch sử.** Một câu trả lời trước đây cho cùng bài toán là để mỗi file
  mở đầu bằng một khối changelog giữ tay; nó đã bị rút, vì một lịch sử giữ tay là
  một nguồn thứ hai không kiểm được, còn lịch sử của git thì không thể trôi.
  Index vì vậy cũng không giữ cột version.

### M — Truy vết lời hứa

_Tinh thần: mọi lời hứa có cơ chế; mọi cơ chế có lời hứa._

- M1 **xuôi**: từng mệnh đề của tuyên bố end-state trong cả ba North Star, cộng
  các luận điểm bên dưới chúng, đều trace tới ít nhất một cơ chế cụ thể. Hụt là
  một blocker — một lời hứa suông.
- M2 **ngược**: mọi cơ chế và mọi spec đều phục vụ một lời hứa hoặc một quan
  điểm. Một cái mồ côi là nghi vấn scope creep và phải có án văn.
- **M3 — một món nợ hoãn đến hạn**: nơi một tài liệu hoãn một cơ chế sang **một
  tài liệu tương lai có tên** ("chặn bởi X", "khi X được viết", "X là ràng buộc
  đầu vào của Y"), việc tài liệu đó ra đời sẽ đóng mọi câu như vậy trong cùng một
  thay đổi. Grep toàn hồ sơ theo tên tài liệu mới trước khi kết thúc thay đổi;
  một lời hoãn còn đứng cạnh chính tài liệu trả nợ cho nó là `major`, vì hai bên
  giờ trả lời cùng một câu hỏi theo hai cách khác nhau và người đọc không có cách
  nào biết bên nào là hiện hành. _Tiền lệ: ba spec runtime sandbox, clickstream
  ingest và quota mỗi cái được nêu là chưa viết ở ba đến năm chỗ — một North Star,
  một spec, sổ ADR, roadmap và scenario catalog — và không tiêu chí nào đọc lại
  những câu đó khi các tài liệu hạ cánh. M1 và M2 đều PASS ở trạng thái ấy: lời
  hứa có cơ chế và cơ chế phục vụ lời hứa. Chỉ có lời hoãn là cũ._

### N — Threat-actor battery

_Tinh thần: kẻ tấn công có tên và tài sản có chủ._

Một ma trận bảy persona đối đầu với các tài sản, chạy như một phase: **một tenant
administrator độc** (cửa hậu database, sửa log?) · **một publisher block độc**
(cài bẫy trong code, manifest hay knowledge) · **một model provider bị chiếm**
(một verifier hay agent trả về kết quả đã bị đầu độc) · **một end user độc** (đầu
độc memory, prompt injection, spam trigger) · **một insider filler** (một người
hay agent tự duyệt việc của chính mình, tuồn tri thức ra ngoài) · **một node bị
chiếm** (giả placement, rút secret) · **một curator độc** (đầu độc knowledge hoặc
một App Profile).

Mỗi ô mang một đòn tấn công cụ thể, cơ chế chặn nó, và một trích dẫn. Một ô trống
là một finding.

### O — Độ phủ cạnh tranh và tiêu chuẩn

_Tinh thần: đối thủ ship hàng quý; rubric không được chờ owner phát hiện hộ._

- O1 một **feature inventory có ngày** cho từng đối thủ được theo dõi — n8n, Dify,
  Astron, và một danh sách mở — giữ trong scenario và competitive catalog. Một
  inventory quá một quý chưa refresh là một finding `stale`.
- O2 mỗi feature mang một verdict theo taxonomy: `thay-ngang` / `thay-hơn` kèm
  tên cơ chế / `thua-tooling` (một mục roadmap, không phải một patch spec) /
  `cố-ý-không-thay, có-án-văn` / **`GAP`**, thứ đi vào pipeline quyết định.
- O3 **một trigger chạy lại**: một bản release lớn của đối thủ, hoặc một đối thủ
  mới, sẽ chạy nhóm O cục bộ mà không đợi một full run.
- O4 một standards inventory — OCI, sigstore, MCP, computer-use API — nơi các tiền
  lệ của J5 có ngày; một chuẩn đang trên đường bị deprecate hoặc bị thay là một
  finding.

### P — Lifecycle completeness

_Tinh thần: đừng hỏi "thứ đang có đã đúng chưa" — hãy hỏi "MỌI giai đoạn vòng đời
đã có nhà chưa". Một ô trống không có mục nào trong sổ là một finding._

Checklist này cố ý là tiên nghiệm, như thuốc chữa cho chính điểm mù của rubric:
một rubric dẫn xuất từ thứ đã được viết thì chỉ nhìn thấy thứ đã được viết.

- **P1 Product**: build → version → release → deploy → upgrade → operate →
  backup/restore → **deprecate và EOL** → sunset.
- **P2 Entity**: create → version → migrate → rollback → delete và GC.
- **P3 Data**: ingest → classify → retain → **backup/restore** → export → shred.
  **Một luật giao thoa bắt buộc**: mọi cơ chế xóa hay quên phải khai quan hệ của
  nó với đường sao lưu — một cái "xóa" mà backup hồi sinh được là một lời hứa
  suông. Tiền lệ: khóa nằm ngoài backup, Event Log §4.
- **P3b — luật giao thoa theo CHIỀU NGƯỢC, và theo LOẠI bản sao**: (a) mọi cơ chế
  _khôi phục_ phải khai **điều gì là đủ để đọc lại được** — khóa, adapter,
  schema version. "Restore từ backup" mà không có đường khóa là lời hứa suông đối
  xứng với P3. (b) Cấm từng _nơi_ vẫn chưa đủ: phải khai cả **loại** bản sao được
  phép. Một bản sao **rewind hay point-in-time** hồi sinh đúng thứ vừa bị hủy,
  nên chỉ một **replica tiến-lên-trước**, thứ mà một lệnh xóa với tới được, mới
  hợp lệ. _Án văn: P3 đã chạy một chiều suốt một thời gian dài và tuyên bố đã đóng
  lỗ backup-hồi-sinh-dữ-liệu-đã-shred; đúng lỗ đó lại được tìm thấy ở một cửa
  khác — một snapshot của key store — cùng với mặt ngược của nó: mất máy là mất
  tất cả dù backup còn nguyên._
- **P4 Actor, Node, Adapter**: enroll hoặc register → update → suspend →
  **decommission có graceful drain** → revoke.
- **P5 Change và Contribution**: propose → review → integrate qua một queue, đối
  chiếu với lỗi giao thoa → land → **revert hoặc rollback rẻ**. Áp cho MỌI dòng
  thay đổi: code, spec, block, knowledge, config. Một ô revert không có đường lùi
  rẻ là một finding, và một cái "revert" không có down path chuẩn bị trước là một
  câu nói chứ không phải một cơ chế.

---

## PHẦN III — PHƯƠNG PHÁP

> Bài học nền: **mỗi phương pháp bắt đúng lớp lỗi mà phương pháp trước nó mù**.
> Đường cong quan sát được: đọc thủ công bắt G3 → quét danh từ bắt hạ tầng ngầm →
> desk simulation bắt lỗi giao thoa G9 → đối kháng cạnh tranh bắt lỗ use case →
> spec hóa một cuốn sổ bắt những câu hỏi mà mô phỏng đã bỏ qua. Một phương pháp
> chạy cạn không có nghĩa là hồ sơ đã sạch.

| Phase | Việc                                                                                                                                                         | Lớp lỗi bắt được                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 0     | **A0**: dựng lại inventory quan điểm từ nguồn, diff với nhóm A                                                                                               | Một rubric thiếu quan điểm                    |
| 1     | Quét cơ giới: grep ngôn ngữ staging G1, các tuyệt đối G5 (điểm danh những cái cố ý), con số cứng B3, tham chiếu chéo, duplicate                              | G1, G6, B3                                    |
| 2     | Đọc từng file đối chiếu A–P, điền **coverage matrix** — mỗi ô cần bằng chứng, chống coverage theater                                                         | Toàn phổ tĩnh                                 |
| 3     | **Quét danh từ hạ tầng**: mọi danh từ xuất hiện ở từ hai file trở lên, hỏi "nó có nhà chưa?"                                                                 | G3                                            |
| 4     | **Desk simulation battery**: cơ bản → trung bình → phức tạp → biên và đối kháng → meta, ít nhất năm lượt, dừng khi bão hòa; mỗi kịch bản dắt qua từng cơ chế | **Lỗi giao thoa G9** — chỉ phase này bắt được |
| 5     | **Đối kháng cạnh tranh**: liệt kê đầy đủ kịch bản khách hàng của một đối thủ, rồi trace từng cái qua ecoma                                                   | Lỗ use case, định vị                          |
| 6     | Litmus full-pass (Phần IV) bằng transcript desk simulation                                                                                                   | H                                             |
| 7     | Findings → patch, mỗi patch chạy lại ma trận nguyên-tắc × invariant trước khi được ghi → hậu kiểm grep → cập nhật sổ và index                                | Regression                                    |

**Kỹ thuật bổ sung — kịch bản là tài sản, không phải phế phẩm:**

- **Scenario catalog** ([scenario-catalog](scenario-catalog.md), append-only):
  mọi kịch bản từng chạy, có id và verdict. Mỗi lượt vừa là **regression** — chạy
  lại catalog trên bộ tài liệu mới, để một patch làm gãy một kịch bản cũ bị bắt —
  vừa là **exploration**, sinh kịch bản mới và nạp vào catalog.
- **Một dimension model cho exploration**, để kịch bản được sinh ra bằng cách đo
  lỗ hổng độ phủ chứ không bằng ngẫu hứng: `loại trigger × filler mix
(người/AI/rule/external/process) × irreversible? × bên ngoài? × knowledge hay
memory? × deterministic/reasoning/hybrid × quy mô (n=1 / team / agency nhiều
client) × chế độ (happy / failure / adversarial)`. Một ô chưa từng có kịch bản
  là một vùng mù khai báo được.
- **Phase 4b — persona review battery**: đọc bộ tài liệu qua năm góc nhìn — SRE
  hoặc operator, compliance officer, developer đang implement, người mua agency,
  contributor cộng đồng — mỗi góc nhìn năm câu hỏi đặc trưng. Một câu hỏi mà tài
  liệu không trả lời được là một finding.
- **Phase 4c — FMEA subsystem**, thứ nuôi F8: một bảng có hệ thống cho từng
  subsystem tầng 1.
- **Implementation-sketch test**, một mũi dò mơ hồ chủ động: chọn một cơ chế,
  phác hai bản pseudo-implementation _độc lập_ từ đúng cùng một đoạn spec. Lệch
  nhau là một mơ hồ mức major được tìm ra trước khi một kỹ sư thật tìm ra nó.

**Coverage matrix, doc class × nhóm:**

| Doc class                     | Ví dụ                        | Nhóm bắt buộc                            | Miễn, kèm án văn                                                                                                                        |
| ----------------------------- | ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Trần** (North Star và spec) | 3 North Star, 27 spec        | A–P **đủ**                               |                                                                                                                                         |
| **System charter**            | playbook funnel              | B, D, F, G kể cả G9, I, J, K, L, M, N, P | A (nó không mang quan điểm sáng lập), C (nó không định nghĩa invariant), E (nó không sở hữu flywheel), H → litmus **riêng của charter** |
| **Meta**                      | rubric này, scenario catalog | G, L, **self-conformance** ở dưới        | A–F, I–K — chúng không mô tả cơ chế sản phẩm                                                                                            |
| **Sống**                      | sổ thị trường                | J cho án văn, L4 cho nhật ký quyết định  | Phần còn lại — sự thật thị trường không phải thứ để một rubric phán                                                                     |

_Một ô "miễn" phải có án văn ghi ngay tại đây; một miễn trừ im lặng chính là
coverage theater._

**Kỹ thuật thêm:**

- **Rubric self-conformance pass**, bắt buộc mở đầu mọi full run: rubric có tuân
  chính **L7** của nó — không mang số version ở bất kỳ đâu trong danh tính — và
  chính **R12** của nó — coverage matrix được khai, và chính tài liệu này không
  phải cái được âm thầm miễn review — không? Và nó có tuân **luật miễn dịch (luật 8)** của hiến pháp không, luật buộc mọi tiêu chí mà một lượt chạy trước đã phải
  sinh ra thì phải tồn tại thật ở đây chứ không chỉ trong report của lượt ấy?
  Tiền lệ là chính tài liệu này đã sống qua vài lượt với một tiêu đề sai và không
  có coverage matrix, vì không ai được giao việc kiểm người kiểm.
- **Đối chiếu nợ khai rải rác với sổ nợ trung tâm, theo cả hai chiều**: grep toàn
  hồ sơ theo "sau này", "sổ", "chờ spec", "gap", rồi đối chiếu hai chiều với sổ.
- **Patch adversarial pass, bắt buộc ở phase 7, TRƯỚC khi ghi**: mỗi patch chịu
  ba đòn, và thất bại một đòn nghĩa là viết lại patch chứ không phải ghi rồi sửa
  sau. Nó có đẻ ra một biên hay một nguồn sự thật thứ hai không? Nó có đứng vững
  ở n=1 không? Nó có sống sót trước phương án mạnh nhất không?
- **Bước đếm-số-cuối-cùng của thủ tục phủ những con số nào ở đây**: tổng litmus,
  exit litmus của milestone, và số lượng spec.
- **Bảng FMEA là điều kiện tồn tại của một subsystem tầng 1**: mọi spec mới tự
  khai mình là subsystem tầng 1 phải mang bảng FMEA của nó **trong cùng lượt đã
  tạo ra nó** (R12).

**Luật xoay phương pháp**, của riêng hồ sơ này và không elevate đi đâu: hai lượt
liên tiếp của _cùng một phương pháp_ mà ra không blocker nào thì bắt buộc phải
đổi phương pháp. Đó chính là lý do bước run report của thủ tục đòi phải ghi lại
một phase rỗng — cò không bóp được trên bằng chứng không ai viết xuống.

**Ba cấp protocol của hồ sơ này**, tên và nội dung mà bước khai-mức của thủ tục
trỏ tới ở đây: `incremental` cho mỗi patch — ma trận nguyên-tắc × invariant cộng
một lượt grep hậu kiểm; `cluster` cho mỗi spec hay cụm mới — phase 2 và 4 cục bộ,
cộng litmus của cụm; và `full`, thứ nợ mọi phase.

**Một run report trên hồ sơ này** đặt tên đúng hai nguồn phát hiện và chỉ hai —
hệ hoặc owner — chính là thứ làm cho kênh owner (R10) đo được chứ không chỉ được
khẳng định.

---

## PHẦN IV — MIRROR LITMUS

> Phạm vi: đây là mirror của litmus **cấp hệ** — ba North Star cộng ba spec lõi
> được nâng lên cấp hệ (Working Data, Memory, Tenant & Identity). Litmus canonical
> nằm trong từng spec. Trước mỗi lượt, diff mirror này với các nguồn canonical của
> nó.

**Platform**: đổi một Filler người sang AI mà không sửa flow · shadow mode với
bảng đối chiếu tự sinh · một thang tin cậy cho cả người lẫn AI · cost và quality
theo Role bất kể ai lấp.

**RPA**: một automation chạy vừa như script _vừa_ như agent mà không đổi định
nghĩa · một script vỡ được agent vá, có lineage và không cần người · replay một
session từ log cộng evidence · takeover nằm trong cùng cuốn log · một secret
không bao giờ chạm tới log, screenshot hay context.

**Hub**: rút phích và mọi tenant vẫn chạy vĩnh viễn · cùng một digest xuyên
public, mirror và air gap · một manifest bất đồng với analysis bị reject · một
publisher biến mất mà người mua không hề hấn · hai version Contract chạy song
song.

**Working Data**: dựng lại table, index và metric từ log cộng lưu trữ
content-addressed một cách tương đương · time-travel một câu join theo log
position · một lần sửa tay database bị phát hiện và được dựng lại có hồ sơ · mọi
write, kể cả bulk, mang đúng một danh tính actor.

**Memory**: đổi filler và trí nhớ về khách hàng vẫn còn nguyên · mọi entry truy
được về bằng chứng gốc của nó · không có đường nào để một lời khai của khách hàng
thành fact mà không qua Gate · không có kịch bản nào khách A thấy khách B.

**Tenant & Identity**: ở n=1 mọi khái niệm đều vô hình · một nhân viên nghỉ việc
và đòi được quên, audit pseudonym sống sót trong khi PII chết · không có đường
nào merge một party mà không qua Gate · client của một agency duyệt mà không cần
account.

---

## PHẦN V — ĐỐI KHÁNG CHÍNH BỘ RUBRIC

Các điểm mù tự khai, để người chạy nó sau không ôm ảo tưởng nào.

| Điểm mù                                                                                                                                                   | Giảm thiểu đã cài                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Tự chấm**: tác giả của hồ sơ chạy rubric trên chính việc của mình                                                                                       | Luật PASS-phải-falsifiable của hiến pháp cộng coverage có bằng chứng; bước fresh reader của nó quyết định lượt pass đóng băng cuối |
| **Rubric nhìn về quá khứ**: nó được viết cho các lớp lỗi đã tìm thấy, và mù với lớp kế tiếp                                                               | Luật xoay phương pháp, cộng ít nhất một phương pháp mới cho mỗi full run                                                           |
| **Goodhart**: pass phần câu chữ mà trượt phần tinh thần                                                                                                   | Một câu hỏi tinh thần cho mỗi nhóm, và verdict `tension`                                                                           |
| **Coverage theater**: tick một ô mà không đọc                                                                                                             | Mỗi ô PASS đòi một trích dẫn hoặc một đòn tấn công đã ghi lại                                                                      |
| **Ảo tưởng bão hòa**: "không tìm thấy" không phải "không có"                                                                                              | PASS nghĩa là sống sót N đòn đã ghi lại; bão hòa được định nghĩa đo được                                                           |
| **Trôi tham chiếu**: tài liệu đánh số lại một section và rubric trỏ vào hư không                                                                          | Rubric trỏ vào _khái niệm_ trước, số section sau; mọi patch đổi cấu trúc section phải kiểm lại                                     |
| **Chi phí giết kỷ luật**                                                                                                                                  | Ba cấp protocol                                                                                                                    |
| **Một giới hạn bản thể**: rubric này chỉ đo _nhất quán nội tại_ — một hồ sơ hoàn hảo về nội tại vẫn có thể là sản phẩm sai cho thị trường                 | Ghi thẳng: rubric không thay được phỏng vấn khách hàng, không thay được ICP, không thay được kill criteria                         |
| **Buồng vọng của một trí tuệ**: người tấn công và người phòng thủ là cùng một người                                                                       | Góc nhìn đối thủ ở phase 5 là một proxy; khuyến nghị đứng nguyên là một red team người thật                                        |
| **Điểm mù của chính việc vá**: rubric đo _hồ sơ_, không đo _bản patch_ — mà patch là nơi một khái niệm mới dễ bị đẻ ra nhất, dưới áp lực đóng một finding | Patch adversarial pass ở phase 7, cộng luật đếm-số-cuối-cùng                                                                       |

---

## PHẦN VI — INVENTORY QUAN ĐIỂM SÁNG LẬP

Nguồn để chạy A0 — tự chứa, không phụ thuộc vào bất kỳ hội thoại nào.

| #   | Quan điểm                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Bài toán cốt lõi: hợp nhất hai lực lượng lao động, người và AI                                                                                                                                                         |
| V2  | Deterministic và reasoning, liền mạch; engine không có `if deterministic`                                                                                                                                              |
| V3  | Công ty một người là một bong bóng; ở n=1 nỗi đau là điều phối — AI nhân sản lượng lên và xác minh trở thành nút thắt; tuyển người kéo nỗi đau đó theo; **và lớn lên không được đòi viết lại**                         |
| V4  | ML là một tính năng thêm — ba tham vọng (quy trình, checkpoint, prompting) không bao giờ đi trước dữ liệu                                                                                                              |
| V5  | 20% của BPMN giải 90%; không theo BPMN 2.0; đối thủ "đi lên từ nghề"                                                                                                                                                   |
| V6  | Một inbox tự xây                                                                                                                                                                                                       |
| V7  | Một agent runtime tự xây                                                                                                                                                                                               |
| V8  | Pair-design: người và AI cùng thiết kế quy trình                                                                                                                                                                       |
| V9  | Docker và Kubernetes                                                                                                                                                                                                   |
| V10 | Fair-code dưới SUL, open-core, bốn dòng doanh thu, chặn phân phối lại vì mục đích thương mại, không bao giờ dán nhãn "open source"                                                                                     |
| V11 | Dữ liệu học thuộc về tenant; việc học diễn ra theo từng tenant                                                                                                                                                         |
| V12 | **Phức tạp và effort không phải ràng buộc — đích đến luôn là cơ chế MẠNH NHẤT**: mọi quyết định phải là phương án mạnh nhất sống sót qua đối kháng. Falsifiable: nêu ra được một phương án mạnh hơn đã không được chọn |
| V13 | Phức tạp là quyền lựa chọn của user                                                                                                                                                                                    |
| V14 | Verifier do người thiết kế quy trình cài; nhiều verifier chạy song song hoặc tuần tự; chấm lại sau khi hoàn thành là được phép                                                                                         |
| V15 | RPA là một sản phẩm riêng trong domain riêng của nó, integration-first, nằm trong monorepo                                                                                                                             |
| V16 | Hub, Block và Template — cộng đồng nối dài cái đuôi                                                                                                                                                                    |
| V17 | Enterprise và Cloud là hai lớp song song; lõi tenant có cardinality ≥ 1                                                                                                                                                |
| V18 | Knowledge: nhiều kho, có phân quyền, có phân mật, bật tắt theo từng tenant                                                                                                                                             |
| V19 | Một chatbot trên ecoma là use case hạng nhất                                                                                                                                                                           |
| V20 | DataTable có join nâng cao, khác một công cụ workflow; mặc định là stack Postgres; không phát minh lại bánh xe                                                                                                         |
| V21 | Locking phải tồn tại, và nó là Lease                                                                                                                                                                                   |
| V22 | Memory thuộc về tổ chức, khóa theo subject                                                                                                                                                                             |
| V23 | Văn hóa: review đối kháng nhiều lượt; một rubric tự tiến hóa                                                                                                                                                           |

A0 diff nhóm A với bảng này. Một quan điểm mới của owner thêm một dòng V mới,
append-only.
