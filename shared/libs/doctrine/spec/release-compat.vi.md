---
title: "Release & Compatibility"
status: design-end-state
canonical-sha: b0f79bd8e452
---

# Release & Compatibility

## 0. Vị trí — nhà duy nhất của bốn thứ

Spec này là nhà canonical của: **(1)** danh tính version của mọi artifact · **(2)** thương lượng tương thích giữa hai thành phần rời nhau · **(3)** luật upgrade/rollback · **(4)** deprecation & EOL. Nơi khác chỉ được **trỏ** về đây, không khai lại (E5).

Nó **không** khai _thủ tục bấm_ — đó là charter `deploy/`. Ranh giới một câu: **spec khai điều kiện tồn tại của một đường; charter khai cách đi đường đó.**

## 1. Ba trục version — tách bạch, cấm trộn

| Trục                                               | Ai đọc                                                        | Hình dạng                                   | Đổi khi                       |
| -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- | ----------------------------- |
| **Release train `X.Y.Z`**                          | con người, vận hành, hỗ trợ                                   | semver, **của WORKSPACE**                   | mỗi lần cắt tag               |
| **Protocol version**                               | hai thành phần rời nhau lúc bắt tay (node↔server, client↔Hub) | **số nguyên đơn điệu, riêng từng protocol** | chỉ khi khung dây đổi         |
| **Schema version** của entry · contract · manifest | engine khi đọc dữ liệu cũ                                     | số nguyên, riêng từng entity                | chỉ khi hình dạng dữ liệu đổi |

**Án văn**: trộn ba trục là lỗi kinh điển — một bản vá website sẽ ép mọi node phải nâng, hoặc ngược lại một đổi khung dây sẽ trốn trong một bản vá. Ba trục đổi vì ba lý do khác nhau nên phải đếm riêng.

**Q3 — `X.Y.Z` là của workspace, không của app.** Một tag cắt ra **mọi** artifact; `package` target của một app chỉ **đóng dấu** tag đó lên artifact của nó, **không tự sinh version**. Án văn: skew node **N-1 minor** và thương lượng protocol đều tựa lên **một trục chung**; per-app version giết cả hai cơ chế và biến "node này có tương thích không" thành câu hỏi không trả lời được.

## 1c. Một trục version, hai repo

`cloud/` sống trong một repo riêng (private), mount vào cây public qua submodule. Điều đó **không** được phép đẻ ra một trục version thứ hai:

| Việc                                   | Ở đâu                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| **Cắt tag `vX.Y.Z`**                   | **Chỉ ở repo public.** Một trục, một nơi cắt                                       |
| Đóng dấu tag lên artifact của `cloud/` | CI của repo private **đọc** tag đó và đóng dấu — **không bao giờ tự sinh version** |
| Ký artifact                            | Mỗi CI ký artifact của chính mình; credential không đi xuyên biên repo             |

**Án văn**: cloud là **downstream** của workspace public, không phải một nửa ngang hàng của nó. Cho nó tự sinh version là dựng đúng cái per-project version mà §1 vừa bác, chỉ ở quy mô repo — và làm câu hỏi _"node này có tương thích với control plane này không"_ trở lại không trả lời được.

**Hệ quả có thật, khai luôn**: CI của cloud build trên `ecoma@main`, tức trên một mục tiêu đang di chuyển. Đó **không** phải khuyết điểm — nó chính là cách bên thứ ba trải nghiệm interface công khai, chỉ sớm hơn. Nếu cloud vỡ vì một thay đổi public, đó là **breaking change đã lọt qua §3**, không phải sự cố xếp lịch.

## 1b. Danh tính của một artifact

Mọi artifact phân phối mang: `train_version` · `source_digest` · `protocol_versions_supported[]` · `build_provenance` (ai build, ở đâu, từ commit nào). **Chữ ký chỉ sinh ở CI**; không máy dev nào giữ credential ký, còn CI nào ký artifact nào là câu trả lời của §1c. Artifact không mang đủ 4 trường = không phải artifact phân phối, chỉ là một file.

## 2. Thương lượng — ai từ chối ai

Lúc bắt tay, bên khởi tạo gửi `protocol_versions_supported[]`; bên nhận chọn **max của giao nhau**.

| Tình huống                            | Luật                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Có giao nhau                          | Dùng max chung; số đã chọn ghi vào entry của phiên                                                                                                                                                                                                                                                                       |
| **Không có giao nhau**                | Bên nhận **từ chối**, phát entry `protocol_incompatible` kèm cả hai danh sách. Không có chế độ "cố chạy"                                                                                                                                                                                                                 |
| Node lệch quá **N-1 minor** của train | Node **từ chối claim task mới** — nhưng **vẫn heartbeat, vẫn nhận lệnh update, vẫn hoàn tất task đang dở**. Án văn: node im lặng biến mất khỏi tầm quản lý là hỏng nặng hơn node không nhận việc                                                                                                                         |
| Server cũ hơn node                    | Cùng luật, đối xứng — **server không bao giờ tự hạ xuống protocol đã bỏ**                                                                                                                                                                                                                                                |
| **Fleet server hỗn hợp**              | Một node có thể chạm hai server khác train trong lúc nâng cấp cuốn chiếu. Luật: **bỏ một protocol version là hành động của TOÀN fleet, không của một server** — chỉ được bỏ sau khi **mọi** server đã ở train hỗ trợ tập mới. Trong cửa sổ cuốn chiếu, tập protocol của fleet là **giao** của các server, không phải hợp |

**Cấm auto-update** ở mọi hướng (RPA NS §4): hệ chỉ **báo** không tương thích, người quyết nâng.

## 3. Breaking & deprecation

- **Trước 1.0 thì minor đóng vai major** _(cluster-run.0)_. **Điều kiện cắt `1.0.0`: khi ◆G4 đóng** — tức mọi interface tầng 1–3 đã freeze (North Star §8, roadmap §1b). Án văn: `1.0` là lời hứa "khung dây công khai đã ổn định"; neo nó vào **cổng freeze cuối cùng** là neo vào một sự kiện có thật, thay vì vào cảm giác sẵn sàng. Tới đó, breaking được phép ở minor và mọi luật dưới đây đọc "minor" thay cho "major".
- **Breaking chỉ ở major.** Minor thêm, patch sửa.
- **Deprecation ≥1 minor trước khi xóa**, và đánh dấu **trong chính artifact khai** — `deprecated_since` + `removed_in` trên protocol descriptor, contract, manifest field. **Không đánh dấu trong changelog**: changelog không kiểm được bằng máy, và cái không kiểm được bằng máy sẽ trôi.
- Mỗi lần một đường deprecated được dùng, engine phát entry **`deprecated_used`** (ai, ở đâu, đường nào). Projection "ai còn dùng gì" là **điều kiện để dám xóa** — không có nó thì việc xóa là đoán.

## 4. Upgrade

Luật bất di (từ North Star §8, không mở lại): **log không bao giờ rewrite** · projection **rebuild** thay vì vá · **migration là entry** · **major tuần tự, không skip** (X → X+2 phải qua X+1).

Trình tự chuẩn — 4 pha, mỗi pha có điểm dừng an toàn:

| Pha          | Việc                                                                                       | Nếu hỏng ở đây                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · cài cạnh | Artifact mới đặt cạnh cũ; cũ vẫn đang chạy                                                 | Xóa artifact mới; không có gì đổi                                                                                                            |
| 2 · migrate  | Mỗi migration là **một Task có Attempt**: đọc-cũ / ghi-mới, idempotent theo `migration_id` | **Không có trạng thái nửa vời**: fail ⇒ engine **ở lại version cũ**, projection giữ nguyên, phát escalation. Chạy lại an toàn nhờ idempotent |
| 3 · cutover  | Chuyển lưu lượng sang artifact mới                                                         | Quay lại pha 2 (cũ chưa gỡ)                                                                                                                  |
| 4 · giữ      | Artifact cũ **giữ lại tới hết cửa sổ rollback** (§5)                                       |                                                                                                                                              |

## 5. Rollback — điều kiện tồn tại của đường lùi

- Luật gốc (North Star §8): **mọi migration major khai đường nghịch, hoặc khai cờ `irreversible_migration`** — cờ đó buộc Gate + bản sao trước khi chạy. Kiểm tĩnh ở Composition §4; ở tầng block là `migrations[].down` (Block §7).
- Spec này thêm **cửa sổ rollback**: khoảng thời gian đường nghịch còn được **bảo đảm** chạy được. Neo đầu tiên: **tới hết minor kế tiếp**.
- **Ranh giới với charter (giao thoa #2)**: trong cửa sổ, rollback = chạy đường nghịch (thủ tục ở charter `deploy/` §6). **Ngoài cửa sổ, rollback không còn tồn tại như một thao tác** — nó trở thành _restore từ backup + replay_, một đường khác hẳn với rủi ro khác hẳn. Charter **phải** nói ra sự khác nhau đó, không được gọi cả hai là "rollback".

## 6. EOL & support window — và giao thoa với backup

- **Support window: major hiện tại + một major trước** (neo đầu tiên; đổi phải ghi lý do).
- **Thông báo EOL là cơ chế, không phải email**. Một sự thật (registry của train), ba kênh phát: entry `version_eol_announced` · cảnh báo trong `resolve` của Hub · cảnh báo trong handshake của node. Ai không nghe kênh này thì nghe kênh kia.
- **Giao thoa #1 với charter `deploy/`**: một backup chỉ hữu ích nếu **còn tồn tại một phiên bản đọc được nó**. Luật: **cửa sổ retention của backup không được dài hơn support window** — trừ khi charter khai tường minh một **restore path** (nâng backup cũ qua chuỗi migration tuần tự). Giữ backup 5 năm mà chỉ hỗ trợ 2 major là **đang giữ một lời hứa không thực hiện được**, đúng lớp lỗi P3b.

## 7. Conformance suite là một giao diện — nên nó có version

- Suite mang `suite_id` + **major.minor riêng**, độc lập train.
- **Đổi suite = đổi giao diện = breaking**, đi đường major của chính suite (Test Harness §7 tuyên câu này; luật breaking sống ở đây).
- Thêm case **trong cùng major** chỉ hợp lệ nếu nó **không làm một implementation đang pass trở thành fail**. Nếu có ⇒ đó là major, dù người thêm nghĩ là "làm rõ".
- Một gate **◆G freeze đúng một major của suite**. Nâng major suite = mở lại gate = quyết định có án văn, không phải thao tác bảo trì.

## 8. Hai artifact trên một máy — không được lệch train

Máy attended chạy **hai artifact**: node runtime headless + lớp UI attended (ADR-0005). Chúng **cùng một train version**, không ngoại lệ.

**Giao thoa #3**: lúc bắt tay nội-máy, lớp UI đọc `train_version` của runtime; **lệch ⇒ UI từ chối chạy** và báo người dùng cập nhật — **không tự update** (RPA NS §4). Hạ về digest N-1 là hành động tường minh có event, và **phải hạ cả hai artifact cùng lượt**. Án văn: hai artifact trên cùng một máy lệch nhau là skew _nội-máy_ — không kênh handshake nào của hệ nhìn thấy nó, nên phải chặn tại chỗ.

## 9. Seam publish cho đơn vị "cắm-vào" (Q4)

Đơn vị nào thuộc lớp **Apache 2.0** theo luật phân loại (North Star §8 — interface, schema, protocol, client, SDK, vocabulary) **phải publish được**: có entry point thật, có build, **không** `private: true`.

**Version của package publish = train version**, không tự do. Án văn: bên thứ ba phải suy được _"client này nói protocol nào"_ từ đúng một con số họ nhìn thấy; hai trục version cho cùng một artifact là bắt họ tra bảng.

## 10. Non-goals

- **Không** quản version của block/template — đó là Hub + Block §7 (digest + lockfile), một hệ khác.
- **Không** auto-update ở bất kỳ hướng nào.
- **Không** semver riêng cho lib nội bộ (Q3).
- **Không** hứa tương thích ngược vô hạn — support window là hữu hạn và nói ra.
- **Không** khai thủ tục vận hành (charter `deploy/`).

## 11. Nhật ký quyết định

| Chủ đề                                  | Chốt                                                                       | Án văn                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Ba trục version                         | Train / protocol / schema, đếm riêng                                       | Ba lý do đổi khác nhau; trộn là ép nâng vô cớ hoặc giấu breaking trong patch                                |
| Train của workspace, không của app (Q3) | Một tag = mọi artifact; `package` chỉ đóng dấu                             | Skew N-1 và negotiation tựa lên một trục chung; per-app version giết cả hai                                 |
| Node lệch quá skew                      | **Từ chối claim, vẫn heartbeat + vẫn nhận update**                         | Node im lặng biến mất nguy hiểm hơn node không nhận việc                                                    |
| Deprecation đánh dấu ở artifact         | `deprecated_since`/`removed_in` trong descriptor, không ở changelog        | Changelog không kiểm được bằng máy ⇒ sẽ trôi                                                                |
| Dám xóa cần bằng chứng                  | Entry `deprecated_used` + projection "ai còn dùng gì"                      | Xóa mà không đo được người dùng là đoán                                                                     |
| Migration fail                          | Ở lại version cũ, không trạng thái nửa vời; idempotent theo `migration_id` | Nửa vời là trạng thái không ai viết được luật cho nó                                                        |
| Cửa sổ rollback                         | Tới hết minor kế tiếp; ngoài cửa sổ **không còn là rollback**              | Gọi restore-từ-backup là "rollback" khiến người vận hành bấm nhầm với kỳ vọng sai                           |
| Retention ≤ support window              | Trừ khi khai restore path tường minh                                       | Backup không đọc lại được là lời hứa suông (P3b)                                                            |
| Suite có version riêng                  | Đổi suite = breaking; ◆G freeze một major suite                            | Suite là giao diện; giao diện đổi ngầm phá mọi implementation song song                                     |
| Hai artifact cùng train                 | UI attended từ chối chạy khi lệch                                          | Skew nội-máy không kênh handshake nào của hệ nhìn thấy                                                      |
| Package publish = train version         | Không semver riêng                                                         | Bên thứ ba phải suy được protocol từ một con số                                                             |
| **Điều kiện cắt 1.0**                   | **Khi ◆G4 đóng**; trước đó minor đóng vai major                            | `1.0` là lời hứa khung-dây-ổn-định; neo vào cổng freeze cuối là neo vào sự kiện có thật, không vào cảm giác |
| **Bỏ protocol là việc của toàn fleet**  | Tập protocol trong cửa sổ cuốn chiếu = **giao** các server                 | Bản nháp giả định một server; fleet hỗn hợp là trạng thái bình thường lúc nâng cấp, không phải ngoại lệ     |

## 12. FMEA

| Hỏng                                                           | Phát hiện                                                     | Phục hồi                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Migration fail giữa chừng                                      | Attempt fail + entry                                          | Ở lại version cũ; chạy lại (idempotent); escalation nếu lặp                                                      |
| Node lệch skew hàng loạt sau nâng server                       | Đếm entry `protocol_incompatible`/`claim_refused` theo node   | Hạ server về train trước (trong cửa sổ) hoặc nâng fleet node; **không** hạ protocol                              |
| Đường nghịch khai có nhưng chạy hỏng                           | Chạy `down` trong pha 2 của môi trường trước khi cutover thật | Restore + replay (đường khác, §5); và **đánh dấu migration đó `irreversible_migration` cho các cài đặt còn lại** |
| Backup ngoài support window, không restore path                | Đối chiếu retention × support window (gate ở charter)         | Không có đường — đó là lý do luật §6 tồn tại; ngăn chặn, không cứu chữa                                          |
| Suite đổi ngầm trong cùng major                                | Implementation đang pass bỗng fail ở CI                       | Gọi tên đúng: đó là major; rollback suite, cắt major mới                                                         |
| Hai artifact attended lệch train                               | UI kiểm lúc bắt tay nội-máy                                   | UI từ chối chạy; người dùng nâng/hạ **cả hai** cùng lượt                                                         |
| Node bắt tay được server A, hỏng với server B trong cùng fleet | Entry `protocol_incompatible` chỉ từ một phần fleet           | Hoàn tất cuốn chiếu (đưa cả fleet về một tập), **không** vá bằng cách cho node pin vào một server                |
| Artifact thiếu provenance/chữ ký                               | Kiểm lúc cài                                                  | Từ chối cài — không có chế độ "cài tạm"                                                                          |

## 13. Litmus

1. Vá một lỗi CSS của website: có artifact nào **ép node phải nâng** không? (bắt buộc: không — ba trục §1)
2. Node ở train lệch **2 minor**: nó **từ chối claim** nhưng **vẫn heartbeat và vẫn nhận được lệnh update** — hay nó biến mất khỏi fleet view?
3. Xóa một trường đã `deprecated`: trả lời được **ai còn đang dùng nó** bằng một projection, hay chỉ bằng niềm tin?
4. Migration major fail ở bản ghi thứ 10.000: hệ ở lại version cũ **nguyên vẹn**, và chạy lại **không nhân đôi** thứ gì?
5. Rollback **sau** cửa sổ: hệ có gọi nó là "rollback" không? (bắt buộc: không — nó là restore + replay, rủi ro khác, thủ tục khác)
6. Giữ backup 5 năm trong khi support window là 2 major: có gate nào chặn cấu hình đó, hay nó im lặng trở thành lời hứa suông?
7. Thêm một case vào conformance suite trong cùng major làm một implementation đang pass thành fail: CI gọi đó là **breaking** hay để lọt?
8. Trên máy attended, ép lớp UI ở train cũ chạy với runtime train mới: UI **từ chối** — hay nó chạy và hỏng ở một chỗ không ai đoán được?
9. Đang nâng cuốn chiếu, một node chạm hai server khác train: nó **thấy tập protocol là giao** của fleet — hay nó bắt tay được với server này và vỡ với server kia?
