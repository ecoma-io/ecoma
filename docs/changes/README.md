# Changes

> **Phạm vi:** Change Specification — đặc tả future target cho một thay đổi introduce/evolve/retire, hai promotion (horizon promotion, canonical promotion), material change, impact classes và quy tắc revalidation khi baseline dịch chuyển.
>
> **Không thuộc tài liệu này:** canonical baseline → bốn view tri thức ([`../README.md`](../README.md)) và ADR đã accept · công việc, Milestone, portfolio → [`../engineering/work-management.md`](../engineering/work-management.md) §3–§4 (Project, Milestone) · trạng thái năng lực → [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5 (trạng thái năng lực) · so sánh target với thực tế → [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §8.1 (reconciliation).

## 1. Mục đích

Change Specification trả lời một câu hỏi mà Issue và Milestone không trả lời: **một thay đổi lớn sẽ đưa hệ thống tới target model nào, dựng trên baseline nào, và cần gì để trở thành canonical.**

Một thay đổi cần Change Specification khi thoả **bất kỳ** mục sau: (1) introduce hoặc retire một bounded context, application, contract dùng chung hay thư viện dùng chung; (2) dịch ownership hoặc trách nhiệm giữa các context; (3) đổi contract/library dùng chung mà nhiều consumer đang phụ thuộc; (4) thiết kế phải giữ ổn định cho nhiều delivery unit hoặc nhiều pipeline cùng hiện thực. Mọi thay đổi còn lại — kể cả feature nhỏ có phạm vi rõ — đi thẳng Delivery hoặc Modelling tại tài liệu canonical; nghĩa vụ cập nhật canonical trong cùng logical change giữ nguyên (quy tắc mâu thuẫn tài liệu canonical — [`../AGENTS.md`](../AGENTS.md) §12). Câu hỏi quyết khi lưỡng lệ: hai PR sau này có cần cùng một target model ổn định để đối chiếu không — không thì không cần spec. Một spec được viết cho thay đổi không thoả mục nào trong (1)–(4) là một finding (overengineering).

Hai ranh giới cố hữu:

- **Design-ahead, không phải baseline.** Baseline có thẩm quyền (authoritative baseline) là tài liệu canonical của bốn view cộng accepted ADRs. Một spec được merge nghĩa là được **accept làm design input**, chưa phải thay đổi baseline; baseline chỉ đổi qua canonical promotion (§3). Trạng thái năng lực (`Specified`…) không bao giờ suy ra từ một Change Specification ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5).
- **Đối lập với [`../features/README.md`](../features/README.md) theo bằng chứng implementation.** Feature mô tả capability mà repository **đang có implementation**, kèm bằng chứng; Change Specification mô tả target chưa có bằng chứng đó. Hai hành vi chuyển tiếp bị tách rời: khi một phần scope của spec đã có implementation evidence và tự đứng được thành một capability hữu ích, Feature document cho phần đó được tạo hoặc cập nhật — mô tả cái đã tồn tại, ghi phần còn lại vào mục loại trừ — mà **không** promotion spec; canonical promotion (§4) vẫn là hành vi duy nhất đổi baseline canonical. Cấm tạo Feature document mô tả một target chưa có implementation evidence.

## 2. Changes không phải gì

- **Không phải backlog, roadmap hay status dashboard.** Công việc thuộc GitHub Issue và Milestone ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §4); catalog bounded context thuộc [`../domains/README.md`](../domains/README.md).
- **Spec không mang trạng thái.** Không lifecycle status, không marker M1/M2, không progress, không danh sách Issue/PR — vòng đời artifact do [`../AGENTS.md`](../AGENTS.md) §9 quy định. Dấu kết thúc duy nhất là **một dòng terminal marker** (supersession/withdrawal), chỉ thêm khi impact class là Superseded hoặc Withdrawn; index ở §6 mang cùng ghi chú đó. Terminal marker là disposition lưu trữ **bất biến**: ghi đúng một lần, trong cùng logical change với ghi chú index của verdict (§4), và không được viết lại hay gỡ bỏ về sau.
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
| **Ordering constraint**      | Hai promotion là hai quyết định độc lập, không tự động kéo nhau: nâng Milestone M2 lên M1 không promotion spec, và delivery một phần không promotion — quy tắc promotion → §4.                                                                                                                                                                                                                                                    |
| **Accepted target decision** | Quyết định đã chốt trong phạm vi target của một spec; ở lại spec, chỉ ràng buộc spec đó và các delivery unit được khai báo phụ thuộc tường minh; không là baseline toàn repository theo mặc định và không cho phép suy ra `Specified`.                                                                                                                                                                                            |
| **Dependency**               | Cạnh prerequisite **có hướng** giữa hai spec — spec phụ thuộc chờ spec được trỏ tới; direction chỉ sống ở mục Dependencies của từng spec và đồ thị phải acyclic (§4). Thứ tự index, tên file và ngày tạo không mang ý nghĩa hướng.                                                                                                                                                                                                |

Impact classes:

| Lớp            | Nghĩa                                                        | Việc phải làm                    |
| -------------- | ------------------------------------------------------------ | -------------------------------- |
| **No impact**  | Spec không phụ thuộc phần bị thay đổi.                       | Không việc gì.                   |
| **Adapt**      | Nội dung spec cần cập nhật; baseline không đổi.              | Owner cập nhật spec.             |
| **Rebase**     | Chính baseline đã dịch; spec phải suy lại trên baseline mới. | Owner re-derive spec.            |
| **Blocked**    | Không thể tiếp tục đến khi thay đổi kích hoạt được xử lý.    | Ghi follow-up; chờ mở khoá.      |
| **Superseded** | Quyết định/spec khác thay thế spec này.                      | Terminal marker + ghi chú index. |
| **Withdrawn**  | Owner rút lại spec.                                          | Terminal marker + ghi chú index. |

Sáu impact class và hai giá trị terminal (`Superseded`, `Withdrawn`) là **closed vocabulary**: không tồn tại trạng thái `Promoted`, không tồn tại lớp thứ bảy — khi canonical promotion hoàn tất, spec bị **xoá** theo §4 chứ không mang thêm marker nào.

**Ba trạng thái của quyết định thuộc một spec.** Một quyết định của spec ở một trong ba trạng thái: **open** — chưa chốt, nằm ở mục Decisions; **accepted target** — đã chốt trong phạm vi target của spec, ở lại spec, chỉ ràng buộc spec này và các delivery unit theo nó, không bao giờ là baseline và không bao giờ cho phép suy ra `Specified` ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5.1); **accepted canonical** — được ghi tại ADR hoặc tài liệu canonical, hiệu lực theo phạm vi chính nó ghi. Hoàn tất modelling **không** đưa quyết định lên canonical.

**Phạm vi ràng buộc là tường minh, không mặc định.** accepted target decision chỉ ràng buộc spec của nó và các delivery unit được khai báo phụ thuộc tường minh trong work record — một delivery unit M1 tiêu thụ accepted target decision của một spec M2 phải khai báo dependency đó, không bao giờ tiêu thụ im lặng (§4). Công việc delivery không liên quan — kể cả cùng product hay cùng Milestone — giữ nguyên baseline canonical hiện hành và ADR đã accept; quyết định của một spec không bao giờ trở thành baseline toàn repository theo mặc định.

Một quyết định của spec chỉ được ghi canonical trước canonical promotion khi nó thay đổi baseline hiện hành ngay: đổi một invariant đang có hiệu lực, đổi behaviour đang chạy, đổi data ownership, hoặc đổi một shared contract đang được tiêu thụ. Quyết định như vậy là quyết định hiện hành bất kể spec nào phát hiện ra nó; thời điểm ghi là trước, hoặc trong cùng logical change với, thay đổi đầu tiên phụ thuộc vào nó; ADR ghi theo [`../AGENTS.md`](../AGENTS.md) §10 và spec đối chiếu nó ở Baseline references. Việc chờ canonical promotion không phải lý do trì hoãn — promotion atomic không được dùng để đẩy một quyết định hiện hành sang sau. Mọi quyết định còn lại lên canonical tại canonical promotion (§4).

## 4. Impact & revalidation

- **Kích hoạt:** một material change (§3) được merge hoặc accept thì phải đánh giá tác động lên các Change Specification phụ thuộc.
- **Tìm spec phụ thuộc:** liệt kê trên các dòng **active** của index §6 (dòng không mang terminal marker; dòng archive không tham gia assessment — §6), rồi đọc mục Baseline references và Dependencies của từng spec active.
- **Ghi verdict:** một trong sáu impact classes, ghi tại triggering Issue và owning root issue của spec phụ thuộc — không bao giờ ghi trong spec.
- **Verdict Superseded/Withdrawn ràng buộc terminal marker:** khi verdict là Superseded hoặc Withdrawn, owner thêm dòng terminal marker tương ứng vào spec và ghi chú index trong **cùng logical change** với verdict ghi trên Issue — verdict sống trên Issue, marker sống trên spec, hai bản ghi này không được tách rời.
- **Owner + follow-up bắt buộc** với mọi verdict khác No impact.
- **Không cascade:** chỉ đánh giá lại các spec chịu tác động; không revalidation diện rộng các package không liên quan.

**Trách nhiệm và thời điểm assessment.** Tác giả/owner của material change kích hoạt chịu trách nhiệm chạy assessment; spec owner chỉ phản hồi verdict. Assessment chạy **sau** khi thay đổi được accept/merge, trong bước reconciliation, trước khi work item kích hoạt được đóng completed ([`../engineering/work-management.md`](../engineering/work-management.md) §2.6, [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §6.7). Trigger không có Issue thì chính PR kích hoạt là trigger record. Trước merge, tác giả PR được ghi chú dependency nghi ngờ làm ngữ cảnh review, nhưng không được trình bày một proposal chưa accept như verdict đã accept. Quy trình bất biến: (1) liệt kê spec từ các dòng active của index (§6); (2) với mỗi ứng viên, đọc Baseline references và Dependencies; (3) ghi lý do giữ hoặc loại từng ứng viên; (4) resolve owning root issue — không có owner hoặc nhiều hơn một owner thì dừng và escalation (§4 Owning root issue); (5) kiểm tra cycle trên đồ thị dependency của các spec bị tác động (quy tắc dependency dưới); (6) mỗi spec bị tác động nhận đúng một impact class kèm why/why-not; (7) verdict ghi trên triggering record và owning root issue của spec — không bao giờ trong nội dung spec; (8) mọi verdict khác No impact kèm owner + follow-up; (9) không cascade.

**Delivery một phần không promotion.** Một delivery unit hiện thực một phần scope của spec đã accept thì: (a) không tạo canonical promotion và không phát sinh nghĩa vụ cập nhật canonical theo từng slice; (b) phần ghi canonical duy nhất còn nợ tại thời điểm slice là các quyết định hiện hành theo quy tắc ở §3; (c) khác biệt giữa thực tế đã deliver và baseline canonical được gọi đúng tên theo từ vựng reconciliation ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §8.1–§8.2) và khi cần follow-up thì follow-up phải đủ bốn thành phần — **owner**, **action**, **điều kiện kích hoạt** (sự kiện nào mở lại việc) và **điều kiện hoàn tất kiểm được**; follow-up sống trên work record (Issue), không sống trong spec; (d) delivery một phần không được âm thầm đổi baseline mà các delivery pipeline không liên quan đang tiêu thụ; (e) canonical promotion xảy ra đúng một lần, atomic, khi toàn bộ scope của spec và điều kiện accept/promotion ở §10 của spec thoả — checklist hoàn tất ở khối dưới. Tài liệu canonical không được mâu thuẫn vĩnh viễn với thực tế đã accept ([`../AGENTS.md`](../AGENTS.md) §12).

**Canonical promotion — điều kiện hoàn tất.** Promotion là atomic ở phạm vi một spec: toàn bộ checklist dưới đây nằm trong cùng một logical change, không để spec ở trạng thái nửa canonical.

- cập nhật mọi tài liệu canonical chịu tác động trong view của chúng;
- viết mọi ADR mà [`../AGENTS.md`](../AGENTS.md) §10 yêu cầu;
- cập nhật domains catalog và context map **chỉ khi** Affected scope của spec introduce/retire/đổi quan hệ giữa các domain — không cập nhật vì lý do khác;
- đối chiếu mọi accepted target decision với baseline hiện hành theo khối mâu thuẫn dưới đây;
- bảo toàn lịch sử qua ADR supersession, không xoá quyết định đã accept;
- xoá file spec **và** gỡ dòng index active của nó trong cùng logical change; cập nhật owning root issue sao cho không còn gì trỏ tới spec đã xoá;
- không để lại link hỏng nào còn coi spec là active.

Canonical promotion không tạo hay sửa Milestone — promotion là thay đổi tài liệu, không phải thay đổi cấu hình GitHub ([`../engineering/work-management.md`](../engineering/work-management.md) §4.1). Nâng Milestone M2 lên M1 là horizon promotion, không promotion spec nào (§3 Ordering constraint).

**Mâu thuẫn tại canonical promotion.** Tại canonical promotion, mọi accepted target decision được đối chiếu lại baseline hiện hành. Quyết định mâu thuẫn với quyết định canonical đã accept sau khi spec được merge thì không được promotion nguyên trạng: ghi ADR mới supersede theo [`../AGENTS.md`](../AGENTS.md) §10, hoặc sửa quyết định trong spec. Baseline dịch chuyển trong lúc spec còn mở được xử lý theo impact classes ở §3 — Rebase hoặc Superseded — trước khi promotion.

**Dependency giữa các spec.** Direction chỉ được ghi ở mục Dependencies của từng spec (theo [`_template.md`](./_template.md) §6) — thứ tự dòng index, thứ tự tên file và ngày tạo không mang ý nghĩa hướng. Spec owner kiểm tra tính acyclic của đồ thị dependency mỗi khi tạo hoặc thay đổi Dependencies. Cycle bị phát hiện là modelling defect chặn delivery và chỉ xử lý được bằng: (1) gộp các thay đổi vào một spec — một target model thống nhất, một owning root issue; (2) tách tại ranh giới ownership/contract để các spec có dependency một chiều tường minh; hoặc (3) escalation. Agent không giải cycle bằng cách tự đoán thứ tự. Không tạo registry dependency mới — mục Dependencies của từng spec là nơi ghi duy nhất.

**Owning root issue.** Mỗi spec đang active có đúng **một** owning root issue, và ownership nằm một chiều: body của root issue tham chiếu spec bằng đường dẫn chính xác (ghi qua trường `change-spec` của Issue form khi tạo). Sub-issue tham chiếu được nhưng không co-own. Kiểm tra ownership: liệt kê các spec **active** từ index §6 (dòng không mang terminal marker — §6), tìm đường dẫn mỗi spec trong các root issue đang mở — đúng một kết quả là owner; không có kết quả là escalation "no reachable owner"; nhiều kết quả là lệch: báo coordinator, không tự chọn; việc khôi phục ownership (sửa body root issue) là quyết định của coordinator hoặc owner issue đó. Spec không chứa danh sách Issue và không lưu trạng thái mutable.

## 5. Quy tắc catalog

Một spec introduce bounded context mới (pending introduce) chỉ được index tại đây, không vào catalog của [`../domains/README.md`](../domains/README.md) — catalog chỉ liệt kê context đã qua canonical promotion.

## 6. Index

Chưa có Change Specification nào. Mỗi spec mới được thêm vào danh sách này trong cùng thay đổi với file của nó: tên file (kebab-case mô tả thay đổi), một dòng mô tả, và terminal marker nếu có.

Đổi tên một spec phải cập nhật dòng index và đường dẫn trong body của owning root issue trong cùng thay đổi; index §6 là nguồn liệt kê để kiểm tra ownership (§4). Xoá spec qua canonical promotion cũng vậy: gỡ dòng index active và cập nhật owning root issue trong cùng logical change với việc xoá file spec, sau khi nội dung còn canonical đã chuyển vào các view ([`../AGENTS.md`](../AGENTS.md) §6) — quy tắc đầy đủ ở §4.

**Active và archive.** Dòng index **không** mang terminal marker là **active**; dòng mang terminal marker là lưu trữ lịch sử — không tham gia bất kỳ kiểm tra ownership hay assessment active nào, không là chỉ dẫn delivery cho unit mới (§4). Spec Superseded/Withdrawn không được delivery unit mới theo sau.

Cấu trúc bắt buộc của một spec → [`_template.md`](./_template.md).
