<script setup lang="ts">
import { useHead, useLocaleHead } from "#imports";

const head = useLocaleHead({ dir: true, lang: true, seo: true });

useHead({
  htmlAttrs: {
    lang: () => head.value.htmlAttrs.lang,
    dir: () => head.value.htmlAttrs.dir,
  },
  link: () => [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }, ...head.value.link],
  meta: () => head.value.meta,
});
</script>

<template>
  <NuxtPage />
</template>
