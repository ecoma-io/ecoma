---
title: "RPA: Tự lành"
status: design-end-state
canonical-sha: 885e1ab7aaf6
---

# RPA: Tự lành

Automation hỏng khi giao diện nó điều khiển thay đổi. Câu hỏi quyết định RPA có
đáng sở hữu hay không không phải là _nó có hỏng không_, mà là **ai sửa nó** — và
câu trả lời ở đây là: chính automation sửa lấy, dưới lineage và sau những cửa
duyệt tỉ lệ với rủi ro của thứ nó chạm vào.

## Executor: hai đầu của một trục

|                            | Script                                                               | Agent                                                                                        |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Là gì                      | Chuỗi action tổng quát hoá từ action log; locator nghiêng structural | Vision model cộng intent; locator nghiêng semantic                                           |
| Chi phí và tốc độ          | Gần bằng không, nhanh                                                | Cao, chậm                                                                                    |
| Sống sót khi giao diện đổi | Kém                                                                  | Tốt                                                                                          |
| Danh tính                  | Id, version và **lineage**                                           | `(model, version, config_hash)` cộng lineage — đúng hình dạng mà Filler mang ở phía platform |

Executor của một automation là **một dial, không phải lựa chọn nhị phân**: từng
action có thể resolve qua một tầng locator khác nhau. Coi nó là lựa chọn giữa
hai sản phẩm là bắt cả automation trả giá agent cho vài bước hiếm hoi cần tới.

## Vòng healing: script → agent → script

```
script fail (locator cạn ở các tầng structural, hoặc precondition đã lệch)
  → agent tiếp quản đúng action đó: resolve theo ngữ nghĩa, thực thi theo intent
  → thành công thì phát patch: một anchor structural mới, học từ thứ vừa chạy được
  → script version mới, parent là bản cũ — lineage, tin cậy kế thừa có decay
```

**Cửa duyệt tỉ lệ theo reversibility.** Phức tạp là lựa chọn của người vận hành;
mặc định là lựa chọn an toàn.

| Lớp action được vá       | Mặc định                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Chỉ đọc, hoặc reversible | Tự áp dụng, có ghi log                                                                                               |
| Compensable              | Tự áp dụng, gắn cờ hậu kiểm                                                                                          |
| Irreversible             | **Giữ lại chờ duyệt** — là một gate đúng nghĩa khi tích hợp; là một xác nhận qua consumer cục bộ khi chạy standalone |

Khi chính việc healing thất bại — tầng semantic cũng không resolve nổi —
automation **escalate** thay vì đoán.

## Chiều ngược: distillation

Một automation chạy thuần agent nhưng chứng minh được là **lặp lại ổn định**
(cùng chuỗi action, cùng phân phối tầng-thắng qua nhiều phiên) sẽ nhận một đề
xuất compile thành script. Đó là đổi vài bậc chi phí lấy một bộ locator vẫn giữ
semantic intent làm lưới an toàn. Chấp nhận đề xuất sinh ra một script có lineage
bắt đầu từ danh tính của agent.

Hai chiều khép thành một vòng: automation **tự trưởng thành về phía rẻ**, và
**tự lùi về phía bền** khi môi trường của nó động. Không chiều nào là một cuộc di
cư ai đó phải xếp lịch.

## Version được vá phải _giành_ lấy tin cậy, không được _cấp_

- Script version mới là một danh tính mới có lineage, nên khi tích hợp nó đi qua
  trust tiers của platform **như mọi filler khác** — kế thừa calibration của cha
  kèm decay, và chạy shadow đối chiếu với cha trước, ở nơi policy đòi. Không có
  ngoại lệ "chỉ là một cái patch thôi mà", vì ngoại lệ đó chính là cách một thay
  đổi hành vi chưa ai xem lọt được vào production.
- **Decay tỉ lệ với thứ mà patch đã đổi**, một giá trị do template đặt: patch chỉ
  đổi locator mà hành vi giữ nguyên thì decay gần như bằng không; patch đổi chuỗi
  action thì decay rất lớn. So sánh shadow là một **action-log diff**, vì artifact
  mà hệ này sinh ra là log và effect, không phải một giá trị trả về.
- **Thứ đăng ký làm filler là automation**, không phải executor tại thời điểm đó.
  Giao một action từ script sang agent là hành vi _bên trong_ filler và được ghi
  làm sub-actor. Calibration bám filler đã đăng ký; thứ gì mịn hơn thì đọc
  sub-actor.
- Bản standalone giữ nguyên nguyên lý với ít nấc hơn: bảng cửa duyệt ở trên là
  toàn bộ phần tin cậy cục bộ.

## Giao diện trôi là dữ liệu, không chỉ là hư hỏng

Mỗi sự kiện healing ghi lại locator, tầng đã fail, tầng đã thắng, patch, và một
fingerprint của ứng dụng. Bản ghi đó đáng giá hơn chính lần sửa:

- **Cùng một locator heal đi heal lại** đánh dấu một phần tử bất ổn định, và nhận
  một đề xuất nâng cấp locator đó trong app profile — sửa nguyên nhân thay vì sửa
  từng triệu chứng.
- **Nhiều locator trong cùng một ứng dụng heal đồng loạt, kèm fingerprint đã
  đổi**, đánh dấu chính ứng dụng đã đổi version, và nhận một đề xuất profile
  version mới. Một lần sửa, lành mọi automation chạy ứng dụng đó.
- Khi tích hợp, những đề xuất đó vào hệ **với tư cách đề xuất**: qua vòng
  pair-design, có gate, có judgment. **Tri thức dùng chung không bao giờ bị viết
  lại lúc runtime**, vì tri thức đổi mà không ai xem là tri thức không ai chịu
  trách nhiệm được.

## Cố ý không làm

- **Không heal ngữ nghĩa nghiệp vụ.** Một biểu mẫu vừa thêm trường bắt buộc là
  một thay đổi quy trình, và nó escalate vào thiết kế chứ không được vá ở tầng
  locator. Phân biệt này không phải cầu toàn: một patch locator lặng lẽ điền cho
  xong trường bắt buộc mới là một automation đang bịa dữ liệu.
- **Không tự áp dụng patch cho action irreversible**, dưới bất kỳ cấu hình mặc
  định nào.

## Đã chốt gì, và vì sao

| Câu hỏi                | Chốt                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Script hay agent       | Hai đầu một trục trên semantic locator; giao ca theo từng action, không theo cả automation |
| Patch sinh ra gì       | Version mới có lineage; cửa duyệt tỉ lệ reversibility; irreversible luôn bị giữ            |
| Chiều ngược            | Distillation agent sang script khi hành vi đã ổn định — trục chạy cả hai chiều             |
| Tin cậy của version vá | Đi qua trust tiers của platform, không ngoại lệ                                            |
| Healing dạy được gì    | Tín hiệu trôi thành đề xuất profile qua vòng duyệt, không bao giờ là tự sửa lúc runtime    |

## Litmus

1. Có cấu hình mặc định nào mà patch cho một action irreversible được áp dụng mà
   không cần duyệt không?
2. Script vừa vá xong có được tin ngay không, hay phải đi qua trust tiers với
   decay tỉ lệ theo thứ mà patch đã đổi?
3. Healing của một tenant có đường nào chạm tới tri thức dùng chung — catalog app
   profile — mà không qua opt-in tường minh và một vòng duyệt không?
