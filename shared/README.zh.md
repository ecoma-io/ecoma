---
name: shared
lang: zh
description: 每个产品都会用到的共享库(设计系统、桌面壳 webview 管线)、由工作区拥有的应用外壳(design-system Storybook 及其 e2e 检查)以及工作区工具链(dev-cli、本地 ESLint 规则、repo-care)
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# Shared

这是工作区里每个产品都依赖的基底(substrate)。它是仓库中唯一一棵可以被任何
范围导入的目录树,正因如此,把某样东西放进 `shared/` 的门槛必须很高:只有当
一样东西真正被不止一个产品需要时,它才属于 `shared/`,而不是因为它*看起来*
通用。如果这里提出的某个 lib 目前只有一个真实消费者,那它只是一个待重新审视
的主张(a claim under review),而不是已经定论的事实——下面有几个 lib 直接
说明了这一点。

`shared/libs` 不允许导入任何产品域(product domain),各个域之间也始终相互
独立;这两条约束都由 Nx 强制执行(`@nx/enforce-module-boundaries`,通过各
`project.json` 里的 tag 实现)。该边界的机制以及工具链注册表位于
[`shared/CLAUDE.md`](./CLAUDE.md)——这个文件是给人读的地图,那个文件才是由
机器校验的契约。

## 三个子层

**[`shared/apps`](./apps)** —— 由工作区拥有的应用外壳,服务于共享基础设施,
而不属于任何单个产品。它们之所以存在,是因为一份拥有自己构建与部署生命周期
的产物无法放进 buildless 的 lib 里:

| App                                                       | 它是什么                                              |
| --------------------------------------------------------- | ----------------------------------------------------- |
| [`design-system`](./apps/design-system/README.md)         | 渲染 `core-ui` 的 story 与设计文档的 Storybook 宿主。 |
| [`design-system-e2e`](./apps/design-system-e2e/README.md) | 针对该 Storybook 构建产物的阻断式 Playwright 检查。   |

**[`shared/libs`](./libs)** —— 各产品共用的运行时代码,在构建期被其他 shell
和 lib 消费:

| Lib                                         | 它是什么                                           |
| ------------------------------------------- | -------------------------------------------------- |
| [`core-tauri`](./libs/core-tauri/README.md) | 各桌面 shell 共用的 Tauri webview 管线(窗口外框)。 |
| [`core-ui`](./libs/core-ui/README.md)       | Alloy —— 所有产品 UI 都以此组合而成的设计系统。    |

**[`shared/tools`](./tools)** —— 一个工作坊(workshop),而非产品。这些工具
从不随任何 app 一起发布;它们存在的意义,是让本应逐渐退化成文字说明
(prose)的规则,继续由机器强制执行,而不是仅仅写在纸面上:
[`dev-cli`](./tools/dev-cli/)(本地开发命令,其中一些是 CI 门禁),
[`eslint-local-rules`](./tools/eslint-local-rules/)(本地 ESLint 规则,用机器
方式强制执行现成规则未覆盖的那部分 practice),
[`repo-care`](./tools/repo-care/)(仓库表层自动化——issue 分诊、咨询性质的 PR
practice 评审——运行自 GitHub Actions)。

## 阅读顺序

从仓库根目录的 [`CLAUDE.md`](../CLAUDE.md) 开始,掌握下面一切内容都必须遵循
的 practice(Rules 1–14)。上面每一项都指向对应子项目的 README 以理解"为什
么",以及它的 `CLAUDE.md` 以理解机制——这两类文档被刻意分开维护,彼此不会
重复对方的内容。
