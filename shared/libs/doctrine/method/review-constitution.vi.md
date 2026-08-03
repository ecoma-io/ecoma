---
title: "Review Constitution"
status: design-end-state
canonical-sha: 59412e88162b
---

# Hiến pháp review

Nửa dùng chung của mọi công cụ review trong dự án này: các luật mà một phán xét
phải tuân, thủ tục mà một lượt chạy phải theo, và phương pháp sinh ra rubric cho
một object chưa có rubric.

**Phần chung là dạng; phần riêng là nội dung.** Một luật ở đây cố định _hình
dạng_ của một phán xét — một verdict phải mang gì, khi nào được tuyên PASS, một
lượt chạy nợ gì trước khi được phép tự gọi là đã xong. Thứ lấp vào hình dạng đó
là của riêng từng công cụ: lỗi nào đáng severity nào, một lượt chạy phải phủ
những tiêu chí nào, công cụ đó có những điểm mù nào. Nội dung không bao giờ được
chuyển lên đây, và dạng không bao giờ được chép lại ở dưới kia.

---

## LỜI MỞ

### Thế nào là một công cụ

Ba điều kiện, và một công cụ chỉ chịu ràng buộc của tài liệu này khi **cả ba**
cùng đúng:

1. **Nó phán xét một object thường trú.** Object sống qua mọi diff — một hồ sơ,
   một workspace, một lớp proposal — chứ không phải chính thay đổi đang nằm
   trước mặt.
2. **Nó mang bộ từ vựng verdict của riêng nó**: finding, verdict, và một thang
   severity nó tự định nghĩa cho object của mình.
3. **Nó sở hữu một bộ tiêu chí thường trú**, mà độ phủ mỗi lượt chạy được khai
   bằng protocol level chứ không lắp ráp lại từ đầu mỗi lần.

Bảng phân loại, ghi thẳng ở đây để không surface nào phải đoán mình đứng ở đâu:

| Surface                                               | Chịu ràng buộc | Vì sao                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rubric review của hồ sơ tài liệu này                  | có             | Đủ cả ba: hồ sơ là thường trú, nó tự định nghĩa test severity, và các nhóm tiêu chí cố định với độ phủ khai theo protocol level                                                                          |
| Rubric conformance của workspace                      | có             | Đủ cả ba, trên một object khác — thứ repository khai so với thứ nó làm                                                                                                                                   |
| Rubric proposal                                       | có             | Đủ cả ba; nó sống trong một issue thread thay vì một file, đó là quyết định tỷ lệ về nơi _giữ_ một rubric, không phải về việc nó có phải rubric hay không                                                |
| Bản review practice tự động trên một pull request     | không          | Trượt (1) và (3): object của nó là một diff, và rubric của nó lắp ráp theo từng pull request từ các practice card mà thay đổi đó kích hoạt. Nó có verdict và finding nhưng không có thang severity riêng |
| Các bản review diff trước khi merge                   | không          | Trượt (1) vì cùng lý do: một diff không cho thấy được thứ thiếu ở khắp nơi                                                                                                                               |
| Lượt hunt issue trên một project                      | không          | Trượt (3): luật xoay của nó cố ý không quét hết mọi thứ trong một lượt, nên không có bộ thường trú nào để một lượt chạy khai độ phủ                                                                      |
| Các tài liệu thủ tục lái những công cụ chịu ràng buộc | không          | Chúng mang thủ tục, không mang tiêu chí — nên không có gì ở đây ràng buộc chúng trực tiếp. Luật 2 vẫn ràng buộc: một tài liệu thủ tục chép lại một luật có chủ ở đây là một bản sao thứ hai              |

**Nghĩa vụ chiều ngược.** Một review surface mới chạy bài kiểm tra kết nạp này
ngay trong chính thay đổi sinh ra nó. Một surface đạt bài kiểm tra mà không cite
tài liệu này là một finding theo luật 2 — không phải việc để dành cho người đọc
sau.

### Trích dẫn đi một chiều

Tài liệu này không bao giờ cite một công cụ. Nó được viết để người không cầm công
cụ nào vẫn đọc được, vì một luật chỉ hiểu được thông qua một instantiation của
nó thì đó là luật của instantiation ấy, bị xếp nhầm chỗ.

Một công cụ cite tài liệu này **bằng tên luật kèm số**, theo thứ tự đó. Tên là
thứ sống sót với người đọc chỉ mở tài liệu đang cite; số là thứ làm cho trích dẫn
kiểm được.

### Chính sách đánh số

Số luật (Phần I, 1–12) và số bước (Phần II, 1–11) là **ổn định, chỉ nối thêm,
không bao giờ đánh số lại và không bao giờ dùng lại.** Một luật bị rút để trống
số của nó; một luật bị thay giữ nguyên số và đổi nội dung. Một số đã nghỉ không
bao giờ được giao cho luật khác, vì mọi trích dẫn viết trước lúc nghỉ sẽ trỏ sang
thứ khác mà vẫn đọc như đúng.

Đây đúng là kỷ luật mà các công cụ áp cho định danh của chính chúng, và vì cùng
một lý do: một trích dẫn chỉ kiểm được chừng nào thứ nó gọi tên chưa dịch chuyển
bên dưới nó.

---

## PHẦN I — CÁC LUẬT PHÁN XÉT

1. **Biên object.** Một công cụ phán xét đúng một object và không thò tay sang
   object của hàng xóm. Nơi hai công cụ nhìn cùng một hiện vật từ hai phía, mỗi
   bên khai thứ nó lấy làm cho sẵn — và một finding về thứ bên kia sở hữu là
   finding của bên kia, được chuyển sang chứ không được nhận.

2. **Luật một bản sao.** Một công cụ khai thủ tục và nội dung của chính nó, và
   không bao giờ chép lại một rule đã có chủ: một bản sao thứ hai là một rule thứ
   hai, và không người đọc nào biết bản nào ràng buộc. Khi rule đổi, nó đổi ở
   tầng sở hữu; mọi nơi khác chỉ cite. Luật này áp lên chính tài liệu này trước
   khi áp lên bất cứ thứ gì khác — mỗi câu ở đây là một câu mà công cụ sau đó bị
   cấm nhắc lại.

3. **Severity là một test khách quan, ba mức.** Mỗi mức được định nghĩa bằng một
   test mà người đọc áp được lên object mà không cần hỏi người đã viết finding.
   Bản thân các test là nội dung của công cụ, vì thứ làm một lỗi trở nên nặng là
   thuộc tính của object, không phải của phán xét nói chung.

   **Severity là ordinal _bên trong_ một công cụ và không so sánh được ở bất cứ
   đâu khác.** Một `blocker` với một hồ sơ tài liệu và một `blocker` với một
   workspace không phải hai thứ cùng loại, và cộng chúng lại cho ra một con số
   vô nghĩa. Vì thế một report phủ nhiều hơn một công cụ phải **ghi tên công cụ
   cạnh mỗi con đếm**, và một con đếm không có tên công cụ là một report chưa
   xong chứ không phải một tổng.

4. **PASS phải falsifiable.** Một tiêu chí pass bằng cách gọi tên cơ chế đang giữ
   nó, kèm trích dẫn — hoặc, với tiêu chí dạng "tìm một trường hợp mà…", bằng
   cách ghi lại những đòn tấn công đã thất bại, mặc định tối thiểu ba đòn. "Không
   tìm thấy gì" không phải một PASS; đó là sự vắng mặt của một lượt chạy.

5. **FAIL mang theo cách tái hiện** — câu lệnh, file và dòng, hoặc đường đi phơi
   nó ra. Một verdict mà người đọc không tự dựng lại được là một ý kiến có dán
   nhãn.

6. **Known gap chỉ được tính nếu object đã tự khai trước lượt chạy.** Một lỗ mà
   object đã thừa nhận, trong prose đi cùng nó, không phải finding, và nhận nó là
   thổi phồng lượt chạy. Một lỗ phát hiện _trong_ lượt chạy là FAIL, chỉ đóng
   bằng một fix hoặc bằng một sự chấp nhận tường minh có kèm lý do.

7. **WITHDRAWN là một outcome bắt buộc, không phải điều xấu hổ.** Một nghi ngờ bị
   verification giết được ghi lại cùng với thứ đã giết nó. Lượt sau không tiêu
   lại đúng giờ đó — và một công cụ mà các lượt chạy không bao giờ rút lại thứ gì
   là đang báo cáo nghi ngờ như sự thật.

8. **Luật miễn dịch.** Một finding mà không tiêu chí sẵn có nào lẽ ra bắt được
   buộc phải sinh một tiêu chí mới **trong cùng thay đổi**, ghi kèm tiền lệ đã ép
   ra nó. Sửa rubric nằm bên trong lượt chạy, không bao giờ là việc để lại cho
   người khác. Hệ quả: không rubric nào từng "hoàn chỉnh" — chỉ "mạnh nhất đến
   nay, và vẫn đang tiến hóa", vì một tuyên bố hoàn chỉnh đúng là tuyên bố không
   falsifiable mà luật 4 cấm.

9. **Hình dạng của một finding.**

   `(tiêu chí, object, trích dẫn hoặc cách tái hiện, verdict, severity, hệ quả)`

   Trường hệ quả gọi tên thứ vỡ ngoài đời thật, không bao giờ gọi tên rule bị
   viện. Mỗi công cụ khai tên trường mà object của nó cần thay cho `object` và
   `hệ quả`, và được thêm trường; không công cụ nào được bỏ bớt.

10. **Tension là một verdict.** Nơi mọi tiêu chí đều pass mà câu hỏi tinh thần
    của nhóm vẫn lung lay, hoặc nơi hai luật kéo ngược nhau, kết quả là `tension`
    — được ghi lại, không bao giờ được giải quyết âm thầm bởi người phát hiện ra
    trước.

11. **Câu hỏi của chủ object là một finding.** Một câu hỏi từ người sở hữu
    object, mà object không trả lời được bằng đúng một trích dẫn, là một finding
    chính thức ở severity theo luật 3, và luật 8 áp lên nó như mọi finding khác.
    Qua mọi công cụ đến nay, đây là kênh bắt lỗ rẻ nhất từng có.

12. **Không gì được review âm thầm.** Một unit mới của object phải đi qua, **ngay
    trong chính phiên tạo ra nó**, mức mà công cụ của nó chỉ định cho một unit
    mới — không bao giờ là mức tối thiểu per-patch — hoặc mang một nhãn tường
    minh cho tới khi qua. Mức đó là mức nào, và "unit" là gì, là nội dung của
    công cụ; còn việc một unit mới không được lặng lẽ bỏ qua review thì không.

### Những khác biệt cố ý

Hai khác biệt giữa các công cụ được giữ chứ không hợp nhất, và gọi tên chúng ở
đây là thứ ngăn một người đọc về sau xếp chúng thành drift.

- **Report-trước-fix so với vá-trong-phiên.** Một công cụ báo cáo finding và để
  việc sửa cho chủ object; công cụ khác vá ngay trong lượt chạy. Đó là thuộc tính
  của object — ai được phép đổi nó, và người chạy có được phép đổi hay không —
  chứ không phải bất đồng về phán xét.
- **Tên các protocol level.** Mỗi công cụ tự đặt tên các mức của nó cho object
  của nó. Luật 12 và bước 2 của Phần II nói "mức mà công cụ chỉ định", không bao
  giờ gọi một mức bằng tên, chính là để các tên được phép khác nhau.

---

## PHẦN II — THỦ TỤC CỦA MỘT LƯỢT CHẠY

1. **Gate trước.** Chạy các kiểm tra tất định trước khi phán xét bất cứ thứ gì.
   Một gate đỏ là finding của máy, không phải của lượt chạy, và một bản review mở
   ra trên gate đỏ đang phán xét một trạng thái đã biết là hỏng. Một bộ gate xanh
   là nơi review _bắt đầu_. Nơi một object không có gate, bước đầu tương đương là
   kiểm chứng các khẳng định về cơ chế mà object tự nói về mình.

2. **Khai protocol level trong report.** Mức quyết định lượt chạy nợ những phase
   nào. Một lượt không khai mức thì không audit được là đã bỏ phase nào, khiến
   mọi "không có finding" bên trong nó thành không falsifiable. Hạ mức giữa chừng
   được phép; làm âm thầm thì không.

3. **Các phase theo thứ tự, mỗi phase mù với lớp lỗi mà phase sau bắt.** Thứ tự
   là chịu lực chứ không phải thủ tục hành chính: gộp hai phase là xóa đúng lớp
   lỗi mà phase bị gộp sở hữu.

4. **Một phase kết bằng bảng bằng chứng, không bao giờ bằng một dòng verdict.**
   Một phase không tìm thấy gì là một kết quả và phải được ghi xuống — việc xoay
   phương pháp phụ thuộc vào chỗ biết được phương pháp nào đã về không.

5. **Kiểm chứng mọi thứ còn sống trước khi viết.** Một nghi ngờ chết ở khâu kiểm
   chứng được ghi là WITHDRAWN kèm thứ đã giết nó: không bao giờ bị bỏ âm thầm,
   và cũng không bao giờ được báo cáo chỉ vì đã tốn công điều tra.

6. **Mỗi full run một phép dò mà object chưa từng đối mặt.** Nếu không nghĩ ra
   được, chính sự bất lực đó là finding của lượt chạy về trần của chính nó, và
   được viết ra như một finding.

7. **Đếm số là thao tác cuối cùng.** Mọi tổng số được tính lại bằng script sau
   patch cuối, kèm phép tính được ghi lại để lượt sau dựng lại được. Một con số
   vá giữa lượt là một lỗi người đọc kế tiếp thừa kế.

8. **Toạ độ giai thoại nằm ngoài hiện vật.** Lịch sử một lượt chạy — các vòng
   lặp, các phase, thứ đã chết — thuộc về report, pull request, hoặc thread. Hiện
   vật ghi cơ chế và lý do của chúng, để một người đọc không có mặt vẫn kiểm
   được.

9. **Một lượt chạy xong khi** mức đã được khai và mọi phase mức đó nợ đều có bằng
   chứng; mọi finding có verdict, severity, và trích dẫn hoặc cách tái hiện; mọi
   nghi ngờ đã rút được ghi lại; mọi tiêu chí mà lượt chạy phải bịa ra đã nằm
   trong rubric ngay trong thay đổi này; và các gate xanh trở lại sau patch cuối.
   Thiếu bất cứ thứ gì thì lượt chạy tự báo cáo là **chưa xong** — không bao giờ
   là một verdict.

10. **Một lượt chạy hạng đóng băng cần người đọc mới.** Tự chấm là một điểm mù
    thường trú, và lượt cuối trước khi đóng băng phải do người không viết object
    chạy, chỉ với object và công cụ.

11. **Run report** ghi finding theo phase, theo severity, và theo **nguồn phát
    hiện**; phương pháp nào đã về không và về mấy lần; và tiêu chí nào chưa từng
    bắt được gì nên đến hạn xem lại. Nơi một report phủ nhiều hơn một công cụ,
    luật 3 áp: mỗi con đếm mang tên công cụ của nó.

---

## PHẦN III — SINH RUBRIC CHO MỘT OBJECT MỚI

Các luật và thủ tục đã có sẵn. Phần này sản xuất đúng thứ một object không thừa
kế được: bộ tiêu chí của nó.

1. **Kiểm kê object, dẫn xuất chứ không nhớ lại** — từ cây thư mục, từ graph,
   hoặc từ chính hồ sơ. Một danh sách nhớ ra là danh sách của object cuối cùng
   bạn đọc.

2. **Thu hoạch claim.** Mỗi "phải / không bao giờ / luôn luôn / duy nhất / đúng
   một" thành hai câu hỏi: ai sở hữu nó, và bây giờ nó còn đúng không.

3. **Invariant xuyên file.** So sibling với sibling — một lỗi vô hình bên trong
   một file trở nên hiển nhiên khi đặt cạnh peer của nó.

4. **Tổ chức tiêu chí theo chín trục**, instantiate câu hỏi của từng trục cho
   object:

| Trục                    | Câu hỏi phổ quát                                                                                                                                                            | Lớp lỗi trục này bắt                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. Sự thật tham chiếu   | Mọi claim có kiểm được từ nguồn bởi một người đọc không có mặt không?                                                                                                       | Một claim chỉ đúng với người đã viết ra nó                      |
| 2. Sự thật cưỡng chế    | Lớp cưỡng chế có lớn đúng như nó tuyên bố, và phần dư không được cưỡng chế có được khai không?                                                                              | Một điều ước bị đọc thành một bảo đảm                           |
| 3. Trung thành với trần | Thứ này có khớp thứ đã khai ở thượng nguồn, truy cả hai chiều không?                                                                                                        | Một cú rẽ nhánh âm thầm giữa thứ đã hứa và thứ đã xây           |
| 4. Độ phủ lời hứa       | Mọi lời hứa có trọng tài không, và suite có với tới xa như lần đóng băng không?                                                                                             | Một lời hứa không gì bác được                                   |
| 5. Toàn vẹn biên        | Có gì với được tới chỗ mà cấu trúc đã khai nói là không thể không?                                                                                                          | Một biên chỉ giữ bằng thói quen                                 |
| 6. Sống sót ở end-state | Nó có đúng ở end-state không, và mọi giai đoạn vòng đời đã có nhà chưa?                                                                                                     | Một giai đoạn không ai sở hữu cho tới lúc nó tới                |
| 7. An toàn              | Điều tồi tệ nhất có bị chặn bằng cấu trúc thay vì bằng lời dặn không?                                                                                                       | Một hiểm hoạ được canh bằng một câu văn                         |
| 8. Vệ sinh quyết định   | Việc chưa xong có kêu to không, non-goal có được gọi tên không, câu hỏi mở có chủ không — và mỗi quyết định có thắng cuộc đối kháng với phương án mạnh nhất được nêu không? | Một quyết định chưa từng bị thách thức, được bảo vệ bằng effort |
| 9. Tỷ lệ                | Bộ máy quản trị có đáng với thứ nó quản không?                                                                                                                              | Nghi thức đã lớn vượt object của nó                             |

**Một trục giành được chỗ của nó nhờ ít nhất hai công cụ độc lập**, và đây là
nghĩa vụ ở thời điểm rubric được sinh ra chứ không phải một thuộc tính phải chứng
minh lại sau: một trục mà chỉ một công cụ từng cần là nhóm tiêu chí riêng của
công cụ đó và ở lại đó. Bằng chứng — công cụ nào đóng góp trục nào — thuộc về
report của lượt chạy đã sinh ra bảng, không thuộc tài liệu này. Xuất xứ mang bên
trong hiện vật là một toạ độ giai thoại, và lần sinh bảng kế tiếp sẽ phải mang
hai bộ.

5. **Viết mỗi tiêu chí như một đòn tấn công**, không bao giờ như một khẳng định.
   Một tiêu chí là một phép dò cố làm giả một lời hứa của object.

6. **Cho mỗi nhóm một câu hỏi tinh thần**, làm chốt chống Goodhart: nếu mọi tiêu
   chí pass mà câu hỏi vẫn lung lay thì kết quả là `tension` (luật 10).

7. **Khai bảng điểm mù của chính rubric**, kèm thứ đã cài chống lại từng cái. Một
   rubric không khai điểm mù nào là đang tuyên bố sự hoàn chỉnh mà luật 8 cấm.

8. **Chạy phép kiểm tỷ lệ sau cùng**, trước khi rubric ra đời: một object đủ hiếm
   có thể xứng với một rubric sống trong thread thay vì trong một file.

9. **Đóng vòng hồi tiếp miễn dịch** — rubric ra đời với hiểu biết rằng finding kế
   tiếp của nó có thể viết lại nó (luật 8).

---

## PHẦN IV — ĐIỂM MÙ CỦA CHÍNH TÀI LIỆU NÀY

Khai theo bước 7 của Phần III, thứ tài liệu này không thể đòi ở người khác rồi bỏ
qua cho mình.

| Điểm mù                                                                                                                 | Thứ đã cài chống lại nó                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tự chấm** — các luật bị phán xét bởi chính những công cụ chúng quản, do chính người viết những công cụ đó viết ra     | Bước 10 của Phần II: lượt chạy có trọng lượng phải do người không viết object chạy. Proposal kế tiếp sau bản này chạy chín trục của Phần III lên chính tài liệu này |
| **Dẫn xuất từ ba công cụ** — dạng khai ở đây là dạng mà ba công cụ ấy tình cờ chia nhau, không phải dạng của phán xét   | Luật 8 với tới tài liệu này: một luật mà một công cụ buộc phải bịa ra thì thuộc về đây, ngay trong thay đổi đã bịa ra nó                                            |
| **Ranh giới dạng/nội dung là một phán đoán** — không có gì máy móc quyết được một rule là dạng chung hay nội dung riêng | Khai thẳng thay vì giấu. Một chỗ đặt còn tranh cãi là một verdict `tension` (luật 10), không bao giờ do người vừa dời văn bản tự quyết                              |
| **Tính không-so-sánh-được được khai chứ không được cưỡng chế** — không gì ngăn một report cộng blocker của hai công cụ  | Luật 3 buộc mỗi con đếm mang tên công cụ, nên một con đếm không tên hiện rõ là một report chưa xong chứ không phải một tổng hợp lý                                  |
| **Luật một bản sao chỉ được giữ bằng review** — không kiểm tra tự động nào đọc tài liệu này đối chiếu các công cụ       | Ghi ở đây, để một bộ gate xanh không bao giờ bị đọc thành bằng chứng rằng các bản sao đã được gỡ                                                                    |
