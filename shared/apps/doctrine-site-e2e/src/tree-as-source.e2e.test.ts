import { rmSync, writeFileSync } from "node:fs";

import { expect, test } from "playwright/test";

import { documentPath, rebuildSite } from "./doctrine-tree";

// The claim this file exists to prove: **the site has no content of its own.**
//
// Every other assertion in this suite would still pass against a site that
// rendered a copy of the tree kept beside the app — a copy is identical on the
// day it is made, and "the page is there" cannot tell the two apart. So this
// test changes the library and nothing else, rebuilds, and looks: if the page
// follows, there is no second source. If it does not, there is one.
//
// It writes into `shared/libs/doctrine` and removes what it wrote. The files are
// untracked for as long as they exist, so the doctrine gate — which reads the
// git index — never sees them; a crashed run leaves two stray files and damages
// no document.

const CANONICAL = "spec/site-e2e-probe.md";
const TRANSLATION = "spec/site-e2e-probe.vi.md";
const CANONICAL_TITLE = "Probe document written by the site e2e";
const TRANSLATION_TITLE = "Tài liệu dò do e2e của site viết";

const document = (title: string, extra = "") =>
  `---\ntitle: "${title}"\nstatus: design-end-state\n${extra}---\n\n# ${title}\n\nWritten by \`tree-as-source.e2e.test.ts\` and removed by it.\n`;

// Two rebuilds of the real site, so the whole file gets time the default single
// test timeout does not allow for.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(() => {
  writeFileSync(documentPath(CANONICAL), document(CANONICAL_TITLE));
  writeFileSync(
    documentPath(TRANSLATION),
    document(TRANSLATION_TITLE, "canonical-sha: 000000000000\nlang: vi\n"),
  );
  rebuildSite();
});

test.afterAll(() => {
  rmSync(documentPath(CANONICAL), { force: true });
  rmSync(documentPath(TRANSLATION), { force: true });
  rebuildSite();
});

test("publishes a document added to the library with no file in the app changed", async ({
  page,
}) => {
  const response = await page.goto("./spec/site-e2e-probe");
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText(CANONICAL_TITLE);
});

test("puts that document in the sidebar, so the navigation is derived from the tree and not listed", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.locator(".VPSidebar").getByRole("link", { name: CANONICAL_TITLE }),
  ).toBeVisible();
});

test("gives a document one sidebar entry however many languages it was published in", async ({
  page,
}) => {
  await page.goto("./spec/site-e2e-probe");
  const sidebar = page.locator(".VPSidebar");
  await expect(sidebar.getByRole("link", { name: CANONICAL_TITLE })).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: TRANSLATION_TITLE })).toHaveCount(0);
});

test("offers the other language from the page itself, in both directions", async ({ page }) => {
  await page.goto("./spec/site-e2e-probe");
  await page
    .getByRole("navigation", { name: "Language" })
    .getByRole("link", { name: "Tiếng Việt" })
    .click();
  await expect(page).toHaveURL(/\/doctrine\/spec\/site-e2e-probe\.vi$/);
  await expect(page.locator("h1")).toContainText(TRANSLATION_TITLE);

  await page
    .getByRole("navigation", { name: "Language" })
    .getByRole("link", { name: "English" })
    .click();
  await expect(page).toHaveURL(/\/doctrine\/spec\/site-e2e-probe$/);
  await expect(page.locator("h1")).toContainText(CANONICAL_TITLE);
});
