---
title: "Clickstream Ingest — the Second Write Path"
status: design-end-state
canonical-sha: ef2f5b60428b
---

# Clickstream Ingest — the Second Write Path

> Platform — **một dòng ghi riêng, đứng cạnh Event Log chứ không nằm trong nó**.
> Nó nhận sự kiện lưu lượng web (page view, click, tương tác form): khối lượng
> lớn, từng sự kiện gần như vô giá trị, và **không phải lao động**. Tuân 4 nguyên
> tắc (canonical: North Star §3). Định vị, nói một lần: đo được mặt tiền mà không
> làm hỏng cuốn sổ mà mọi thứ khác dựng lại từ đó.
>
> **Đây không phải subsystem tầng 1.** ◆G0 đóng băng schema entry của Event Log
> và các interface subsystem lõi; tier này gác ở ◆G3 và hội tụ cùng Track C. Nó
> tiêu thụ phần lõi đã đóng băng — schema entry, cây khóa, lattice phân loại — và
> phần lõi không tiêu thụ gì từ nó (§2).

## 1. Quyết định trung tâm — log riêng, không phải một nhãn trên log lao động

**Chốt: một dòng ghi riêng.** Không phải partition có nhãn của Event Log, cũng
không phải một loại entry mới nằm trong nó.

Cám dỗ đi hướng ngược lại là có thật, và nó có tiền lệ ngay trong nhà: nhãn
`run_kind` (Event Log §1) tách hai lớp entry mà **không** cần hai dòng. Nhưng
`run_kind` tách hai thứ **cùng bản chất** — đều là lao động, đều đầy đủ, đều vĩnh
viễn — nên một nhãn là đủ và một dòng là đúng. Clickstream lệch ở **cả ba** thuộc
tính cùng lúc, và mỗi vế lệch là một lý do cấu trúc chứ không phải một sở thích:

| Thuộc tính             | Log lao động                                                                         | Clickstream                                                            | Vì sao không ở chung một dòng được                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vòng đời**           | Metadata entry **vĩnh viễn** — nó chính là lịch sử (canonical: Event Log §4)         | **Bắt buộc có TTL** (§6)                                               | Một dòng không thể vừa vĩnh viễn vừa hết hạn. Áp TTL lên log lao động là **đục log** — đúng thứ crypto-shredding sinh ra để không ai phải làm                                                                       |
| **Loại sự thật**       | Bản ghi **đầy đủ**: mọi projection rebuild ra kết quả tương đương (§3 ở tài liệu đó) | **Ước lượng có lấy mẫu** (§3, §4 ở đây)                                | Trộn hai loại tuyên bố vào một dòng thì tuyên bố mạnh tụt xuống mức tuyên bố yếu: người đọc một entry không còn biết mình đang cầm _điều đã xảy ra_ hay _một mẫu của nó_, nếu khác biệt duy nhất chỉ nằm ở một nhãn |
| **Ai định khối lượng** | Lao động của chính tenant — hữu hạn, đo được, và là của họ                           | **Người lạ**: một chiến dịch quảng cáo nhân lưu lượng lên gấp trăm lần | Đây là khối lượng duy nhất trong hệ do người ngoài đặt. Ghép nó vào nguồn sự thật là trao cho người lạ cái van điều khiển kích thước log, thời gian replay và nghĩa vụ retention của **mọi thứ** dựng lại từ log đó |

**Vì sao "lọc ở projection" không phải câu trả lời.** Bộ lọc chạy thật: số liệu
lao động sẽ ra đúng. Nhưng ba chi phí mà bài toán này thật sự nói tới — **kích
thước log, thời gian replay, nghĩa vụ retention** — đều trả **tại lúc ghi**,
không phải lúc đọc. Không bộ lọc đường đọc nào hoàn lại một byte đã ghi. Test
chấp nhận (§9) đo đúng ba thứ đó, nên máy phân định được giữa hai phương án thay
vì phải tranh luận.

**Vì sao không dùng sản phẩm analytics bên thứ ba.** Bản ghi visitor là dữ liệu
của một data-subject; đưa nó ra ngoài là **external effect chịu egress theo
classification** (§7). Một hệ nằm ngoài lattice không có sàn mật để chịu, nên câu
hỏi _"dữ liệu này được phép đi đâu"_ mất đi đúng cơ chế mà dự án này dùng để trả
lời ở mọi chỗ khác.

**Hệ quả không được đọc nhầm**: một dòng riêng **không** phải nguồn sự thật thứ
hai (Event Log §7 giữ nguyên hiệu lực). Nguồn sự thật thứ hai là hai nơi cùng
khai **một loại sự thật**; ở đây chủ thể khác nhau — một bên là _lao động_, một
bên là _lưu lượng_ — và §2 đóng đinh chiều đi để bên này không bao giờ trở thành
bên kia.

**Vì sao gọi là "thứ hai".** Cho tới nay Event Log là nơi duy nhất một sự kiện
được _ghi nhận lần đầu_: Artifact Store giữ bytes thuộc về entry, còn một lượt
ghi DataTable bản thân nó là một entry (Working Data §1). Tier này là nơi thứ
hai, và con số đó có ý định dừng ở hai.

## 2. Ranh giới — một chiều, một cửa băng qua

- **Cấm chiều đọc vào lao động.** Không Task, Checkpoint, Judgment, calibration
  input hay quyết định định tuyến nào của engine được đọc tier này. Static
  analysis bắt tại thiết kế, qua đúng cửa của luật _"process tham chiếu một
  collection ngoài grant của Role là lỗi lúc thiết kế"_ (Knowledge §2), và nó
  thuộc cùng bảng đó (Composition §4). Án văn: một ước lượng có lấy mẫu chảy vào
  Judgment là một phán quyết dựa trên thứ không tái lập được **về nội dung**, và
  calibration ăn phải nó thì học từ nhiễu — Calibration §2 đã cấm mọi đường vào
  cell không phải một Judgment hợp lệ, và luật này là thứ giữ cho ranh giới đó
  không bị vượt ở một tầng thấp hơn.
- **Cấm chiều ghi ngược.** Không có gì trong log lao động ghi sang tier này. Hai
  dòng, rời nhau ở đường ghi.
- **Đúng một cửa băng qua — conversion.** Khi một lượt truy cập **sinh ra lao
  động** (gửi form, mở hội thoại, đăng ký), việc băng qua là một **entry trigger
  đầy đủ trong log lao động** (Trigger & Channel §2), **không lấy mẫu, không gộp
  lô**. Danh tính bên ngoài đi vào theo đúng văn phạm sẵn có: một Filler
  `external` của một Role, hợp nhất thành Party (Trigger & Channel §3, Tenant &
  Identity §5). Trước thời điểm đó, visitor mang danh tính principal `external`
  **không gắn Role nào** — một page view không phải lao động và không lấp vị trí
  nào.
- **Một hệ quả là cơ chế chứ không phải trùng hợp**: conversion được đo ở **cả
  hai phía** — phía clickstream có lấy mẫu, phía lao động đầy đủ. Tỉ lệ giữa hai
  con số đó **đo được sai số của chính phép lấy mẫu**. Nên "mẫu có lệch không" là
  câu hỏi có dữ liệu trả lời, không phải một giả định đặt sẵn ở đầu chương.

## 3. Lấy mẫu và gộp lô — hình dạng chi phí và các van điều tiết

**Hình dạng chi phí**: tuyến tính theo lưu lượng, với biên trên do bên ngoài đặt.
Ba van; cả ba là tham số engine ép tồn tại, giá trị do cascade cấp (nguyên tắc
#3; cascade là Composition §3):

| Van                      | Cơ chế                                                                                                                                                        | Vì sao đúng hình dạng này                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lấy mẫu theo visitor** | Giữ-hay-bỏ được quyết định **một lần cho cả phiên**, bằng một hàm xác định trên `visitor_ref` cộng salt của kỳ — không bao giờ tung đồng xu theo từng sự kiện | Lấy mẫu theo _sự kiện_ đẻ ra một click không có page view đứng trước: **mọi tỉ lệ phễu đều sai**, và sai theo cách không ai phát hiện được từ chính dữ liệu. Lấy mẫu theo _visitor_ giữ nguyên hình dạng phễu và chỉ thu nhỏ mẫu |
| **Gộp lô**               | N sự kiện thành **một entry trỏ vào một blob trong Artifact Store**, đúng khuôn batch-event mà bulk import đã dùng (Working Data §1) — không sinh cơ chế mới  | Chi phí thật nằm ở _số entry_, không ở số byte payload; gộp lô cắt đúng trục đắt và vẫn để lại một dấu vết duy nhất cho cả lô                                                                                                    |
| **TTL**                  | §6                                                                                                                                                            | Van duy nhất tác động lên **tồn kho**; hai van trên chỉ tác động lên **lưu lượng**                                                                                                                                               |

- **Tỉ lệ mẫu là dữ liệu thuộc về lô, không phải cấu hình đọc lúc hỏi**: mỗi entry
  lô mang `sampling_rate` và salt của kỳ đã thực dùng. Đây là điều kiện tiên
  quyết của §4 — thiếu nó thì "rebuild" không có nghĩa xác định.
- **Thứ tự** theo đúng hình dạng của Event Log §2 mà không mượn dòng của nó: tổng
  thứ tự trên mỗi phiên visitor, với **entry lô** là đơn vị của position. Một
  projection khai khoảng trống theo position; không bao giờ apply nửa lô.
- **Ba tham số engine ép tồn tại trước khi có một byte nào được ghi**: tỉ lệ mẫu,
  TTL, và khóa của visitor (§5). Template cấp giá trị bảo thủ nên một cài đặt
  zero-config vẫn chạy; nhưng **không tồn tại đường ghi nào khi một trong ba
  không phân giải được** — engine từ chối và phát một entry nói rõ lý do. Không có
  chế độ "ghi trần rồi phân loại sau": không khai nghĩa là chặt hơn, không bao
  giờ lỏng hơn.
- Entry của tier này dùng lại **đúng schema entry của Event Log §1** — id, thời
  điểm, loại, schema-version, actor identity, tham chiếu `entity@version`,
  `run_kind`, payload — để reader-tolerant, provenance và dedup không phải viết
  lần thứ hai. Thứ nó không mang là hai lời hứa kia: **đầy đủ** và **vĩnh viễn**.

## 4. "Rebuild" nghĩa là gì trên một dòng đã lấy mẫu

Luật mọi view là projection rebuild được vẫn giữ nguyên (canonical: Event Log
§3). Thứ phải nói thẳng là **rebuild của dòng nào, và nó hứa gì**.

- **Định nghĩa**: rebuild ở đây nghĩa là dựng lại **đúng cùng một ước lượng từ
  đúng cùng một mẫu đã giữ** — không phải dựng lại điều đã xảy ra. Dòng này chưa
  bao giờ là bản ghi đầy đủ, nên nó không được phép hứa như thế.
- **Điều làm nó xác định — lấy mẫu xảy ra đúng một lần, tại biên ghi.** Quyết
  định giữ-hay-bỏ đã nằm sẵn trong dòng; **reader không bao giờ lấy mẫu lại**.
  Hai lần rebuild ra cùng một con số, và máy kiểm được điều đó. Án văn: một hệ lấy
  mẫu lúc đọc thì hai lần rebuild ra hai con số khác nhau và **không ai chứng minh
  được cái nào đúng** — projection thôi không còn là phép chiếu, nó thành một phép
  đo mới ở mỗi lần chạy.
- **Điều làm nó trung thực — con số luôn đi kèm tỉ lệ của nó.** Mọi projection
  trên tier này mang `sampling_rate` của dữ liệu nó đọc và **không bao giờ được
  render như một phép đếm chính xác**. Engine ép trường đó tồn tại; cách hiển thị
  là giá trị của template.
- **Cửa sổ retention giới hạn phạm vi rebuild, và điều đó phải nói ra chứ không
  để người ta tự phát hiện.** TTL hủy segment (§6), nên một lần rebuild chỉ với
  tới hết cửa sổ còn sống. Số liệu cũ hơn cửa sổ là **snapshot đã vật chất hóa và
  đóng băng**, không tính lại được — và một snapshot chỉ được mang **những tổng
  hợp đã qua sàn nhóm của leakage gate** (§7). Giữ một hàng theo từng visitor quá
  hạn TTL dưới cái tên "snapshot" là TTL bị vô hiệu bằng một phép đổi tên, và điều
  đó bị cấm.
- **Falsifiable chứ không phải một lời hứa**: sai số của mẫu đo được bằng phép đối
  chiếu conversion hai phía ở §2. Một tier có lấy mẫu mà không có điểm neo đầy đủ
  nào để đối chiếu thì "mẫu này đại diện" là một câu không ai kiểm được.

## 5. Khóa của visitor — treo ở đâu trên cây khóa

- **Visitor là một Party chưa hợp nhất** (Tenant & Identity §5): một con người bên
  ngoài, tức **một data-subject có quyền xóa**. Không phải một loại chủ thể mới.
- **Khóa là subject key — tầng 3 của cây khóa hiện có, và không sinh tầng thứ
  tư** (canonical: Vault §2, `root → tenant DEK → subject key`, "ba tầng là đủ và
  cố định"). `subject_ref` là một `visitor_ref` sinh tại biên ghi: pseudonymous,
  ổn định, không mang PII.
- **Khóa đó mã hóa cái gì**: mọi trường định danh hoặc gần-định danh của lượt truy
  cập — địa chỉ mạng, user agent, referrer kèm tham số, và mọi thuộc tính do chủ
  thể cung cấp. Thứ để trần chỉ là thứ không định danh được ai.
- **Khóa phải tồn tại TRƯỚC entry đầu tiên.** "Shreddable" chỉ là cơ chế khi khóa
  có mặt lúc ghi; sinh khóa hồi tố cho dữ liệu đã ghi trần là **dọn dẹp, không
  phải xóa** — và nó không bao giờ với tới bản đã nằm trong sao lưu.
- **Hợp nhất khi chủ thể tự khai** (Tenant & Identity §5): visitor đăng ký hoặc
  xác thực, và danh tính hợp nhất vào Party đã có. **Không sinh khóa thứ hai và
  không re-encrypt gì cả**: ánh xạ `subject_ref → key_id` là một projection của
  log (Vault §2), nên hợp nhất đổi **ánh xạ** chứ không đụng vào entry cũ — đúng
  luật rotate-không-phải-shred (Vault §4). Hệ quả phải nói thẳng: **shred một
  Party là hủy mọi `key_id` mà lineage của Party đó trỏ tới**, không chỉ cái mới
  nhất. Hụt một mắt lineage là một lời hứa xóa không tới nơi.
- **Luật _loại bản sao_ áp nguyên văn, không nới một chữ** (canonical: Event Log
  §4, Vault §3 vế (c)): khóa của visitor không có bản sao point-in-time nào,
  chỉ replica tiến-lên-trước. Đây đúng là chỗ Vault §3 vế (b) đã tách sẵn theo
  tầng — root và tenant DEK có đường DR, **subject key thì không** — nên tier này
  không xin ngoại lệ nào; nó chỉ là một consumer nữa của một luật đã viết sẵn.
- **Lệnh xóa sống trong log lao động, không trong tier này**: hủy một khóa là hành
  động có chủ đích qua Gate dưới capability `key_admin` (Vault §4), tức là **lao
  động**, nên entry của nó nằm ở nơi entry sống vĩnh viễn. Hệ quả là cố ý và cần
  thiết: **bằng chứng đã xóa sống lâu hơn dữ liệu bị xóa** — clickstream hết hạn
  theo §6 trong khi entry hủy khóa còn nguyên, nên câu _"chứng minh anh đã xóa
  tôi"_ vẫn trả lời được rất lâu sau khi không còn gì để xóa.

## 6. TTL — bắt buộc, ai đặt và ai được đổi

- **Bắt buộc tồn tại.** Không khai thì phân giải về giá trị **ngắn nhất** của
  cascade, không bao giờ về vô hạn — đơn giản hơn nghĩa là bảo thủ hơn.
  Clickstream sống lâu hơn phân tích mà nó được thu để phục vụ là trách nhiệm
  pháp lý thuần túy, không còn mặt lợi nào.
- **Ai được đổi**, và ai không:

| Chủ thể                                            | Được đổi TTL                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Một Role giữ capability tương ứng                  | **Được** — như một Task qua Gate, và thay đổi đó là một entry trong log **lao động**, cùng khuôn với declassification (Knowledge §3) và migration (Working Data §1). Taxonomy capability vốn đã mở (Tenant & Identity §4, Role §2), nên không xuất hiện hệ phân quyền thứ hai |
| Một mức cascade thấp hơn (workspace, một mặt tiền) | **Chỉ được thu hẹp** — nó được siết giá trị thừa kế từ trên, không bao giờ nới rộng. Engine ép chiều đơn điệu đó; con số cụ thể là giá trị của template (nguyên tắc #3)                                                                                                       |
| Chính đường ghi ingest                             | **Không.** Không có vòng tự chỉnh nào âm thầm kéo dài retention vì thấy khối lượng có vẻ thấp                                                                                                                                                                                 |
| Một operator, bên ngoài log                        | **Không tồn tại đường nào.** Một TTL đổi được mà không sinh entry thì không phải chính sách retention, nó là một thói quen                                                                                                                                                    |

- **Nâng TTL không hồi sinh gì cả**: dữ liệu đã hết hạn đã bị hủy, và giá trị mới
  chỉ áp cho dữ liệu ghi sau đó. Án văn: nếu nâng mà hồi sinh được thì TTL chưa
  bao giờ là xóa — nó chỉ là che, và mọi lời hứa retention dựa trên nó đều rỗng.
- **Hết hạn là hành động có dấu vết**: mỗi lượt dọn phát một entry, cùng nguyên
  tắc _"xóa bytes là hành động có dấu vết"_ (Artifact Store §3) — audit không bao
  giờ gặp một lỗ không giải thích được.

**TTL và erasure là hai cơ chế, cho hai mục đích, và không cái nào thay được cái
kia** — đây là chỗ dễ gộp nhầm nhất của cả tài liệu:

| Cơ chế                   | Trị cái gì                                    | Làm bằng gì                                                                            | Chỗ nó không với tới                                                            |
| ------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **TTL**                  | **Khối lượng** tồn kho, và trách nhiệm đi kèm | **Hủy segment** — hợp lệ ở đây vì tier này tự khai mình hữu hạn, khác hẳn Event Log §4 | Không với tới bản sao đã rời khỏi hệ trong một bản sao lưu                      |
| **Erasure theo yêu cầu** | **Quyền** của một data-subject                | **Hủy khóa** (§5) — có hiệu lực trên mọi bản sao, kể cả bản đã nằm trong backup        | Không giải phóng một byte nào: dữ liệu vẫn nằm đó, chỉ vĩnh viễn không đọc được |

## 7. Phân loại và egress — không có cơ chế mới nào ở đây

- Bản ghi visitor mang một **classification**; không khai nghĩa là `confidential`
  và cấm external egress (canonical: Knowledge §3).
- Công bố một tổng hợp — dashboard trong sản phẩm, trang public, báo cáo cho
  khách — đi qua **floor propagation cộng leakage gate**, đúng cơ chế đã dùng cho
  tổng hợp rút từ một bảng mật (canonical: Working Data §1, Knowledge §3). Đưa nó
  ra ngoài là một external effect và chịu egress hai lớp, static và runtime.
- **Rủi ro riêng của tier này — tái định danh từ mẫu nhỏ**: một tổng hợp trên một
  nhóm đủ nhỏ chỉ đúng vào một con người. Cơ chế đó đã có nhà: cùng sàn nhóm mà
  distill đa-subject đang chịu (Memory §5, k-anonymity bằng floor propagation).
  Leakage gate là chỗ áp; đây không phải một cửa kiểm thứ hai.
- **Chiều workspace phải khai** (một agency nhiều client): projection tổng hợp
  khai `scope` của nó, và không khai nghĩa là workspace **hẹp nhất** chứa mọi
  nguồn — cùng luật với distill (Memory §5). Số liệu lưu lượng của client A không
  bao giờ _vô tình_ nằm trong báo cáo của client B.

## 8. Projection — phễu là một view, không phải kho thứ hai

- Số liệu phễu và lưu lượng là **projection**, mang đúng hình dạng một view đã
  có: đọc được bằng SQL trên một snapshot, provenance là `(log position, query
text, result hash)` — DataTable và Labor Analytics (Working Data §1, §4). Không
  sinh kho analytics thứ hai, và non-goal của Event Log §7 giữ nguyên.
- **Nó chịu luật `run_kind` như mọi projection khác** (canonical: Event Log §3),
  và lý do là cụ thể chứ không phải nghi thức: một projection phễu **đọc cả hai
  dòng** — lượt truy cập có lấy mẫu ở đây, và entry conversion đầy đủ trong log
  lao động (§2) — nên nó cũng là một projection của Event Log, và nó phải khai lập
  trường tường minh, không có mặc định im lặng, **kèm negative test bắt buộc trong
  suite ◆G0**. Lập trường của nó có hàng riêng trong bảng của Event Log §3.
- Dashboard trong sản phẩm là bề mặt tầng 3 đọc một projection, không phải engine
  (Working Data §4).

## 9. Test chấp nhận, viết thành thứ đo được

Yêu cầu được nêu thẳng: **lưu lượng có thể tăng gấp trăm lần mà log lao động
không lớn thêm.** Biến nó thành thứ máy phân định được cần một đính chính trung
thực, và đính chính đó làm nó mạnh lên chứ không yếu đi.

**Log lao động lớn theo lao động, không theo lượt truy cập.** Một conversion _là_
lao động — một lượt đăng ký thật sinh ra một process instance thật — nên entry
của nó buộc phải nằm trong log lao động, và một chiến dịch tạo ra nhiều lượt đăng
ký hơn thì chính đáng tạo ra nhiều entry hơn. Một test viết là "log không lớn lên
dưới bất kỳ chiến dịch nào" sẽ sai ngay từ câu chữ, và một test sai thì bị nới ra
ngay lần đầu nó đỏ.

**Dạng đo được**, tức thứ mà conformance suite của ◆G3 chạy:

| Fixture | Lượt truy cập  | Conversion           | Khẳng định                                                                                                                                                 |
| ------- | -------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | khối lượng nền | một tập cố định      | —                                                                                                                                                          |
| B       | **100× của A** | **đúng tập giống A** | **Số entry, kích thước byte, thời gian replay và cửa sổ retention của Event Log lao động không đổi so với A** — bằng nhau tuyệt đối ở số đếm và kích thước |

Nên tính chất được đóng đinh là chính xác: **mức lớn lên của log lao động là một
hàm của tập conversion và của không gì khác.** Tier clickstream hấp thụ trọn phần
gấp trăm lần đó trong dòng của chính nó, dưới van của chính nó và TTL của chính
nó. Một entry lao động duy nhất mà sự tồn tại của nó phụ thuộc vào khối lượng
truy cập sẽ làm fixture B đỏ, và đó là lỗi thiết kế chứ không phải chuyện tinh
chỉnh.

Lý do việc này phải xong **trước khi sự kiện đầu tiên được ghi** đúng là lý do
issue đã nêu: một log ghi sai cách không được sửa bằng cách thêm cái nắp về sau.
Entry đã nằm trong đó rồi, và mọi projection đã rebuild xuyên qua chúng rồi.

## 10. Non-goals

- Không phải một sản phẩm web analytics: không session recording, không heatmap,
  không theo dõi xuyên site, và **không fingerprinting** — không cơ chế nào ở đây
  sinh ra một danh tính mà chủ thể không cung cấp.
- Không phải nguồn sự thật cho bất kỳ quyết định lao động nào (§2), và không phải
  message bus chung hay kho log ứng dụng dùng chung.
- Không lấy mẫu lúc đọc, không TTL vô hạn, và không ghi khi khóa, TTL hoặc tỉ lệ
  mẫu chưa phân giải được.
- Không tự chỉnh tỉ lệ mẫu một cách âm thầm — đổi tỉ lệ là một thay đổi có entry,
  không phải một vòng điều khiển lặng lẽ.
- Không phải tiền lệ cho một đường ghi thứ ba: số dòng ghi nhận sự kiện lần đầu
  dừng ở hai, và một dòng thứ ba sẽ phải làm lại toàn bộ lập luận ở §1 của tài
  liệu này từ đầu.

## 11. Nhật ký quyết định

| Vấn đề                           | Chốt                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Log riêng hay một nhãn?**      | **Log riêng.** Ba thuộc tính lệch cùng lúc — vòng đời · loại sự thật · ai định khối lượng; `run_kind` đủ cho hai thứ cùng bản chất và không gánh nổi một thứ khác bản chất                                                                            |
| Lọc ở projection                 | Bác: bộ lọc đúng ở đường đọc, còn kích thước log, thời gian replay và retention trả ở đường **ghi** và không hoàn lại được                                                                                                                            |
| Analytics bên thứ ba             | Bác: đưa bản ghi visitor ra ngoài classification lattice là vứt đi cơ chế duy nhất trả lời "dữ liệu này được phép đi đâu"                                                                                                                             |
| Nguồn sự thật thứ hai?           | Không: chủ thể khác nhau (lao động ≠ lưu lượng), và §2 khóa chiều đọc bằng static analysis                                                                                                                                                            |
| **Lấy mẫu theo cái gì**          | Theo **visitor**, không bao giờ theo sự kiện — lấy mẫu theo sự kiện làm hỏng mọi tỉ lệ phễu theo cách không phát hiện được từ chính dữ liệu                                                                                                           |
| **Rebuild trên dòng đã lấy mẫu** | Dựng lại **cùng một ước lượng từ cùng một mẫu**; lấy mẫu xảy ra một lần tại biên ghi, tỉ lệ nằm trong lô, reader không bao giờ lấy mẫu lại ⇒ hai lần rebuild bằng nhau, máy kiểm được. Rebuild chỉ với tới hết cửa sổ còn sống                        |
| Số liệu cũ hơn cửa sổ            | Snapshot đã vật chất hóa và đóng băng, chỉ mang **những** tổng hợp đã qua sàn nhóm — không bao giờ là một hàng theo từng visitor sống sót qua TTL dưới một cái tên khác                                                                               |
| Sai số của mẫu                   | Đo được chứ không giả định: conversion có mặt ở cả hai phía, có mẫu và đầy đủ                                                                                                                                                                         |
| **Khóa của visitor**             | **Subject key tầng 3 trên cây khóa hiện có** — không tầng thứ tư, không cây thứ hai; phải tồn tại trước entry đầu tiên; hợp nhất đổi ánh xạ và không re-encrypt gì; một lần shred phủ **mọi `key_id` dọc theo lineage**                               |
| Bằng chứng đã xóa                | Entry hủy khóa nằm trong log **lao động** ⇒ nó sống lâu hơn dữ liệu bị xóa, nên "chứng minh anh đã xóa tôi" vẫn trả lời được sau khi TTL đã dọn sạch                                                                                                  |
| **TTL và erasure**               | Hai cơ chế, hai mục đích: TTL hủy segment và trị **khối lượng** (hợp lệ vì tier này tự khai hữu hạn); erasure hủy khóa và trị một **quyền** (nó với tới cả backup). Không cái nào thay được cái kia                                                   |
| Ai đổi TTL                       | Một Role có capability, qua Gate, là một entry; mức cascade thấp hơn chỉ được **thu hẹp**; nâng lên **không hồi sinh gì**; không có đường tự chỉnh và không có đường nào ngoài log                                                                    |
| Mật và công bố                   | Không cơ chế mới: classification, floor propagation, leakage gate, egress hai lớp; sàn nhóm chống tái định danh dùng lại đúng cửa của distill đa-subject                                                                                              |
| Chiều workspace                  | Projection tổng hợp khai `scope`; không khai nghĩa là hẹp nhất — lưu lượng của client A không rơi vào báo cáo của client B                                                                                                                            |
| Zero-config                      | Chạy được ở mức bảo thủ nhất, nhưng **không tồn tại đường ghi trần**: thiếu khóa, TTL hay tỉ lệ thì engine từ chối và phát một entry nói rõ lý do                                                                                                     |
| **Test chấp nhận**               | Chốt thành một khẳng định hai fixture: 100× lượt truy cập với tập conversion giữ nguyên thì số entry, kích thước, thời gian replay và cửa sổ retention của log lao động không đổi — mức lớn lên của log lao động là hàm của conversion, không gì khác |

## Litmus

1. Một chiến dịch nhân lưu lượng lên gấp trăm lần trong một tuần với tập
   conversion giữ nguyên: **số entry, kích thước byte, thời gian replay và cửa sổ
   retention** của Event Log lao động có **y hệt** mức nền không — đo bằng con số
   chứ không bằng cảm nhận?
2. Rebuild một projection phễu hai lần từ cùng một dòng: nó có ra **cùng một con
   số** không — và con số đó có mang tỉ lệ mẫu khi hiển thị, thay vì đội lốt một
   phép đếm chính xác?
3. Một visitor đòi được quên: **đúng một lệnh hủy khóa** có làm mọi bản ghi của họ
   không đọc được không, kể cả bản nằm trong một sao lưu cũ hơn lệnh đó — và bằng
   chứng đã xóa có còn tra được sau khi TTL đã dọn sạch dữ liệu không?
4. Nâng TTL lên: dữ liệu đã hết hạn có đọc lại được không? (Đáp án bắt buộc:
   không.)
5. Chỉ ra **một đường** mà một con số của tier này chảy vào một Judgment, một
   calibration input, hay một quyết định định tuyến của engine. Nếu tồn tại, ranh
   giới §2 đã hỏng.
6. Không cấu hình gì: tier chạy ở mức bảo thủ nhất, ghi trần, hay từ chối im lặng?
   (Bắt buộc: chạy bảo thủ; một lần từ chối phải kèm entry nói rõ lý do; ghi trần
   là vi phạm.)
7. Hỏi một số liệu phễu cũ hơn cửa sổ retention: hệ trả lời từ một snapshot tổng
   hợp đã đóng băng và nói rõ như vậy, hay lặng lẽ trả về một con số tính lại trên
   dữ liệu không còn ở đó nữa?

## FMEA

| Hỏng                                                      | Phát hiện bằng                                          | Phục hồi                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Sink clickstream quá tải hoặc chết                        | Backpressure tại biên ghi                               | **Hạ tỉ lệ mẫu hoặc bỏ sự kiện — không bao giờ tràn sang log lao động**; lần hạ đó là một entry, nên projection thấy được khoảng đã bị thu hẹp |
| Blob của một lô bị mất                                    | `exists(hash)` fail (Failure modes của Artifact Store)  | Lô đó rơi khỏi ước lượng; projection khai khoảng trống theo position — không bao giờ apply nửa lô                                              |
| Khóa của visitor không phân giải được                     | Engine từ chối tại cửa ghi                              | Một entry nói rõ lý do; **không tồn tại đường ghi trần** — dừng an toàn hơn chạy hở, như ở Vault §7                                            |
| Lượt dọn TTL không chạy                                   | Tuổi của segment cũ nhất vượt giá trị đã khai           | Escalation; **không bao giờ tự nới hạn** — một TTL bị lỡ là sự cố có người xử, không phải một giá trị mới                                      |
| Mẫu bị lệch (bot, một chiến dịch bất thường)              | Phép đối chiếu conversion hai phía (§2) lệch bất thường | Escalation để người quyết; đổi tỉ lệ là một thay đổi có entry, không phải một vòng điều khiển                                                  |
| Ghi trùng lô (at-least-once)                              | Dedup theo id của lô                                    | Idempotent, bản trùng bị bỏ — cùng cơ chế dedup của Event Log                                                                                  |
| Một lần shred sót một mắt lineage sau khi hợp nhất Party  | Đối chiếu tập `key_id` dọc lineage lúc thi hành         | **Không báo shred hoàn tất** cho tới khi mọi `key_id` đã bị hủy — cùng luật với một replica chưa xác nhận `destroy` (Vault §4)                 |
| Một snapshot ngoài cửa sổ mang chi tiết theo từng visitor | Sàn nhóm được kiểm lại lúc ghi snapshot                 | Snapshot bị từ chối; chỉ những tổng hợp đã qua leakage gate mới được đóng băng (§4, §7)                                                        |
