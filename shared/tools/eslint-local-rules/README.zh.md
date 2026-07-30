---
name: eslint-local-rules
subsystem: shared
lang: zh
description: 自研 ESLint 规则，强制执行本工作区自身的准则，而非通用语法检查。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# eslint-local-rules

<!-- readme:why -->

现成的 ESLint 插件只能检查通用语法和常见模式，无法识别本仓库自身的准则。它们
不知道 `v2`/`wip`/`phase-3` 属于被禁止的 journey marker(Rule 13),不知道
单元测试(`*.test.ts`)必须对每个导入的内部协作模块使用 `vi.mock`,不知道已
提交的 `.only`/`.skip` 属于违规,也不知道每个 `project.json` 必须恰好声明一个
`type:*` 标签和一个 `scope:*` 标签。这里的每条规则都直接挂钩 AST,用来强制
执行一条这样的仓库专属约束,统一放在 `local/` 插件命名空间下:
`no-journey-markers`、`no-journey-marker-names`、
`no-focused-or-skipped-tests`、`no-unmocked-internal-imports`,以及
`require-project-tags`。`test-call-chain.mjs` 不是规则——它是一个共享的
解析器,让 `no-journey-markers` 与 `no-focused-or-skipped-tests` 能识别同一套
测试链式调用形态(`it.each(...)`、`it.only.each(...)` 等)。

<!-- readme:consumers -->

每个规则模块都在根目录的 `eslint.config.mjs` 中以 `local/` 插件命名空间接入,
因此会作为普通 ESLint 规则通过各个项目自己的 `lint` target 运行——也就是说,
工作区里的每个项目都是间接消费者。没有单独的调用路径:`pnpm nx affected -t
lint` / `pnpm nx run-many -t lint` 会运行它,lefthook 的 pre-commit 钩子会对
暂存文件运行它,CI 会对整棵树重新运行一遍。

<!-- readme:ecosystem -->

本项目是强制执行 Rule 13(journey marker)的 AST 那一半;另一半是 `dev-cli`
的 `check-journey-markers`,负责扫描 ESLint 触及不到的部分——非 JS/TS/Vue
文件内容、文件/目录名,以及 Nx target 名。两者读取同一个 pattern 来源——仓库
根目录的 `journey-markers.config.json`——因此修改规则只需改一处。在
`shared/tools` 中,本项目与 `dev-cli`、`repo-care` 是同级关系:是整个工作区
都依赖的工具,但自身不依赖任何产品领域。

<!-- readme:boundary -->

这里不是重新配置标准 ESLint 规则的地方——那属于根目录 `eslint.config.mjs`
的职责。这里的每个规则模块都刻意保持零依赖,测试也是如此:测试是纯 `node`
脚本(`<name>.test.mjs`),不使用 Vitest。`test` target 通过 `dev-cli` 的
`run-node-tests` 在 Node 自带的测试运行器上运行它们,由它把测试守在
`coverage.config.json` 声明的工作区覆盖率下限上——这是委托而非依赖:不会因此
安装任何东西。本项目没有 build,也没有 typecheck 步骤。

<!-- readme:status -->

五条规则目前都已在根目录 `eslint.config.mjs` 中真实启用——没有哪条规则是写
完就被遗忘、未接线的。新增规则的机制与注意事项见
[`./CLAUDE.md`](./CLAUDE.md)。
