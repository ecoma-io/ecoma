---
name: onboard
subsystem: shared
lang: zh
description: 唯一的 onboarding 入口——验证开发者工具链并搭建仓库(依赖、git hooks、Playwright Chromium)。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# onboard

这是每个贡献者、以及每个 Claude Code 云端 session 都会运行的唯一脚本,让你
从一个全新的 clone 走到一个可以跑 definition of done 的 checkout。

<!-- readme:why -->

## 为什么存在

一个多语言(TypeScript/Go/Rust/Python)工作区,在本地跑通
`pnpm nx affected -t lint test typecheck build e2e` 之前需要准备好不少工具链:
正确的 Node/pnpm 版本、Go、带 `clippy`/`rustfmt` 的 Rust、`uv`、一旦有 Go
项目就需要的 `golangci-lint`、强制提交规范的 git hooks,以及 e2e 套件所需的
Playwright Chromium。`src/setup.mjs` 是唯一一个脚本,依据仓库自身已经拥有的
版本 pin(`package.json` 的 `engines`/`packageManager`、`go.work`)校验以上
全部内容,对有官方 user-space 安装器的工具提供安装,并且从不悄悄跳过任何一
步。`runSetup(argv)` 被特意导出,既能在进程内运行,也能从 CLI 运行——只有
一条 onboarding 路径,以两种方式被调用。

<!-- readme:consumers -->

## 谁在使用它

- **贡献者**:`pnpm run setup`,或用 `pnpm run setup -- --check` 只验证、不
  改动任何东西。根目录 `package.json` 里的 `setup` 脚本把
  `nx run onboard:setup` 串联到 `node src/setup.mjs`。完整文档见
  [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)。
- **Claude Code 云端 session**:SessionStart hook
  (`.claude/hooks/session-start-remote.mjs`,注册在
  `.claude/settings.json` 中)从 `src/setup.mjs` **进程内**导入 `runSetup`
  并以 `--yes` 调用它,让全新的 sandbox 在 session 开始做任何其他事之前就
  完成准备。

<!-- readme:ecosystem -->

## 在生态中的位置

`onboard` 是 `shared/tools` 下 [`dev-cli`](../dev-cli/README.zh.md) 与
[`eslint-local-rules`](../eslint-local-rules/README.zh.md) 的同级工具,构建
方式相同(纯 ESM `.mjs`,无 build/typecheck),但它不是一个文档/约定 gate——
它是这个工作区唯一的 setup 脚本,被单独拆出来是为了拥有真正的测试覆盖,以
及属于自己的 target(`nx run onboard:setup`),而不再是仓库根目录下一个未
被 Nx 追踪的文件。

<!-- readme:boundary -->

## 它刻意不做的事

绝不会自己安装系统级运行时(Git、Node.js、Go),也绝不会调用 `sudo` 或任何
提权提示——对于这些,它只会打印出对应平台的确切安装命令。只有当缺失的工具
拥有官方的 user-space 安装器时(pnpm、rustup、uv、golangci-lint)才会去安
装,并且除非传入 `--yes`,否则总会先询问。它不是一个通用的 provisioning 框
架——一个脚本,一个仓库,一套版本 pin。

<!-- readme:status -->

## 状态

正在作为本地贡献者与云端 session 共用的真实 onboarding 路径运行,而不是草
稿。相关机制、不变量,以及 SessionStart hook 的隐坑记录在同目录下的
[`CLAUDE.md`](./CLAUDE.md) 中。
