> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# Ecoma

[![CI](https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ecoma-io/ecoma/badge)](https://scorecard.dev/viewer/?uri=github.com/ecoma-io/ecoma)

[ecoma.io](https://ecoma.io) · [Doctrine](https://ecoma.io/doctrine)

Ecoma 是一个可自托管的、"fair-code" 的劳动操作系统(labor operating
system),在其中人类、AI、以及规则/代码共同扮演同一类劳动资源(Role/
Filler);工作流——无论是确定性流程还是推理型任务——都由人类与 AI 直接在
引擎内共同设计;每一个输出都要经过一个 checkpoint,其置信度会根据各租户
自身的数据动态调整;人类的注意力(human attention)被视为一种需要被度量
和优化的资源。

## 如何阅读这个仓库

每个子项目都带有**两份文档,面向两类读者**:

- **`README.md` —— 面向人类。** 这是什么、为什么存在、以及它刻意**不**
  做什么。从这里开始阅读。
- **`CLAUDE.md` —— 面向编码 agent。** 目录范围内的机制:不变量、隐坑
  (footgun)、配对规则、运行命令。人类也可以读,但它假定你已经知道这个
  东西是用来做什么的。

工作区级别的原则与约定位于根目录的 [`CLAUDE.md`](./CLAUDE.md)。

## 快速开始

```bash
# 验证工具链并搭建仓库——依赖、git hooks,以及 e2e 套件所需的 Playwright
# Chromium。详见 CONTRIBUTING.md。
pnpm run setup

# 设计系统的 Storybook
pnpm nx run design-system:serve

# 一次代码改动的完成标准(definition of done)
pnpm nx affected -t lint test typecheck build e2e
```

`pnpm nx` 是唯一的任务运行器。约定与架构方面的决策记录在
[`CLAUDE.md`](./CLAUDE.md) 以及提交历史中。

## 参与贡献

- [贡献理念](./CONTRIBUTING.md) —— 我们的协作方式
- [行为准则](./CODE_OF_CONDUCT.md) —— 社区规范
- [安全策略](./SECURITY.md) —— 如何报告漏洞

## 许可证

Ecoma 采用 **fair-code**:源码公开,**不是开源(open source)**,同时也**不是
闭源软件**。这三者并不相同,而它们之间的差别恰恰是关键所在。

源码是公开的,并且会一直如此——产品向租户承诺的每一项机制,都写出来供人阅读、
自行部署和修改。fair-code 保留的是**商业性的再分发**,其中最典型的就是把
Ecoma 本身作为服务出售。正因为保留了这一条,其余部分才能够开放。

**本节是便于快速阅读的摘要,不是条款。** 具有法律效力的是
[`LICENSE`](./LICENSE);当摘要与条款不一致时,**以条款为准**。

| 路径                           | 条款                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| 下表未列出的其余部分           | Sustainable Use License                                                            |
| `<subsystem>/packages/`        | Apache License 2.0 —— 供第三方对接的部分                                           |
| `<subsystem>/enterprise/`      | **不授予任何权利** —— 需另行签署书面 [Enterprise License](./ENTERPRISE-LICENSE.md) |
| `shared/libs/doctrine/**/*.md` | [CC BY-SA 4.0](./shared/libs/doctrine/LICENSE.docs),含这些文件所引用的图片         |
| `cloud/`                       | 专有,且不公开                                                                      |
| 第三方组件                     | 依其各自权利人的条款                                                               |

自行部署 Ecoma 来运营你自己的组织是**明确允许**的,无论是否用于商业目的,也包
括用它来生产并向你自己的客户交付商品和服务。**不被允许**的是以**商业目的或收取
费用**的方式把 Ecoma 提供给他人——无论采取何种形式:出售副本、捆绑进另一个收费
产品,或者最典型的,替他们运行为托管服务。向他人分发,只有在**既免费又非商业**
时才被允许。把 Ecoma 嵌入你自己的更大产品另有一项三条件测试——请阅读 `LICENSE`。

构建过程会**检查这份声明**,而不是靠记忆:每个 project 都声明一个 `license:*`
标签,当标签与它自身所在的目录不一致时,约定检查会失败。那是针对代码树所声明内
容的一项 lint —— 真正具有法律效力的是 `LICENSE`。

参与贡献需要一次性同意 [`CLA.md`](./CLA.md)。这里的任何许可证都不授予“Ecoma”
这一名称的任何权利。
