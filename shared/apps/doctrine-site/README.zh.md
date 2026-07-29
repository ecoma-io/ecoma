---
name: doctrine-site
subsystem: shared
lang: zh
description: 用 VitePress 构建、在 ecoma.io/doctrine 发布 doctrine 文档树的站点——只负责渲染,从不承载写作。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# doctrine-site

<!-- readme:why -->

## 为什么需要它

ecoma 的设计在文档里定下来,而这些文档是对外公开的。这里就是公开它们的界面:一
个静态构建,随每次发布切出,以路径形式挂载在同一个域名下,与设计系统并列。

它只做渲染,别无其他。页面内容全部来自 `shared/libs/doctrine`,因此一份文档不可
能只存在于站点上、却不存在于工作区能够检查的那棵树里。

<!-- readme:consumers -->

## 谁在使用它

读者,通过 `ecoma.io/doctrine`。挂载点归边缘路由所有,本应用只需与之保持一致。

`doctrine-site-e2e` 驱动构建产物,是唯一的自动化使用方。

<!-- readme:ecosystem -->

## 它处在什么位置

放在 `shared/`,理由与文档树相同:顶层文档覆盖所有产品领域,因此无论内容还是它
的展示界面,都不属于任何单一产品。先例完全对应——`/design` 由
`shared/apps/design-system` 提供,建立在 `shared/libs/core-ui` 之上。

<!-- readme:boundary -->

## 它刻意不做的事

- **不承载写作。** 内容属于库;只写在这里的页面,就是不受任何 gate 约束的
  doctrine。
- **不自动推导侧边栏顺序。** 字母序不是阅读顺序。
- **没有运行时。** 静态产物,由部署层负责分发。

<!-- readme:status -->

## 状态

已搭好骨架:外壳可以构建,e2e 在两个占位页面上通过。顶层文档将在单独的变更中迁
入。目录范围内的具体机制见 [`./CLAUDE.md`](./CLAUDE.md)。
