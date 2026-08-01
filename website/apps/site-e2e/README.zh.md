---
name: site-e2e
subsystem: website
lang: zh
description: 对已构建的 ecoma.io 外壳的阻塞性 Playwright 门禁 — 在产物层面钉住网站的 SEO 契约（lang、hreflang、canonical、robots）。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# site-e2e

对已构建的 ecoma.io 网站外壳（`site`）的阻塞性 Playwright 门禁。它驱动
`nuxt generate` 产生的 `dist/` 产物，钉住未来内容构建不得退化的 SEO 契约：
按 locale 的 `html lang`、带 `x-default` 的 hreflang 替代链接、指向生产
来源的 canonical 链接、语言切换器与 `robots.txt`。

<!-- readme:why -->

## 为什么存在

外壳的 SEO 表面由 `@nuxtjs/i18n` 从配置文件生成 — 后续内容构建中一个手写
的 `<link rel="alternate">` 或缺失的 canonical 能通过所有 lint。改为读取
构建后的 HTML，钉住真正发布的内容，这与其它 e2e 套件扫描构建产物而非源码
的理由相同。

<!-- readme:consumers -->

## 谁消费它

每个触及 `site` 的更改 — 每当应用的构建变化时 `nx affected` 都会运行此
套件，且 `e2e` 目标依赖该构建，因此被测产物永不过时。

<!-- readme:ecosystem -->

## 它位于哪里

`website/apps/site-e2e`，标签 `type:e2e`、`scope:website`。它通过
`dev-cli run-e2e` 运行（Linux 上使用 xvfb，浏览器垫片集中一处），并通过
`vite preview` 在端口 4176 上服务构建好的 `dist/`。机制见
[`./CLAUDE.md`](./CLAUDE.md)。

<!-- readme:boundary -->

## 它不覆盖什么

robots 契约的 preview-`noindex` 一半：证明 `NUXT_PUBLIC_PREVIEW=true`
添加 robots meta 需要第二次构建，因此它由人工检查并记录在
`site/CLAUDE.md` — 套件从不声称自己没有的覆盖率。

<!-- readme:status -->

## 状态

一个套件文件（`shell.e2e.test.ts`）覆盖外壳的 SEO 契约 — 机制见
[`./CLAUDE.md`](./CLAUDE.md)，套件见 [`./src`](./src)。
