---
name: conformance-g0
subsystem: platform
lang: zh
description: 仲裁第一个 gate 的套件 —— Event Log 条目模式、两种栈上的日志存储与 blob-CAS 契约、Lease，以及 Principal identity。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# conformance-g0

一个 gate 是一份冻结的文本，加上一个能独立运行的套件；没有套件的 gate 是纸面
gate。本 project 就是第一个 gate 的那个套件，而它的范围是封闭的，不是开放的。

<!-- readme:why -->

## 为什么存在

冻结一个 interface 是一个承诺，而无人能核对的承诺只是一份文档。本套件覆盖的
五个契约领域，恰好就是该 gate 所冻结的内容：Event Log 条目模式、在两种栈上运
行的日志存储 port 契约、在两种 blob 后端上运行的 blob-CAS 契约、Lease 契约，
以及 Principal identity。在这个 gate 之下，永远不会有别的 —— 在冻结时就已声明
的增长是承诺的兑现，冻结之后的增长则是破坏。

<!-- readme:consumers -->

## 谁在使用它

conformance 执行器：它通过 `conformance` target 与 gate 标签找到本 project，
并在 gate 账本中报告它。提议把该 gate 的文档翻为冻结状态的人也消费它：本套件
转绿是那个动作的前置条件，而不是它之后的收尾。

<!-- readme:ecosystem -->

## 它在生态中的位置

位于 `platform/` 区域内，与它所仲裁的东西并列 —— 绝不在其内部。它直接驱动
`engine-ports` 与 `engine-adapters`，不依赖任何 application service，因为它必
须在其存在之前就能运行。给在此编辑文件的人准备的机制见
[`./CLAUDE.md`](./CLAUDE.md)。

<!-- readme:boundary -->

## 它刻意不做的事

它不带 `layer:` 标签：port 契约必须够到 adapter 才能在两种栈上运行，而任何
layer 标签都会恰好禁止这一点。它也不执行冻结 —— 那仍是一个带后果的人类动作。
它同样不仲裁该 gate 留白的存储行为；SQL-read、metrics-projection 与密钥存储契
约作为普通测试住在 `engine-adapters`。

<!-- readme:status -->

## 状态

一个诚实的骨架：五个文件，每个契约领域一个，各自以 TODO 列出自己的用例。
**目前没有任何测试函数** —— 一个通过的空测试会把无人核对的契约报告为已核对，
所以 `go test` 只是在零个用例上转绿，账本读到一个套件、零个冻结。断言将与它们
所检查的 interface 一同落地。目录级机制见 [`./CLAUDE.md`](./CLAUDE.md)。
