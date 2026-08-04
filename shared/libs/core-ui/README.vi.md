---
name: core-ui
subsystem: shared
lang: vi
description: Design system Loom — primitive Vue 3, block, và design token dùng chung cho mọi bề mặt sản phẩm Ecoma.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# core-ui — Loom

Loom là design system Ecoma đóng gói dưới tên `@ecoma-io/ui`: các primitive
Vue 3 + Tailwind, block, và design token dùng để được **consume**, không
phải tự tay làm lại, bởi mọi bề mặt sản phẩm trong workspace. Ngôn ngữ hình
thức của nó là hai sợi trên một tấm vải — Human (warp, sợi dọc) × Agent
(weft, sợi ngang) — với đường can gradient chỉ ở nơi hai sợi bắt nhau; tông
light-first, enterprise.

<!-- readme:why -->

## Tại sao nó tồn tại

Ecoma là một workspace nơi con người và agent làm việc cạnh nhau, và với
phía con người điều đó có nghĩa là màn hình — những màn hình trải khắp mọi
ranh giới sản phẩm mà repo này sẽ từng có (một app độc lập, một workspace
shell, hay phần composition riêng của một sản phẩm trên nền đó). Nếu mỗi
sản phẩm tự tay làm lại nút bấm, dialog, hay skeleton loader của riêng mình,
mỗi bản sẽ trôi dạt về spacing, motion, và accessibility theo lịch trình
riêng. Loom tồn tại để một affordance chung — một primitive, một token,
một motion pattern — được xây một lần và consume ở khắp nơi, theo một luật
cho mỗi chiều: sản phẩm consume trước khi tự tay làm lại, và bất kỳ thứ
generic nào được phác thảo bên trong một sản phẩm sẽ "tốt nghiệp"
(graduate) ngược lên đây thay vì ở lại như một bản fork cục bộ. Đây không
phải một phán đoán mơ hồ kiểu "trông có vẻ generic" — mà là một tập hợp
component cụ thể mà nhiều sản phẩm không liên quan tới nhau đều với tới
theo cùng một cách.

<!-- readme:consumers -->

## Ai đang consume nó

Bất kỳ app hướng UI hay product UI lib nào trong workspace, import qua
`@ecoma-io/ui`. Hiện chưa có consumer nào trong repo — mới chỉ có `shared/`
tồn tại, trước khi có bất kỳ domain sản phẩm nào — nên lib này hiện được
giữ làm substrate cho các bề mặt sản phẩm tương lai. Trong lúc đó, Storybook
của app `design-system` (`pnpm nx run design-system:serve`) chính là consumer
sống của tài liệu thiết kế: trang `.mdx` của từng primitive và các trang spec
dùng chung
`docs/design/*` (Motion, Color, Elevation, Typography, Iconography, Logo,
Signature, Principles) đều render ở đó.

<!-- readme:ecosystem -->

## Vị trí của nó trong hệ sinh thái

Loom là tier một trong một UI stack hai tầng: lib này sở hữu mọi affordance
_generic_ (primitive, block, token, motion), còn UI lib riêng của từng sản
phẩm (tier hai) chỉ sở hữu phần composition đặc thù sản phẩm bên trên. Sự
phân tách đó là điều giúp một sản phẩm ship một màn hình mà không phải
quyết định lại từ đầu một nút bấm hay một dialog xác nhận trông như thế
nào. Mỗi primitive ở đây là năm artifact đi kèm nhau (component, test,
demo, stories, trang thiết kế `.mdx`), và các trang thiết kế dưới
`docs/design/*` là spec dùng chung — từ vựng (token, keyframe, motion
pattern, bộ icon) mà mọi primitive dựa vào.

<!-- readme:boundary -->

## Ranh giới — nó cố ý không làm gì

Nó không biết gì về domain của bất kỳ sản phẩm nào — không timeline video,
không danh sách profile trình duyệt, không process editor. Nó không chứa
routing, không data fetching, không business logic; một primitive ở đây
chỉ nhận props và emit event, không hơn. Composition đặc thù sản phẩm thuộc
về UI lib riêng của từng sản phẩm (tier hai), không bao giờ ở đây — và
chiều ngược lại cũng đúng: một khi sản phẩm thứ hai cần cùng một affordance
generic, nó phải tốt nghiệp lên lib này thay vì bị nhân bản ở tầng dưới.

<!-- readme:status -->

## Trạng thái

Đã build xong và được kiểm chứng qua Storybook của `design-system`, chưa có
consumer nào trong repo — giữ làm substrate cho các bề mặt sản phẩm tương
lai. Cơ chế — năm artifact đi kèm mỗi primitive, luật consume-first /
graduate-upstream, nguồn sự thật của token, và các cái bẫy Tailwind v4 —
nằm ở [`./CLAUDE.md`](./CLAUDE.md).
