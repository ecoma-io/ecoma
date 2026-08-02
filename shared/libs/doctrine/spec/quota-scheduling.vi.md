---
title: "Quota & Scheduling Fairness"
status: design-end-state
canonical-sha: f9ca617dca2e
---

# Quota & Scheduling Fairness

## 0. Vị trí — hai câu hỏi, một spec

Tài liệu này trả lời hai câu hỏi cùng đọc một projection nhưng tuyệt đối không
được gộp thành một khái niệm:

- **Trần** — một tenant được tiêu bao nhiêu.
- **Thứ tự** — khi nhiều tenant cùng có việc chờ, ai chạy trước.

Gộp lại thì "hết trần" và "chưa tới lượt" thành một chữ, và hệ mất đúng câu mà cả
cơ chế này tồn tại để nói được: _tenant A chậm vì chính nó, không phải vì
tenant B._

**Không store mới, không bề mặt cấu hình mới, không đơn vị đo mới.** Mức tiêu thụ
là projection trên Event Log (§2); hạn mức là tham số của default cascade sẵn có
(Composition §3); đơn vị đo là cost function mà mỗi Filler đã khai (Role §3). Đây
chính là "metering là cơ chế, pricing là policy" (North Star §8) áp lên một tầng
cao hơn.

**Không con số nào sống trong tài liệu này.** Engine ép tham số tồn tại, template
cấp giá trị (nguyên tắc #3). Một hạn mức viết vào cơ chế là một quyết định kinh
doanh đóng băng trong engine, trong khi gói cước đổi mà không cần phát hành
engine — và mọi lần đổi giá sẽ thành một lần sửa engine.

Bốn cơ chế thường bị nhầm là quota. Không cơ chế nào trong đó là quota:

| Cơ chế                                     | Nó chặn cái gì                                         | Vì sao nó không thay được quota                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard` của Trigger (Trigger & Channel §2) | Lưu lượng qua **một cửa vào**                          | Mười trigger đều nằm trong guard của mình vẫn cộng lại thành một tenant làm tràn cả installation                                                                |
| `budget` của Task (Task §2)                | Chi phí của **một đơn vị việc**                        | Trần của một task không nói gì về tổng của một tenant — và cascade thường cho mức dưới _nới rộng_ một giá trị, đúng thứ trần không được phép                    |
| capacity / rate limit của Filler (Role §3) | Sức chứa của **một bên lấp việc**                      | Đó là thuộc tính của _tài nguyên_, không phải của _bên tiêu thụ_: hai tenant dùng chung một filler vẫn giành nhau trong sức chứa đó                             |
| Trạng thái `suspended` (Tenant §2b)        | **Mọi thứ**, với một tenant không còn ở tình trạng tốt | Là trạng thái vòng đời chứ không phải một mức: nó đóng băng hẳn đường ghi, vào theo policy chứ không theo phép đo, và không nói gì về một tenant đang hoạt động |

Ba cơ chế đầu chặn theo **nguồn**; quota chặn theo **bên tiêu thụ**. Admission lấy
**min của mọi trần đang áp** — không cái nào thay cái nào, và không cái nào được
nới cái nào.

## 1. Bốn tài nguyên, hai hình thái khan hiếm

| Tài nguyên                      | Đo bằng                                                         | Sinh ra từ entry loại    | Biết được khi nào                    |
| ------------------------------- | --------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| **Model token**                 | Token vào/ra theo cost function của filler (Role §3)            | attempt                  | **Sau khi đã tiêu**                  |
| **Sandbox CPU / thời gian máy** | Thời gian chiếm executor — sandbox RPA, runtime của code filler | attempt · session effect | **Sau khi đã tiêu**                  |
| **Run đồng thời**               | Số Lease tenant đang giữ (Working Data §3)                      | lease acquire / release  | **Trước khi tiêu bất cứ gì**         |
| **Lưu trữ**                     | Bytes content-addressed, payload log inline, row DataTable      | artifact · write · GC    | Tổng tích lũy, đọc lúc nào cũng được |

Taxonomy **mở** như mọi taxonomy trong hệ: thêm một tài nguyên là thêm một cost
function và một trần trong cascade, không bao giờ là sửa engine.

**Hai hình thái, hai điểm thi hành.** Phân biệt này quyết định phần còn lại của
tài liệu:

| Hình thái             | Ví dụ                    | Thi hành ở đâu                                                                                                                                               |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Đếm được TRƯỚC**    | run đồng thời, lưu trữ   | **Admission**: không cấp Lease kế tiếp, không nhận write. Trần đúng tuyệt đối — không tồn tại độ vượt                                                        |
| **Chỉ biết được SAU** | model token, sandbox CPU | **Biên kế tiếp**: mỗi lần xin admission đọc lại số đã tiêu. Đơn vị _đang_ chạy bị chặn bởi `budget` của chính nó (Task §2) và TTL của lease, không bởi quota |

Coi hai hình thái như một thì hỏng theo một trong hai cách. Chặn trước theo ước
lượng thì cơ chế giết việc đáng lẽ vừa trần. Hứa không bao giờ vượt dù một token
thì cơ chế đã hứa điều mà một phép đo hậu nghiệm không giữ nổi. Hệ quả trung thực
thuộc về chỗ này chứ không thuộc về một sự cố về sau: **trần token/CPU là trần có
độ vượt, và độ vượt đó có trần khai báo của riêng nó** (§7). Trần đồng thời thì
không có độ vượt.

## 2. Mức tiêu thụ là projection — và nó phải khai lập trường

- Quota đọc một projection **rebuild được từ log** (Event Log §3), không đọc một
  bảng đếm tự ghi. Sửa tay số đã tiêu là drift, bị phát hiện và dựng lại có hồ sơ
  như mọi projection (Working Data §2). Không tồn tại nguồn sự thật thứ hai về
  việc một tenant đã tiêu bao nhiêu.
- Nó là **projection riêng, không phải một cột của metering**, vì hai lý do cơ chế
  chứ không phải vì tiện: lập trường với nhãn `run_kind` khác metering (§4); và
  hình dạng khác — metering là tổng tích lũy theo kỳ tính tiền, còn quota là
  **tổng theo cửa sổ trượt**, phải đọc nóng ở mỗi lần admission.
- Nhà canonical của nhãn `run_kind` là Event Log §1/§3. Tài liệu này **khai lập
  trường**, không khai lại nhãn.
- **Chịu negative test bắt buộc như mọi projection** (Event Log §3, trong suite
  ◆G0): fixture có entry `run_kind: test` thì bộ đếm kế hoạch **không đổi**. Với
  projection này, negative test còn phải kiểm **chiều ngược lại** — bộ đếm tài
  nguyên **có đổi**. Thiếu khẳng định thứ hai đó, một cách thi hành chỉ việc lọc
  sạch nhãn ở mọi nơi vẫn qua suite trong khi nó mở toang đúng chỗ mà §4 tồn tại
  để bịt.

## 3. Hạn mức khai ở đâu — cascade sẵn có, cộng đúng một luật

- `quota` là tham số engine ép tồn tại, resolve theo đúng chuỗi như mọi tham số
  khác: `tenant → template → process → role → task` (Composition §3). Không có bề
  mặt cấu hình thứ hai. Gói cước của một tenant là **giá trị ở mức `tenant`**, do
  workflow provisioning của control plane khai — control plane _gọi_ engine, chứ
  không _vá_ engine (North Star §8, Tenant §2b).
- **Luật thêm duy nhất, và nó ngược với cascade thường: mức dưới chỉ được SIẾT,
  không bao giờ được NỚI.** Cascade thường trả lời _giá trị nào áp dụng_, nên mức
  dưới override mức trên. Trần trả lời _cái gì không được vượt_, mà một trần mức
  dưới nới được thì bất kỳ process nào cũng tự cấp cho mình hạn mức vô hạn bằng
  một dòng khai báo. Phép hợp nhất vì thế là **min theo từng tài nguyên**, không
  phải "mức gần nhất thắng". Ở đây hướng bảo thủ chính là hướng đơn giản: đơn giản
  hơn phải nghĩa là chặt hơn, không bao giờ là lỏng hơn.
- **Không snapshot vào instance** — khác `budget` và `sla`, vốn được snapshot lúc
  khởi chạy (Composition §3). Snapshot đúng với tham số điều khiển _cách một
  instance chạy_. Trần điều khiển _việc một đơn vị mới có được nhận hay không_, mà
  mỗi đơn vị chỉ có đúng một lần admission; chính khoảnh khắc đó **là** lúc
  resolve, nên không có gì để snapshot. Hệ quả phải nói thẳng, vì đây là chỗ hai
  cơ chế giao nhau: **hạ trần của một tenant không giết việc đang chạy** (§6), nó
  chỉ chặn đơn vị kế tiếp.
- **`∅` — không trần — là một giá trị phải khai, không phải một ô bỏ trống.**
  Self-host đơn-tenant ship với `∅` ở mức tenant: người vận hành _chính là_ tenant,
  và trần duy nhất có nghĩa với họ là phần cứng của chính họ, nên zero-config vẫn
  chạy được. Nhưng "chưa ai khai" và "vô hạn có chủ ý" phải phân biệt được bằng
  cách đọc, nên engine ép trường tồn tại và lần khai đó là một entry
  `config-change` (Event Log §1). Escape hatch được phép — có dán nhãn và ghi vết,
  không bao giờ im lặng.

## 4. `run_kind: test` — hai trục, tuyệt đối không gộp

**Lập trường của projection này với nhãn là HAI lập trường ngược chiều nhau, trên
hai trục:**

| Trục                                                          | Lập trường  | Vì sao                                                                                                        |
| ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| **Hạn mức kế hoạch** — thứ gói cước cho phép                  | **Loại**    | Chạy thử là việc của người thiết kế quy trình; tính vào gói cước là phạt đúng hành vi mà hệ muốn khuyến khích |
| **Trần tài nguyên thật** — token, CPU, run đồng thời, lưu trữ | **Tính đủ** | Chi phí đó _đã xảy ra_: token đã đốt, executor đã bị chiếm, hàng xóm đã chậm. Nhãn không hoàn lại gì cả       |

**Hệ quả cơ chế**: projection quota giữ **hai bộ đếm trên cùng một tập entry** —
bộ đếm kế hoạch có đọc nhãn và bộ đếm tài nguyên không đọc nhãn — chứ **không**
phải một bộ đếm kèm một bộ lọc. Một test run vì thế **xin admission y hệt một
production run**: cùng trần đồng thời, cùng trần token, cùng hàng đợi công bằng
(§6). Thứ duy nhất nó không chạm là bộ đếm kế hoạch.

**Án văn — hai câu nghe giống nhau và chỉ một câu đúng**: _không tính vào gói_
không phải là _không tốn gì_. Gộp chúng lại thì `run_kind` thành **công tắc
quota**: ai cũng chạy mọi thứ dưới nhãn test, installation vẫn xuống cấp đúng như
khi không có quota, còn sổ sách thì sạch bong. Hỏng **nặng hơn** trạng thái không
có cơ chế nào, vì nó kèm theo một con số nói rằng mọi thứ vẫn ổn.

**Điều kiện để luật trên không thành một lời dặn**: nhãn do engine gắn tại **điểm
khởi chạy đòi capability** (Test Harness §1 — test run scope), không bao giờ là
một trường payload do người gọi tự đặt. Nhãn tự khai thì cả mục này chỉ mô tả một
hệ thống danh dự.

**Trong một tenant, thứ tự là việc của chính tenant đó**: test run tranh chỗ với
production run của cùng tenant theo `priority` (Task §2), và không cần trục ưu
tiên thứ hai. Công bằng _giữa_ các tenant (§6) không bao giờ nhìn nhãn; nó chỉ
nhìn tài nguyên đã tiêu.

## 5. Chạm trần — ba kết cục, không kết cục nào im lặng

| Kết cục   | Nghĩa                                                       | Đi qua cơ chế sẵn có nào                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reject`  | Đơn vị việc **không khởi chạy**                             | Tại cửa vào: reject ở biên đúng như `auth` không hợp lệ hoặc `payload_contract` vi phạm (Trigger & Channel §2). Với task đang chờ: **một Violation, rồi `on_fail`** (Checkpoint §5) — retry / reroute / escalate theo đúng đường có sẵn |
| `queue`   | Nhận nhưng **hoãn**; đơn vị nằm trong hàng đợi công bằng §6 | Việc chờ mang **trần thời gian engine ép tồn tại**; hết trần thì kết cục chuyển thành `reject` kèm escalation — invariant 5 cấm kẹt im lặng                                                                                             |
| `degrade` | Nhận và chạy, ở **giá trị thấp hơn**                        | Định tuyến sang filler rẻ hơn trong pool của Role (Role §3) · hạ tần suất sampling · thu hẹp bề rộng của `spawn_policy` (Task §5)                                                                                                       |

**`degrade` có một biên cứng: nó thu hẹp giá trị và policy, không bao giờ chạm cơ
chế.** Không bỏ Gate, không bỏ Judgment, không hạ classification, không hạ lớp
reversibility, không auto-pass vì hết hạn mức. Riêng trên trục lưu trữ, `degrade`
không bao giờ có nghĩa là **thu hồi sớm artifact của chính tenant để lấy chỗ**:
retention là policy của Artifact Store (Artifact Store §3), và một trần phải xóa
dữ liệu để nằm dưới chính nó thì đã hủy đúng thứ nó đang bảo vệ. Án văn vẫn là án
văn §4 dùng ở phía nhãn: `degrade` chạm được cơ chế thì "hết quota" thành một
đường lách Checkpoint — cùng một lỗ, chỉ khác cửa vào.

Kết cục nào áp cho tài nguyên nào là **tham số cascade** engine ép tồn tại. Mặc
định bảo thủ là `reject`: dừng lại và nói rõ, chứ không âm thầm chạy tiếp ở một
chất lượng không ai chọn.

**Luật hiển thị — một quyết định biên là một entry, và entry đó phải đủ để trả
lời "vì sao tôi bị chặn".** Nó mang `(tài nguyên, trần đã resolve, tầng cascade
nào cấp trần đó, số đã tiêu tại thời điểm quyết, kết cục)`. Ghi lại _tầng nào
thắng_ đi theo đúng khuôn mà resolution cascade của semantic locator đã dùng
(Driver & Perception §4). Một trần không giải thích được là một trần người dùng
chỉ có thể đoán — và họ sẽ đoán rằng hệ hỏng rồi thử lại, đúng lúc hệ đang cần họ
dừng.

**Chống bão**: chạm trần lặp lại không sinh mỗi lần một escalation. Dedup và
correlation áp dụng nguyên vẹn (Escalation §5), nên một process misfire tạo
**một** escalation đang mở kèm bộ đếm, chứ không phải một nghìn dòng trong hàng
đợi chú ý (invariant 3). Trigger ở đây là một thành viên của taxonomy **mở** ở
Escalation §2, nên nhận thêm nó không cần cơ chế mới.

## 6. Công bằng giữa các tenant — và Lease là đường duy nhất chạm việc đang chạy

**Lời hứa đo được**: không tenant nào bị bỏ đói bởi _hành vi_ của tenant khác.
Chậm vì hạ tầng nhỏ là quyết định của chính người vận hành; chậm vì hàng xóm lặp
vô hạn là lỗi thiết kế.

- **Thứ tự không theo giờ đến.** FIFO trao hàng đợi cho ai gõ cửa nhiều nhất, đúng
  kịch bản process schedule bắn liên tục mà cơ chế này sinh ra để xử lý. Scheduler
  chọn đơn vị kế tiếp theo **nợ tài nguyên trong cửa sổ**, đọc từ chính projection
  §2: tenant vừa tiêu nhiều thì xuống sau, tenant im lặng cả ngày lên trước. Trọng
  số per-tenant là tham số cascade, vì thứ gói cước mua là policy chứ không phải
  cơ chế. Hình thái này đã được chứng minh ngoài hệ — fair queueing theo deficit
  trong lập lịch mạng là cùng một bài toán, khác đơn vị đo.
- **Không có cột priority xuyên tenant.** `priority` (Task §2) xếp việc _bên
  trong_ một tenant. Một trục ưu tiên xuyên tenant gõ tay là nguồn sự thật thứ hai
  về thứ tự, và nó sẽ thắng mọi cơ chế đúng vì nó gần tay nhất.
- **Scheduler chỉ tác động ở đúng hai điểm, và cả hai đều là "chưa bắt đầu"**:
  nhận vào (§5), và **cấp Lease** (Working Data §3). Nó **không bao giờ** giết một
  attempt đang chạy. Cắt ngang một đơn vị đã ghi effect chính là kịch bản
  `orphaned` mà Lease từ chối cấp lại tự động; nó không tạo ra công bằng, nó tạo
  ra effect nửa vời hoặc effect đôi (nhất quán với luật node-chết, RPA North Star
  §4). Việc _đang_ chạy đã có đúng hai trần và cả hai đều đã tồn tại: `budget` của
  chính nó (Task §2) và **TTL bắt buộc của lease**. Vì TTL là ràng buộc cấu trúc,
  không tồn tại đơn vị chạy vô hạn để mà cần tới một cơ chế giết.
- **Trần "run đồng thời" chính _là_ số Lease một tenant được giữ cùng lúc** —
  không cơ chế đếm mới. Và vì TTL bắt buộc, bộ đếm đó tự tan khi máy đang giữ
  lease chết, không cần ai dọn tay.
- **Scheduler là thành phần DUY NHẤT đọc xuyên tenant, nên phạm vi đọc của nó
  phải khai công khai.** Nó đọc **số liệu tiêu thụ tổng hợp**, và không bao giờ
  đọc knowledge, memory hay calibration — invariant 4 áp cho cả người vận hành
  Cloud (North Star §8, Tenant §2c). Chiều ngược lại cũng là cơ chế chứ không phải
  kỷ luật vận hành: **entry trong log của một tenant không bao giờ mang danh tính
  hay số liệu của tenant khác.** Log per-tenant (Event Log §1) đã cho điều đó gần
  như miễn phí; luật nêu ở đây cấm chiều ngược — _"vì sao tôi phải chờ"_ được trả
  lời bằng số của chính tenant đó (nợ của tôi, trần của tôi, độ dài hàng đợi của
  tôi), không bao giờ bằng một ô cửa nhìn sang hàng xóm. Không có luật này thì
  chính công cụ dựng ra để giải thích lại thành một side-channel đếm được ai đang
  ở chung cụm — cùng lớp lỗ mà dedup xuyên tenant bị cấm vì nó (Artifact Store §4).

## 7. Kinh tế của chính cơ chế, và chuyện gì xảy ra khi số liệu đi sau

- **Không thêm đường ghi.** Projection quota tổng hợp các entry vốn đã được ghi vì
  lý do khác; nó không sinh event mới trên đường nóng. Chỉ **quyết định biên** mới
  là entry mới, và số lượng của chúng bị chặn bởi chính cơ chế sinh ra chúng (§5,
  chống bão).
- **Van điều tiết**: cửa sổ và độ mịn của bộ đếm là tham số — engine ép tồn tại,
  template cấp giá trị. Admission đọc một tổng nóng chứ không quét log; lịch sử
  dựng lại từ log khi cần.
- **Số liệu đi sau là trạng thái bình thường, không phải sự cố** — một token chỉ
  đo được sau khi đã tiêu (§1). Nên **độ trễ của projection mang một trần khai
  báo**: trong trần, admission chấp nhận một **độ vượt có giới hạn**; vượt trần
  đó, engine chuyển hành vi sang `reject` và phát escalation cho người vận hành.
  Trần này bảo vệ _hàng xóm_, không bảo vệ _tính đúng của sổ sách_, nên câu hỏi
  đúng là "vượt bao nhiêu thì không chấp nhận được", chứ không phải "không bao giờ
  vượt" — thứ mà một phép đo hậu nghiệm không hứa nổi. Và fail-closed toàn phần
  mỗi khi projection trễ thì biến một lần rebuild thường lệ thành một lần ngừng
  dịch vụ: đó là chỗ sai để tuyệt đối hóa.

## 8. Non-goals

- Không phải bảng giá, không phải gói cước, và không phải bất kỳ hạn mức cụ thể
  nào — quota là cơ chế, hạn mức là giá trị (North Star §8).
- Không thay giới hạn ở tầng hạ tầng (CPU của container, trần connection). Chúng
  không thấy biên tenant nên bóp đều cả bên gây lẫn bên chịu. Bổ sung, không bao
  giờ thay thế.
- Không phải QoS _bên trong_ một tenant — đó là `priority` (Task §2) — và không
  phải load hay performance testing (Test Harness §9).
- Không kiểm entitlement, không license key, không phone-home trong runtime
  (North Star §7): quota đọc tham số cascade của chính tenant và không hỏi ai bên
  ngoài.
- **Không có quota killer**: không đường nào chạm việc đang chạy ngoài `budget` và
  TTL của Lease.
- Không phải vòng đời tenant. `suspended` là trạng thái vào theo policy
  (Tenant §2b), không bao giờ là kết cục quota tự chạm tới.
- Không projection thứ hai cho token hay lưu trữ, và không đơn vị đo mới — cùng
  tập entry, cùng cost function của Filler (Role §3), và hai bộ đếm có lập trường
  được khai tường minh (§4).

## 9. Nhật ký quyết định

| Vấn đề                    | Chốt                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hạn mức khai ở đâu        | Tham số của default cascade sẵn có; control plane cấp giá trị ở mức tenant — không bề mặt cấu hình thứ hai                                                                 |
| **Hướng resolve**         | **Mức dưới chỉ siết, không bao giờ nới; hợp nhất là min theo từng tài nguyên.** Cascade thường trả lời "giá trị nào", trần trả lời "cái gì không được vượt"                |
| Snapshot                  | **Không** snapshot vào instance: mỗi đơn vị có đúng một lần admission và đó chính là lúc resolve — hạ trần chặn đơn vị kế tiếp và không giết gì đang chạy                  |
| Không ai khai trần        | `∅` là một giá trị phải khai, ghi lại thành entry `config-change` — không phải ô trống. Self-host zero-config vẫn chạy, và escape hatch vẫn được dán nhãn                  |
| Đo cái gì                 | Bốn tài nguyên trên một taxonomy mở; **hai hình thái** — đếm được trước và chỉ biết được sau — với **hai điểm thi hành khác nhau**                                         |
| **Nhãn `run_kind: test`** | **Hai lập trường ngược nhau**: loại khỏi bộ đếm kế hoạch, **tính đủ** vào bộ đếm tài nguyên. Nhà của nhãn ở Event Log §1/§3; tài liệu này chỉ khai lập trường              |
| Ai gắn nhãn               | Engine gắn, tại điểm khởi chạy đòi capability (Test Harness §1). Một trường payload tự khai sẽ biến mọi luật ở trên thành lời dặn                                          |
| Kết cục biên              | `reject` / `queue` (có trần chờ) / `degrade`; mặc định là `reject`. **`degrade` chỉ thu hẹp giá trị và không bao giờ chạm cơ chế**, kể cả trên trục lưu trữ                |
| Hiển thị                  | Mọi quyết định biên là một entry mang trần, số đã tiêu, kết cục **và tầng cascade đã cấp trần** — một trần không giải thích được là trần người dùng phải đoán              |
| Thứ tự giữa các tenant    | Nợ tài nguyên trong cửa sổ, không FIFO, không cột priority xuyên tenant; trọng số là giá trị template                                                                      |
| Việc đang chạy            | Chỉ chạm qua Lease và `budget`; **không bao giờ giết** — cắt ngang sau commit point là effect đôi hoặc nửa vời                                                             |
| Đọc xuyên tenant          | Chỉ scheduler, và chỉ số liệu tiêu thụ tổng hợp (invariant 4 áp cả operator); entry của một tenant không bao giờ mang số của tenant khác — chiều side-channel cũng bị đóng |
| Số liệu đi sau            | Độ vượt có giới hạn kèm trần khai báo; vượt trần đó thì `reject` cộng escalation, chứ không fail-closed toàn phần                                                          |

## Litmus

1. Một tenant lặp trigger vài giây một lần: nó có chạm trần **của chính nó**, hai
   tenant còn lại có đo được khác biệt nào không — và log của họ có đúng không một
   dòng nào nói về tenant đã misfire?
2. Chạy đúng khối lượng đó dưới `run_kind: test`: bộ đếm kế hoạch có đứng yên
   trong khi trần token, CPU và đồng thời chặn y hệt như với production — để "chạy
   như test" không mua thêm nổi một token?
3. Một process, một template hoặc một task khai `quota` rộng hơn mức tenant: giá
   trị nào thắng, và có tồn tại đường nào nới được trần của tenant không?
4. Hạ trần của một tenant khi ba instance đang chạy: cả ba có chạy tiếp tới
   `budget` hoặc TTL của chính chúng trong khi đơn vị kế tiếp bị chặn — không
   instance nào bị giết giữa chừng và không effect nào nửa vời?
5. Chỉ vào một lần bị chặn bất kỳ: entry của nó có trả lời được tài nguyên nào,
   trần bao nhiêu, tầng cascade nào cấp trần đó và đã tiêu bao nhiêu — hay người
   dùng chỉ có thể đoán?
6. Xóa toàn bộ projection quota rồi dựng lại từ log: kết quả có tương đương, và có
   bảng đếm nào sống ngoài log không?
7. Bật `degrade` hết cỡ trên mọi tài nguyên: có Gate nào bị bỏ, Judgment nào không
   được sinh, classification hay lớp reversibility nào bị hạ, hay artifact nào bị
   thu hồi sớm để lấy chỗ không?

## FMEA

| Hỏng                                                  | Phát hiện                                                                 | Phục hồi                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Projection quota trễ hoặc drift                       | Checksum theo log-position (Working Data §2) cộng trần độ trễ (§7)        | Trong trần, chấp nhận độ vượt đã khai. Vượt trần, hành vi chuyển sang `reject` cộng escalation; dựng lại từ log |
| Scheduler ngừng cấp lease trong khi hàng đợi còn việc | Trần thời gian chờ hết hạn (§5)                                           | `queue` chuyển thành `reject` cộng escalation terminal — không bao giờ kẹt im lặng (invariant 5)                |
| Lease hết TTL khi tenant đang ở trần đồng thời        | TTL và heartbeat (Working Data §3)                                        | Bộ đếm đồng thời tan theo TTL; nếu effect đã ghi thì lease thành `orphaned` và không được cấp lại tự động       |
| Trần của một tenant mới khai sai, nhầm thành `∅`      | Trần là một entry `config-change` đọc lại được, không phải một ô trống    | Sửa là một entry khác, có actor và thời điểm — không có "không ai khai" để đổ lỗi                               |
| Lách quota bằng cách tự gắn nhãn test                 | Nhãn gắn tại điểm khởi chạy đòi capability (§4), không phải trong payload | Nhãn giả không tồn tại về cấu trúc; và kể cả khi capability bị lạm dụng, bộ đếm tài nguyên vẫn chặn (§4)        |
| Chạm trần liên tục sinh bão escalation                | Dedup và correlation (Escalation §5)                                      | Một escalation gộp kèm bộ đếm, chứ không phải mỗi lần thử một dòng trong hàng đợi chú ý                         |
