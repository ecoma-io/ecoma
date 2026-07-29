> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# Ecoma

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
pnpm install

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
自行部署和修改。fair-code 保留的,只是 OSI 许可证无法保留的那一项自由:把
Ecoma 本身作为服务出售。正因为保留了这一条,其余部分才能够开放。

**目前尚未授予任何许可证。** Sustainable Use License 正在准备中、尚未完成法务
审阅,因此在它生效之前,法律状态仍是 © Ecoma,保留所有权利。对已经发布出去的代
码而言,授予许可证是**不可撤回**的——这也是为什么这段话是一个**状态说明**,而不
是一处待填的占位。

`shared/libs/doctrine/` 目录下的文档则已单独授权,自即日起生效:
[CC BY-SA 4.0](./shared/libs/doctrine/LICENSE)。
