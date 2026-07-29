---
name: doctrine
subsystem: shared
lang: en
description: The published ceiling — North Stars, specs, charter, rubric — plus the pure logic that turns that tree into navigation.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# doctrine

<!-- readme:why -->

## Why it exists

Ecoma's design is settled in documents before it is settled in code: the North
Stars, the specs each mechanism must satisfy, the deploy charter, and the rubric
those reviews run against. Those documents are published, so they need a home
that is versioned with the code they govern rather than living beside it in a
folder somewhere.

Giving them a project of their own — instead of dropping the Markdown into the
site that renders it — buys one thing that matters: the tree becomes something
the workspace can check. A document that exists but reaches no reader is the
characteristic way a documentation site fails, and it fails quietly, because
nobody reports a page they never knew was there. The logic here refuses that
shape rather than rendering around it.

<!-- readme:consumers -->

## Who consumes it

`shared/apps/doctrine-site` and nothing else. It reads the tree, hands the
document list here, and renders what comes back.

Because the project is a real Nx node and the site imports it, editing a
document is a change `nx affected` can see — which is why the content lives in a
library rather than inside the app that displays it.

<!-- readme:ecosystem -->

## Where it sits

In `shared/` because the ceiling spans every product area — platform, RPA and
Hub alike — and `shared/` is where the workspace keeps what belongs to no single
product.

The module itself is pure: it takes a list of documents and returns ordered
sections, and never touches a filesystem. Reading the tree is the caller's job,
which keeps every rule here testable without a fixture directory on disk.

<!-- readme:boundary -->

## What it deliberately does not do

- **No filesystem access.** Callers read; this decides.
- **No built-in section order.** The order arrives as an argument, checked in
  both directions against the tree. A default baked in here would be a claim
  about content this project cannot see.
- **No title map.** Titles come from each document's own heading, so renaming a
  heading renames its navigation entry and there is no second place to edit.
- **No rendering.** Themes, routing and search belong to the site.

<!-- readme:status -->

## Status

Scaffolded: the navigation logic is live and tested; the ceiling documents land
in their own change, and the site that renders them follows. Directory-scoped
mechanics live in [`./CLAUDE.md`](./CLAUDE.md).
