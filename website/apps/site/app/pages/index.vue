<script setup lang="ts">
import { useHead, useI18n, useSwitchLocalePath } from "#imports";

const { t, locale, locales } = useI18n();
const switchLocalePath = useSwitchLocalePath();

useHead({
  title: () => t("shell.title"),
  meta: [
    { name: "description", content: () => t("shell.description") },
    { property: "og:title", content: () => t("shell.title") },
    { property: "og:description", content: () => t("shell.description") },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Ecoma" },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: () => t("shell.title") },
    { name: "twitter:description", content: () => t("shell.description") },
  ],
});
</script>

<template>
  <main>
    <h1>ecoma.io</h1>
    <p>{{ t("shell.status") }}</p>
    <nav :aria-label="t('shell.languages')" data-testid="locale-switcher">
      <a
        v-for="l in locales"
        :key="l.code"
        :href="switchLocalePath(l.code)"
        :hreflang="l.code"
        :lang="l.code"
        :aria-current="locale === l.code ? 'page' : undefined"
      >
        {{ l.name }}
      </a>
    </nav>
  </main>
</template>
