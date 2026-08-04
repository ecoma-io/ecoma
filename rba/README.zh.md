---
name: rba
lang: zh
description: RPA 领域——目前只有一个桌面外壳，用于在它将要承载的接口冻结之前验证 Rust 与 Tauri 工具链。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# rba

North Star 为机器人流程自动化命名的领域：让 Filler 能操作为人类设计的软件的
driver、session 与 self-healing。

**这些几乎都还不在这里，而这份空白正是本意。** RPA 轨道的准入条件不是"引擎做
完了"，而是 ◆G0 已冻结两个接口：Filler interface 与 Session effect。在该冻结之
前启动机制会产生第二条代码路径，而这正是 RPA 原则明令禁止的唯一失败方式。

今天这里只有一个项目 `apps/rba-desktop`：一个不含任何 RPA 机制的桌面外壳。它存
在，是因为工具链总得在某处得到验证，而在还没有东西可被破坏时验证最便宜。

## 为什么外壳先于机制落地

工作区早已在 CI 中安装 Rust 工具链、早已带着 `Cargo.toml`、也早已为桌面窗口装饰
提供了 `shared/libs/core-tauri`。在这个项目之前，其中没有一行 Rust 被编译过——
车道已声明却从未行驶，这与未经测试无异。

迟迟才验证的工具链，会在最糟的时刻失败：第一个真正的 RPA driver 需要它的那天，
在期限压力之下，而机制本身尚存疑问。现在落地一个空壳把这两种失败分开，等 driver
到来时，唯一的新东西就只是 driver。

## 刻意缺席的部分

没有 driver、没有 perception、没有 session、没有凭据处理、没有 Filler。它们在
doctrine 树中各有规格，也各有冻结其接口的 gate；而这些冻结都尚未发生。针对未冻
结接口写的代码就是将被重写的代码，路线图在管辖本轨道的那一行里正是这么写的。

## 布局

| 路径                | 是什么                                               |
| ------------------- | ---------------------------------------------------- |
| `apps/rba-desktop/` | Tauri 桌面外壳——一个 webview、共享设计系统，别无其他 |

本领域面向 agent 的机制说明见 [`CLAUDE.md`](./CLAUDE.md)。
