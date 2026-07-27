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
- [安全策略](./SECURITY.md) —— 如何报告漏洞

## 许可证

专有且保密 —— © Ecoma。保留所有权利。这是闭源软件,不是开源项目。
