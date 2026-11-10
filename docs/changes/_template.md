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

Change Specification khác mà spec này phụ thuộc, và shared context/library theo từng pipeline đang tiêu thụ sẽ chịu tác động thế nào.

## 7. Assumptions

Giả định mà spec đang đứng trên. Mỗi giả định nêu điều kiện khiến nó sai và hệ quả khi điều đó xảy ra.

## 8. Compatibility & impact

Tác động lên backward compatibility, contract đang chạy, dữ liệu và migration — áp dụng hướng expand → compatible rollout → contract khi chạm schema/contract.

## 9. Open decisions

Quyết định còn mở của thay đổi này — quy tắc single-home ở [`./README.md`](./README.md) §2. Khi một quyết định được chốt, nó rời mục này: chuyển vào ADR ([`../AGENTS.md`](../AGENTS.md) §10) hoặc tài liệu canonical, để lại tối đa một dòng trỏ. Quyết định system-wide chưa chốt thuộc `docs/architecture/01-architecture.md` §10; ranh giới nghiệp vụ chưa chốt thuộc `docs/domains/open-boundaries.md` — cross-link, không copy.

## 10. Acceptance & promotion criteria

Điều kiện để spec được coi là đạt, và điều kiện canonical promotion riêng cho spec này: tài liệu nào của bốn view phải cập nhật, ADR nào phải viết theo [`../AGENTS.md`](../AGENTS.md) §10, catalog và context-map nào phải đổi trước khi retire spec theo [`../AGENTS.md`](../AGENTS.md) §6.
