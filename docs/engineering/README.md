# Engineering

> **Phạm vi:** quá trình kỹ thuật — cách developer và coding agent hiểu hệ thống, tiến hoá mô hình, chọn và hiện thực thay đổi, verify kết quả và reconcile với target.
>
> Tài liệu này giải thích **vì sao** và **trỏ tới đâu**; specification canonical của quá trình nằm ở [`evolution-process.md`](./evolution-process.md), không chép lại ở đây.

## Tài liệu

| Document                                                 | Nội dung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`evolution-process.md`](./evolution-process.md)         | Canonical process: ba lớp (Knowledge · Work Management · Reality & Evidence), bốn view tri thức (Architecture · Domains · Applications · Features), năm loại công việc ghi bằng Issue Type, vòng đời bảy bước, ý nghĩa Vertical Slice, bốn trạng thái năng lực, và reconciliation/deviation semantics                                                                                                                                                                                                                                                                                                              |
| [`work-management.md`](./work-management.md)             | Canonical cho GitHub work management: khi nào tạo/tái dùng Issue, root issue so với sub-issue, work item so với ledger/precondition tracker/experiment record, cách ghi Issue Type (native, kèm khối transition), nội dung tối thiểu, điều kiện đóng theo cấp root/sub, membership Project của root issue và legacy `project:track`, product pipeline `M1 → M2 → Feature Discovery` độc lập theo từng product và Milestone delivery commitment độc lập với product (cross-product khi các product phối hợp một outcome), completion/activation/release độc lập; trách nhiệm của Project, Milestone và Pull Request |
| [`contribution-workflow.md`](./contribution-workflow.md) | Quy trình thực hành cho developer và coding agent: mười hành động từ hiểu yêu cầu tới reconcile, handoff giữa các vai trò, cách chọn validation theo scope, và ranh giới giữa tài liệu hướng dẫn với ràng buộc trong `AGENTS.md`                                                                                                                                                                                                                                                                                                                                                                                   |

Entry point cho contributor là [`CONTRIBUTING.md`](../../CONTRIBUTING.md) ở repository root. Nó tổng hợp và dẫn chiếu ba tài liệu trên, không chép lại nội dung.

## Quan hệ với các trục tài liệu khác

`docs/engineering/` **không** phải trục tri thức thứ tư về hệ thống. Nó nói về **cách** các trục kia được dùng và tiến hoá. Ranh giới sở hữu của từng trục đã có canonical tại [`docs/README.md`](../README.md) và [`docs/AGENTS.md`](../AGENTS.md) §3–§4; tài liệu này không chép lại bảng đó.

Repository tổ chức tri thức kỹ thuật thành **bốn view** — Architecture · Domains · Applications · Features (§3 của [`evolution-process.md`](./evolution-process.md)) — mỗi view có một canonical location:

- [`architecture/`](../architecture/README.md) → Architecture
- [`domains/`](../domains/README.md) → Domains
- [`applications/`](../applications/README.md) → Applications
- [`features/`](../features/README.md) → Features

"Bốn trục" trong [`domains/README.md`](../domains/README.md) §1.1 là khái niệm khác (bounded context / deploy unit / Nx scope / deployment project), không phải bốn view tri thức.

Change Specification — thiết kế vượt trước baseline cho một thay đổi tương lai — nằm ở [`changes/`](../changes/README.md), không phải view tri thức thứ năm và không bao giờ là baseline. Quy tắc promotion và impact classes do [`changes/README.md`](../changes/README.md) sở hữu.

## Phạm vi hiện tại

Tài liệu này mô tả quá trình **đích** và cách áp dụng nó. Nó không tuyên bố mọi thay đổi trong repository đã theo quá trình này.

`work-management.md` quy định **policy** cho GitHub, không phải ảnh chụp cấu hình: label, Milestone, Project và field hiện có phải đọc từ GitHub trước khi dùng. `contribution-workflow.md` mô tả hành động và handoff, không thay thế nội dung canonical của các nguồn khác.
