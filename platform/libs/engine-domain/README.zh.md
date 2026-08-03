---
name: engine-domain
subsystem: platform
lang: zh
description: 引擎的 domain 词汇 —— 其他每一层都据以书写的原语，每个概念一个 Go package。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# engine-domain

引擎中纯粹的那一半：只有概念，没有任何与外界交谈的东西。每个概念一个 Go
package —— `eventlog`、`role`、`task`、`checkpoint`、`handoff`、
`escalation`、`calibration`、`composition`、`tenant`、`lease`、`keytree`。

<!-- readme:why -->

## 为什么存在

其他每一层都据这些原语书写，因此它们必须能在不知道谁存储、也不知道什么在
线路上承载它们的前提下被表达出来。把它们放进独立的 library，正是让这一点
可验证而非停留于愿望的做法：一个 `layer:domain` 的 library 只能触及 domain
与 util，于是泄漏的依赖出现在编译器处，而不是出现在评审里。

<!-- readme:consumers -->

## 谁在使用它

`engine-ports` 用这套词汇为自己的 interface 命名，`engine-adapters` 实现那些
interface，随后出现的 application service 与 composition root 在其上编排。
`platform/` 区域之外没有东西消费它，而它自己什么都不消费。

<!-- readme:ecosystem -->

## 它在生态中的位置

位于 `layer:domain` → `layer:port` → `layer:adapter` 方向的最前端。内部的
package 边界是一条已命名的接缝：当某个 package 赢得独立的消费者时，它被提升
为自己的 library —— 保持原有 import path —— 在此之前不动。给在此编辑文件的人
准备的机制见 [`./CLAUDE.md`](./CLAUDE.md)。

<!-- readme:boundary -->

## 它刻意不做的事

它不做 I/O，也不讲任何 wire format。它拥有 Filler 这个概念，却从不拥有
Filler 的 wire contract —— 这是两回事，两者之间的映射属于 application
service。它同样不在根 package 里放逻辑：一个不落在任何接缝里的 type，等于悄
悄退出了这些接缝所服务的那次拆分。

<!-- readme:status -->

## 状态

已脚手架。十一个 package 均已存在，每个都记录了它将持有什么，目前没有任何
type。内容将与各自实现的规范一同落地。目录级机制见
[`./CLAUDE.md`](./CLAUDE.md)。
