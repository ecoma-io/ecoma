<script setup lang="ts">
import { useHead, useI18n, useLocalePath } from "#imports";

// Nuxt renders error.vue for every failure; the prop carries statusCode so the
// 404 copy (a missing page) and the error copy (a page that failed to render)
// can stay distinct.
const props = defineProps({ error: { type: Object } });

const { t, locale, locales } = useI18n();
const localePath = useLocalePath();

const isNotFound = props.error?.statusCode === 404;

useHead({
  htmlAttrs: { lang: locale },
  title: () => (isNotFound ? t("shell.notFound") : t("shell.error")),
  meta: [
    {
      name: "description",
      content: () => (isNotFound ? t("shell.notFoundHint") : t("shell.errorHint")),
    },
  ],
});
</script>

<template>
  <main>
    <h1>{{ isNotFound ? t("shell.notFound") : t("shell.error") }}</h1>
    <p>{{ isNotFound ? t("shell.notFoundHint") : t("shell.errorHint") }}</p>
    <nav :aria-label="t('shell.languages')" data-testid="locale-switcher">
      <a
        v-for="l in locales"
        :key="l.code"
        :href="localePath('/', l.code)"
        :hreflang="l.code"
        :lang="l.code"
        :aria-current="locale === l.code ? 'page' : undefined"
      >
        {{ l.name }}
      </a>
    </nav>
  </main>
</template>
