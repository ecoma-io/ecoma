> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# Ecoma

[![CI](https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ecoma-io/ecoma/badge)](https://scorecard.dev/viewer/?uri=github.com/ecoma-io/ecoma)

[ecoma.io](https://ecoma.io) · [Doctrine](https://ecoma.io/doctrine)

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
- [Quy tắc ứng xử](./CODE_OF_CONDUCT.md) — chuẩn mực cộng đồng
- [Chính sách bảo mật](./SECURITY.md) — báo cáo lỗ hổng

## Giấy phép

Ecoma là **fair-code**: mã nguồn công khai, **không phải open source**, và cũng
**không phải phần mềm đóng**. Ba thứ đó khác nhau, và chính chỗ khác nhau ấy
mới là điều đáng nói.

Mã nguồn là công khai và sẽ ở nguyên như vậy — mọi cơ chế mà sản phẩm cam kết
với tenant đều được viết ra để đọc được, tự cài được và sửa được. Thứ fair-code
giữ lại là **việc phân phối lại vì mục đích thương mại**, rõ nhất là bán chính
Ecoma thành một dịch vụ. Chính hạn chế đó là lý do mọi phần còn lại có thể mở.

**Phần này là bản tóm tắt để đọc nhanh, không phải điều khoản.** Thứ có hiệu
lực pháp lý là [`LICENSE`](./LICENSE); nếu bản tóm tắt này khác với điều khoản,
**điều khoản là thứ có hiệu lực**.

| Đường dẫn                      | Điều khoản                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| mọi thứ không nêu bên dưới     | Sustainable Use License                                                                     |
| `<subsystem>/packages/`        | Apache License 2.0 — thứ bạn lập trình đối tiếp                                             |
| `<subsystem>/enterprise/`      | **không cấp quyền nào** — cần một Enterprise License riêng, bằng văn bản                    |
| `shared/libs/doctrine/**/*.md` | [CC BY-SA 4.0](./shared/libs/doctrine/LICENSE.docs), kèm các ảnh mà những tệp đó tham chiếu |
| `cloud/`                       | độc quyền, và không công bố                                                                 |
| thành phần của bên thứ ba      | theo điều khoản của chính chủ sở hữu                                                        |

Tự cài Ecoma để vận hành tổ chức của chính bạn là **được phép rõ ràng**, dù có
mục đích thương mại hay không, kể cả để tạo ra và cung cấp hàng hoá, dịch vụ
cho khách hàng của bạn. Thứ **không** được phép là đem Ecoma cung cấp cho người
khác **vì mục đích thương mại hoặc có thu tiền** — dưới bất kỳ hình thức nào:
bán bản sao, bán kèm trong một sản phẩm có phí khác, hay trường hợp rõ nhất là
vận hành hộ họ như một dịch vụ. Phân phối cho người khác chỉ được phép khi
**vừa miễn phí vừa phi thương mại**. Việc nhúng Ecoma vào một sản phẩm lớn hơn
của chính bạn có phép thử ba điều kiện riêng — đọc `LICENSE`.

Bản build **kiểm tra lời khai đó** chứ không trông vào trí nhớ: mỗi project khai
một tag `license:*`, và gate quy ước sẽ đỏ khi tag lệch với chính thư mục của
nó. Đó là một lint trên thứ cây khai ra — thứ có hiệu lực pháp lý là `LICENSE`.

Đóng góp cần đồng ý một lần với [`CLA.md`](./CLA.md). Không giấy phép nào ở đây
cấp quyền với tên Ecoma.
