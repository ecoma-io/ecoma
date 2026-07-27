> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# Ecoma

Ecoma là một hệ điều hành lao động (labor operating system) tự lưu trữ,
"fair-code", nơi con người, AI, và luật/code cùng đóng vai trò một loại tài
nguyên lao động (Role/Filler); các workflow — cả quy trình xác định lẫn tác vụ
suy luận — được con người và AI cùng thiết kế trực tiếp bên trong engine; mọi
output đều đi qua một checkpoint với mức độ tin cậy được điều chỉnh theo dữ
liệu của từng tenant; và sự chú ý của con người (human attention) được xem như
một tài nguyên cần được đo lường và tối ưu.

## Cách đọc repo này

Mỗi subproject mang **hai tài liệu, cho hai loại người đọc**:

- **`README.md` — cho con người.** Đây là gì, tại sao nó tồn tại, và nó
  **không** cố tình làm gì. Bắt đầu từ đây.
- **`CLAUDE.md` — cho coding agent.** Cơ chế theo phạm vi thư mục: invariant,
  footgun, quy tắc pairing, lệnh chạy. Con người cũng đọc được, nhưng file này
  giả định bạn đã biết thứ đó dùng để làm gì.

Nguyên tắc và quy ước toàn workspace nằm ở
[`CLAUDE.md`](./CLAUDE.md) gốc.

## Bắt đầu

```bash
pnpm install

# Storybook của design system
pnpm nx run design-system:serve

# Definition of done cho một thay đổi code
pnpm nx affected -t lint test typecheck build e2e
```

`pnpm nx` là task runner duy nhất. Các quyết định về quy ước và kiến trúc được
ghi lại trong [`CLAUDE.md`](./CLAUDE.md) và trong lịch sử commit.

## Đóng góp

- [Triết lý đóng góp](./CONTRIBUTING.md) — cách chúng ta làm việc
- [Chính sách bảo mật](./SECURITY.md) — báo cáo lỗ hổng

## Giấy phép

Độc quyền và bảo mật — © Ecoma. Bảo lưu mọi quyền. Đây là phần mềm đóng, không
phải mã nguồn mở.
