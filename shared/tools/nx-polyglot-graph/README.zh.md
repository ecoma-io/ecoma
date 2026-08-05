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
上传到 GitHub code scanning。

### 在编辑器里运行它

`lsp.mjs` 通过 stdio 说 Language Server Protocol,为每一条边界违规发布一
条诊断,带着 `@nx/enforce-module-boundaries` 对同一个 import 会报出的那个
`messageId`。它分析不了的文件会收到一条明说这一点的诊断——所以这个 server
给出的空诊断列表永远意味着"没有违规",绝不意味着"没有检查"。

之所以是编辑器而不是 ESLint 插件:ESLint 插件只够得着 JS 和 TS,也就是本
来就能用的那一半;Go、Rust、Python 和 Vue 什么都得不到。

**Claude Code** 从本仓库自己的插件目录 `.claude/plugins` 加载它。
`.claude/settings.json` 带着 `enabledPlugins` 条目;注册 marketplace 是每
个开发者的一次性动作,因为仓库本身无权声明——`extraKnownMarketplaces` 只从
user、flag 和 managed settings 读取,这样一个 checkout 就无法让会话运行其
机器主人从未同意过的插件代码:

```shell
claude plugin marketplace add ./.claude/plugins
```

之后,会话每次编辑 Go、Rust、Python 或 Vue 文件都会拿到边界诊断。server 声
明是那个插件 `plugin.json` 里的 `lspServers`;JS 和 TS 被刻意留给 ESLint,
因为编辑器每个文件扩展名只给一个 server,认领它们会挤掉开发者在那里真正需
要的语言服务器。

**任何其他 LSP 客户端**启动的是同一个可执行文件:

```text
command                node <workspace>/shared/tools/nx-polyglot-graph/lsp.mjs
transport              stdio
initializationOptions  { "workspaceRoot": "<workspace>" }
                       —— 仅在编辑器的根目录不是工作区根目录时需要
watched files          **/module-boundaries.config.mjs 和 **/project.json
```

工作区根目录依次取自 `initializationOptions`、`workspaceFolders`、
`rootUri`、`rootPath`,最后是工作目录。只声明全文本同步。支持动态注册的客
户端会被要求监视上面那两个文件,这样一次约束变更就会重新诊断所有打开的文
件。做不到的客户端会在 stderr 上被告知,此后只有当那个文件是通过编辑器本
身保存时才会看到约束变更——在编辑器之外改动它则不会。

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

两半都在运行。`src/rules/` 在分析记录之上(而不是 ESLint 的 AST)复现了
`@nx/enforce-module-boundaries` 全部十五种违规类型及其八个选项。`cli.mjs
check` 读取 Nx 图,分析一个项目拥有的每一个被跟踪的源文件,一旦有违规就以 1
退出,并给出 `file:line:column` 报告或 SARIF 2.1.0。`lsp.mjs` 把同一个引擎服
务给编辑器,为每条违规发布一条诊断——或者发布一条说明它看不了的诊断,绝不
会给出一个它并未挣得的空列表。

两个执行器有意并行运行。ESLint 对 JavaScript 和 TypeScript 保持权威;本工具
覆盖 ESLint 完全读不了的 Go、Rust 和 Python。`src/conformance/` 度量两者在哪
里一致、在哪里不一致,任何让其中一方退休的决定都要以它为依据。机制、各语言
的解析限制,以及一个项目一个清单的建模假设,都在
[`./CLAUDE.md`](./CLAUDE.md) 里。
