---
name: engine-ports
subsystem: platform
lang: zh
description: 引擎 domain 向外暴露的 interface —— 日志存储、blob 存储、租约、密钥存储 —— 以需求命名，而非以技术命名。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# engine-ports

引擎向外部世界所需的东西，用它自己的词汇书写：一个只追加的日志存储、一个按
内容寻址的 blob 存储、一个租约、一个密钥存储、一个 SQL 读取面、一个指标
projection。

<!-- readme:why -->

## 为什么存在

port 是让后端可替换的那个东西。把它同时从概念与实现中分离出来，才使同一个
引擎既能跑在小型栈上、也能跑在参考栈上，而内部不需要任何分支 —— 也才使一套
契约套件能以同一组用例驱动两者。写在 `engine-domain` 里，会把存储关注点拖进
纯粹层；写在 `engine-adapters` 里，则再没有什么可替换的了。

<!-- readme:consumers -->

## 谁在使用它

`engine-adapters` 实现它，`conformance-g0` 直接驱动它，随后出现的
application service 与 composition root 在其上编排。它只消费
`engine-domain`，别无其他。

<!-- readme:ecosystem -->

## 它在生态中的位置

处于 `layer:domain` → `layer:port` → `layer:adapter` 的中间，位于 `platform/`
区域内。给在此编辑文件的人准备的机制见 [`./CLAUDE.md`](./CLAUDE.md)。

<!-- readme:boundary -->

## 它刻意不做的事

它不指名任何技术 —— 没有驱动、没有方言、没有 URL 形态。它也不持有契约测试：
套件从不住在它所仲裁的 project 内部。它目前也没有向量 port：
`engine-ports/vector` 是一条已命名的接缝，将随其首个消费者 Knowledge 一同到
来，而不是一份为无人设计的契约。

<!-- readme:status -->

## 状态

已脚手架，且刻意没有任何 interface。每个 interface 将与它所服务的规范一同落
地，而属于 gate 范围的那些，将与把它们钉在契约上的套件一同落地。目录级机制
见 [`./CLAUDE.md`](./CLAUDE.md)。
