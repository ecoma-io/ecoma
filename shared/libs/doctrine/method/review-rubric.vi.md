---
title: "Review Rubric & Method"
status: design-end-state
canonical-sha: 47e7885dea2b
---

# Review Rubric & Method

>

---

## PHẦN I — HIẾN PHÁP PHÁN XÉT

### 1. Thứ tự ưu tiên khi tiêu chí va nhau (R7)

`Invariant (5) > Nguyên tắc canonical (4, North Star §3) > Nguyên tắc domain (RPA/Hub §3) > Policy/Template`
Va chạm không được âm thầm chọn — ghi thành finding loại `tension`.

### 2. Thang severity (R5) — test khách quan

| Mức       | Test                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| `blocker` | Vi phạm invariant/nguyên tắc canonical, HOẶC mặc định không an toàn (đơn giản = lỏng hơn) |
| `major`   | Hai kỹ sư đọc sẽ implement khác nhau; hoặc khái niệm chịu lực không định nghĩa            |
| `minor`   | Câu chữ, tham chiếu, nhãn thiếu                                                           |

### 3. Luật verdict (R1, R4, R8)

- **PASS phải falsifiable**: kèm trích dẫn kiểm được. Tiêu chí dạng "tìm một kịch bản…" → PASS = **sống sót ≥N đòn tấn công có hồ sơ** (mặc định N=3), không phải "chưa tìm kỹ".
- **FAIL** kèm kịch bản tái hiện.
- **KNOWN-GAP** chỉ hợp lệ khi (a) đã tự khai trong docs **trước** lượt chạy, hoặc (b) thuộc miền kinh doanh. Lỗ cơ chế phát hiện _trong_ lượt = FAIL; chỉ đóng bằng fix hoặc `accepted-by-owner` có lý do + xác nhận của owner.

### 4. Schema finding (R6) — sổ append-only

`(criterion@rubric-version, file, trích dẫn/kịch bản, verdict, severity, án-văn-hoặc-fix-ref, vòng)`

### 5. Luật miễn dịch (R9) — điều biến rubric thành hệ tự tiến hóa

**Mỗi finding mà không một tiêu chí sẵn có nào bắt được → BẮT BUỘC sinh tiêu chí/kỹ thuật mới trong cùng patch**, ghi vào nhật ký version kèm tiền lệ. Rubric không có R9 chỉ là ảnh tĩnh của các lỗi quá khứ. Hệ quả trung thực: rubric **không bao giờ "tối ưu nhất"** — chỉ "mạnh nhất đến nay + đang tiến hóa"; claim tối ưu tuyệt đối tự phạm R1 (không falsifiable).

### 6. Kênh owner (R10)

Lịch sử mọi vòng đến nay: người bắt lỗ hiệu quả nhất là **owner, bằng câu hỏi ngây thơ** ("X là gì?", "sao không có Y?"). Luật: **mọi câu hỏi của owner mà docs không trả lời được bằng đúng một trích dẫn = finding chính thức** (severity theo R5), và R9 áp dụng — nếu không tiêu chí nào lẽ ra bắt được, sinh tiêu chí mới.

### 7. Owner-fact sync (R11)

Mọi convention/quyết định/thông tin owner nêu ra → **ghi vào memory + docs trong cùng lượt**; còn sót trong hội thoại = finding tự động (tiền lệ: monorepo convention, kill-criteria treo). Trước mỗi freeze: **owner-debrief 5 câu** bắt buộc — "có convention/quyết định nào anh từng nói chưa thấy trong docs?", "phần nào anh _cảm thấy_ mỏng?", "gần đây anh đọc/thấy gì ở đối thủ?", "có ai hỏi anh câu gì mà docs không trả lời được?", "điều gì anh đang đánh cược mà chưa ghi?".

### 8. Không tồn tại tài liệu "chưa review" âm thầm (R12)

File/section mới (mọi class — trần, charter, sống) phải qua **cluster-run trong cùng lượt tạo ra nó**, hoặc mang nhãn `chưa-review` trong index cho tới khi chạy. Coverage matrix khai tường minh **doc-class × nhóm áp dụng** — charter chịu đủ J/G/K/G9 như trần (tiền lệ SSR lọt vì charter được đối xử nhẹ).

### 9. Điều kiện đóng băng

0 blocker + 0 major mở; mọi KNOWN-GAP có tên trong North Star/index; **coverage matrix kín** (R3: mọi file × mọi nhóm, ô = scanned/N-A kèm bằng chứng); litmus **full-pass toàn bộ** (**hiện 148: 20 NS + 103 L5 của 24 spec + 25 charter**; **đếm lại bằng script ở BƯỚC CUỐI của mỗi lượt**, sau mọi patch: cho thấy vá-số-trước-patch thì số sai ngay khi patch thêm litmus) bằng desk-sim, không phải chỉ 38 câu mirror.

---

## PHẦN II — BỘ TIÊU CHÍ A–P

> Mỗi nhóm có **câu hỏi tinh thần** đứng trên tiêu chí (chống Goodhart): nếu mọi tiêu chí pass mà câu tinh thần lung lay → finding `tension`.

### A — Trung thành quan điểm sáng lập

_Tinh thần: hồ sơ còn phục vụ đúng người sáng lập không?_

- **A0 (bắt buộc chạy đầu tiên)**: dựng lại **inventory quan điểm từ nguồn gốc** (hội thoại/nhật ký quyết định), diff với danh sách A hiện hành — nhóm A chỉ chấm được thứ nó nhớ, và lịch sử cho thấy nó đã thiếu ≥3 lần.
- A1 hợp nhất 2 lực lượng bằng _cơ chế_ (Role/Filler + trust tiers + một thang Judgment) không phải khẩu hiệu · A2 luận điểm tăng trưởng n=1→N không-rewrite có cơ chế · A3 không một dòng `if-deterministic` trong engine; duality nổi từ khai báo · A4 ba tham vọng ML có nguồn dữ liệu định danh, không đi trước flywheel · A5 pair-design có chỗ đứng cơ chế · A6 các quyết định đã chốt còn nguyên (inbox tự xây, runtime tự xây, Docker/K8s, không BPMN, SUL, fair-code không nhãn "open source", một lõi ML, memory thuộc tổ chức) · A7 RPA integration-first: standalone là phép chiếu.

### B — Bốn nguyên tắc cơ chế (dạng tấn công)

_Tinh thần: engine có đang lén làm policy không?_

- B1 mọi câu chứa "người/human/AI" — cái nào là _luật engine_ thay vì _mặc định template_? · B2 mọi thứ được calibration — cái nào thiếu identity ổn định/lineage? · B3 mọi con số cứng — cái nào nằm ở engine thay vì template? · B4 _(deprecated → nhóm K)_.

### C — Năm invariant (dạng tấn công)

_Tinh thần: năm lời hứa nền còn không thể vi phạm không?_

- C1 kịch bản đổi Filler buộc sửa flow? · C2 hành động không dấu vết (override không Judgment? engine tự sửa? can thiệp không là Task-của-Role?) · C3 mọi điểm tiêu thụ chú ý có triage/ưu-tiên/storm-control? · C4 vẽ đường đi một byte dữ liệu học từ sinh đến dùng — điểm nào rời tenant không opt-in? · C5 trạng thái kẹt im lặng, hoặc timeout/bế tắc → auto-pass?

- **C6** — **vách mềm workspace**: mọi cơ chế _tổng hợp / khái quát hóa / gộp_ (distill, calibration pool, analytics aggregate, block install, collection, projection dùng chung) phải khai **chiều workspace**; không khai = mặc định **hẹp nhất**. C4 chỉ canh biên cứng tenant — vách mềm là nơi khách hàng thật (agency đa client) chảy máu.

### D — Ranh giới kiến trúc

_Tinh thần: các domain còn không thể lẫn vào nhau không?_

- D1 kênh thứ ba lậu ngoài (Filler + Session effect) và (resolve/pull/verify)? — kể cả learning signal/proposal/update/telemetry · D2 rút phích Hub: liệt kê mọi thứ ngừng — có gì runtime? entitlement/license-key/phone-home trong engine? · D3 tính năng EE không qua extension point (fork trá hình)? · D4 control plane _vá_ thay vì _gọi_? · D5 cơ chế nào chỉ đúng ở SaaS (tenant phải cardinality ≥ 1)? · D6 Platform biết selector/vision? RPA biết Gate/calibration? · D7 shared mutable state ngoài Handoff/DataTable-event? · D8 (mới) module opt-in nào tắt mà **không** zero-overhead?

### E — Danh tính, phiên bản, flywheel

_Tinh thần: hệ có tự đốt dữ liệu học của chính nó không?_

- E1 pinning phủ kín — một chỗ upgrade ngầm phá instance đang chạy? · E2 mọi version mới có parent+decay (verifier, filler, contract, criterion, script, profile, driver, table, metric)? · E3 cold-start per-tenant đủ 3 thuốc; chỗ nào ngầm dựa cross-tenant? · E4 bộ não ML thứ hai (micro-consumer vượt thống kê? index ML chạm calibration tenant?) · **E5 (mới) "một sự thật một nhà"**: liệt kê mọi _loại sự thật_ — cái nào có ≥2 nơi ghi? (tiền lệ đã chặn: memory-về-filler vs calibration; bảng-tự-ghi vs event log; **một _nhãn/trường_ mới cũng là một loại sự thật — `run_kind` được khai _hệ quả_ ở 4 consumer nhưng không có nhà ⇒ projection viết sau sẽ quên lọc, **). Hệ quả thao tác: patch nào khai "hệ quả của X ở nhiều nơi" phải chỉ ra **X sống ở đâu** trước khi ghi.

### F — An toàn & trách nhiệm

_Tinh thần: điều tồi tệ có bị chặn bởi cấu trúc thay vì lời dặn không?_

- F1 effect nào chạy được mà không phân lớp? "không khai = irreversible" nhất quán Platform + RPA action? · F2 đường unwind vượt commit point? · F3 vẽ đường đi một credential/secret — điểm nào giá trị lọt executor/log/evidence/prompt? masking một chốt tại perception, **input capture**, **và mọi kênh phát lại/live-view**? · F4 node chưa enroll claim/nhận secret? kênh điều khiển thường trực? input takeover nào không thành Action-có-actor? · F5 chuỗi cung ứng block: manifest≠analysis → reject? filler block → gated/shadow? code → verified+opt-in? · F6 lease/claim: kịch bản silent re-run sau khi có action ghi? · F7 (mới) egress theo classification hai lớp (static + runtime) — nhánh dynamic spawning lách được? leakage-gate đứng đúng chỗ? · **F8 (vòng ≤15) FMEA subsystem**: mỗi subsystem tầng 1 (Event Log, Artifact Store, Lease, Node, Channel, vector adapter) có bảng _failure-mode × phát-hiện × phục-hồi_? — thiếu bảng = finding (docs hiện tại sẽ dính)

### G — Taxonomy lỗi văn bản & thiết kế (la bàn phân loại mọi finding)

- G1 ngôn ngữ staging trong tài liệu trần ("v1/giai đoạn đầu/tạm") · G2 policy đội lốt cơ chế (mệnh lệnh tuyệt đối: luật engine hay mặc định template?) · G3 khái niệm chịu lực không định nghĩa (danh từ được ≥3 tài liệu dựa vào mà chưa có nhà — tiền lệ: template, tenant, trigger, storage, event log) · G4 vòng tối ưu tự phá calibration của chính nó · G5 tuyệt đối hóa quá tay (một use-case hợp lệ bị giết — tiền lệ: "không remote control" vs takeover) · G6 duplicate lệch nhau (nội dung ≥2 nơi không có canonical) · G7 đặc quyền trá hình (một loại filler/sản phẩm có đường riêng không do dữ liệu/khai báo) · G8 danh tính mơ hồ khi ủy quyền (calibration bám đâu, sub-actor?) · **G9 (mới) lỗi giao thoa**: hai cơ chế đúng riêng lẻ, ghép lại sinh lỗi — _chỉ bắt được bằng desk-sim_, không bắt được bằng đọc từng spec (tiền lệ: masking-scene vs input-capture; floor-propagation vs chatbot-cần-internal).

### H — Litmus (danh mục đầy đủ, PHẦN IV)

Mỗi câu trả lời bằng **desk-sim transcript** (dắt kịch bản qua từng cơ chế, trích từng bước) — trỏ section chỉ chứng minh _có viết_, không chứng minh _chạy được_.

### I — Versioning & Migration

- I1 phủ kín: mọi entity tiến hóa được có (id+version)? · I2 semver có ngữ nghĩa khai báo, áp nhất quán Contract→Block? · I3 không upgrade ngầm ở mọi tầng (auto-migrate, node update, block, cascade snapshot) · I4 mọi migration là Task-của-Role-có-Gate · I5 hai version cùng entity chạy song song (pinning per-entity)? · I6 lineage + semantic diff theo entity-có-kiểu · I7 rollback định nghĩa = migration tường minh hai chiều.

### J — Cơ chế trần, bất chấp phức tạp

_Tinh thần: đích đến luôn là cơ chế TỐI ƯU NHẤT — phức tạp không bao giờ là lý do dừng, và "đủ tốt" không bao giờ là đích. Mỗi quyết định phải thắng cuộc đối kháng với mọi phương án mạnh hơn được nêu ra._

- J1 dấu vết chiết trung ("đủ dùng/để nhẹ/khó nên thôi") · J2 mọi cắt giảm có **án văn cơ chế** trong nhật ký quyết định · J3 "phương án lý tưởng hơn là gì, sao không chọn?" — trả lời bằng effort = fail; bằng cơ-chế-kém-rõ/phạm-nguyên-tắc = pass · J4 phức tạp dồn về engine (một lần), đơn giản dành cho user (mọi lần) · J5 trần vẫn executable — mỗi cơ chế chỉ được ≥1 công nghệ/tiền lệ đã chứng minh · **J6 (vòng ≤15) kinh tế vận hành**: "bất chấp phức tạp" là về effort _thiết kế_, không phải chi phí _runtime của user_ — cơ chế có write-amplification/tăng trưởng lưu trữ/chi phí token (event-per-write, evidence, calibration, extraction) phải khai _hình dạng chi phí_ + _van điều tiết_ (sampling/retention/batch/cascade).

### K — Phức tạp là quyền lựa chọn của user

- K1 zero-config test: bản tối thiểu phải khai để chạy — dài quá vài dòng là mặc-định-tối-giản giả · K2 cascade phủ kín mọi tham số engine ép · K3 nâng cao là opt-in, không phải opt-out · K4 tăng dần không vách đá cấu hình · K5 **đơn giản = bảo thủ hơn, không bao giờ = lỏng hơn** (không khai reversibility = irreversible; không khai classification = confidential; timeout ≠ pass) · K6 mọi escape hatch được phép-nhưng-dán-nhãn-và-ghi-vết.

### L (mới) — Cấu trúc spec chuẩn

Mỗi spec phải có đủ: L1 định nghĩa entity + danh tính · L2 tham chiếu canonical (không chép nguyên tắc) · L3 non-goals · L4 nhật ký quyết định (án văn cho mọi lựa chọn) · L5 litmus riêng của spec · **L6 (vòng ≤15) glossary canonical**: một khái niệm một tên — bảng thuật ngữ trong index; cùng khái niệm hai tên = finding.

- **L7 — Doc identity: VÒNG là danh tính, không có số version**: hồ sơ là **entity tiến hóa được** nên chịu đúng I1 mà nó áp lên sản phẩm — nhưng cách trả I1 **không** phải gắn thêm một con số phải đồng bộ tay ở hai nơi. Bốn luật: (a) **tài liệu KHÔNG mang số version** ở tiêu đề, ở index, hay ở bất kỳ tham chiếu chéo nào — nói "spec X ", không nói "spec X v0.4"; (b) mỗi file trần/charter mở đầu bằng khối **`> **Nhật ký sửa**`** xếp **giảm dần**, mỗi dòng định dạng **`vòng NN — nội dung`** ⇒ grep được, CI lint được sau này; (c) **mọi patch thêm một dòng vòng**, không có sửa im lặng (R12); (d) **index không giữ cột version** — nó giữ **vòng cập nhật gần nhất**, và vì vòng là một sự kiện có thật trong run report nên nó **kiểm chứng được**, khác một con số tự khai. _Án văn: version per-file là nguồn sự thật thứ hai về danh tính tài liệu và đã trôi ở 12 file; vòng thì chỉ có một nhà (catalog Phần 5). Bỏ số = giết lớp lỗi tận gốc, không phải vá nó._

### M (vòng ≤15) — Truy vết lời hứa (completeness xuôi)

_Tinh thần: mọi lời hứa có cơ chế; mọi cơ chế có lời hứa._

- M1 **xuôi**: từng mệnh đề trong tuyên bố end-state (cả 3 North Star §1) + luận điểm §2 → trace tới ≥1 cơ chế cụ thể; hụt = blocker (hứa suông).
- M2 **ngược**: từng cơ chế/spec → phục vụ lời hứa/quan điểm nào; mồ côi = nghi vấn scope creep, đòi án văn.

### N (vòng ≤15) — Threat-actor battery (an ninh có kỷ luật, không nhờ may mắn kịch bản)

_Tinh thần: kẻ tấn công có tên, tài sản có chủ._
Ma trận 7 persona × tài sản, chạy như một phase: `tenant-admin độc` (cửa hậu DB, sửa log?) · `publisher block độc` (code/manifest/knowledge cài bẫy) · `model provider bị chiếm` (verifier/agent trả kết quả độc) · `end-user độc` (poisoning memory, prompt injection, trigger spam) · `insider filler` (người/agent tự approve, tuồn tri thức) · `node bị chiếm` (giả placement, rút secret) · `curator độc` (đầu độc knowledge/App Profile). Mỗi ô: đòn cụ thể + cơ chế chặn + trích dẫn; ô trống = finding.

### O (vòng ≤15) — Competitive & standards coverage (nghĩa vụ thường trực, không phải lượt ad-hoc)

_Tinh thần: đối thủ ship hàng quý; rubric không được chờ owner phát hiện hộ._

- O1 **Feature inventory có ngày** cho từng đối thủ theo dõi (n8n, Dify, Astron, + danh sách mở) — lưu trong Scenario & Competitive Catalog; inventory quá 1 quý chưa refresh (web search) = finding `stale`.
- O2 Mỗi feature mang verdict taxonomy: `thay-ngang` / `thay-hơn` (kèm cơ chế) / `thua-tooling` (roadmap, không vá spec) / `không-thay-có-án-văn` / **`GAP`** (→ vào pipeline quyết định như DataTable/memory đã đi).
- O3 **Trigger re-run**: đối thủ release lớn hoặc thêm đối thủ mới → chạy lại O cục bộ, không đợi full-run.
- O4 Standards inventory (OCI, sigstore, MCP, computer-use API…): tiền lệ J5 có ngày — chuẩn bị deprecated/thay thế = finding.

### P — Lifecycle completeness (checklist tiên nghiệm — trị mù tự thân của rubric-derive-từ-cái-đã-viết)

_Tinh thần: không hỏi "cái đang có đúng chưa" — hỏi "MỌI giai đoạn vòng đời đã có nhà chưa". Ô trống không có ledger = finding._

- **P1 Product**: build → version → release → deploy → upgrade → operate → backup/restore → **deprecate/EOL** → sunset.
- **P2 Entity**: create → version → migrate → rollback → delete/GC.
- **P3 Data**: ingest → classify → retain → **backup/restore** → export → shred. **Luật giao thoa bắt buộc**: mọi cơ chế xóa/quên phải khai quan hệ với đường sao lưu — "xóa" mà backup hồi sinh được là lời hứa suông (tiền lệ: khóa-ngoài-backup, Event Log §4).
- **P3b — luật giao thoa CHIỀU NGƯỢC, và theo LOẠI bản sao**: (a) mọi cơ chế **khôi phục** phải khai **điều kiện đủ để đọc lại được** (khóa, adapter, schema-version) — "restore backup" không kèm đường khóa là lời hứa suông đối xứng với P3; (b) cấm-mọi-_nơi_ chưa đủ: phải khai cả **loại** bản sao được phép — bản sao **rewind/point-in-time** hồi sinh đúng thứ vừa bị hủy, nên chỉ **replica tiến-lên-trước** (lệnh xóa replicate được) là hợp lệ. _Án văn: P3 chạy một chiều suốt 24 vòng và tuyên đã đóng lỗ S50; tìm thấy đúng lỗ đó ở cửa khác (snapshot key store) cộng một lỗ ngược (mất máy = mất tất cả dù backup nguyên)._
- **P4 Actor/Node/Adapter**: enroll/register → update → suspend → **decommission (graceful drain)** → revoke.
- **P5 Change/Contribution**: propose → review → integrate (queue — chống giao thoa) → land → **revert/rollback rẻ**. Áp cho MỌI dòng thay đổi: code, spec, block, knowledge, config. Ô revert không có đường lùi rẻ = finding; "revert" không kèm down-path chuẩn bị trước = lời nói, không phải cơ chế.

---

## PHẦN III — PHƯƠNG PHÁP LUẬN (pipeline 8 phase; *không ghi số vòng ở đây: con số chép tay là một lớp lỗi, *)

> Bài học nền: **mỗi phương pháp bắt loại lỗi mà phương pháp trước mù**. Đường cong thực tế: đọc-thủ-công bắt G3 → quét-danh-từ bắt hạ tầng ngầm → desk-sim bắt G9 giao thoa → đối-kháng-cạnh-tranh bắt lỗ use-case → spec-hóa-ledger bắt câu hỏi mô phỏng bỏ qua. Một phương pháp cạn ≠ hồ sơ sạch.

| Phase | Việc                                                                                                                                              | Bắt loại lỗi                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0     | **A0**: dựng inventory quan điểm từ nguồn, diff nhóm A                                                                                            | Rubric thiếu quan điểm                    |
| 1     | Quét cơ giới: grep G1 (staging), G5 (tuyệt đối — điểm danh soát chủ đích), B3 (số cứng), tham chiếu chéo, duplicate                               | G1, G6, B3                                |
| 2     | Đọc từng file × A–P, điền **coverage matrix** (ô nào cũng cần bằng chứng — chống coverage theater)                                                | Toàn phổ tĩnh                             |
| 3     | **Quét danh từ hạ tầng**: mọi danh từ xuất hiện ≥2 file, hỏi "có nhà chưa?"                                                                       | G3                                        |
| 4     | **Desk-simulation battery**: cơ bản → trung bình → phức tạp → biên/đối kháng → meta (≥5 vòng, dừng khi bão hòa); mỗi kịch bản dắt qua từng cơ chế | **G9 giao thoa** — chỉ phase này bắt được |
| 5     | **Đối kháng cạnh tranh**: liệt kê đầy đủ kịch bản khách của đối thủ → ecoma trace từng cái                                                        | Lỗ use-case, định vị                      |
| 6     | Litmus full-pass (PHẦN IV) bằng desk-sim transcript                                                                                               | H                                         |
| 7     | Findings → patch (mỗi patch tự chạy lại ma trận nguyên-tắc × invariant trước khi ghi) → hậu kiểm grep → cập nhật sổ + index                       | Regression                                |

**Kỹ thuật bổ sung (vòng ≤15 — kịch bản là tài sản, không phải phế phẩm):**

- **Scenario catalog** (file riêng: [scenario-catalog](scenario-catalog.md), append-only): mọi kịch bản đã chạy có ID + verdict. Mỗi lượt = **regression** (chạy lại catalog trên docs mới — patch nào làm kịch bản cũ gãy là regression bắt được) + **exploration** (sinh mới, nạp vào catalog).
- **Dimension model cho exploration** — sinh kịch bản theo 8 chiều, đo coverage gap thay vì ngẫu hứng: `trigger-type × filler-mix (người/AI/rule/external/process) × irreversible? × external-party? × knowledge/memory? × deterministic/reasoning/hybrid × quy mô (n=1/team/agency-multiclient) × chế độ (happy/failure/adversarial)`. Ô chưa từng có kịch bản = vùng mù khai báo được.

**Kỹ thuật bổ sung (vòng ≤15):**

- **Phase 4b — Persona review battery**: đọc docs bằng 5 góc nhìn (SRE/operator, compliance officer, dev-implementer, người mua agency, contributor cộng đồng) — mỗi persona 5 câu hỏi đặc trưng của họ; câu không trả lời được từ docs = finding.
- **Phase 4c — FMEA subsystem** (nuôi F8): bảng hệ thống cho từng subsystem tầng 1.
- **Implementation-sketch test** (dò mơ hồ chủ động): chọn mẫu cơ chế, phác 2 bản pseudo-implementation _độc lập_ từ đúng đoạn spec — lệch nhau = ambiguity major tìm được trước khi kỹ sư thật tìm ra.

**Coverage matrix doc-class × nhóm:**

| Doc-class                    | Ví dụ                           | Nhóm bắt buộc                           | Miễn (có án văn)                                                                                                               |
| ---------------------------- | ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Trần** (North Star + spec) | 3 NS + **24 spec**              | A–P **đủ**                              |                                                                                                                                |
| **System Charter**           | playbook funnel (không công bố) | B, D, F, G (đủ G9), I, J, K, L, M, N, P | A (không mang quan điểm sáng lập), C (không định nghĩa invariant), E (không sở hữu flywheel), H → litmus **riêng của charter** |
| **Meta**                     | rubric, scenario catalog        | G, L, **self-conformance** (dưới)       | A–F, I–K (không mô tả cơ chế sản phẩm)                                                                                         |
| **Sống**                     | sổ thị trường (không công bố)   | J (án văn), L4 (nhật ký),               | phần còn lại — sự thật thị trường không do rubric phán                                                                         |

_Ô "miễn" phải có án văn tại đây; miễn im lặng = coverage theater._

**Kỹ thuật bổ sung:**

- **Rubric self-conformance pass** (bắt buộc mở đầu mọi full-run): rubric có tuân chính R2 (version tự khai khớp), R3 (mọi artifact mà luật đòi _tồn tại thật_), R12 (coverage matrix có mặt) không? — tiền lệ: vòng ≤15→sống 4 vòng với tiêu đề sai và không có coverage matrix; không ai kiểm vì không ai được giao kiểm người kiểm.
- **Đối chiếu nợ-khai-rải-rác ↔ sổ nợ trung tâm — HAI CHIỀU, HAI LẦN** _(nâng cấp)_: grep mọi cụm "vòng sau / ledger / chờ spec / gap" trong toàn hồ sơ, đối chiếu **hai chiều** với bảng known-gaps ở index — nợ khai trong spec mà index không có = **nợ ẩn**; mục trong index không còn ai nhắc = **nợ ma**. **Và chạy HAI LẦN: một lần ở phase 1, một lần LẠI SAU khi vá xong** (phase 7). _Án văn: chỉ chạy chiều-1 nên bỏ lọt 3 nợ ma; chạy đủ hai chiều ở phase 1 nhưng **không chạy lại sau khi vá**, nên chính bộ patch của mình đẻ ra 4 nghĩa vụ mới cho `deploy/`, `cloud/`, quota, runtime-sandbox mà sổ nợ không ghi — owner bắt được qua debrief Q2. Patch tạo nợ mới cũng nhanh như nó đóng nợ cũ._

**Kỹ thuật bổ sung:**

- **Patch adversarial pass (bắt buộc ở phase 7, TRƯỚC khi ghi)**: mỗi patch chịu **ba đòn**, thất bại một đòn = viết lại patch, không phải ghi rồi sửa sau. (1) **Nó có đẻ biên / nguồn-sự-thật / khái niệm mới không?** (2) **Nó có làm rơi nghĩa vụ dư của thứ nó thay thế không?** (3) **J3 áp lên chính patch**: có phương án nào đóng cùng lỗ mà **không** thêm khái niệm? _Tiền lệ patch v1 của suýt đẻ một cây tenant cha–con (biên cứng thứ hai); patch v1 của suýt đẻ write-amplification lên nguồn sự thật; patch v1 của suýt ghi đôi một ngưỡng đã có ở ICP B4 — cả ba **chỉ lộ ra khi mô phỏng việc vá**, không cách nào bắt được bằng đọc hồ sơ._
- **Đếm-số-là-thao-tác-cuối**: mọi con số (litmus tổng, exit-litmus milestone, số spec) **đếm lại bằng script sau khi mọi patch đã ghi**, không bao giờ vá số ở giữa lượt; phép tính ghi vào run report để lượt sau kiểm được.
- **Bảng FMEA là điều kiện tồn tại của subsystem tầng 1**: mỗi spec mới tự khai "subsystem tầng 1" phải mang bảng FMEA **trong cùng lượt tạo ra nó** (R12) — F8 vốn có, nhưng sinh Vault mà cluster-run không đối chiếu nhãn-tầng-1 với danh sách F8.

**Luật xoay phương pháp**: hai lượt liên tiếp của _cùng một phương pháp_ ra 0 blocker → bắt buộc đổi phương pháp; full-run nào cũng phải thử **≥1 phương pháp dò chưa từng dùng** — không nghĩ ra được thì bản thân điều đó là một finding về giới hạn của lượt chạy.

**Ba cấp protocol** (chống chi phí giết kỷ luật): `incremental` (mỗi patch: ma trận nguyên-tắc×invariant + grep hậu kiểm) · `cluster` (mỗi spec/cụm mới: phase 2+4 cục bộ + litmus cụm) · `full` (trước mỗi lần đóng băng: đủ 8 phase).

**Run report** — rubric tự đo: mỗi lượt ghi `(findings × phase × severity × NGUỒN-PHÁT-HIỆN [hệ/owner], phương pháp nào 2 lượt 0-blocker → xoay, tiêu chí chưa-từng-bắt-được-gì → xem lại)`. **Luật bảng-artifact**: phase ✅ phải kèm bảng bằng chứng liệt kê từng mệnh đề — verdict một dòng = chưa chạy (tiền lệ M1 chạy nông bỏ lọt "Deploy qua Docker/K8s" là lời hứa không cơ chế). **Ngưỡng miễn dịch**: 2 lượt liên tiếp owner bắt major mà hệ không bắt → bắt buộc immune-review (truy vì sao mù, sinh tiêu chí/kỹ thuật mới theo R9).

---

## PHẦN IV — LITMUS CATALOG (38 câu mirror — canonical nằm ở từng spec; **tổng toàn hồ sơ: 148 câu**)

> Phạm vi: đây là mirror của litmus **hệ** — 3 North Star + 3 spec core đã được nâng lên cấp hệ (Working Data, Memory, Tenant & Identity). Trước mỗi lượt: diff mirror này với nguồn canonical — lệch = cập nhật trước khi chạy (tự tuân G6).

**Platform (4)**: đổi Filler người↔AI không sửa flow · shadow mode + bảng đối chiếu tự sinh · một thang tin cậy cho người lẫn AI · cost+quality theo Role bất kể ai lấp.
**RPA (9)**: một automation chạy bằng script _và_ agent không đổi định nghĩa · script vỡ → agent vá có lineage không cần người · replay phiên từ log+evidence · takeover cùng log · secret không bao giờ vào log/screenshot-cho-model/context · standalone = cùng binary cùng đường effect · node đứt mạng — resume cursor không mất/trùng · node chưa enroll không claim/nhận secret · không kênh điều khiển thường trực, takeover từng input là Action-có-actor.
**Hub (6)**: rút phích — mọi tenant chạy vĩnh viễn · cùng digest xuyên public/mirror/air-gap · manifest ≠ analysis → reject · publisher biến mất — người mua nguyên vẹn · hai version Contract cùng cài không xung đột · **publisher không tự duyệt được badge verified; badge thu hồi được và artifact code mất quyền cài**.
**Working Data (6)**: rebuild table+index+metric từ log+CAS tương đương · time-travel một câu join theo log-position · sửa tay DB bị phát hiện + rebuild có hồ sơ · mọi write (kể cả bulk) đúng một actor · lease hết TTL — không kịch bản kẹt · **holder chết sau commit point — không có đường lease cấp lại tự động sinh effect đôi**.
**Memory (6)**: đổi filler — trí nhớ về khách còn nguyên · mọi entry truy được bằng chứng gốc · không đường nào claim của khách thành fact không qua Gate · không kịch bản khách A thấy hồi ức khách B · erasure một lệnh hủy khóa, log không đục · **distill xuyên workspace phải khai tường minh, mặc định hẹp nhất**.
**Tenant & Identity (7)**: n=1 — mọi khái niệm vô hình · nghỉ việc + đòi quên: audit pseudonym nguyên, PII chết · không đường merge party không qua Gate · client agency duyệt không cần account · falsifiable: một quyền không biểu diễn được bằng Role+capability+grant? · đổi SSO — actor-id bất biến · **tenant suspend giữa 50 task: không auto-pass, không mất dữ liệu, export vẫn chạy**.

---

## PHẦN V — ĐỐI KHÁNG CHÍNH BỘ RUBRIC (điểm mù tự khai, để người chạy sau không ảo tưởng)

| #   | Điểm mù                                                                                                                                                                                                                       | Giảm thiểu đã cài                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     | **Tự chấm**: tác giả docs chạy rubric trên chính mình                                                                                                                                                                         | R1 falsifiable + coverage-có-bằng-chứng; **vòng đóng băng cuối phải chạy bởi context mới** (người khác/phiên khác) chỉ với docs + file này — đó là lý do file phải tự chứa |
|     | **Rubric nhìn về quá khứ**: viết cho các lớp lỗi _đã_ tìm thấy — mù với lớp kế tiếp                                                                                                                                           | Luật xoay phương pháp + bắt buộc ≥1 phương pháp mới mỗi full-run                                                                                                           |
|     | **Goodhart**: pass câu chữ, trượt tinh thần                                                                                                                                                                                   | Câu-hỏi-tinh-thần mỗi nhóm; finding `tension`                                                                                                                              |
|     | **Coverage theater**: tick ô không đọc                                                                                                                                                                                        | Mỗi ô PASS đòi trích dẫn/đòn tấn công ghi lại                                                                                                                              |
|     | **Ảo tưởng bão hòa**: "không tìm thấy" ≠ "không có"                                                                                                                                                                           | PASS = sống-sót-N-đòn-có-hồ-sơ; bão hòa định nghĩa đo được (2 lượt 0-blocker _xuyên_ nhiều phương pháp + litmus full-pass) — và vẫn chỉ là "chưa tìm thấy"                 |
|     | **Drift tham chiếu**: docs đổi số mục, rubric trỏ hụt                                                                                                                                                                         | Rubric trỏ _khái niệm_ trước, số mục sau; patch nào đổi cấu trúc mục phải grep ngược về file này                                                                           |
|     | **Chi phí giết kỷ luật**                                                                                                                                                                                                      | Ba cấp protocol                                                                                                                                                            |
|     | **Giới hạn bản thể**: rubric chỉ đo _nhất quán nội tại_ — một hồ sơ hoàn hảo nội tại vẫn có thể là sản phẩm sai thị trường                                                                                                    | Ghi thẳng: rubric không thay được phỏng vấn khách/ICP/kill-criteria; hai loại sự thật, hai công cụ                                                                         |
|     | **Buồng vọng một trí tuệ**: người tấn công và người phòng thủ là một                                                                                                                                                          | Phase 5 (góc nhìn đối thủ) là proxy; khuyến nghị đứng: red-team người thật trước launch — rubric là lưới, không phải bảo hiểm                                              |
|     | **Điểm mù của chính hành động vá**: rubric đo _hồ sơ_, không đo _bản patch_ — mà patch là nơi khái niệm mới bị đẻ ra dễ nhất (áp lực "đóng finding cho xong"). 4 major + 1 mở-rộng-blocker chỉ xuất hiện khi mô phỏng việc vá | **Patch adversarial pass** (3 đòn, phase 7) + luật đếm-số-cuối-cùng. Vẫn là giảm thiểu, không phải miễn dịch: người vá và người soi patch vẫn là một                       |

---

## PHẦN VI — INVENTORY QUAN ĐIỂM SÁNG LẬP (nguồn chạy A0 — tự chứa, không phụ thuộc hội thoại)

| #   | Quan điểm                                                                                                                                                                                                                                                              | Đã mã hóa tại                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| V1  | Bài toán cốt lõi: hợp nhất 2 lực lượng lao động human+AI                                                                                                                                                                                                               | NS §1–2, Role                                           |
| V2  | Deterministic + reasoning seamless, engine không if-deterministic                                                                                                                                                                                                      | Task §5, duality tables                                 |
| V3  | OPC là bong bóng; n=1 đau điều phối (AI ×3, nghẽn xác minh); tăng nhân lực kéo theo; **không rewrite khi lớn**                                                                                                                                                         | NS §2                                                   |
| V4  | ML là tính năng thêm — 3 tham vọng (quy trình/checkpoint/prompting) không đi trước dữ liệu                                                                                                                                                                             | NS §7–8, tầng 5                                         |
| V5  | 20% BPMN giải 90%; không theo BPMN 2.0; đối thủ "đi lên từ nghề"                                                                                                                                                                                                       | NS §2, §7                                               |
| V6  | Inbox tự xây                                                                                                                                                                                                                                                           | NS §8 tầng 3                                            |
| V7  | Agent runtime tự xây                                                                                                                                                                                                                                                   | NS §8 tầng 2                                            |
| V8  | Pair-design: người + AI cùng tạo quy trình                                                                                                                                                                                                                             | Composition §5                                          |
| V9  | Docker/K8s                                                                                                                                                                                                                                                             | NS §8                                                   |
| V10 | Fair-code SUL, open-core, 4 dòng doanh thu, chặn phân phối thương mại, không nhãn "open source"                                                                                                                                                                        | NS §8                                                   |
| V11 | Dữ liệu học thuộc tenant, per-tenant learning                                                                                                                                                                                                                          | Invariant 4                                             |
| V12 | **Không quan tâm phức tạp/effort — đích đến luôn là cơ chế TỐI ƯU NHẤT**: mọi quyết định phải là phương án mạnh nhất sống sót qua đối kháng (falsifiable: đưa được phương án tốt hơn = quyết định hiện tại thua); cơ chế rõ + executable là điều kiện, không phải trần | Nhóm J (J3 là nghi thức thử), NS preamble "đây là trần" |
| V13 | Phức tạp là quyền lựa chọn của user                                                                                                                                                                                                                                    | Nguyên tắc #4, nhóm K                                   |
| V14 | Verifier do người thiết kế cài; multi-verifier song song/tuần tự; chấm lại sau done                                                                                                                                                                                    | Checkpoint                                              |
| V15 | RPA sản phẩm riêng domain riêng, integration-first, monorepo                                                                                                                                                                                                           | RPA NS                                                  |
| V16 | Hub/Block/Template — cộng đồng nối dài đuôi                                                                                                                                                                                                                            | Hub NS, Block                                           |
| V17 | EE & Cloud là 2 lớp ngang; tenant core cardinality ≥ 1                                                                                                                                                                                                                 | NS §8, Tenant spec                                      |
| V18 | Knowledge: nhiều kho, phân quyền, phân mật, bật/tắt theo tenant                                                                                                                                                                                                        | Knowledge                                               |
| V19 | Chatbot trên ecoma là use case hạng nhất                                                                                                                                                                                                                               | Trigger & Channel                                       |
| V20 | DataTable có join nâng cao (khác n8n); default Postgres stack; không phát minh bánh xe                                                                                                                                                                                 | Working Data                                            |
| V21 | Locking phải tồn tại → Lease                                                                                                                                                                                                                                           | Working Data §3                                         |
| V22 | Memory thuộc tổ chức theo subject (chốt qua ủy quyền)                                                                                                                                                                                                                  | Memory                                                  |
| V23 | Văn hóa: review đối kháng đa vòng; rubric tự tiến hóa                                                                                                                                                                                                                  | File này                                                |

A0 = diff nhóm A với bảng này; thêm quan điểm mới của owner → thêm dòng V-mới (append-only).

## PHẦN VII — NHẬT KÝ TIẾN HÓA (theo VÒNG — xếp giảm dần)

| Vòng     | Nội dung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|          | **Full-run — con dấu, context sạch thứ hai.** 1 blocker (mở rộng phạm vi) + 15 major + 13 minor; **9 finding sinh ra từ chính vòng vá** ⇒ điểm mù mới. Sinh theo R9: **L7** doc identity & version integrity (từ — 12 file lệch version giữa header và index); **P3b** luật giao thoa chiều ngược + theo _loại_ bản sao (từ blocker và — snapshot key store hồi sinh khóa đã shred); **Patch adversarial pass** 3 đòn ở phase 7 + **đếm-số-là-thao-tác-cuối** + **FMEA là điều kiện tồn tại của subsystem tầng 1** (từ). Tự sửa: luật tự-tuân trỏ "dòng cuối" trong khi nhật ký xếp lộn → xếp giảm dần; "34 câu ↔ 38 câu" trong cùng đoạn; "19 spec" ở coverage matrix; bỏ con số vòng chép tay ở R10/Phần III. Litmus full-pass **124 → 130**. **Quyết định owner cuối vòng: BỎ ĐÁNH VERSION TÀI LIỆU** — L7 viết lại quanh **VÒNG là danh tính** (bỏ số ở tiêu đề/index/tham chiếu chéo; khối `Nhật ký sửa` dạng `vòng NN — nội dung`; index giữ cột _Vòng cập nhật gần nhất_); luật tự-tuân của rubric đổi từ "khớp số version ở 4 chỗ" sang "**khớp VÒNG ở 3 chỗ**". Đây là **giết lớp lỗi tận gốc** thay vì vá nó. **bắt ở phase 6** (litmus pass, không phải phase 2): nhãn `run_kind` được khai _hệ quả_ ở 4 consumer mà không có nhà ⇒ E5 mở rộng sang _trường/nhãn_, không chỉ _bảng_ — R9 **không** sinh tiêu chí mới vì E5/G3 lẽ ra bắt được, chỉ thêm tiền lệ + hệ quả thao tác |
|          | **IMMUNE-REVIEW KÍCH HOẠT** (đúng ngưỡng: 2 lượt liên tiếp owner bắt major mà hệ mù — ô-`build`, rồi merge-queue/revert/AI-drift, dù charter vừa cluster-run trong cùng lượt). Truy gốc mù: nhóm P có vòng đời Product/Entity/Data/Actor nhưng **không có vòng đời của một THAY ĐỔI** → cluster-run charter chạy D2/G6/J/K mà không nhóm nào hỏi "đường lùi của một PR ở đâu". Sinh **P5 Change/Contribution lifecycle** theo R9. Ghi nhận kèm: lớp lỗi "AI-velocity drift" là lớp mới của thời đại AI-dev — P5 ôm bằng ô revert-rẻ + charter §5b                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|          | **Full-run đầu tiên do context sạch chạy** (đúng điều kiện). Rubric tự dính 3 finding: (a) version tự khai lệch — tiêu đề/R2/Phần II/pipeline vẫn nói vòng ≤15, A–K, R1–R8 trong khi nhật ký đã → một context sạch sẽ chạy thiếu M/N/O/P và R9–R12; (b) **coverage matrix doc-class × nhóm** mà R12 đòi chưa từng tồn tại; (c) "litmus full-pass" đo trên 34 câu mirror, bỏ ngoài L5 của 19 spec + 7 câu charter. Vá: luật tự-tuân version, matrix doc-class, định nghĩa lại phạm vi litmus. **R9 sinh mới**: C6 (vách mềm workspace), F3 mở rộng live-view, P3 thêm backup/restore + luật giao thoa xóa×sao-lưu. **Kỹ thuật mới**: rubric self-conformance pass; đối chiếu nợ-khai-rải-rác ↔ sổ nợ trung tâm; implementation-sketch test lần đầu thực chạy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|          | Trả lời "làm sao không mắc lỗi tương tự": truy 4 gốc rễ (rubric-derive-từ-cái-đã-viết; nợ-nội-dung-mới; owner-đầu-không-sync; phase-chạy-nông) → **nhóm P** lifecycle checklist tiên nghiệm; **R11** owner-fact sync + debrief 5 câu; **R12** cấm tài liệu chưa-review âm thầm; run-report (nguồn-phát-hiện, luật bảng-artifact, ngưỡng miễn dịch owner-catch). P-run đầu tiên bắt ngay 2 finding: EOL window, node decommission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|          | Finding qua R10 (owner không nhận ra quan điểm của mình trong V12): encoding nén mất vế "đích đến tối ưu nhất" — reword V12 đủ hai vế (không-bị-chặn-bởi-effort + bắt-buộc-tìm-phương-án-mạnh-nhất); thêm câu tinh thần nhóm J. Ghi nhận: "cơ chế tối ưu nhất" là claim falsifiable (J3), khác "rubric tối ưu nhất" (không falsifiable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| vòng ≤15 | 4 vòng đối kháng theo yêu cầu owner: nhóm **O** competitive/standards watch thường trực (bắt bài học Data-Tables/memory do owner phát hiện); **scenario catalog** = tài sản regression + **dimension model** 8 chiều; **R10** kênh owner (câu hỏi không trả lời được bằng 1 trích dẫn = finding); **run report** tự đo; phụ lục **Inventory 23 quan điểm** (vá lỗ tự-chứa của A0); litmus đánh dấu mirror (tự tuân G6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| vòng ≤15 | Đối kháng chính vòng ≤15 theo yêu cầu "có chắc tối ưu nhất?": **R9 luật miễn dịch** (finding không ai bắt → sinh tiêu chí mới, cùng patch); nhóm **M** truy vết lời hứa 2 chiều; nhóm **N** threat-actor battery 7 persona; **F8** FMEA subsystem; **J6** kinh tế vận hành; **L6** glossary; phase 4b/4c + implementation-sketch test. Bác 3 ứng viên có án văn (benchmark định lượng, quét pháp lý, đo thời gian đọc). Sửa claim: không "tối ưu nhất" — "mạnh nhất đến nay + tự tiến hóa"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| vòng ≤15 | Hợp nhất toàn bộ rubric hội thoại (A–K + R1–R8); thêm A0, D8, E5, F7, G9, nhóm L; pipeline 8 phase + luật xoay phương pháp + 3 cấp protocol; litmus catalog 34; tự-đối-kháng –. **Deprecated: B4** (superseded-by K1–K6). Thay thế mọi phiên bản trong hội thoại                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
