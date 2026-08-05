---
name: nx-polyglot-graph
subsystem: shared
lang: zh
description: 本地 Nx 图插件，通过静态读取 manifest 为 Go/Rust/Python 添加跨项目依赖边。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# nx-polyglot-graph

<!-- readme:why -->

## 为什么存在

`pnpm nx affected` 只有在依赖关系体现为 Nx 项目图里的一条边时才会知道它存
在,而 Nx 自身的图推断完全不理解 Go 的 import、Cargo 的 path 依赖,或者
`[tool.uv.sources]` 里的一条条目。没有这个插件,修改一个 Go 库永远不会把
兄弟 Go 项目标记为 affected,从而在不声不响间让工作区里每一个多语言项目
的 `pnpm nx affected -t lint test typecheck build e2e` 失效。社区里针对这个问
题的插件(gonx、`@nxlv/python`)是连同 target 一起从工具链推断出来解决
的——但这个仓库刻意把 target 保持为每个 `project.json` 手写的内容(根
`CLAUDE.md` → Workspace Execution),让 `nx.json` 的 `targetDefaults` 和每
个多语言项目自己的 `nx:run-commands` 始终是 target 该做什么的唯一真源。
这个插件存在的意义,只是补上缺失的那些边,而不是把 target 推断偷偷带回
来。

同一个缺口还有另一半。`@nx/enforce-module-boundaries` 只读 JavaScript 和
TypeScript,所以在 Go 或 Rust 项目里,`layer:`、`scope:` 和 `license:` 这些
标签只是没有任何机制托底的声明:给一个 `.go` 文件加上违反 layer 轴的
import,图里照样出现这条边,`lint` 照样通过。这个项目正是那套机制被建起来
的地方,所以它现在除了图插件之外,还带着一个分析层和自己的入口点。

<!-- readme:consumers -->

## 谁在使用它

Nx 本身。它在 `nx.json` → `plugins` 下注册为
`./shared/tools/nx-polyglot-graph/index.mjs`,并在 Nx 构建自己的项目图的
任何地方运行——`nx affected`、`nx graph`、`nx run-many`。没有任何产品代码
或工具代码直接导入它。

它还在自己的 `package.json` 里以 `bin` 条目声明了两个可执行文件:
`cli.mjs` 用于终端运行,`lsp.mjs` 用于编辑器。`cli.mjs check` 已经是一个真
正的检查器,并且已经接成门禁——`lefthook.yml` 的 pre-push 列表在整个工作区
上运行它,`.github/workflows/ci.yml` 在一个独立的 job 里运行它并把它的 SARIF
上传到 GitHub code scanning。`lsp.mjs` 仍然不声明任何 capability,而不是把
每个文件都涂绿。

<!-- readme:ecosystem -->

## 它在生态中的位置

它与 `shared/tools` 下的 `dev-cli`、`eslint-local-rules`、`repo-care` 是同
级关系——都是工作区工具,而不是任何产品的运行时依赖。它是对每个多语言
项目手写 `project.json` 的补充,而不是替代:那些文件声明项目本身及其
`build`/`test`/`lint` target(Go/Rust/Python 通过 `nx:run-commands` 调用
`go`/`cargo`/`uv`),而这个插件只负责在它们之间添加边,让 `nx affected`
能够看穿语言边界。

<!-- readme:boundary -->

## 它刻意不做的事

它从不创建项目节点,也从不推断或附加 target——节点和 target 始终由每个
项目自己的 `project.json` 手写。各个 resolver 从不 shell 调用
`go`、`cargo` 或 `uv`;它们只读取已被 git 追踪的 manifest 和源文件(用正
则解析 gofmt 规范格式的 Go import,用 `smol-toml` 解析
`Cargo.toml`/`pyproject.toml`),因此即便机器从未安装过这些工具链——包括
CI 的文档门禁步骤和只写 TS 的贡献者——图依然能算出来。它也从不把外部包
(crates.io、PyPI、Go module proxy)记录为 `externalNodes`——对
`nx affected` 有意义的只有项目与项目之间的边。

它也不会把边界规则再抄一遍。约束表只存在一处,即工作区根目录的
`module-boundaries.config.mjs`,那正是 ESLint 也在读的文件;这里只有
`src/config.mjs` 会加载它。而且这里没有任何东西假定本仓库的项目名、区域或
标签取值——这个工具还要在私有的控制平面工作区里运行,所以一切都来自图和
那份配置。

<!-- readme:status -->

## 状态

图这一半正在运行且是真正的 gate:它是工作区图中 Go/Rust/Python 跨项目边的
唯一来源,每个 resolver 都有对应的单元测试覆盖,外加一个驱动真实 Nx 入
口、基于 tmpdir fixture 的集成测试。

分析这一半已经是真的了。`src/analysis/` 把 TypeScript、JavaScript、Vue、
Go、Rust 和 Python 的源码读成已解析的 import 记录——写下的是哪一个 import、
在第几行第几列、以什么形式、指向什么——遵循 `src/analysis/contract.md` 里
定死的记录形状。TypeScript 的解析用的是 TypeScript 自己的
`ts.resolveModuleName`,Vue 的 `<script>` 提取用的是 Vue 自己的 SFC
parser;两者都没有在这里被重写。

强制执行这一半已经在跑了。`src/rules/` 在分析记录之上(而不是在 ESLint 的
AST 之上)复现了 `@nx/enforce-module-boundaries` 的全部十五种违规类型及其八
个选项;`cli.mjs check` 读取 Nx 的图,分析每个项目所拥有的、被 git 跟踪的
源文件,只要有任何违规就以 1 退出,并给出 `file:line:column` 报告或
SARIF 2.1.0。两个执行器并行运行是有意为之:在一套 conformance 套件证明二者
一致之前,JavaScript 和 TypeScript 仍以 ESLint 的判定为准。

面向编辑器的那一半仍然只是骨架,而且是一副很吵的骨架:`lsp.mjs` 不声明任何
capability,而不是把每个文件都涂绿。机制、每种语言的解析边界,以及
one-manifest-per-project 的建模假设都写在 [`./CLAUDE.md`](./CLAUDE.md)。
