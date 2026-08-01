---
name: website
lang: zh
description: ecoma.io 的商店与增长区域 — 位于 `/` 的 Nuxt 应用外壳、其 Playwright 门禁，以及被保留的 Website Charter 漏斗将落地的接缝。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# website

Website Charter 的公开记录为 ecoma.io 表面指定的子系统：商店与增长，与产品
Hub 强分离。宪章本身被保留（漏斗剧本）；今天这里存在的是它的架构接缝 —
URL 拓扑、i18n 形态，以及将在宪章落地后发布营销表面的应用外壳。

<!-- readme:why -->

## 为什么存在

Deploy charter 将产品划分为固定 URL 上的表面：位于 `/` 的网站
（ADR-0004 — Nuxt，SSG 与 ISR），位于 `/doctrine` 的 doctrine
（ADR-0007 — VitePress），以及一个挂载点的设计系统。这些表面需要一个归属
树，corpus map 记录的归属树就是这个区域 — 而不是 `shared/apps`。把表面放
在这里，可让商店区远离必须可从每个 scope 导入的共享基座：一个由营销文案
拥有的增长表面，没有东西可以导出给 `core-ui`。

<!-- readme:consumers -->

## 谁消费它

网站访客与搜索引擎爬虫 — 外壳同时服务人类读者和 SEO 表面（hreflang、
canonical、`robots.txt`）。工作区门禁也消费它：这里的每个 project 都携带
完整的检查集合（`lint`、`test`、`typecheck`、`build`，外加独立 project 里的
`e2e`），`site` 应用的 hreflang/canonical 行为由 `site-e2e` 钉住，让未来的
内容构建无法无声地使其退化。

<!-- readme:ecosystem -->

## 它位于哪里

仓库根目录是 `website/` 的父目录，与 `shared/` 和 `cloud/` 同级。URL 拓扑
与 i18n 决策记录在 [`website/CLAUDE.md`](./CLAUDE.md)，那里也持有延期记录 —
设计系统的挂载名（`/design` 对比 `/design-system`）、doctrine 表面的按
locale 构建迁移、站点地图和 ISR 都在那里预留了接缝。这里不导入任何共享
库：外壳是一个表面，不是消费者。

<!-- readme:boundary -->

## 什么不在范围内

漏斗本身 — 文案、按 ICP 的增长与渲染决策属于 Website Charter，而该宪章被
保留。doctrine 表面位于 `shared/apps/doctrine-site`，不在这里，并且边缘
路由器（不是这棵树）拥有所有挂载。系统宪章唯一且属于 Hub；`website/`
记录区域，从不记录漏斗。

<!-- readme:status -->

## 状态

外壳脚手架：`website/apps/site`（Nuxt 4 + `@nuxtjs/i18n`，语言从
`languages.config.json` 派生）和 `website/apps/site-e2e`（Playwright 门禁）。
除响亮的状态页之外的任何内容都被宪章推迟。这个区域是一个等待填充的接缝，
而不是一个发布营销文案的产品。
