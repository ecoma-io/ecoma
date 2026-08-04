---
name: rba-desktop
subsystem: rba
lang: zh
description: Ecoma RBA 桌面外壳——承载共享设计系统的 Tauri 窗口，也是本工作区中唯一编译 Rust 的项目。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# rba-desktop

一个渲染共享设计系统、别无他用的桌面窗口。

<!-- readme:why -->

## 为什么存在

为了在验证工具链还便宜的时候把它验证掉。

本工作区在 CI 中无条件安装 Rust 工具链、带着工作区级的 `Cargo.toml`、也已为桌面
窗口装饰交付了 `core-tauri`——而在这个项目之前，一行 Rust 都没有编译过。已配置
却从未运行过的车道，与已损坏的车道无法区分；本该第一个发现这件事的变更，会是第
一个真正的 RPA driver——那是发现工具链问题最糟糕的时刻。

这个外壳把那种失败与机制的失败分开。等 driver 到来时，打包、窗口、设计系统的组
合与 Rust 构建都已知良好，唯一未经验证的就只有 driver 本身。

它**不是** RPA 轨道的起点。该轨道的准入条件是 ◆G0 冻结 Filler interface 与
Session effect，而两者都尚未发生。禁止的内容见
[`../../CLAUDE.md`](../../CLAUDE.md)。

<!-- readme:consumers -->

## 谁消费它

按设计，没有人——它是应用，而应用是叶子。

它自己的依赖方向相反：它消费 `@ecoma-io/ui` 的原语与令牌，并将在外壳长出需要的
装饰后消费 `@ecoma-io/core-tauri` 的窗口控件。这两者正是这个外壳值得存在的理
由：它们是设计系统能在 Tauri webview 中组合、而不仅仅在 Storybook 中组合的第一
份真实证据。

<!-- readme:ecosystem -->

## 它的位置

`rba/` 领域的第一个也是唯一一个项目，同时是本工作区唯一的 Rust crate。这两点让
它承担的重量远超其体积：它是 `scope:rba` 标签的唯一持有者，也是 `cargo`、
`clippy` 与 `rustfmt` 的唯一运行者。

前端是 Vite + Vue 3，与设计系统 Storybook 宿主所用的技术栈相同，因此同一个组件
在两处行为一致。Rust 侧是一个很薄的组合根：一个构建窗口的 `run()`，以及一个调用
它的 `main`。

<!-- readme:boundary -->

## 它刻意不做的事

- **没有 RPA 机制**——没有 driver、没有 perception、没有 session、没有凭据处
  理、没有 Filler。这些都在等 ◆G0 冻结。
- **没有自己的业务逻辑。** 任何值得测试的东西都属于其他界面可以共享的 lib；一个
  积累逻辑的外壳会变成某个东西第二份副本的所在地。
- **拉取请求 CI 中不做打包。** `bundle` 构建真正的安装包，属于发布车道的目标；
  每次变更的关卡是 `lint`（运行 `cargo fmt --check` 与 `clippy`）与 `test`
  （`cargo test`）。

<!-- readme:status -->

## 状态

脚手架，并且如实标注为脚手架：窗口能打开、渲染一个标题，并带有一个 Rust 单元测
试。`tauri.conf.json` 中的 `bundle.active` 为 `false`——在图标集与签名身份就位之
前不产出任何安装包。

构建它需要 Tauri 所链接的 GTK/WebKit 开发头文件；缺少它们的机器连 `cargo check`
都无法执行。面向 agent 的机制说明（包括哪些失败属于环境而非代码）见
[`./CLAUDE.md`](./CLAUDE.md)。
