---
name: onboard
subsystem: shared
lang: vi
description: Entry point onboarding duy nhất — kiểm tra toolchain của developer và setup repo (dependencies, git hooks, Playwright Chromium).
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# onboard

Script duy nhất mà mọi contributor và mọi Claude Code cloud session chạy để
đi từ một clone mới tới một checkout đã sẵn sàng cho definition of done.

<!-- readme:why -->

## Vì sao tồn tại

Một workspace polyglot (TypeScript/Go/Rust/Python) có khá nhiều toolchain
cần chuẩn bị đúng trước khi `pnpm nx affected -t lint test typecheck build e2e` chạy
được cục bộ: đúng version Node/pnpm, Go, Rust với `clippy`/`rustfmt`, `uv`,
`golangci-lint` một khi có project Go, git hooks cưỡng chế quy ước commit, và
Playwright Chromium mà suite e2e cần. `src/setup.mjs` là script duy nhất
kiểm tra tất cả những thứ đó dựa trên chính các pin mà repo đã sở hữu
(`package.json` `engines`/`packageManager`, `go.work`), đề nghị cài những gì
có installer chính thức cho user-space, và không bao giờ âm thầm bỏ qua một
bước. `runSetup(argv)` được export chủ đích để có thể chạy in-process lẫn từ
CLI — chỉ có đúng một đường onboarding, chạy theo hai cách khác nhau.

<!-- readme:consumers -->

## Ai gọi nó

- **Contributor**: `pnpm run setup`, hoặc `pnpm run setup -- --check` để
  kiểm tra mà không đổi gì. Script `setup` trong `package.json` gốc nối tiếp
  `nx run onboard:setup` tới `node src/setup.mjs`. Tài liệu đầy đủ ở
  [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
- **Claude Code cloud session**: SessionStart hook
  (`.claude/hooks/session-start-remote.mjs`, đăng ký trong
  `.claude/settings.json`) import `runSetup` từ `src/setup.mjs`
  **in-process** và gọi với `--yes`, để một sandbox mới được provision
  trước khi session bắt đầu làm bất cứ việc gì khác.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

`onboard` là tool anh em trong `shared/tools` của [`dev-cli`](../dev-cli/README.vi.md)
và [`eslint-local-rules`](../eslint-local-rules/README.vi.md), xây theo cùng
cách (plain-ESM `.mjs`, không build/typecheck), nhưng nó không phải một
doc/convention gate — nó là script setup duy nhất của workspace, được tách
riêng để có test coverage thật và một target của riêng nó
(`nx run onboard:setup`) thay vì là một file untracked ở repo root.

<!-- readme:boundary -->

## Ranh giới

Không bao giờ tự cài một system runtime (Git, Node.js, Go), và không bao giờ
gọi `sudo` hay một elevated prompt — với những thứ đó nó chỉ in ra đúng
command cài đặt cho platform đã phát hiện. Chỉ cài một tool còn thiếu nếu
tool đó có installer chính thức cho user-space (pnpm, rustup, uv,
golangci-lint), và chỉ sau khi hỏi trừ khi có `--yes`. Không phải một
framework provisioning tổng quát — một script, một repo, một bộ pin.

<!-- readme:status -->

## Trạng thái

Đang hoạt động như đường onboarding thật cho cả contributor cục bộ lẫn cloud
session, không phải bản nháp. Mechanics, invariant, và cạm bẫy của
SessionStart hook nằm ở [`CLAUDE.md`](./CLAUDE.md) cùng thư mục.
