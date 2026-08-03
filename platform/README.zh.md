---
name: platform
lang: zh
description: Platform 区域 — 沿六边形 layer 轴切分的 Ecoma 引擎，以及为路线图已开启的每个 gate 充当仲裁者的 conformance 套件。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# platform

承载劳动操作系统引擎的区域：它的 domain 词汇、该词汇暴露的 port、这些 port
背后的 adapter，以及为各个 gate 充当仲裁者的套件。内部结构不是习惯 —— 它
是一个决定，记录在
[ADR-0008](../shared/libs/doctrine/method/subsystem-structure.md)，而这棵树
逐行实现该决定。

<!-- readme:why -->

## 为什么存在

区域就是一个顶层目录，它在落地首个 project 的那次变更中生根，而不是提前
预留。`platform/` 此刻配得上它，是因为引擎必须落在既非产品表面、也非跨产
品基座的地方：`shared/` 必须能被每个 scope 导入，而人人都能导入的引擎，也
就是谁都替换不掉的引擎。树内按六边形 layer 轴而非按功能切分，使得未来每一
次 import 的方向只被决定一次 —— 在 `layer:` 标签上 —— 而不是在每个 pull
request 里重新争论。

<!-- readme:consumers -->

## 谁消费它

区域之外暂时没有，这正是此刻应有的状态：`engine-domain`、`engine-ports` 和
`engine-adapters` 将由稍后出现的 application service 与 composition root 消
费，而 `conformance-g0` 直接消费 port 与 adapter，因为它必须在任何
application service 存在之前就能运行。工作区门禁今天就消费整棵树 —— 这里
的每个 project 都携带 `lint`、`test`、`typecheck` 和 `build`，套件另外携带
`conformance`，也就是 `dev-cli conformance` 所运行的 target。

<!-- readme:ecosystem -->

## 它位于哪里

仓库根目录是它的父目录，与 `shared/` 和 `website/` 一样。两个 domain 共享
的契约绝不住在其中任何一个里 —— 它属于 `shared/packages/`，以 Apache 2.0
授权，那里也是第二个产品区域唯一可以依赖的家。在这棵树内方向是
`layer:domain` → `layer:port` → `layer:adapter`；职责恰是把 adapter 接进
port 的 composition root，刻意不带任何 layer 标签。目录级机制见
[`platform/CLAUDE.md`](./CLAUDE.md)。

<!-- readme:boundary -->

## 它刻意不做的事

它不设 `packages/` 层：该层是给第三方接收的单元准备的，而这里还没有任何东
西被许诺给谁。它也不承载产品表面 —— 商店是 `website/`，doctrine 站点与设
计系统是共享的应用外壳。它同样不决定 wire contract：domain 词汇与 wire
contract 是两回事，协议 schema 与它自己的 bindings 放在一起，而不在这棵树
里。

<!-- readme:status -->

## 状态

已脚手架，刻意留空。`engine-domain` 带着将来拆分要沿之切开的 package 接缝，
`engine-ports` 与 `engine-adapters` 只带着各自的角色，`conformance-g0` 带着
一个已命名的套件骨架，其断言将与它所检查的那些 interface 一同落地。这里的
layer 与 licence 边界**由评审把关，而非由机器检查** —— 每个 library 都是
Go，而工作区里没有任何东西解析 Go 的 import。目录级机制见
[`./CLAUDE.md`](./CLAUDE.md)。
