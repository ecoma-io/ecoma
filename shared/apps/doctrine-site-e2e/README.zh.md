---
name: doctrine-site-e2e
subsystem: shared
lang: zh
description: 驱动已构建 doctrine 站点的 Playwright 套件,验证组装结果确实是浏览器能打开的页面。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# doctrine-site-e2e

<!-- readme:why -->

## 为什么需要它

doctrine 站点是由生成器从 Markdown 组装出来的。单元测试层无法告诉你组装是否成功
——首页是否在挂载路径上响应、侧边栏能否走到一份文档、许可证是否出现在读者会看到
的位置。这些都是关于**已构建产物**在真实浏览器中的事实,而这里正是验证它们的地
方。

<!-- readme:consumers -->

## 谁在使用它

CI(作为阻塞式检查),以及在本地修改 `doctrine-site` 的人。

<!-- readme:ecosystem -->

## 它处在什么位置

位于 `shared/apps` 中 `doctrine-site` 旁边,与 `design-system-e2e` 之于
`design-system` 完全对应。e2e 项目从不与它所驱动的代码放在一起——它从外部驱动一
个已构建的产物。

<!-- readme:boundary -->

## 它刻意不做的事

- **不对内容下判断。** 一份文档说得对不对,是文档要回答的问题,不是浏览器的。
- **不覆盖单元层。** 导航逻辑已在 `@ecoma-io/doctrine` 中被测试固定。
- **不负责构建。** Nx target 通过 `dependsOn` 先行构建。

<!-- readme:status -->

## 状态

已运行:针对外壳的四项检查,外加四项证明页面来自 `shared/libs/doctrine` 而非某份
副本的检查——做法是改动那个库,然后去看。它们随站点一起生长,而不会跑在站点前
面。目录范围内的具体机制见 [`./CLAUDE.md`](./CLAUDE.md)。
