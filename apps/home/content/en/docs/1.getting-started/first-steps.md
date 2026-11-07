---
title: First Steps
description: A quick end-to-end walkthrough from the home page to reading a document.
---

# First Steps

This walkthrough takes you from the public home page to a document in the docs
app, exercising the whole public surface.

## 1. Open the home page

Open `https://ecoma.io` (or `http://localhost:4200` in local development). The
root `/` is a **locale-resolution entry point**: it does not serve content
itself, it forwards to a localized surface such as `/en` or `/vi`.

## 2. Choose a locale

The header shows a language switcher with the available locales. Choose
English to reach `/en` or Vietnamese to reach `/vi`.

## 3. Open the docs

From the global navigation in the header, open **Docs**. You land on
`/en/docs` — the documentation landing page.

## 4. Choose a section

The landing page lists the documentation sections:

- Getting Started
- Concepts
- Guides

Open **Concepts** and then the **Public Web** page to learn about the URL model.

## 5. Read a document

A document page is made of several parts:

- breadcrumbs, e.g. `Docs → Concepts → Public Web`,
- the **On this page** table of contents on wide screens,
- the rendered content itself, and
- previous / next navigation at the bottom.

Use the **Previous** and **Next** links to move deterministically through a
section without leaving the current locale.

---

_Previous: [Installation](/en/docs/getting-started/installation) · Next:
[Concepts](/en/docs/concepts)_
