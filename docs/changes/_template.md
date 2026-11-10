# <Tên Change Specification>

> **Mô tả một dòng:** kết quả mà thay đổi này hướng tới, sau canonical promotion.
>
> Tài liệu này là đặc tả **design-ahead, không phải baseline** ([`./README.md`](./README.md) §1). Không status field, không marker M1/M2, không progress, không danh sách Issue/PR; dấu kết thúc duy nhất là **một dòng terminal marker** (supersession/withdrawal), chỉ thêm khi impact class là Superseded hoặc Withdrawn. Quy tắc viết → [`./README.md`](./README.md).

Cả mười phần đều bắt buộc; phần không áp dụng cho thay đổi này ghi ngắn gọn `không áp dụng`.

## 1. Problem

Vấn đề gì của baseline hiện tại khiến thay đổi này cần thiết: điểm nào không còn phù hợp, gây chi phí, hoặc chặn capability. Không mô tả giải pháp ở đây.

## 2. Outcome

Sau khi thay đổi được hiện thực và canonical promotion hoàn tất, hệ thống có gì mà hôm nay không có — phát biểu bằng hành vi và ranh giới, không bằng khối lượng công việc.

## 3. Baseline references

Tài liệu canonical và ADR đã accept mà spec này dựng trên — authoritative baseline ([`./README.md`](./README.md) §3). Chỉ liệt kê nguồn và phần liên quan; không copy nội dung.

| Nguồn baseline                         | Phần liên quan |
| -------------------------------------- | -------------- |
| `docs/architecture/01-architecture.md` | …              |
| `docs/domains/<context>/adr/ADR-NNNN`  | …              |

## 4. Affected scope

Mỗi dòng là một mục bị thay đổi, mang đúng **một** change type. Một thay thế là retire trên mục cũ và introduce trên mục mới.

| Mục                                                    | Change type                       | Loại đối tượng                                        |
| ------------------------------------------------------ | --------------------------------- | ----------------------------------------------------- |
| `<bounded context / application / contract / library>` | `introduce` / `evolve` / `retire` | bounded context, architecture area, contract, library |

## 5. Target model

Trạng thái đích của các mục trong Affected scope, theo change type:

- **introduce** — target model đầy đủ của phần mới.
- **evolve** — delta so với baseline hiện hành và trạng thái đích sau thay đổi.
- **retire** — phạm vi bị xoá và trạng thái còn lại sau khi retire.

Không copy nguyên đặc tả canonical; phần không đổi trỏ tới tài liệu canonical.

## 6. Dependencies

Change Specification khác mà spec này phụ thuộc, và shared context/library theo từng pipeline đang tiêu thụ sẽ chịu tác động thế nào. Mỗi pipeline bị ảnh hưởng ghi Product ID và Milestone đang lái (nếu có — pipeline chưa có Milestone committed thì ghi Product ID một mình) — không ghi giá trị horizon ([`../engineering/work-management.md`](../engineering/work-management.md) §4.1).

Mỗi entry Dependencies ghi tên spec được trỏ tới (prerequisite) và spec này đang chờ phần nào của nó — direction là từ spec này tới prerequisite; thứ tự index, tên file và ngày tạo không mang ý nghĩa hướng; đồ thị dependency phải giữ acyclic. Quy tắc dependency đầy đủ → [`./README.md`](./README.md) §4.

## 7. Assumptions

Giả định mà spec đang đứng trên. Mỗi giả định nêu điều kiện khiến nó sai và hệ quả khi điều đó xảy ra.

## 8. Compatibility & impact

Tác động lên backward compatibility, contract đang chạy, dữ liệu và migration — áp dụng hướng expand → compatible rollout → contract khi chạm schema/contract.

## 9. Decisions

Quyết định của thay đổi này, tách hai trạng thái ([`./README.md`](./README.md) §3). **Open decisions** — chưa chốt; quy tắc single-home ở [`./README.md`](./README.md) §2; quyết định system-wide chưa chốt thuộc `docs/architecture/01-architecture.md` §10, ranh giới nghiệp vụ thuộc `docs/domains/open-boundaries.md` — cross-link, không copy. **Accepted target decisions** — đã chốt trong phạm vi target của spec, mỗi mục một dòng kèm nơi chốt (PR/ADR); ở lại spec cho tới canonical promotion; chỉ ràng buộc spec này và delivery unit của nó. Quyết định có hiệu lực lên baseline trước promotion được ghi canonical ngay và đối chiếu ở Baseline references.

## 10. Acceptance & promotion criteria

Điều kiện để spec được coi là đạt, và điều kiện canonical promotion riêng cho spec này: tài liệu nào của bốn view phải cập nhật, ADR nào phải viết theo [`../AGENTS.md`](../AGENTS.md) §10, catalog và context-map nào phải đổi trước khi retire spec theo [`../AGENTS.md`](../AGENTS.md) §6.
