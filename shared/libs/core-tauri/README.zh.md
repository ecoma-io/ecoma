---
name: core-tauri
subsystem: shared
lang: zh
description: Tauri 窗口装饰 composable，为 @ecoma-io/ui 的 TitleBar 提供支持。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# core-tauri

Tauri webview 共享插件层：为 `@ecoma-io/ui` 的 `TitleBar`（最小化 / 最大化 /
关闭，以及最大化状态）提供支持的窗口装饰 composable。目前是工作区里唯一的
桌面壳（desktop-shell）基础层。

<!-- readme:why -->

## 存在的原因

每一个无边框（frameless）桌面壳都需要恰好一套接入 `TitleBar` 的窗口装饰
控制——最小化、最大化、关闭，以及决定按钮图标的最大化状态。如果每个 Tauri
host app 各自实现这部分逻辑，各个版本会随时间逐渐产生差异（`isMaximized`
刷新时机不同、错误处理不同）。这个库的存在就是为了让这部分接线只写一次，
供工作区里所有桌面壳复用。

<!-- readme:consumers -->

## 谁在使用它

Tauri host app 的 `TitleBar` 接线代码调用 `src/window-controls.ts` 里的
`useWindowControls`，驱动 `@ecoma-io/ui` 的 `TitleBar` 组件。目前仓库里还
没有 host app——这个库在第一个消费者出现之前就已构建完成，作为未来第一个
Tauri 桌面壳的基础层保留。

<!-- readme:ecosystem -->

## 在生态系统中的位置

`shared/libs` 中的一个库：任何产品域都可以通过 `@ecoma-io/core-tauri` 引入，
反过来则永远不行（`shared/*` 从不反向依赖某个产品域——见
`shared/CLAUDE.md`）。它与 `@ecoma-io/ui` 的 `TitleBar` 配对：该组件负责
窗口装饰的外观，这个库负责驱动其背后真正的操作系统窗口。它是目前工作区里
唯一的桌面壳基础层——如果出现第二个桌面壳后端，会实现同样的
`UseWindowControls` 形状，而不是让这个库再长出第二套后端。

<!-- readme:boundary -->

## 它刻意不做的事

- 没有 preload/IPC 层——Tauri 的 webview 通过 `@tauri-apps/api/window` 直接
  驱动自己的窗口，所以 `useWindowControls` 就是全部的桥接层；那种分层属于
  真正需要 IPC 跳转的壳层。
- 不配置无边框窗口——那属于 host app 自己的 `tauri.conf.json`
  （`app.windows[].decorations: false`）及其 Rust 壳层。
- 没有窗口尺寸策略——那是每个 app 自己的产品决策（见 core-ui 的 Design
  System › Principles §4）。
- 公共接口里不带任何 Tauri 类型——`UseWindowControls` 是一个纯粹的形状
  （`isMaximized` ref 加三个函数），这样第二个桌面壳后端可以实现它而无需
  改动 host app 的 `TitleBar` 接线。

<!-- readme:status -->

## 状态

已构建完成，带有单元测试（在模块边界 mock `@tauri-apps/api/window`），
仓库里还没有 host app 使用它。真实运行时的验证属于未来 host app 的 e2e
套件，不属于这个库。机制与不变量见 [`CLAUDE.md`](./CLAUDE.md)。
