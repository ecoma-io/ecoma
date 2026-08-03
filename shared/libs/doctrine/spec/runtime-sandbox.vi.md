---
title: "Runtime Sandbox"
status: design-end-state
canonical-sha: cc766a69e5ff
---

# Runtime Sandbox

> **Anh em của RPA: Sandbox & Credential, không phải bản sao của nó.** Hai tài
> liệu dùng chung một mô hình cách ly và khác nhau ở thứ được bao: bên kia là một
> phiên tương tác với môi trường, bên này là một tiến trình chạy code được cấp.
> Mọi luật chung — secret là handle chứ không bao giờ là giá trị, egress theo
> allowlist, một permission scope được khai báo và bị chặn tại engine — có nhà
> canonical ở tài liệu đó và ở Vault & Key Lifecycle §5, và **không** được khai
> lại ở đây. Cái spec này thêm gồm ba thứ: biên dành cho code, hình dạng của việc
> cấp secret khi consumer là một **tiến trình**, và đường cắt vòng tròn của vòng
> duyệt verified.

## 1. Định vị — cái gì được bao, và vì sao biên nằm ngoài tiến trình

Runtime Sandbox là **biên thực thi của code filler**: nơi duy nhất code do tenant
viết hoặc do publisher phân phối — trust class `code` của Block §3 — được chạy.
Tập ngôn ngữ là ràng buộc đầu vào đã chốt, không phải câu hỏi mở lại ở đây: tối
thiểu JS/TS, Python và Go, với **Python chạy như một interpreter thật và đường
WASM bị cấm** (ADR-0006). Tài liệu này khai cái biên mà một interpreter thật phải
nằm bên trong.

**Biên là ranh giới của hệ điều hành hoặc máy ảo, không bao giờ là ranh giới của
ngôn ngữ.** Câu đó chịu lực cho cả tài liệu, và nó là một hệ quả chứ không phải
một sở thích:

| Loại biên                                                           | An toàn là hàm của cái gì  | Hệ quả                                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trong tiến trình — interpreter hạn chế, allowlist module ở tầng VM  | **Hành vi của chính code** | Muốn chạy an toàn thì phải tin code trước, nên vòng tròn ở §6 không cắt được. Tệ hơn không có gì: nó **trông** an toàn, nên không ai dựng cái biên lẽ ra đã giữ được |
| **OS / VM** — tiến trình riêng với namespace riêng, hoặc một máy ảo | **Cấu hình của một host**  | Mức an toàn không đổi khi code đổi, nên chạy code chưa ai vouch là **một thao tác bình thường** chứ không phải một ngoại lệ được cấp phép                            |

Chọn hàng dưới không chỉ là chọn phương án mạnh hơn. Nó là **điều kiện tồn tại
của §6**: một biên mà độ mạnh phụ thuộc vào code bên trong thì không bao giờ dùng
được để _thiết lập_ mức đáng tin của chính code đó.

**Sàn nâng theo thứ nó bảo vệ.** Cơ chế cụ thể đi theo hình thái triển khai, nhất
quán với ADR-0002 và được ADR-0006 khai như một cơ chế:

| Cài đặt                                                      | Sàn                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Small stack, phục vụ đúng một tenant (Tenant & Identity §2c) | Một tiến trình OS riêng với namespace riêng: không mạng của host, không filesystem của host, không thừa kế biến môi trường |
| Bất kỳ cài đặt nào phục vụ nhiều hơn một tenant              | **Cách ly ở mức kernel** — một container runtime class hoặc một microVM — vì biên tiến trình là không đủ                   |

Lý do của lằn ranh này là bán kính thiệt hại, không phải mốt. Trên một cài đặt
một tenant, một lần thoát chạm tới dữ liệu của chính tenant đó, thứ mà code vốn
đã có grant khai báo. Khi hai tenant dùng chung một cài đặt, cùng lần thoát ấy
vượt qua **biên cứng duy nhất của hệ** (Tenant & Identity §2), nên sàn phải nâng
theo. Không có cấu hình nào nằm dưới hai cái sàn này: như RPA Sandbox & Credential
§5, mức lỏng nhất vẫn là một chuồng.

**Chỗ hai sandbox khác nhau, và vì sao:**

| Chiều            | RPA Sandbox & Credential                                            | Runtime Sandbox                                                                  |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Đơn vị chuồng    | Một **session** (RPA: Session §1)                                   | Một **Attempt** (Task §4)                                                        |
| Trạng thái bền   | `persistent_profile` — tài nguyên có id, cho một đăng nhập sống lâu | **Không tồn tại** — chuồng chết cùng Attempt, không ngoại lệ                     |
| Chốt masking     | Tầng perception, trước khi một Scene rời khỏi đó (§3)               | Tại biên, trước khi output hay trace rời chuồng (§3 dưới đây)                    |
| Cấp credential   | Injection tại tầng driver — runtime tự gõ giá trị vào               | **Gắn ở chặng cuối tại một broker ngoài chuồng** (§3 dưới đây)                   |
| Hình dạng egress | Allowlist domain do profile trình duyệt hoặc desktop thi hành       | Allowlist domain do **kênh duy nhất tồn tại** thi hành — không có đường nào khác |

Lý do của dòng "không trạng thái bền" đáng nói ra, vì cái lợi của một cache ấm là
có thật. Identity của code filler là `(code, version)` (Role §3), và calibration
của nó hội tụ nhanh **vì nó nhị phân** (Role §6). Trạng thái sống sót giữa hai
Attempt là hành vi mà identity không gọi tên: calibration khi đó đo một thứ mà
khóa của chính nó không phân biệt được, và tính chất giúp code lên `autonomous`
nhanh bị giết bởi đúng cái được thêm vào cho nhanh.

**Được phép pool, không được phép có kênh.** Một bản cài có thể giữ sẵn chuồng ấm
để khỏi khởi động lại interpreter. Một chuồng chỉ dùng lại được khi đã reset về
đúng trạng thái của image, tức là không phân biệt được với một chuồng mới. Pool là
tối ưu của host, không bao giờ là đường đi từ Attempt này sang Attempt kia.

**Code block là filler thường.** Nó có identity, availability và cost (Role §3),
nó chịu trust tier và graduation (Role §5), và nó qua Gate như mọi filler khác
(Checkpoint). Spec này **không** đẻ tier riêng, **không** đẻ hệ kiểm duyệt song
song, và **không** mở đường vòng qua Checkpoint. Đó là nguyên tắc 1 — engine đối
xứng — áp dụng đúng chỗ dễ vỡ nhất, vì code là loại filler dễ bị coi là đã đáng
tin sẵn nhất.

## 2. Biên — cái gì đi qua, theo chiều nào

| Chiều   | Đi qua                                                                                                                                                                                                                                          | Không bao giờ đi qua                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Vào** | Code artifact pin theo digest · runtime image pin theo digest (§7) · artifact đầu vào theo `inputs` của Task · **credential handle**, không bao giờ là giá trị · grant tài nguyên đã resolve (§4) · hạn chót · nhãn `run_kind` và `test_run_id` | Biến môi trường của host · filesystem của host · mạng nền · bất kỳ token gọi API nào của engine · bất cứ thứ gì thuộc tenant khác |
| **Ra**  | Đúng một artifact theo `output_contract` · **yêu cầu Effect** · số đo tiêu thụ · entry log mang sub-actor · stdout, stderr và trace **sau chốt masking** (§3)                                                                                   | Bất kỳ side effect nào không khai · giá trị secret · tham chiếu tới blob nằm ngoài grant                                          |

Bốn luật giữ hình dạng này:

1. **Deny-all cả hai chiều; mọi thứ đi qua đều là một grant đã khai.** Cấu hình
   lỏng nhất vẫn là một chuồng không mạng và không filesystem của host. Đơn giản
   hơn ở đây luôn nghĩa là bảo thủ hơn, không bao giờ lỏng hơn — đúng luật Handoff
   §8 áp cho một effect chưa phân lớp.
2. **Code không cầm token nào gọi engine.** Effect là một **yêu cầu** phát trên
   kênh biên; engine đối chiếu nó với `effects` đã khai của Task và **từ chối cái
   không khai**. Đó là biên cứng thứ nhất của Task §5, được tôn trọng chứ không
   được mở thêm một cửa thứ hai. Effect khai mà không phân lớp reversibility vẫn
   là `irreversible` (Handoff §8).
3. **Bên trong chuồng là sub-actor, không phải Task.** Các bước nội bộ của code
   được ghi làm sub-actor trong provenance của filler (Task §5). Lao động cần
   Role, Gate hay calibration riêng thì phải là Task; không được giấu vào trong
   code để né Gate.
4. **Chuồng sống và chết cùng Attempt** (§1). Retry là một Attempt mới trong một
   chuồng mới, mang theo feedback có cấu trúc của Attempt trước (Task §4).

**Kiểm được tĩnh**, và vì thế được kiểm ngay lúc vẽ quy trình chứ không phải lúc
chạy: một domain nằm trong grant egress của code filler mà **không Effect nào đã
khai của Task phủ** là một lỗi thiết kế, và nó thuộc bảng kiểm tĩnh của
Composition §4 cùng với các kiểm khác. Chiều ngược lại — manifest khai ít năng lực
hơn cái analysis tìm thấy — đã là luật install của Block §6 và không khai lại.

## 3. Secret — gắn ở chặng cuối, bên ngoài chuồng

Luật gốc không khai lại: giá trị chỉ sống trong vault và consumer chỉ cầm một
**handle** (canonical: Vault & Key Lifecycle §5; RPA Sandbox & Credential §2).
Spec này trả lời đúng một câu hỏi mà tài liệu kia chưa phải trả lời: **tương đương
của "injection tại tầng driver" là gì khi consumer là một tiến trình?**

Nó **không** phải "tiêm giá trị vào một biến bên trong chuồng". Một biến nằm
trong address space, và mọi thứ trong address space đều có đường ra: stack trace,
core dump, `repr()` của một exception, log debug của chính thư viện HTTP mà code
tình cờ gọi. Câu trả lời tương đương về cấu trúc là **giá trị được gắn ở chặng
cuối, bên ngoài biên.**

- **Egress broker.** Mọi lời gọi ra ngoài rời chuồng qua một broker chạy trên
  host. Code gửi request kèm một **handle**; broker kiểm scope, resolve handle,
  gắn giá trị vào request **sau khi request đã rời chuồng**, rồi mới phát. Chuồng
  nhận **kết quả** và không bao giờ nhận giá trị.
- Hệ quả là một **tính chất**, không phải một lời hứa: _một stack trace không thể
  chứa thứ chưa bao giờ nằm trong address space sinh ra nó._ Không tồn tại bước
  "redact hậu kỳ", vì hậu kỳ nghĩa là đã rò rồi (canonical: RPA Sandbox &
  Credential §3).
- **Code cần tính toán trên một secret** — ký một payload, dựng một token — thì
  **phép toán đi ra, khóa không đi vào**: broker cấp một primitive ("ký chuỗi này
  bằng handle X"). Khi broker không có primitive cho phép toán đó, nó **từ chối**;
  nó không bao giờ trả về giá trị. Đây đúng là chỗ người ta mở một ngoại lệ "chỉ
  lần này", và việc từ chối mở _chính là_ cơ chế.
- **stdout, stderr và trace là artifact.** Chúng đi qua **đúng một** chốt masking
  tại biên trước khi trở thành entry hay evidence, với một detector có version mà
  số lần sót được đo bằng hậu kiểm mẫu — cùng thiết kế một chốt duy nhất, và cùng
  rủi ro còn lại được khai tường minh, như RPA Sandbox & Credential §3.
- Mỗi lần broker dùng một handle là một entry `secret_accessed` — handle, mục
  đích, actor, không bao giờ giá trị (Vault & Key Lifecycle §5).
- **Biên test giữ nguyên**: một test run scope không resolve được handle
  production, và engine từ chối ngay tại vault (Vault & Key Lifecycle §5). Sandbox
  không phải một cửa thứ hai để hỏi.

## 4. Trần tài nguyên — sandbox thi hành trần, sandbox không đặt trần

- Một grant tài nguyên — CPU time, wall clock, bộ nhớ, số tiến trình, đĩa tạm,
  byte egress, số chuồng đồng thời — resolve qua **cascade đã có sẵn**,
  `tenant → template → process → role → task` (Composition §3), cùng đường với
  `budget` và `sla` của Task §2. Không đẻ ra bề mặt cấu hình thứ hai; cascade của
  nguyên tắc 4 vốn đã phủ mọi tham số mà engine ép phải tồn tại.
- **Trần của cả một tenant, và luật công bằng khi nhiều tenant cùng xếp hàng,
  không thuộc tài liệu này.** Chúng thuộc spec **quota and scheduling fairness**
  (roadmap A.12). Ranh giới trong một câu: _spec kia quyết bao nhiêu; spec này thi
  hành một grant đã resolve và báo cáo đã tiêu bao nhiêu._ Code là đường rẻ nhất
  để một tenant đốt hết năng lực của một cài đặt, nên hai spec gặp nhau đúng ở đây
  — và gặp nhau không phải là gộp lại.
- **Sự phụ thuộc được khai chứ không được ngầm hiểu.** Chừng nào cơ chế đó chưa
  tồn tại, trần duy nhất trong hệ là trần theo Attempt resolve qua cascade —
  **một cái trần cho mỗi đơn vị công việc và không cái trần nào cho mỗi tenant**.
  Điều đó là đủ cho self-host một tenant, hình thái xuất hiện trước tiên (Tenant &
  Identity §2c), và **không** đủ cho một cài đặt dùng chung. Nói ra điều đó chính
  là điểm mấu chốt: một cái trần đang tồn tại mời gọi cách đọc rằng mức tiêu thụ
  đã bị chặn, trong khi trần theo Attempt không chặn tenant nào cả. Thứ tự xây
  dựng nào giải quyết việc này là câu hỏi của roadmap, không phải của tài liệu này.
- **Vượt trần thì Attempt bị chấm dứt và một entry nêu đúng tài nguyên nào bị
  vượt**, sau đó đi tiếp theo `on_fail` của Checkpoint §5 như mọi Attempt hỏng.
  Không có cắt cụt im lặng: **một output nửa chừng không bao giờ là một artifact
  hợp lệ**, vì một kết quả viết dở mà vẫn qua được kiểm schema đúng là kiểu hỏng
  mà một Gate không bắt được.
- Tiêu thụ đo được là đầu vào của projection metering, và nó được đo **kể cả dưới
  `run_kind: test`**: nhãn quyết định thứ gì _tính vào hóa đơn_, không bao giờ
  quyết định thứ gì _tốn tiền_ — CPU sandbox của một test run là chi phí đã phát
  sinh thật (canonical: Event Log §3, vốn đã khai đúng câu này).

## 5. `supports_dry_run` — một năng lực của hình học, không phải một lời hứa

Luật sống ở nơi khác và không khai lại: `dry_run` là năng lực của **adapter**, và
một contract khai `dry_run` với một adapter không hỗ trợ thì resolve về
`forbidden` (canonical: Handoff §3, Test Harness §5). Tài liệu này chỉ trả lời
sandbox executor **thỏa** năng lực đó bằng cách nào.

- Vì chuồng không có mạng nền (§2), broker là đường ra **duy nhất**. Một chốt duy
  nhất là thứ làm `test_behavior` thi hành được tại đúng một chỗ: `mock` trả
  fixture, `dry_run` chạy tới broker rồi **dừng trước khi phát**, `forbidden`
  chặn. Năng lực này vì thế là **hệ quả của hình học chứ không phải lời hứa của
  executor** — và đó chính là khác biệt giữa một khai báo kiểm được và một khai
  báo phải tin.
- **Điều kiện làm nó sai được khai ra chứ không giấu đi.** Taxonomy grant là mở,
  và một grant mà broker **không phân loại được** — một socket thô, một kênh nhị
  phân do image tự định nghĩa — phá mất chốt duy nhất. Khi đó cặp khai
  **`supports_dry_run: false`**, và mọi contract khai `dry_run` với nó resolve về
  `forbidden`.
- Khai báo gắn theo **cặp `(executor, image)`**, không theo cả hệ: một image mở
  socket thô không được phép hạ năng lực của mọi image khác. Static analysis kiểm
  cặp `contract × adapter` trước khi chạy, đúng như với mọi adapter khác
  (Composition §4).

## 6. Vòng duyệt verified — vòng tròn bị cắt bằng một cơ chế

Vòng tròn, viết đúng hình dạng của nó: **chạy code an toàn đòi hỏi nó đã verified;
verified đòi hỏi chạy suite của nó, mà với một block `code` thì suite ấy _chính
là_ code chưa verified.**

**Vòng tròn tan ra vì tiền đề thứ nhất của nó sai** — nó chỉ đúng với một biên
trong tiến trình (§1). Với biên OS/VM, an toàn là hàm của cấu hình host chứ không
của code, nên "chạy code chưa ai vouch" là một thao tác bình thường. Ở đây không
có cơ chế mới nào được sinh ra; cái §1 cung cấp là **lý do** cơ chế đã có là đủ.
Đây cũng là lý do phương án để publisher tự chạy suite rồi nộp kết quả bị bác: nó
không cắt vòng tròn mà đẩy vòng tròn sang publisher, và biến badge thành lời chứng
cho một **lời khai** thay vì cho một **quan sát**.

Còn lại một câu hỏi khác hẳn, và trả lời được: **run duyệt phải được cách ly khỏi
dữ liệu của chính operator**, vì Hub North Star §7 cho nó chạy trong test run
scope của operator — mà tenant operator là một tenant thật với dữ liệu thật.

| Chiều      | Grant của run duyệt                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nhãn       | `run_kind: test` trong chính tenant của operator — **không đẻ tenant riêng** (án văn là của Test Harness §1 và không lập luận lại ở đây)                       |
| Input      | **Chỉ fixture của suite**; 0 grant Knowledge, Memory hay DataTable                                                                                             |
| Secret     | **0 credential handle** — không phải "không có handle production", mà là không có cái nào, kể cả handle test                                                   |
| Egress     | **Deny-all, không allowlist.** Một suite cần mạng thì **không đủ tư cách làm bằng chứng**: kết quả là _"không kiểm chứng được"_, không bao giờ là _"verified"_ |
| Effect     | `test_behavior: forbidden` toàn phần (Hub North Star §7)                                                                                                       |
| Tài nguyên | Trần cứng; vượt trần cho ra _"không kiểm chứng được"_ và không bao giờ tự chuyển thành một lần đạt                                                             |
| **Host**   | **Không bao giờ dùng chung host sandbox với việc production của bất kỳ tenant nào**                                                                            |

Dòng cuối là thứ duy nhất tài liệu này **thêm** vào Hub North Star §7, và nó cần
án văn đi kèm. Biên OS/VM là thật nhưng **hữu hạn**: rủi ro còn lại là một lỗi
kernel hoặc hypervisor, và không cơ chế nào trong hệ này sửa được lớp lỗi đó. Thứ
còn thiết kế được vì thế không phải là việc một lần thoát có xảy ra hay không, mà
là **một lần thoát sẽ rơi vào đâu**. Tách host biến rủi ro còn lại thành một bán
kính thiệt hại rỗng, và nó là một cấu hình đo được chứ không phải một sự cẩn thận.

Hai điều kiện của Hub North Star §7 giữ nguyên và không mở lại: suite là **bằng
chứng phụ** còn badge đến từ **Judgment của một reviewer**; và Role reviewer khai
`distinct_filler_from` publisher, do operator lấp.

**Không tồn tại đường "publisher đã verified nên code của họ chạy ngoài
sandbox".** Cửa duyệt là cửa **duy nhất** cho một artifact `code`, và một fast
path như vậy sẽ dựng lại đúng cái vòng tròn ngay tại cái cửa sinh ra để cắt nó.

## 7. Runtime image — version, phân phối, thu hồi

Image là **một artifact**, đi qua đúng kênh phân phối của mọi thứ khác — không nằm
trong engine và không đi kèm bản cài. `resolve` / `pull` / `verify` như mọi block
(Hub North Star §5); kéo về xong thì được materialize vào Artifact Store của
tenant, đúng ranh giới "Hub phân phối, Artifact Store chạy" (Artifact Store §7);
mirror air-gap dùng các lệnh chuẩn (Block §8).

**Hai trục version, cả hai đều đã tồn tại — cấm đẻ trục thứ ba**
(Release & Compatibility §1):

| Cái gì được version                                 | Trục                                         | Cơ chế                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Nội dung image** — interpreter, thư viện hệ thống | Digest cho máy, semver cho người             | Digest được pin vào lockfile của tenant; nâng cấp đi theo luật migration và đường lùi của Block §4, §6 và §7                                                 |
| **Giao diện image ↔ engine** — kênh biên của §2     | **Protocol version**, một số nguyên đơn điệu | Thương lượng lúc khởi động chuồng; giao rỗng là một **từ chối** kèm entry `protocol_incompatible`, không có chế độ "cứ thử xem" (Release & Compatibility §2) |

Án văn: nội dung image đổi vì lý do của publisher — vá một thư viện, nâng một
interpreter — còn giao diện biên đổi vì lý do của engine. Hai lý do khác nhau thì
phải đếm riêng, nếu không một bản vá thư viện sẽ ép mọi engine nâng cấp, hoặc một
đổi khung dây sẽ trốn được trong một bản vá.

**Thu hồi có ba mức, và gộp chúng lại là cái sai:**

| Hành động                                    | Với một pin đã có                                                                                                  | Với một lần khởi động chuồng mới                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **`yank` image** (Block §8)                  | **Chạy nguyên** — pin đã có sống mãi; image không phải ngoại lệ của litmus thứ nhất của Hub                        | `resolve` cảnh báo, và mỗi lần khởi động phát một entry `yanked_image_used`                    |
| **`unverify` publisher** (Hub North Star §7) | Attempt **đang chạy** chạy tiếp tới hạn chót của chính nó                                                          | **Từ chối** — artifact `code` của publisher đó quay về mặc định bị reject — kèm một escalation |
| **Bytes**                                    | **Không bao giờ xóa**: một pin phải resolve được, nếu không "chạy nguyên" chỉ là một câu nói chứ không phải cơ chế | —                                                                                              |

Dòng `unverify` cần án văn đi kèm, vì dừng ngay lập tức mới là lựa chọn trực giác.
Giết một Attempt giữa chừng **sau khi một Effect đã phát** để lại nửa cái effect
không có đường bù — tệ hơn hẳn việc để nó chạy nốt dưới đúng cái biên đã giữ nó
một giây trước đó. Thu hồi badge là một phán quyết về **lòng tin vào publisher**;
nó không hồi tố làm biên yếu đi. "Dừng ngay bây giờ" là việc của một cơ chế khác —
rút grant, đình chỉ tenant — và gộp hai thứ lại thì mỗi lần thu hồi badge là một
lần sinh ra việc dở dang.

**Dám thu hồi thì cần bằng chứng**, cùng luật với `deprecated_used`
(Release & Compatibility §3). Các entry ở trên nuôi một projection **kiểm kê
runtime image**: tenant hay block nào đang pin image nào, image nào đã `yank`,
publisher nào đã bị `unverify`. Không có nó thì mọi quyết định thu hồi là đoán.

Đây là một projection riêng chứ không phải một cách dùng của projection "ai còn
đang dùng cái gì" ở Release & Compatibility §3, và ranh giới là của chính tài liệu
đó: §10 loại việc version block và template ra khỏi trục train, vì đó là hệ digest
và lockfile. Một image bị thu hồi trên trục digest, nên gộp nó vào projection
deprecation sẽ vượt đúng cái lằn ranh mà Release & Compatibility vạch ra. Là một
projection mới, nó **khai lập trường của mình về nhãn `run_kind` tại nhà canonical
của nhãn** (Event Log §3) — **tính vào, có gắn nhãn**, vì câu hỏi nó trả lời là
"ai hỏng nếu image này thôi resolve được", và một test run đang pin image ấy cũng
hỏng — và nó chịu nghĩa vụ negative test bắt buộc trong suite phân xử nó, như mọi
projection khác.

## 8. Non-goals

- **Không phải một nền tảng container tổng quát hay PaaS.** Một chuồng chạy một
  Attempt của một filler; nó không phải một dịch vụ có vòng đời riêng.
- **Không có chế độ "trần, không sandbox"** ở bất kỳ cấu hình nào — không cho một
  publisher đã verified, không cho code do chính tenant viết (đối xứng với RPA
  Sandbox & Credential §5).
- Không mạng nền, không filesystem của host, không thừa kế biến môi trường.
- **Không quyết tập ngôn ngữ ở đây** (ADR-0006), và **không quyết trần của cả
  tenant hay luật công bằng xếp hàng ở đây** (spec quota and scheduling fairness,
  roadmap A.12).
- Không đẻ trust tier riêng, không đẻ hệ kiểm duyệt riêng, không đẻ loại Task
  riêng: code filler đi đúng Role §5 và Checkpoint như mọi filler khác.

## 9. Nhật ký quyết định

| Vấn đề                       | Chốt                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loại biên                    | **OS / VM, không bao giờ là sandbox ở tầng ngôn ngữ.** An toàn phải là hàm của host, nếu không thì vòng tròn ở §6 không cắt được                                                                 |
| Sàn                          | Một tiến trình có namespace khi chỉ phục vụ một tenant; **cách ly mức kernel ở bất cứ đâu hai tenant dùng chung một cài đặt** — sàn nâng theo cái biên nó bảo vệ                                 |
| Đơn vị chuồng                | Một **Attempt**, chết cùng nó; **không có tương đương `persistent_profile`** — trạng thái ẩn giết đúng cái tính chất làm calibration của code filler hội tụ nhanh. Pool thì được, kênh thì không |
| Đường ra                     | Deny-all; **broker là chốt duy nhất**; Effect là một yêu cầu được engine đối chiếu với khai báo của Task, không bao giờ là một quyền code cầm sẵn                                                |
| Secret                       | Gắn **ở chặng cuối, ngoài chuồng**; cần tính toán thì **phép toán đi ra, khóa không đi vào**; không có primitive thì từ chối                                                                     |
| Trần tài nguyên              | Sandbox **thi hành** một grant đã resolve qua cascade sẵn có; **trần của cả tenant và công bằng xếp hàng thuộc spec quota**, và sự phụ thuộc vào nó được khai chứ không ngầm hiểu                |
| `run_kind: test` và chi phí  | Không tính vào hóa đơn không đồng nghĩa với miễn phí — CPU sandbox của một test run vẫn được đo (Event Log §3)                                                                                   |
| `supports_dry_run`           | Thỏa được **bằng hình học**, nhờ chốt duy nhất; một grant broker không phân loại được thì khai `false` **theo cặp `(executor, image)`**, không bao giờ theo cả hệ                                |
| **Vòng tròn verified**       | Nó tan ra vì "chạy an toàn đòi hỏi đã verified trước" chỉ đúng với một biên trong tiến trình. Phần còn lại — cách ly khỏi dữ liệu operator — là grant cộng với **tách host**                     |
| Tách host cho run duyệt      | Biên OS/VM là thật nhưng hữu hạn; thứ còn thiết kế được là **một lần thoát rơi vào đâu**, không phải việc kernel không có lỗi                                                                    |
| Version của image            | Hai trục đã có: **digest và lockfile** cho nội dung, **protocol version** cho giao diện biên. Cấm trục thứ ba                                                                                    |
| **`yank` so với `unverify`** | `yank` không bao giờ phá một pin đã có; `unverify` từ chối **lần khởi động mới** và để Attempt đang chạy chạy nốt. Giết giữa chừng sinh ra nửa cái effect không có đường bù                      |
| Bằng chứng để dám thu hồi    | Projection **kiểm kê runtime image** cộng một entry mỗi lần dùng một image đã thu hồi — cùng luật với `deprecated_used`, và là một projection riêng vì trục digest không phải trục train         |

## Litmus

1. Một code filler mở kết nối tới một domain ngoài grant của nó: nó bị chặn **tại
   broker** và thành một entry — hay chỉ tình cờ hỏng vì image không có sẵn thư
   viện đó?
2. Vẽ đường đi của một credential từ vault ra hệ ngoài: có điểm nào giá trị nằm
   trong address space của chuồng, trong stdout, trong một trace, hay trong một
   entry không?
3. Suite của một block `code` chưa verified đang chạy trong vòng duyệt: nó có
   đường nào chạm dữ liệu thật của tenant operator, hoặc chạm một host đang chạy
   việc production của bất kỳ tenant nào không?
4. Một image bị `yank` sau khi một tenant đã pin nó: tenant đó có chạy nguyên
   không, **và** hệ có trả lời được _ai còn đang pin nó_ bằng một projection thay
   vì bằng trí nhớ không?
5. Một contract khai `dry_run` với một image mà broker không phân loại được đường
   ra: nó resolve về `forbidden` — hay chạy thật?
6. Một code filler vượt trần CPU giữa chừng: có đường nào để output nửa chừng trở
   thành một artifact hợp lệ không?
7. Một publisher đã verified: có cấu hình nào cho code của họ chạy ngoài một
   chuồng không?

## Các kiểu hỏng

| Hỏng                                                   | Phát hiện bằng                             | Phục hồi                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code chạy quá giờ, hoặc lặp vô hạn                     | Trần wall clock hoặc CPU time của grant    | Chấm dứt Attempt kèm một entry nêu tài nguyên; đi tiếp `on_fail` hoặc escalate (Checkpoint §5). Output nửa chừng bị bỏ và không bao giờ thành artifact                                                                       |
| **Thoát khỏi chuồng** (một lỗi kernel hoặc hypervisor) | Bất thường ở host, đối chiếu với grant     | Run duyệt: host không giữ dữ liệu (§6), nên bán kính thiệt hại là rỗng. Host production: coi **mọi grant trên host đó là đã lộ** — rotate mọi handle trong tầm (Vault & Key Lifecycle §4) và dựng lại host từ một image sạch |
| Image kéo về không verify được chữ ký                  | `verify` lúc pull (Hub North Star §5)      | Từ chối khởi động; không có chế độ "chạy tạm"                                                                                                                                                                                |
| Image và engine lệch protocol                          | Thương lượng lúc khởi động chuồng          | `protocol_incompatible`; một người quyết định nâng cấp — engine **không bao giờ tự hạ** xuống một protocol đã bỏ (Release & Compatibility §2)                                                                                |
| Broker chết                                            | Mọi lời gọi ra ngoài đều lỗi               | Attempt đi tiếp `on_fail`; **không có đường đi thẳng bỏ qua broker** — dừng an toàn hơn chạy hở                                                                                                                              |
| Publisher bị `unverify` khi một Attempt đang chạy      | Entry `unverify` từ Hub                    | Attempt đang chạy chạy nốt; các lần khởi động mới bị từ chối, kèm escalation để một người đổi pin (§7)                                                                                                                       |
| Suite của run duyệt treo hoặc ngốn tài nguyên          | Trần cứng của run duyệt                    | Kết quả là **"không kiểm chứng được"**; nó không bao giờ tự chuyển thành một lần đạt                                                                                                                                         |
| Detector masking sót một secret trong trace            | Hậu kiểm mẫu (RPA Sandbox & Credential §3) | Nâng version detector và **rotate handle đã lộ** (Vault & Key Lifecycle §4). Một giá trị đã ra ngoài là đã lộ; không có đường thu hồi                                                                                        |
| Image bị `yank` vì một lỗ hổng mà một tenant vẫn pin   | Projection **kiểm kê runtime image** (§7)  | Cảnh báo qua `resolve` cộng một entry mỗi lần dùng; đổi pin là một lần nâng cấp block bình thường và **không bao giờ** tự động (Block §7)                                                                                    |
