---
name: design-system-e2e
subsystem: shared
lang: vi
description: Cổng chặn bằng Playwright trên Storybook đã build của app design-system — a11y bằng axe, hợp đồng design token, và tuân thủ palette — kèm smoke check story index.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# design-system-e2e

Bộ test e2e cho Storybook của app `design-system` — host render các story của
`core-ui`. Nó có Nx project riêng vì taxonomy test của workspace này cấm đặt
test e2e cùng chỗ với code được test — xem `CLAUDE.md` ở root.

<!-- readme:why -->

## Tại sao nó tồn tại

Storybook của `design-system` có một panel accessibility sống trong lúc phát
triển, nhưng một panel chỉ mang tính khuyến nghị — không gì ngăn một vi
phạm được ship trừ khi có một bước build fail vì nó. Bộ test này chính là
bước đó: nó scan Storybook **đã build** (`storybook-static`), không phải
source, vì một vi phạm do chính quá trình build gây ra — một stylesheet bị
rớt làm sập contrast, một asset trả về 404 — sẽ vô hình với bất kỳ scan nào
chạy trên source. Scan đúng cái artifact mà một operator thực sự sẽ mở
chính là trọng tâm.

Cùng lập luận đó vươn ra ngoài phạm vi accessibility. `tokens.css` phát biểu
các định luật thiết kế của nó bằng văn xuôi — nhịp elevation `--sunken` <
`--background` < `--card`, focus ring chính là lực Human, `--seam` chạy từ
`--primary` sang `--agent` — và vài định luật trong số đó được giữ bằng những
literal viết lại giá trị của token khác thay vì tham chiếu tới nó, nên khi
chỉnh tông một lực thì các chỗ còn lại lặng lẽ trỏ về màu cũ mà không có gì
fail. Bộ test này giờ còn resolve mọi token trong artifact đã build và kiểm
tra các định luật đó, đồng thời quét mọi story tìm màu mà không token nào định
nghĩa. Cả hai đều cần một browser thật: jsdom không resolve `var()` lẫn
`hsl()`, nên tầng unit chỉ có thể so sánh những chuỗi chép ra từ đúng cái file
mà nó lẽ ra phải kiểm tra.

<!-- readme:consumers -->

## Ai đang consume nó

CI và mọi developer đưa thay đổi vào `core-ui` hoặc app `design-system`, qua
`pnpm nx run design-system-e2e:e2e` (một phần của definition of done,
`CLAUDE.md` ở root). Đây là thứ thực sự chặn một vi phạm WCAG khỏi việc
merge; panel a11y lúc dev chỉ hiển thị cùng loại vấn đề đó một cách tương
tác, nó không chặn gì cả.

<!-- readme:ecosystem -->

## Vị trí của nó trong hệ sinh thái

Gắn tag `type:e2e`, `scope:shared`, với
`implicitDependencies: ["design-system", "core-ui", "dev-cli"]`.
Nó import `WCAG_TAGS` từ `@ecoma-io/ui/a11y` thay vì viết lại phạm vi tag WCAG
2.0/2.1 A/AA, để panel tương tác và cổng chặn này không bao giờ bất đồng về
việc thế nào là một vi phạm. Danh sách story cần scan không bao giờ được
liệt kê thủ công: nó được đọc từ chính `index.json` của Storybook đã build,
nên một primitive mới được cover ngay khi story của nó tồn tại, và một cái bị
xoá tự động rớt ra. Mỗi story được scan như một test riêng, nên một hồi quy
trải trên nhiều story sẽ báo cáo đủ tất cả. Phép suy ra đó có một điểm mù, và
`lint` bịt nó lại: một component không có story thì không sinh ra entry nào
trong index, nên `check-e2e-story-coverage` buộc mọi component trong
`core-ui/src` phải có một story. Chạy qua
`pnpm nx run design-system-e2e:e2e`, đi qua `dev-cli run-e2e` (xử lý `xvfb` trên
Linux và lớp shim cấp phát Chromium); các target sẵn có là `lint`,
`typecheck`, `e2e`.

<!-- readme:boundary -->

## Ranh giới — nó cố ý không làm gì

Nó không unit-test component — đó là việc của target `test` riêng của
`core-ui`, chạy trên jsdom. Nó cũng không test bất kỳ application sản phẩm
nào; đối tượng duy nhất của bộ test này là Storybook của app `design-system`.

<!-- readme:status -->

## Trạng thái

Hiện bao phủ ba cổng chặn — quét a11y bằng axe, hợp đồng design token, và
tuân thủ palette — cộng với một smoke check rằng Storybook đã build có phục
vụ story index của nó. Đây là project `type:e2e` đầu tiên trong workspace.
Cơ chế — vì sao phạm vi WCAG được import thay vì viết lại, vì sao preview
server bỏ qua Nx, vì sao mỗi story được scan như một test riêng, và vì sao
mỗi token phải được dò trên một element mới hoàn toàn — nằm ở
[`./CLAUDE.md`](./CLAUDE.md).
