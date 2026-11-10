# Changes

> **Phạm vi:** Change Specification — đặc tả future target cho một thay đổi introduce/evolve/retire, hai promotion (horizon promotion, canonical promotion), material change, impact classes và quy tắc revalidation khi baseline dịch chuyển.
>
> **Không thuộc tài liệu này:** canonical baseline → bốn view tri thức ([`../README.md`](../README.md)) và ADR đã accept · công việc, Milestone, portfolio → [`../engineering/work-management.md`](../engineering/work-management.md) §3–§4 (Project, Milestone) · trạng thái năng lực → [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5 (trạng thái năng lực) · so sánh target với thực tế → [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §8.1 (reconciliation).

## 1. Mục đích

Change Specification trả lời một câu hỏi mà Issue và Milestone không trả lời: **một thay đổi lớn sẽ đưa hệ thống tới target model nào, dựng trên baseline nào, và cần gì để trở thành canonical.**

Một thay đổi cần Change Specification khi thoả **bất kỳ** mục sau: (1) introduce hoặc retire một bounded context, application, contract dùng chung hay thư viện dùng chung; (2) dịch ownership hoặc trách nhiệm giữa các context; (3) đổi contract/library dùng chung mà nhiều consumer đang phụ thuộc; (4) thiết kế phải giữ ổn định cho nhiều delivery unit hoặc nhiều pipeline cùng hiện thực. Mọi thay đổi còn lại — kể cả feature nhỏ có phạm vi rõ — đi thẳng Delivery hoặc Modelling tại tài liệu canonical; nghĩa vụ cập nhật canonical trong cùng logical change giữ nguyên (§4). Câu hỏi quyết khi lưỡng lệ: hai PR sau này có cần cùng một target model ổn định để đối chiếu không — không thì không cần spec. Một spec được viết cho thay đổi không thoả mục nào trong (1)–(4) là một finding (overengineering).

Hai ranh giới cố hữu:

- **Design-ahead, không phải baseline.** Baseline có thẩm quyền (authoritative baseline) là tài liệu canonical của bốn view cộng accepted ADRs. Một spec được merge nghĩa là được **accept làm design input**, chưa phải thay đổi baseline; baseline chỉ đổi qua canonical promotion (§3). Trạng thái năng lực (`Specified`…) không bao giờ suy ra từ một Change Specification ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5).
- **Đối lập với [`../features/README.md`](../features/README.md).** Feature mô tả capability mà repository **đang có implementation**, kèm bằng chứng; Change Specification mô tả target **chưa tồn tại**. Một capability đi từ spec sang Feature qua canonical promotion và delivery — không qua việc sửa status.

## 2. Changes không phải gì

- **Không phải backlog, roadmap hay status dashboard.** Công việc thuộc GitHub Issue và Milestone ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §4); catalog bounded context thuộc [`../domains/README.md`](../domains/README.md).
- **Spec không mang trạng thái.** Không lifecycle status, không marker M1/M2, không progress, không danh sách Issue/PR — vòng đời artifact do [`../AGENTS.md`](../AGENTS.md) §9 quy định. Dấu kết thúc duy nhất là **một dòng terminal marker** (supersession/withdrawal), chỉ thêm khi impact class là Superseded hoặc Withdrawn; index ở §6 mang cùng ghi chú đó.
- **Quyết định phân theo ba trạng thái, không phải hai.** Quyết định kiến trúc đã accept canonical nằm trong ADR ([`../AGENTS.md`](../AGENTS.md) §10) hoặc tài liệu canonical; quyết định đã chốt trong phạm vi target của spec là **accepted target decision** — ở lại spec cho tới canonical promotion; quyết định còn mở nằm trong mục Decisions của spec đó. Ba trạng thái này → §3.

## 3. Từ vựng

| Thuật ngữ                    | Nghĩa                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Change type**              | `introduce` / `evolve` / `retire` — thuộc tính của **từng mục** trong Affected scope, không phải field của GitHub hay của cả spec.                                                                                                                                                                                                                                                                                                |
| **Horizon promotion**        | Đưa một thay đổi lên cam kết portfolio: Feature Discovery → M2 → M1. Điều kiện readiness: scope committable, có owner, có evidence; procedure và mechanics Milestone thuộc [`../engineering/work-management.md`](../engineering/work-management.md) §4; horizon promotion được thể hiện bằng khai báo Milestone theo [`../engineering/work-management.md`](../engineering/work-management.md) §4.1, không bằng marker trong spec. |
| **Canonical promotion**      | Nội dung spec trở thành canonical: cập nhật tài liệu của bốn view, viết ADR khi [`../AGENTS.md`](../AGENTS.md) §10 yêu cầu, cập nhật domains catalog và context map, rồi retire spec theo [`../AGENTS.md`](../AGENTS.md) §6.                                                                                                                                                                                                      |
| **Impact class**             | Hiệu quả của một material change **lên một Change Specification phụ thuộc** — sáu lớp trong bảng dưới. Trục khác với reconciliation classes khi so target với thực tế ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §8.1).                                                                                                                                                                        |
| **Material change**          | Thay đổi kích hoạt impact assessment: đổi canonical baseline hiện hành, đổi quyết định đã accept, đổi scope của Milestone đã cam kết, hoặc đổi contract/library/bounded context dùng chung.                                                                                                                                                                                                                                       |
| **Authoritative baseline**   | Tài liệu canonical của bốn view cộng accepted ADRs — không bao giờ là một Change Specification.                                                                                                                                                                                                                                                                                                                                   |
| **Ordering constraint**      | Hai promotion là hai quyết định độc lập, không tự động kéo nhau; nghĩa vụ đi kèm delivery đầu tiên → §4.                                                                                                                                                                                                                                                                                                                          |
| **Accepted target decision** | Quyết định đã chốt trong phạm vi target của một spec; ở lại spec, chỉ ràng buộc spec đó và các delivery unit của nó; không là baseline và không cho phép suy ra `Specified`.                                                                                                                                                                                                                                                      |

Impact classes:

| Lớp            | Nghĩa                                                        | Việc phải làm                    |
| -------------- | ------------------------------------------------------------ | -------------------------------- |
| **No impact**  | Spec không phụ thuộc phần bị thay đổi.                       | Không việc gì.                   |
| **Adapt**      | Nội dung spec cần cập nhật; baseline không đổi.              | Owner cập nhật spec.             |
| **Rebase**     | Chính baseline đã dịch; spec phải suy lại trên baseline mới. | Owner re-derive spec.            |
| **Blocked**    | Không thể tiếp tục đến khi thay đổi kích hoạt được xử lý.    | Ghi follow-up; chờ mở khoá.      |
| **Superseded** | Quyết định/spec khác thay thế spec này.                      | Terminal marker + ghi chú index. |
| **Withdrawn**  | Owner rút lại spec.                                          | Terminal marker + ghi chú index. |

**Ba trạng thái của quyết định thuộc một spec.** Một quyết định của spec ở một trong ba trạng thái: **open** — chưa chốt, nằm ở mục Decisions; **accepted target** — đã chốt trong phạm vi target của spec, ở lại spec, chỉ ràng buộc spec này và các delivery unit theo nó, không bao giờ là baseline và không bao giờ cho phép suy ra `Specified` ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5.1); **accepted canonical** — được ghi tại ADR hoặc tài liệu canonical, hiệu lực theo phạm vi chính nó ghi. Hoàn tất modelling **không** đưa quyết định lên canonical.

Một quyết định của spec chỉ được ghi canonical trước canonical promotion khi và chỉ khi nó có hiệu lực lên baseline hiện hành ngay — đổi hành vi đang chạy, đóng băng một vùng, hoặc bắt đầu chuỗi expand/contract. Quyết định như vậy là quyết định hiện hành bất kể spec nào phát hiện ra nó; ADR ghi theo [`../AGENTS.md`](../AGENTS.md) §10 và spec đối chiếu nó ở Baseline references. Mọi quyết định còn lại lên canonical tại canonical promotion.

## 4. Impact & revalidation

- **Kích hoạt:** một material change (§3) được merge hoặc accept thì phải đánh giá tác động lên các Change Specification phụ thuộc.
- **Tìm spec phụ thuộc:** qua mục Baseline references và Dependencies của từng spec khác.
- **Ghi verdict:** một trong sáu impact classes, ghi tại triggering Issue và owning root issue của spec phụ thuộc — không bao giờ ghi trong spec.
- **Verdict Superseded/Withdrawn ràng buộc terminal marker:** khi verdict là Superseded hoặc Withdrawn, owner thêm dòng terminal marker tương ứng vào spec và ghi chú index trong **cùng logical change** với verdict ghi trên Issue — verdict sống trên Issue, marker sống trên spec, hai bản ghi này không được tách rời.
- **Owner + follow-up bắt buộc** với mọi verdict khác No impact.
- **Không cascade:** chỉ đánh giá lại các spec chịu tác động; không revalidation diện rộng các package không liên quan.

**Nghĩa vụ canonical promotion của delivery đầu tiên.** Khi hành vi đầu tiên của một spec đã accept xuất hiện trong hệ thống, thay đổi đó phải kèm một trong hai: cập nhật tài liệu canonical chịu tác động trong cùng một logical change, hoặc ghi follow-up tường minh. "Đã implement nhưng chưa canonical promotion" là trạng thái transient được theo dõi — tài liệu canonical không được mâu thuẫn vĩnh viễn với thực tế đã accept ([`../AGENTS.md`](../AGENTS.md) §12).

**Mâu thuẫn tại canonical promotion.** Tại canonical promotion, mọi accepted target decision được đối chiếu lại baseline hiện hành. Quyết định mâu thuẫn với quyết định canonical đã accept sau khi spec được merge thì không được promotion nguyên trạng: ghi ADR mới supersede theo [`../AGENTS.md`](../AGENTS.md) §10, hoặc sửa quyết định trong spec. Baseline dịch chuyển trong lúc spec còn mở được xử lý theo impact classes ở §3 — Rebase hoặc Superseded — trước khi promotion.

**Owning root issue.** Mỗi spec đang active có đúng **một** owning root issue, và ownership nằm một chiều: body của root issue tham chiếu spec bằng đường dẫn chính xác (ghi qua trường `change-spec` của Issue form khi tạo). Sub-issue tham chiếu được nhưng không co-own. Kiểm tra ownership: liệt kê các spec từ index §6, tìm đường dẫn mỗi spec trong các root issue đang mở — đúng một kết quả là owner; không có kết quả là escalation "no reachable owner"; nhiều kết quả là lệch: báo coordinator, không tự chọn; việc khôi phục ownership (sửa body root issue) là quyết định của coordinator hoặc owner issue đó. Spec không chứa danh sách Issue và không lưu trạng thái mutable.

## 5. Quy tắc catalog

Một spec introduce bounded context mới (pending introduce) chỉ được index tại đây, không vào catalog của [`../domains/README.md`](../domains/README.md) — catalog chỉ liệt kê context đã qua canonical promotion.

## 6. Index

Chưa có Change Specification nào. Mỗi spec mới được thêm vào danh sách này trong cùng thay đổi với file của nó: tên file (kebab-case mô tả thay đổi), một dòng mô tả, và terminal marker nếu có.

Đổi tên một spec phải cập nhật dòng index và đường dẫn trong body của owning root issue trong cùng thay đổi; index §6 là nguồn liệt kê để kiểm tra ownership (§4).

Cấu trúc bắt buộc của một spec → [`_template.md`](./_template.md).
