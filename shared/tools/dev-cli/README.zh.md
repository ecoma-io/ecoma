---
name: dev-cli
subsystem: shared
lang: zh
description: 本地开发命令行工具，把仓库里的一条条准则变成机器强制执行的关卡，而不是容易被遗忘的散文规定。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# dev-cli

本地开发命令行工具，把 `CLAUDE.md` 里的规则从"希望大家都记得"变成"忘记了
commit/push/merge 就直接过不去"。

<!-- readme:why -->

## 为什么存在

这个仓库里有几十条规则，只有持续被检查才真正有效：Rule 13（禁止 journey
marker）、每个 subproject 都要有自己的 `CLAUDE.md`、commit 的 scope 必须
和改动的路径匹配、每张 practice card 都必须仍然指向它引用的那句原文。如果
这些规则只写在 `CLAUDE.md` 的散文里，它们会慢慢失效——人会忘记，agent 也
会忘记，而且没有人违反时也不会有任何警报。`dev-cli` 就是让每条规则变成一
个返回退出码的小函数，并挂接到 commit/push/CI 生命周期里正确的那个环节，
从而让 practice 变成机器强制执行的东西，而不只是文档。原本分散的各个脚
本，现在统一收在一个注册表里（`src/main.mjs` 里的 `COMMANDS`），用同一种
方式调用：`node shared/tools/dev-cli/src/main.mjs <command>`。

<!-- readme:consumers -->

## 谁在用它

并不是每个命令都挂在某个 gate 上——真正决定哪个命令能拦住什么的，是
`lefthook.yml` 和 `.github/workflows/ci.yml`：

- **lefthook pre-commit**：`check-journey-markers-workspace`、
  `check-doc-links`、`check-command-refs`、`check-doctrine`、`check-practice-index`、
  `ensure-commit-identity --check`。
- **lefthook prepare-commit-msg / commit-msg**：`strip-claude-trailers`、
  `check-commit-scope`。
- **CI**（`.github/workflows/ci.yml`）：`check-commit-scope --commit <sha>`
  （对 PR 里的每个 commit 各跑一次）、`check-contributor-record`（pull request
  上带 PR 作者参数，其余情况裸跑）、以及 `workspace-gates`——把所有
  workspace 级 gate 收进一个命令，清单由 `src/workspace-gates.mjs` 里的
  `WORKSPACE_GATES` 拥有，而不是在这里或 workflow step 里再抄一份。cloud
  仓库的 CI 在合并树上跑的正是同一个命令，这也是清单是一个命令而不是一串
  step 的原因。
- **每个 project 自己的 `lint` target**（`project.json`——几乎覆盖仓库里
  所有 subproject，包括 `dev-cli` 自己）：以 per-project 的方式跑
  `check-journey-markers`。`check-primitive-artifacts` 只挂在 `core-ui` 的
  `lint` 上，因为它检查的约定只属于那一个 project。
  `check-e2e-story-coverage` 只挂在 `design-system-e2e` 的 `lint` 上：它要求
  `core-ui` 的每个 component 都拥有 story，因为正是 story 让 component
  进入该 suite 的 a11y 扫描范围。`check-gofmt` 只挂在刚 scaffold 出来的 Go
  project 自己的 `lint` 上（`scaffold-lib`），因为目前还没有其他 Go
  project 可以让它运行。
- **`commitlint.config.mjs`** 直接 import `check-commit-scope.mjs` 的
  project/subsystem discovery 来构建 `scope-enum`——scope 列表只有一个真源；
  `list-scopes` 打印出同一套推导结果，供手动查阅。
- **没有挂在任何 gate 上**——按需手动调用，或者由 agent skill 调用，而不
  是持续强制执行：`scaffold-lib`（`scaffold-lib` skill）、`pr-facts`
  （`create-pr` skill）、`run-e2e`（各个 `*-e2e` app 的 `e2e` target）、
  `run-node-tests`（`eslint-local-rules` 的 `test` target，全仓唯一使用 Node
  自带测试运行器的 project）。

<!-- readme:ecosystem -->

## 在生态中的位置

`dev-cli` 强制执行的是**源代码和仓库约定**，无论是本地（lefthook）还是
CI 里。它从不触碰 GitHub 本身的界面（issue、PR 评论）——那是
[`repo-care`](../repo-care/README.zh.md) 的职责，同属 `shared/tools` 下的
兄弟工具，它会消费 `check-practice-index` 的同一份数据源
（`practice-index.json`）来生成自己的 PR review 评审标准。`dev-cli` 也是
唯一存放 Rule 13 检测逻辑的地方（`check-journey-markers`，读取仓库根目录
的 `journey-markers.config.json`），
[`eslint-local-rules`](../eslint-local-rules/README.zh.md) 复用同一份
pattern 数据源来实现对应的两条 ESLint 规则——这是同一条规则的两层强制执行
（文件名/内容匹配 vs. AST 匹配），而不是两份互相独立的拷贝。

<!-- readme:boundary -->

## 边界

不是一个 CLI 框架——参数解析刻意保持极简（见 `main.mjs` 开头的注释）；只
有当真正有多个命令都需要框架时才值得换。没有 build，没有 typecheck（刻意
使用纯 ESM 的 `.mjs`）。不是自然语言判断发生的地方——这里的每个命令都是
确定性检查（Rule 5）。像 PR review、issue 分类这类需要判断的工作属于
`repo-care`，不属于这里。

<!-- readme:status -->

## 现状

对大多数命令来说，它已经是真正在运行的 gate，而不是草稿。每个命令的机制、
不变量和坑点详见同目录下的 [`CLAUDE.md`](./CLAUDE.md)。
