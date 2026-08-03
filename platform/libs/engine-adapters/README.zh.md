---
name: engine-adapters
subsystem: platform
lang: zh
description: 引擎各 port 背后的实现 —— 每个后端一个，覆盖两种部署形态 —— 以及仲裁里程碑退出试金石的 port 契约。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# engine-adapters

引擎终于接触到真实事物的地方：一个存储、一个文件系统、一个对象桶。每个 port
都为每种部署形态各有一个实现，绝不用一个共享实现顶着两个名字。

<!-- readme:why -->

## 为什么存在

有两种部署形态要发布 —— 小型栈与参考栈 —— 而"它们行为一致"这个承诺，只值一
个测试所能证明的分量。把所有实现放进同一个 project、置于 `engine-ports` 之
后，正是让它可被证明的做法：契约用例只写一次，然后逐个后端跑过去。这也把后
端选择挡在其他每一层之外，而这正是设置 port 的全部意义。

<!-- readme:consumers -->

## 谁在使用它

composition root 把它们接进 port；除此之外没有东西 import 一个 adapter，因为
以别的方式够到一个存储，恰恰是 port 边界存在的目的所要阻止的。
`conformance-g0` 也会够到它们 —— 没有背后的实现，port 契约就跑不起来。它消费
`engine-ports` 与 `engine-domain`。

<!-- readme:ecosystem -->

## 它在生态中的位置

处于 `layer:domain` → `layer:port` → `layer:adapter` 方向的末端，位于
`platform/` 区域内。给在此编辑文件的人准备的机制见
[`./CLAUDE.md`](./CLAUDE.md)。

<!-- readme:boundary -->

## 它刻意不做的事

它不仲裁任何 gate。三份 port 契约住在这里 —— SQL-read、metrics-projection 与
密钥存储 —— 它们衡量的是某个里程碑的退出试金石而非一个 gate，因此是 `test`
target 下的普通集成测试，并且不带 `conformance` target：套件要么仲裁一个有名
字的 gate，要么什么都不仲裁。它也不持有应用逻辑；在 port 之上的编排属于上面
一层。

<!-- readme:status -->

## 状态

已脚手架，且刻意没有任何 adapter。每个 adapter 将与它所实现的 port 一同落
地，并且成对出现 —— 小型栈的后端与参考栈的后端 —— 其契约用例随之而来，命名为
`*_integration_test.go`。目录级机制见 [`./CLAUDE.md`](./CLAUDE.md)。
