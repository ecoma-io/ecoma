---
name: site
subsystem: website
lang: zh
description: ecoma.io 网站外壳 — 位于 `/` 的 Nuxt 应用（ADR-0004），在 Website Charter 落地后以 en/vi/zh 发布营销表面。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# site

ecoma.io 网站外壳：位于 `/` 的 Nuxt 应用，将在 Website Charter 落地后发布
商店区。今天它证明的是宪章将依托的管道 — URL 拓扑（`/`、`/vi/`、`/zh/`）、
i18n 形态和 SEO 表面（hreflang、canonical、`robots.txt`）— 以一个诚实的
状态页呈现，不含任何营销文案。

<!-- readme:why -->

## 为什么存在

ADR-0004 将 `/` 上的网站分配给 Nuxt（SSG 与 ISR）。Website Charter 被保留，
拥有漏斗与文案；此应用是将已记录的决策变成可运行、可部署产物的接缝 — 也是
`site-e2e` 把关的产物，因此当内容构建稍后发生时，SEO 契约不会无人察觉地
腐烂。

<!-- readme:consumers -->

## 谁消费它

ecoma.io 的访客与爬虫 — 每种语言一个页面，`html lang`、hreflang 替代链接、
canonical 与 `og:locale` 由 `useLocaleHead` 生成而非手写。Nx 项目
`site-e2e` 将构建产物 `dist/` 作为其阻塞门禁消费。

<!-- readme:ecosystem -->

## 它位于哪里

`website/apps/site`，标签 `type:app`、`scope:website`。语言在构建时从仓库
根目录的 `languages.config.json` 派生；canonical 基准 URL 从根
`package.json` 的 `homepage` 字段派生。两者都是被读取，绝不复制（规则 14）。
机制与预览 `noindex` 接缝在 [`./CLAUDE.md`](./CLAUDE.md)；区域的延期记录在
[`../../CLAUDE.md`](../../CLAUDE.md)。目标：`lint`、`typecheck`、`test`、
`build`、`serve` — 外加独立项目中的 `e2e`。

<!-- readme:boundary -->

## 它不是什么

它不是 doctrine 表面（`shared/apps/doctrine-site` 拥有 `/doctrine`），也
不是设计系统（`shared/apps/design-system` 拥有 `/design` 挂载）。它不导入
任何共享库 — 一个表面，不是消费者。它也不是 Website Charter：漏斗、文案
与 ICP 工作在那边落地，而不是在这个外壳里。

<!-- readme:status -->

## 状态

外壳脚手架 — 通过 `nuxt generate` 实现 SSG；ISR、站点地图和真正的商店区
内容是保留接缝（见 [`./CLAUDE.md`](./CLAUDE.md) 中的延期记录）。
