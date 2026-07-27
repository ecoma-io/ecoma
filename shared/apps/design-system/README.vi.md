---
name: design-system
subsystem: shared
lang: vi
description: App host Storybook của workspace — build các story và design docs của core-ui thành site tĩnh mà các cổng e2e quét và website ecoma.io tương lai sẽ publish.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# design-system

App host Storybook cho design system của workspace: lớp vỏ render các story
và design docs của `core-ui`. Nó không ship component nào của riêng nó —
toàn bộ nội dung nằm trong `core-ui`; app này sở hữu phần host biến nội dung
đó thành một site chạy được và một artifact deploy được.

<!-- readme:why -->

## Tại sao nó tồn tại

Các library của workspace là buildless theo doctrine, nhưng một Storybook là
một quá trình build: nó phát ra `storybook-static`, một artifact có vòng đời
riêng — `design-system-e2e` quét nó như một cổng chặn, và website ecoma.io
theo kế hoạch sẽ publish nó như mục design system của site. Đặt Storybook
host trong một app cho artifact đó một chủ sở hữu hạng nhất, trong khi
`core-ui` vẫn là một library thuần buildless.

<!-- readme:consumers -->

## Ai đang consume nó

Developer, qua `pnpm nx run design-system:serve` — Storybook dev (port 6008)
với panel accessibility sống. `design-system-e2e`, qua
`pnpm nx run design-system:build` — các cổng Playwright của nó quét output
đã build. Và, theo định hướng thiết kế đã ghi nhận, website ecoma.io tương
lai sẽ mount Storybook đã build như một mục của nó.

<!-- readme:ecosystem -->

## Vị trí của nó trong hệ sinh thái

Gắn tag `type:app`, `scope:shared`, với
`implicitDependencies: ["core-ui"]` — các glob story vươn vào cây của
`core-ui`, một cạnh mà graph import không thể thấy. Các target sẵn có là
`build`, `serve`, `lint`. Nguồn theme (`tailwind.preset.js`) và mọi story
vẫn nằm trong `core-ui`; app này chỉ giữ phần wiring của host: config
Storybook, `tailwind.config.js`, và shim `postcss.config.js` mà Tailwind v4
yêu cầu.

<!-- readme:boundary -->

## Ranh giới — nó cố ý không làm gì

Nó không ship component nào và không có public API — `@ecoma-io/ui` vẫn là
alias nội bộ của `core-ui`, không bao giờ là một npm package. Nó không có
target `typecheck` hay `test`: mọi thứ ở đây là config host do chính
toolchain của Storybook thực thi, và mọi component nó render đều được
typecheck và test trong `core-ui`. Nó cũng không phải cổng chặn
accessibility — đó là `design-system-e2e`.

<!-- readme:status -->

## Trạng thái

Build và serve trọn bộ Storybook của design system — mọi story và design doc
của `core-ui`, với story ID thuộc về nội dung chứ không thuộc về host này.
Cơ chế — các alias Vite được suy ra, cái bẫy jiti của Tailwind, shim
PostCSS, và đường nối website đã được ghi nhận — nằm ở
[`./CLAUDE.md`](./CLAUDE.md).
