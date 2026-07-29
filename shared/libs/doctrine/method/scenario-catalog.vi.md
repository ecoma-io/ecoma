---
title: "Catalog kịch bản"
status: design-end-state
canonical-sha: dce2d8de8cda
---

# Catalog kịch bản

Một thiết kế chỉ tốt bằng những tình huống nó đã bị đem ra đối chiếu. Đây là bộ
pin đó: mỗi kịch bản là một tình huống hệ thống phải trả lời, ghép với cơ chế trả
lời nó.

Nó là một **tài sản regression**, không phải một bản ghi của một vòng review. Nó
dùng để nhìn tới: khi một cơ chế đổi, những kịch bản gọi tên cơ chế đó là những
kịch bản phải đem ra cãi lại. Một kịch bản mà cơ chế được gọi tên đã không còn tồn
tại thì hoặc là một kịch bản đã mất câu trả lời, hoặc là một cơ chế bị đổi tên mà
không ai kiểm ở đây — cả hai đều đáng tìm ra.

Mã kịch bản là ổn định. Chúng được trích dẫn từ những tài liệu khác, nên đánh số
lại sẽ làm vỡ mọi trích dẫn; một kịch bản bị rút giữ nguyên mã của nó và nói rõ
thứ gì thay thế nó.

## Bộ pin

| ID  | Tình huống                                                                                | Cơ chế trả lời                                                                                                    |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| S01 | Một webhook đến, được transform, rồi gọi một API                                          | Trigger và channel; một handoff có contract                                                                       |
| S02 | Một lịch kéo một báo cáo rồi gửi email                                                    | Một timer là một entry trong log                                                                                  |
| S03 | Một form được validate rồi ghi vào một hệ khách hàng                                      | Kiểm contract trước khi phát effect                                                                               |
| S04 | Một người làm một mình cho AI viết, rồi tự duyệt                                          | Checkpoint gánh phần chính ở cardinality bằng một                                                                 |
| S05 | Automation standalone điền một form web cho một hệ không có API                           | RPA standalone với consumer nội bộ của nó                                                                         |
| S06 | Một brief thành một bản nháp AI, một người sửa, rồi xuất bản                              | Trọn chuỗi primitive, từ đầu tới cuối                                                                             |
| S07 | Một chatbot chạm giới hạn hiểu biết và chuyển cho một người                               | Một end user là filler `external`; escalation                                                                     |
| S08 | Một hóa đơn đến qua email dạng PDF, được extract, duyệt, rồi ghi sổ                       | Extract là lao động, có một gate trước effect ghi sổ                                                              |
| S09 | Hồ sơ ứng tuyển được sàng lọc; ứng viên là một filler bên ngoài                           | Một model role duy nhất phủ cả người ngoài tổ chức                                                                |
| S10 | Onboarding chạy song song automation, một người và một quản lý                            | Các task song song dưới một process                                                                               |
| S11 | Một AI writer chạy shadow sau một người, rồi tốt nghiệp                                   | Shadow mode và các trust tier                                                                                     |
| S12 | Một người mới chạy shadow sau một process AI để học nghề                                  | Shadow mode, theo chiều ngược lại                                                                                 |
| S13 | Một cuộc hoàn tiền dùng policy nội bộ nhưng trả lời công khai                             | Classification lattice và egress gate                                                                             |
| S14 | Một cuộc đàm phán nhiều vòng có pháp lý và provisioning                                   | Trạng thái durable xuyên nhiều tuần                                                                               |
| S15 | Một agent phân rã một trang thành các subtask, hai trong số đó cho người                  | Dynamic spawning: một agent giao việc cho một người                                                               |
| S16 | Một nhà cung cấp model sập giữa năm mươi task đang chạy                                   | Escalation có correlation thay vì năm mươi escalation rời                                                         |
| S17 | Một process đã chạy ba tuần bị migrate                                                    | Pin cộng migration tường minh                                                                                     |
| S18 | Một block được cài, criteria của nó fork ra, rồi nhận một thay đổi từ upstream            | Phân phối block có lineage                                                                                        |
| S19 | Một cuộc audit hỏi ai duyệt, dựa trên tri thức nào, với model nào                         | Provenance xuyên judgment, knowledge và filler identity                                                           |
| S20 | Một người nghỉ đột ngột với mười hai task đang treo                                       | Trạng thái durable và độc lập với trí nhớ của bất kỳ ai                                                           |
| S21 | Hai process đua nhau ghi cùng một record                                                  | Serialization key và Lease                                                                                        |
| S22 | Một prompt injection đòi hệ xuất toàn bộ policy của nó                                    | Egress gate, vốn không hỏi ý model                                                                                |
| S23 | Một máy bị tắt giữa phiên, sau khi đã qua một commit point                                | Interruption với một trạng thái mà evidence chứng minh được — không bao giờ tự chạy lại                           |
| S24 | Một chatbot bị dội một nghìn tin nhắn mỗi phút                                            | Storm control cho sự chú ý                                                                                        |
| S25 | Một block giấu một action irreversible mà nó không khai                                   | Phân tích lại lúc cài: reject, không phải cảnh báo                                                                |
| S26 | Publisher của một block trả phí phá sản                                                   | Entitlement chỉ kiểm ở phân phối; thứ đã cài vẫn chạy                                                             |
| S27 | Một khách hàng trong một cuộc chat đòi được xóa                                           | Crypto-shredding, hòa giải với một log append-only                                                                |
| S28 | "AI không bao giờ được tự gửi email cho một khách hàng lớn"                               | Một criterion cộng policy, không cần một ngoại lệ trong engine                                                    |
| S29 | Hai bộ phận cùng sửa một contract dùng chung                                              | Version hóa contract với pin theo từng entity                                                                     |
| S30 | Một cài đặt self-host mất điện với hai trăm task đang chạy                                | Replay từ log                                                                                                     |
| S31 | Một agency tách chất lượng theo từng client trong bốn mươi client                         | Chiều workspace của calibration                                                                                   |
| S32 | Hệ được dùng để xây chính nó                                                              | Pair-design chạy trên engine                                                                                      |
| S33 | Hai tenant nhập lại sau một thương vụ                                                     | Thuộc vận hành, và cố ý nằm ngoài trần                                                                            |
| S34 | Một cơ quan quản lý audit theo thời gian thực                                             | Một projection trên event log                                                                                     |
| S35 | Một role được lấp bởi một process con                                                     | `process` là một loại filler                                                                                      |
| S36 | Hai process cạnh tranh được so sánh bằng outcome                                          | Shadow mode với một process filler                                                                                |
| S37 | Một cài đặt air-gap                                                                       | Mirror bằng lệnh chuẩn; không phone-home                                                                          |
| S38 | Escalation ping-pong vô hạn                                                               | Một chuỗi tuyến tính với terminal handler bắt buộc                                                                |
| S39 | Một người tự duyệt việc của chính mình qua hai role                                       | Một reviewer role khai một filler khác với tác giả                                                                |
| S40 | Chi phí model tăng vọt giữa tháng                                                         | Metering là một projection; chi phí nhìn thấy theo từng role                                                      |
| S41 | Một khách hàng lâu năm có hồ sơ memory dày yêu cầu hoàn một khoản lớn                     | Memory scope theo party, một sàn gate, và egress gate cùng lúc                                                    |
| S42 | Một process filler lồng nhau kẹt ở hai cấp dưới                                           | Service level của chính task cha escalate; không cần cơ chế xuyên cấp                                             |
| S43 | Block riêng của một client bên trong một tenant agency nhiều workspace                    | Install scope mang chiều workspace                                                                                |
| S44 | Một phản hồi đồng bộ phải qua egress gate dưới tải                                        | Một verifier máy trong time budget; vượt thì fail chứ không âm thầm xuống cấp                                     |
| S45 | Một knowledge base kéo từ một repo và một website, rồi website bị sửa mà không báo        | Drift là một hash mismatch; gate cho nguồn web chặt hơn cho repo                                                  |
| S46 | Một node attended bị takeover từ xa khi màn hình đang hiện một secret                     | Live view là một projection của scene đã masking, không phải một stream frame                                     |
| S47 | Memory distill từ khách của một client chạm sang workspace của một client khác            | Distillation khai chiều workspace của nó, mặc định hẹp nhất                                                       |
| S48 | Một admin bootstrap tự cấp cho mình một capability                                        | Chấp nhận: chủ quyền của tenant, có audit                                                                         |
| S49 | Một publisher đẩy block của chính mình qua review để lấy badge, rồi ship code             | Một reviewer filler khác với publisher, và thu hồi là một event                                                   |
| S50 | Một khách được quên, rồi một backup từ trước đó được restore                              | Khóa nằm ngoài đường backup; escrow chịu chính lệnh shred đó                                                      |
| S51 | Người giữ một lease singleton chết sau khi đã phát một effect ra ngoài, rồi lease hết hạn | Lease thành orphaned và một terminal escalation quyết — không bao giờ tự chạy lại                                 |
| S52 | Một agent filler gọi một tool ngoài có side effect mà nó không bao giờ khai               | Hành vi bên trong một filler khác với một Task, với hai biên cứng                                                 |
| S53 | Một tenant ngừng trả tiền, bị suspend, rồi đòi export và bị purge                         | Vòng đời tenant: provision, suspend, export, purge                                                                |
| S54 | Một bản major đã migrate một schema, và migration đó hóa ra sai                           | Một down-migration đã khai, hoặc một cờ irreversible tường minh                                                   |
| S55 | Một ổ đĩa chết; backup dữ liệu nguyên vẹn và root key đã đúng luật nằm ngoài nó           | Khôi phục thảm họa bắt buộc cho khóa root và khóa tenant, với thử thách checksum lúc bootstrap                    |
| S56 | Sau một lần shred, snapshot của chính key store bị restore                                | Chỉ replica tiến-lên-trước được giữ key material; snapshot point-in-time bị cấm                                   |
| S57 | Ai đó duyệt trên một desktop attended khi máy đang offline                                | Kênh nội-máy chỉ mang điều khiển phiên; hành động lao động đi thẳng engine API                                    |
| S58 | Test một process của một tenant cần definition và fixture ở đâu đó                        | Một test run scope có nhãn bên trong chính tenant thật, không phải một tenant thứ hai                             |
| S59 | Một test run đọc thật vào hệ khách hàng bằng credential production                        | Test run scope không resolve secret production — `forbidden` phải phủ cả đọc, không chỉ ghi                       |
| S60 | Một contract khai dry run nhưng adapter không có chế độ dry-run                           | Adapter khai `supports_dry_run`; thiếu nó thì contract resolve về `forbidden`                                     |
| S61 | Một dev bên ngoài mở một thay đổi vào repo đã công bố                                     | Một đường contribution đã khai, không chỉ một cái cổng đã khai                                                    |
| S62 | Một publisher ship một block class `code` kèm suite riêng để lấy badge                    | Chỉ là bằng chứng phụ, trong một test run scope, không secret — và đường review phụ thuộc vào việc có một sandbox |
| S63 | Một test run ghi một projection, và một truy vấn production time-travel qua nó            | `run_kind` trên entry, và mọi projection khai lập trường của nó                                                   |
| S64 | Backup được giữ lâu hơn hẳn support window                                                | Retention bị chặn bởi support window, hoặc một restore path đã diễn tập                                           |
| S65 | Một bản nâng cấp phải được lùi lại sau khi cửa sổ rollback đã đóng                        | Đó là restore và replay, và thủ tục cấm gọi nó là rollback                                                        |
| S66 | Một máy attended chạy runtime mới với lớp UI cũ                                           | Một phép kiểm train nội-máy từ chối chạy, cộng một installer từ chối cả bộ                                        |
| S67 | Giữa một đợt nâng cấp cuốn chiếu, một node chạm hai server ở hai train khác nhau          | Tập protocol của fleet là giao; bỏ một protocol là một hành động toàn fleet                                       |
| S68 | Một việc bị khai là xong mà không điều kiện kết thúc nào được thỏa                        | Một board sở hữu trạng thái; nó không bao giờ sở hữu định nghĩa xong                                              |
| S69 | Một cột ưu tiên được thêm vào một board kế hoạch                                          | Thứ tự công việc đã có một nguồn; một cột gõ tay trở thành nguồn cạnh tranh và, vì gần tay nhất, sẽ thắng         |

## Dùng nó thế nào

- **Khi đổi một cơ chế**, đọc những kịch bản gọi tên nó. Nếu một trong số đó không
  còn câu trả lời, thay đổi đó là chưa xong chứ không phải đã xong.
- **Khi thêm một kịch bản**, thêm vì một tình huống thật chưa có câu trả lời ở đây,
  không phải vì một nhóm trông thưa. Một kịch bản mà không cơ chế nào trả lời được
  là entry giá trị nhất của bảng này, và nó nên nói thẳng ra như vậy thay vì bị làm
  mềm đi cho tới khi nó qua được.
- **Khi một kịch bản được trả lời bằng "thuộc vận hành, ngoài trần"**, đó là một
  câu trả lời thật chứ không phải một cách né — nhưng nó phải nói được vì sao tình
  huống đó không phải một cơ chế mà sản phẩm cam kết.
