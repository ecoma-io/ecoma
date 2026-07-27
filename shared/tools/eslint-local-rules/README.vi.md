---
name: eslint-local-rules
subsystem: shared
lang: vi
description: Các rule ESLint tự viết cưỡng chế đúng doctrine riêng của workspace, không phải cú pháp chung.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# eslint-local-rules

<!-- readme:why -->

Các plugin ESLint phổ thông kiểm được cú pháp và pattern chung, nhưng không
biết gì về doctrine riêng của repo này. Chúng không thể biết `v2`/`wip`/
`phase-3` là journey marker bị cấm (Rule 13), rằng unit test (`*.test.ts`)
phải `vi.mock` mọi collaborator nội bộ mà nó import, rằng `.only`/`.skip` bị
commit là vi phạm, hay rằng mọi `project.json` phải khai đúng một tag
`type:*` và một tag `scope:*`. Mỗi rule ở đây cắm thẳng vào AST để cưỡng chế
một luật đặc thù như vậy, dưới namespace plugin `local/`:
`no-journey-markers`, `no-journey-marker-names`,
`no-focused-or-skipped-tests`, `no-unmocked-internal-imports`, và
`require-project-tags`. `test-call-chain.mjs` không phải rule — đây là
resolver dùng chung để `no-journey-markers` và `no-focused-or-skipped-tests`
nhận diện đúng cùng một tập hình dạng chain test (`it.each(...)`,
`it.only.each(...)`, …).

<!-- readme:consumers -->

Mọi rule module được nối dây vào `eslint.config.mjs` gốc dưới namespace
plugin `local/`, nên chạy như một rule ESLint bình thường qua target `lint`
của từng project — tức là mọi project trong workspace đều gián tiếp dùng nó.
Không có đường gọi riêng: `pnpm nx affected -t lint` / `pnpm nx run-many -t
lint` chạy nó, lefthook pre-commit chạy nó trên file staged, và CI chạy lại
toàn bộ cây.

<!-- readme:ecosystem -->

Đây là nửa AST của việc cưỡng chế Rule 13 (journey marker); nửa còn lại là
`check-journey-markers` của `dev-cli`, quét những thứ ESLint không chạm tới —
nội dung file không phải JS/TS/Vue, tên file/thư mục, và tên target Nx. Cả
hai đọc chung một nguồn pattern, `journey-markers.config.json` ở repo root,
nên sửa luật chỉ sửa một chỗ. Project này nằm ngang hàng với `dev-cli` và
`repo-care` trong `shared/tools` — tooling mà phần còn lại của workspace phụ
thuộc vào, nhưng bản thân nó không phụ thuộc vào bất kỳ domain sản phẩm nào.

<!-- readme:boundary -->

Đây không phải nơi cấu hình lại rule ESLint chuẩn — việc đó thuộc về
`eslint.config.mjs` gốc. Mỗi rule module ở đây được thiết kế dependency-free,
và test của chúng cũng vậy: đó là script `node` thuần (`<name>.test.mjs`),
không dùng Vitest, được chạy trực tiếp bởi danh sách lệnh tường minh trong
target `test`. Project này không build, không typecheck.

<!-- readme:status -->

Cả năm rule đều đang bật thật trong `eslint.config.mjs` gốc — không có rule
nào viết ra rồi bỏ quên chưa nối dây. Xem [`./CLAUDE.md`](./CLAUDE.md) để
biết mechanics khi thêm rule mới và các cạm bẫy liên quan.
