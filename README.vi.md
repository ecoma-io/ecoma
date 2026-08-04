> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

<p align="center">
  <a href="https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/ecoma"><img src="https://api.securityscorecards.dev/projects/github.com/ecoma-io/ecoma/badge" alt="OpenSSF Scorecard"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-fair--code-blue" alt="Fair-code"></a>
</p>

<p align="center">
  <a href="https://ecoma.io">ecoma.io</a> ·
  <a href="https://ecoma.io/doctrine">Doctrine</a> ·
  <a href="./CONTRIBUTING.md">Đóng góp</a>
</p>

---

## Dựng việc thành đồ thị. Tiến hoá bằng vòng lặp.

Hầu hết công cụ tự động hoá bắt bạn chọn. Pipeline tất định, hay AI agent. Một
workflow engine, hay một trợ lý chat. Người trong vòng lặp, hay người ngoài nó.

**Ecoma từ chối lựa chọn đó.** Con người, AI agent, và rule/code là cùng một
loại thứ — một _nguồn lực lao động_ lấp vào một _vai_. Một bước trong quy trình
không quan tâm người, mô hình hay script làm việc đó; nó quan tâm kết quả có đạt
ngưỡng của nó không. Nên workflow là một đồ thị, còn thứ lấp vào từng nút là một
quyết định bạn đổi được vào thứ Ba mà không phải viết lại gì.

Đúng một ý đó là thứ làm phần còn lại thành khả thi.

### 1. Graph engineering — sơ đồ tổ chức trở thành thứ chạy được

Công việc được mô hình hoá thành đồ thị: nút là task, cạnh là handoff, và mỗi
nút khai báo một kết quả tốt trông ra sao. Con người và AI cùng thiết kế đồ thị
đó **ngay bên trong engine** — không phải trong một công cụ vẽ mà tới thứ Sáu đã
lệch khỏi thực tế.

Đồ thị _chính là_ quy trình. Không có bản sao thứ hai nào phải giữ đồng bộ.

### 2. Loop engineering — độ tin cậy được đo, không phải được tuyên bố

Mọi output đều đi qua một **checkpoint** trước khi chạy tiếp, và ngưỡng tin cậy
của checkpoint đó được hiệu chỉnh theo dữ liệu của _chính tenant bạn_, không
phải theo bản demo của nhà cung cấp. Một vai liên tục vượt ngưỡng sẽ được nới
quyền tự chủ; một vai thôi vượt ngưỡng sẽ bị dẫn ngược về vòng review.

Đó là vòng lặp: chạy, đo, hiệu chỉnh lại, nới hoặc siết dây. Không phải một
dashboard để bạn nhìn — mà một cơ chế tự hành động.

### 3. Từ công ty một người tới doanh nghiệp

Cùng một engine phục vụ cả hai, vì ràng buộc quyết định là giống hệt nhau và chỉ
khác quy mô: **sự chú ý của con người là nguồn lực khan hiếm nhất trong toà
nhà.**

Với một solo founder, ràng buộc đó là tuyệt đối — bạn _là_ cả toà nhà. Ecoma coi
sự chú ý của bạn như một nguồn lực đo được: cái gì đến tay bạn, khi nào, và vì
sao — trở thành một chính sách bạn đặt ra thay vì một cơn lũ bạn phải phân loại.
Công ty vượt quá một người không đổi công cụ; nó đổi ngưỡng.

---

## Thực tế đang ở đâu

**Ecoma đang ở giai đoạn tiền phát hành.** Chưa phiên bản nào ra mắt và chưa
artifact nào được phân phối. Làm một thứ để tự vận hành và để người khác kiểm
toán nghĩa là thiết kế phải đúng trước khi code đúng — nên thiết kế được công bố
trước, và mục này nói cái gì có thật chứ không phải cái gì đang dự tính.

| Tầng                    | Trạng thái                                                                   |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Doctrine**            | 3 North Star, 27 đặc tả, các charter và ADR — đã công bố và đọc được         |
| **Bộ đồ nghề kỹ thuật** | Đang chạy: CI, gate, hợp đồng commit, sổ conformance, toolchain đa ngôn ngữ  |
| **Design system**       | Đang chạy: primitive và block Vue 3 sau một gate accessibility có quyền chặn |
| **Website + tài liệu**  | Đang chạy: vỏ storefront và bề mặt đọc doctrine                              |
| **Engine**              | Đã đặc tả trọn vẹn; các mối nối package đã có, phần chạy thì chưa            |

Nếu ở đâu đó trong repository này có phát biểu trái với bảng trên về một bề mặt
sản phẩm, đó là lỗi của file chứ không phải một tính năng bạn bỏ sót.

## Đọc thiết kế trước khi đọc code

Phần lập luận là công khai, và đó chính là chủ ý. Mọi cơ chế mà một tenant phải
dựa vào đều được viết ra trước khi được dựng, để bạn có thể phản bác thiết kế
trên lý lẽ thay vì phải dịch ngược từ một file nhị phân.

Bắt đầu từ [doctrine](https://ecoma.io/doctrine). Bên trong cây mã nguồn, mỗi
subproject mang **hai tài liệu cho hai loại người đọc**:

- **`README.md`** — cho con người. Đây là cái gì, tồn tại vì sao, và cố tình
  **không** làm gì.
- **`CLAUDE.md`** — cho coding agent. Bất biến, footgun và lệnh chạy theo phạm
  vi thư mục. Người đọc được, nhưng nó mặc định bạn đã biết thứ đó dùng để làm
  gì.

Nguyên tắc toàn workspace nằm ở [`CLAUDE.md`](./CLAUDE.md) gốc.

## Bắt đầu

```bash
# Kiểm tra toolchain, cài dependency, git hook, và trình duyệt Playwright
pnpm run setup

# Storybook của design system
pnpm nx run design-system:serve

# Định nghĩa "xong" cho mọi thay đổi code
pnpm nx affected -t lint test typecheck build e2e
```

`pnpm nx` là task runner duy nhất. Xem [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Đóng góp

Đóng góp từ bên ngoài được chào đón, và điều khoản thì được viết ra chứ không
ứng biến:

- [Hướng dẫn đóng góp](./CONTRIBUTING.md) — cách chúng tôi làm việc, và định nghĩa "xong"
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Chính sách bảo mật](./SECURITY.md) — cách báo cáo một lỗ hổng
- [`CLA.md`](./CLA.md) — một thoả thuận một lần, trước lần merge đầu tiên của bạn

## Giấy phép

Ecoma là **fair-code**: nguồn mở để đọc, không phải open source, và cũng không
đóng. Đó là ba thứ khác nhau và chính sự khác biệt ấy mới là điểm mấu chốt.

Mã nguồn là công khai và sẽ giữ như vậy — mọi cơ chế mà sản phẩm cam kết với một
tenant đều phải đọc được, tự host được và sửa được. Cái mà fair-code giữ lại là
việc phân phối lại vì mục đích thương mại, và trên hết là bán chính Ecoma dưới
dạng dịch vụ. Chính hạn chế đó là lý do phần còn lại có thể mở.

> **Mục này là bản tóm tắt để đọc nhanh, không phải điều khoản.**
> [`LICENSE`](./LICENSE) mới là thứ có hiệu lực pháp lý, và ở đâu hai bên khác
> nhau thì `LICENSE` thắng.

| Đường dẫn                      | Điều khoản                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| mọi thứ không nêu dưới đây     | Sustainable Use License                                                                     |
| `<subsystem>/packages/`        | Apache License 2.0 — thứ bạn dựng lên trên                                                  |
| `shared/libs/doctrine/**/*.md` | [CC BY-SA 4.0](./shared/libs/doctrine/LICENSE.docs), kèm hình ảnh mà các file đó tham chiếu |
| `cloud/`                       | độc quyền, và không công bố                                                                 |
| thành phần bên thứ ba          | điều khoản của chính chủ sở hữu chúng                                                       |

**Chạy Ecoma cho tổ chức của chính bạn là được phép rõ ràng** — thương mại hay
không, kể cả để cung cấp hàng hoá và dịch vụ cho khách hàng của bạn. Cái không
được phép là cung cấp Ecoma cho người khác vì mục đích thương mại hoặc có thu
phí: bán bản sao, gói nó vào trong một sản phẩm có phí khác, hoặc trường hợp rõ
ràng nhất là vận hành nó cho họ dưới dạng dịch vụ. Phân phối cho người khác chỉ
được phép khi vừa miễn phí vừa phi thương mại.

Bản build kiểm tra chính lời khai đó thay vì tin vào trí nhớ: mỗi project khai
một tag giấy phép, và gate quy ước sẽ đỏ khi một tag mâu thuẫn với chính thư mục
của nó. Không giấy phép nào ở đây cấp quyền đối với cái tên Ecoma.
