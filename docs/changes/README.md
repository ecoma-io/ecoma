# Changes

> **Phạm vi:** Change Specification — đặc tả future target cho một thay đổi introduce/evolve/retire, hai promotion (horizon promotion, canonical promotion), material change, impact classes và quy tắc revalidation khi baseline dịch chuyển.
>
> **Không thuộc tài liệu này:** canonical baseline → bốn view tri thức ([`../README.md`](../README.md)) và ADR đã accept · công việc, Milestone, portfolio → [`../engineering/work-management.md`](../engineering/work-management.md) §3–§4 · trạng thái năng lực → [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5 · so sánh target với thực tế → [`../engineering/evolution-process.md`](../engineering/evolution-process.md) §8.1.

## 1. Mục đích

Change Specification trả lời một câu hỏi mà Issue và Milestone không trả lời: **một thay đổi lớn sẽ đưa hệ thống tới target model nào, dựng trên baseline nào, và cần gì để trở thành canonical.**

Một thay đổi cần spec khi thiết kế của nó lớn hơn một PR: introduce bounded context mới, dịch ownership, đổi contract dùng chung, hoặc retire một phần hệ thống. Thay thế một phần hệ thống là **một** spec — retire trên phần cũ, introduce trên phần mới.

Hai ranh giới cố hữu:

- **Design-ahead, không phải baseline.** Baseline có thẩm quyền (authoritative baseline) là tài liệu canonical của bốn view cộng accepted ADRs. Một spec được merge nghĩa là được **accept làm design input**, chưa phải thay đổi baseline; baseline chỉ đổi qua canonical promotion (§3). Trạng thái năng lực (`Specified`…) không bao giờ suy ra từ một Change Specification ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §5).
- **Đối lập với [`../features/README.md`](../features/README.md).** Feature mô tả capability mà repository **đang có implementation**, kèm bằng chứng; Change Specification mô tả target **chưa tồn tại**. Một capability đi từ spec sang Feature qua canonical promotion và delivery — không qua việc sửa status.

## 2. Changes không phải gì

- **Không phải backlog, roadmap hay status dashboard.** Công việc thuộc GitHub Issue và Milestone ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §4); catalog bounded context thuộc [`../domains/README.md`](../domains/README.md).
- **Spec không mang trạng thái.** Không lifecycle status, không marker M1/M2, không progress, không danh sách Issue/PR — vòng đời artifact do [`../AGENTS.md`](../AGENTS.md) §9 quy định. Dấu kết thúc duy nhất là **một dòng terminal marker** (supersession/withdrawal), chỉ thêm khi impact class là Superseded hoặc Withdrawn; index ở §6 mang cùng ghi chú đó.
- **Không phải nơi ghi quyết định đã accept.** Quyết định kiến trúc đã accept nằm trong ADR ([`../AGENTS.md`](../AGENTS.md) §10) hoặc tài liệu canonical; quyết định còn mở của chính spec nằm trong mục Open decisions của spec đó.

## 3. Từ vựng

| Thuật ngữ                  | Nghĩa                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Change type**            | `introduce` / `evolve` / `retire` — thuộc tính của **từng mục** trong Affected scope, không phải field của GitHub hay của cả spec.                                                                                                                         |
| **Horizon promotion**      | Đưa một thay đổi lên cam kết portfolio: Feature Discovery → M2 → M1. Điều kiện readiness: scope committable, có owner, có evidence; procedure và mechanics Milestone thuộc [`../engineering/work-management.md`](../engineering/work-management.md) §4.    |
| **Canonical promotion**    | Nội dung spec trở thành canonical: cập nhật tài liệu của bốn view, viết ADR khi [`../AGENTS.md`](../AGENTS.md) §10 yêu cầu, cập nhật domains catalog và context map, rồi retire spec theo [`../AGENTS.md`](../AGENTS.md) §6.                               |
| **Impact class**           | Hiệu quả của một material change **lên một Change Specification phụ thuộc** — sáu lớp trong bảng dưới. Trục khác với reconciliation classes khi so target với thực tế ([`../engineering/evolution-process.md`](../engineering/evolution-process.md) §8.1). |
| **Material change**        | Thay đổi kích hoạt impact assessment: đổi canonical baseline hiện hành, đổi quyết định đã accept, đổi scope của Milestone đã cam kết, hoặc đổi contract/library/bounded context dùng chung.                                                                |
| **Authoritative baseline** | Tài liệu canonical của bốn view cộng accepted ADRs — không bao giờ là một Change Specification.                                                                                                                                                            |
| **Ordering constraint**    | Hai promotion là hai quyết định độc lập, không tự động kéo nhau; nghĩa vụ đi kèm delivery đầu tiên → đoạn cuối mục này.                                                                                                                                    |

Impact classes:

| Lớp            | Nghĩa                                                        | Việc phải làm                    |
| -------------- | ------------------------------------------------------------ | -------------------------------- |
| **No impact**  | Spec không phụ thuộc phần bị thay đổi.                       | Không việc gì.                   |
| **Adapt**      | Nội dung spec cần cập nhật; baseline không đổi.              | Owner cập nhật spec.             |
| **Rebase**     | Chính baseline đã dịch; spec phải suy lại trên baseline mới. | Owner re-derive spec.            |
| **Blocked**    | Không thể tiếp tục đến khi thay đổi kích hoạt được xử lý.    | Ghi follow-up; chờ mở khoá.      |
| **Superseded** | Quyết định/spec khác thay thế spec này.                      | Terminal marker + ghi chú index. |
| **Withdrawn**  | Owner rút lại spec.                                          | Terminal marker + ghi chú index. |

**Nghĩa vụ canonical promotion của delivery đầu tiên.** Khi hành vi đầu tiên của một spec đã accept xuất hiện trong hệ thống, thay đổi đó phải kèm một trong hai: cập nhật tài liệu canonical chịu tác động trong cùng một logical change, hoặc ghi follow-up tường minh. "Đã implement nhưng chưa canonical promotion" là trạng thái transient được theo dõi — tài liệu canonical không được mâu thuẫn vĩnh viễn với thực tế đã accept ([`../AGENTS.md`](../AGENTS.md) §12).

## 4. Impact & revalidation

- **Kích hoạt:** một material change (§3) được merge hoặc accept thì phải đánh giá tác động lên các Change Specification phụ thuộc.
- **Tìm spec phụ thuộc:** qua mục Baseline references và Dependencies của từng spec khác.
- **Ghi verdict:** một trong sáu impact classes, ghi tại triggering Issue và owning root issue của spec phụ thuộc — không bao giờ ghi trong spec.
- **Owner + follow-up bắt buộc** với mọi verdict khác No impact.
- **Không cascade:** chỉ đánh giá lại các spec chịu tác động; không revalidation diện rộng các package không liên quan.

## 5. Quy tắc catalog

Một spec introduce bounded context mới (pending introduce) chỉ được index tại đây, không vào catalog của [`../domains/README.md`](../domains/README.md) — catalog chỉ liệt kê context đã qua canonical promotion.

## 6. Index

Chưa có Change Specification nào. Mỗi spec mới được thêm vào danh sách này trong cùng thay đổi với file của nó: tên file (kebab-case mô tả thay đổi), một dòng mô tả, và terminal marker nếu có.

Cấu trúc bắt buộc của một spec → [`_template.md`](./_template.md).
