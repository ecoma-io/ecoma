<template>
  <!--
    Stated once per page by the site, not once per document by hand: the licence
    covers the whole tree, and a sentence repeated in thirty-odd documents is a
    sentence corrected in one of them.

    Deliberately not `themeConfig.footer`: the default theme hides that footer
    outright on any page that has a sidebar (`.VPFooter.has-sidebar { display:
    none }`), which is every page here — the licence would have been configured
    and rendered nowhere.
  -->
  <aside class="document-licence">
    The documents are licensed
    <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="license">CC BY-SA 4.0</a>. The
    source code is licensed separately — see the repository root.
  </aside>
</template>

<style scoped>
.document-licence {
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-size: 14px;
}
</style>
