---
name: design-system-e2e
subsystem: shared
lang: zh
description: 基于 Playwright 的阻断式检查，扫描 design-system 应用已构建的 Storybook——axe 无障碍、design token 契约与调色板合规——并附带 story 索引冒烟测试。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# design-system-e2e

这是 `design-system` 应用的 Storybook（渲染 `core-ui` story 的宿主）的 e2e
测试套件。它拥有自己独立的 Nx project，因为本仓库的测试分层禁止把 e2e 测试
与被测代码放在同一目录——详见根目录 `CLAUDE.md`。

<!-- readme:why -->

## 为什么存在

`design-system` 的 Storybook 在开发时会显示一个实时的无障碍面板，但面板只是建议
性的——除非有一个构建步骤会因违规而失败，否则什么都无法阻止违规被发布。
这个套件就是那个步骤：它扫描的是**已构建**的 Storybook
(`storybook-static`)，而不是源码，因为构建过程本身引入的违规——比如样式表
丢失导致对比度塌陷、某个资源返回 404——对任何针对源码运行的扫描都是不可见
的。扫描 operator 实际会打开的那份构建产物，才是重点所在。

同样的道理并不止于无障碍。`tokens.css` 用散文陈述了它的设计法则——elevation
节奏 `--sunken` < `--background` < `--card`、focus ring 即 Human 之力、
`--seam` 从 `--primary` 走向 `--agent`——而其中若干条是靠字面量维系的：它们
重复写出了另一个 token 的值，而不是引用它，因此重新调校某一种力之后，其余
位置只会悄悄指向旧颜色，没有任何东西会失败。本套件现在还会在已构建产物中
解析每一个 token 并检查这些法则，同时扫描每个 story，寻找任何 token 都未
定义的颜色。这两件事都需要真实浏览器：jsdom 既不解析 `var()` 也不解析
`hsl()`，因此单元层只能拿它本应检查的那个文件里抄出来的字符串作比较。

<!-- readme:consumers -->

## 谁在使用它

CI，以及每一位向 `core-ui` 或 `design-system` 应用提交改动的开发者，通过
`pnpm nx run design-system-e2e:e2e`（definition of done 的一部分，见根目录
`CLAUDE.md`）。它才是真正阻止 WCAG 违规合并的机制；开发态的 a11y
面板只是以交互方式展示同一类问题，本身并不阻断任何东西。

<!-- readme:ecosystem -->

## 它在生态中的位置

标签为 `type:e2e`、`scope:shared`，并声明
`implicitDependencies: ["design-system", "core-ui", "dev-cli"]`。它从
`@ecoma-io/ui/a11y` 导入 `WCAG_TAGS`，而不是重新声明一份
WCAG 2.0/2.1 A/AA 标签范围，这样交互面板与这个阻断式检查就永远不会在"什么
算违规"这件事上产生分歧。需要扫描的 story 列表从不手工维护：它从已构建
Storybook 自身的 `index.json` 中读取，因此新增的基础组件一旦有了
story 就会被自动覆盖，被移除的组件也会自动退出覆盖范围。每个 story 都作为
独立的测试被扫描，因此跨多个 story 的回归会被完整报告。这套推导有一个
盲点，而 `lint` 把它堵上了：没有 story 的组件根本不会产生索引条目，因此
`check-e2e-story-coverage` 要求 `core-ui/src` 中的每个组件都必须拥有一个
story。通过
`pnpm nx run design-system-e2e:e2e` 运行，内部经由 `dev-cli run-e2e`（处理
Linux 上的 `xvfb` 以及 Chromium 供应 shim）；可用的 target 有 `lint`、
`typecheck`、`e2e`。

<!-- readme:boundary -->

## 它刻意不做的事

它不对组件做单元测试——那是 `core-ui` 自身 `test` target 的职责，运行在
jsdom 中。它也不测试任何产品应用；这个套件唯一的测试对象就是 `design-system`
应用的 Storybook。

<!-- readme:status -->

## 当前状态

目前覆盖三道阻断式检查——axe 无障碍扫描、design token 契约与调色板合规——
外加一项冒烟测试，确认已构建的 Storybook 会正确提供其 story 索引。这是工作
区中第一个 `type:e2e` project。相关机制——为什么 WCAG 范围是导入而不是重新
声明、为什么 preview server 绕开了 Nx、为什么每个 story 都是独立的测试、
以及为什么每个 token 每次都必须在全新元素上探测——记录在
[`./CLAUDE.md`](./CLAUDE.md) 中。
