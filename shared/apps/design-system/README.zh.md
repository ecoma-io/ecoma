---
name: design-system
subsystem: shared
lang: zh
description: 工作区的 Storybook 宿主应用——把 core-ui 的 story 与设计文档构建为静态站点，供 e2e 检查扫描，也将由未来的 ecoma.io 网站发布。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# design-system

工作区设计系统的 Storybook 宿主应用：负责渲染 `core-ui` 的 story
与设计文档的外壳。它自身不提供任何组件——所有内容都在 `core-ui`
中；这个应用拥有的是宿主本身，把这些内容变成一个可运行的站点和一份可部署的
构建产物。

<!-- readme:why -->

## 为什么存在

工作区的 library 按 practice 是 buildless 的，但 Storybook 是一次构建：它产出
`storybook-static`，一份拥有自己生命周期的构建产物——`design-system-e2e`
把它作为阻断式检查来扫描，规划中的 ecoma.io 网站也将把它作为设计系统栏目
发布。把 Storybook 宿主放进一个应用，让这份构建产物拥有一等公民的归属，同时
`core-ui` 仍是纯粹的 buildless library。

<!-- readme:consumers -->

## 谁在使用它

开发者，通过 `pnpm nx run design-system:serve`——开发态 Storybook（端口
6008），带实时无障碍面板。`design-system-e2e`，通过
`pnpm nx run design-system:build`——它的 Playwright 检查扫描已构建的输出。
另外，按已记录的设计意图，未来的 ecoma.io 网站会把已构建的 Storybook
挂载为它的一个栏目。

<!-- readme:ecosystem -->

## 它在生态中的位置

标签为 `type:app`、`scope:shared`，并声明
`implicitDependencies: ["core-ui"]`——story glob 伸进了 `core-ui`
的目录树，这是任何 import 图都看不见的一条边。可用的 target 有 `build`、
`serve`、`lint`。主题源（`tailwind.preset.js`）与所有 story 仍留在
`core-ui`；这个应用只持有宿主接线：Storybook 配置、`tailwind.config.js`，
以及 Tailwind v4 所要求的 `postcss.config.js` shim。

<!-- readme:boundary -->

## 它刻意不做的事

它不提供任何组件，也没有公共 API——`@ecoma-io/ui` 始终是 `core-ui`
的内部别名，永远不是一个 npm 包。它没有 `typecheck` 或 `test`
target：这里的一切都是由 Storybook 自身工具链执行的宿主配置，它渲染的每个
组件都在 `core-ui` 中完成 typecheck 与测试。它也不是阻断式的无障碍检查——
那是 `design-system-e2e` 的职责。

<!-- readme:status -->

## 当前状态

构建并运行完整的设计系统 Storybook——`core-ui` 的每个 story
与设计文档，story ID 归内容所有，而不归这个宿主。相关机制——派生的 Vite
别名、Tailwind 的 jiti 陷阱、PostCSS shim，以及已记录的网站接缝——记录在
[`./CLAUDE.md`](./CLAUDE.md) 中。
