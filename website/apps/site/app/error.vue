<script setup lang="ts">
import { useHead, useI18n, useLocalePath } from "#imports";

const { t, locale, locales } = useI18n();
const localePath = useLocalePath();

useHead({ title: () => t("shell.notFound") });
</script>

<template>
  <main>
    <h1>{{ t("shell.notFound") }}</h1>
    <p>{{ t("shell.notFoundHint") }}</p>
    <nav :aria-label="t('shell.languages')">
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
