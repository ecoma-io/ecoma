<!--
  Tiêu đề PR (tiếng Anh — CI kiểm bằng `pnpm dx pr-check`):
    feat(<scope>): <subject>
  - scope là tên Nx project không prefix (vd: account, transactional-mail, dx); `pnpm nx show projects` in ra tên có `@ecoma-io/`, bỏ prefix khi viết scope. Scope
    không bắt buộc; nếu có thì chỉ được đúng một.
  - PR dùng squash merge → tiêu đề PR trở thành commit title trên main
  - Breaking change chỉ hợp lệ với type feat/fix
  - Số commit trên nhánh không bị giới hạn; mỗi commit phải được ký

  Body PR viết tiếng Việt; giữ nguyên file path, error code, technical term.
  Quy tắc liên kết Issue và điều kiện đóng: docs/engineering/work-management.md §5.
-->

## Linked issue

<!-- Closes #N chỉ khi PR hoàn thành toàn bộ Issue. PR chỉ làm một phần dùng Refs #N.
     Không phải PR nào cũng cần Issue — nếu không có, ghi lý do. -->

## Mô tả

<!-- Thay đổi này làm gì và tại sao cần. Loại công việc (Evolution Process §4.1) nếu hữu ích. -->

## Thay đổi chính

-

## Phần chưa làm

<!-- Giới hạn phạm vi có chủ ý: phần nào của outcome chưa được phủ và vì sao, hoặc "Không có". -->

## Kiểm chứng

<!-- Lệnh đã chạy và kết quả thật, phù hợp với loại thay đổi (xem CONTRIBUTING.md §6). -->

```bash

```

## Checklist

- [ ] PR là một logical change review độc lập được; đã link Issue hoặc giải thích vì sao không cần
- [ ] Tiêu đề PR tiếng Anh, theo Conventional Commits, scope tối đa một Nx project
- [ ] Đã chạy validation phù hợp với scope thay đổi (không nhất thiết toàn bộ lint/test/build)
- [ ] Không đưa secret vào Git; không log prompt/response body
- [ ] Docs được cập nhật nếu behavior/contract thay đổi (tiếng Việt)
- [ ] Đã rebase lên `main` mới nhất; CI xanh và mọi conversation đã resolve trước khi mark Ready for review
